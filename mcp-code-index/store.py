"""Storage layer: sqlite-vec (vectors) + SQLite (symbol table).

sqlite-vec stores embeddings for semantic search (~2 MB RAM, zero extra processes).
SQLite stores the full symbol table for exact/prefix lookups and freshness tracking.
"""

from __future__ import annotations

import json
import sqlite3
import struct
import time
import urllib.request
from pathlib import Path
from typing import Any

# Embedding dimension for nomic-embed-text (default Ollama model).
_EMBED_DIM = 768

from indexer import Chunk


# ---------------------------------------------------------------------------
# SQLite symbol + file tracking
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS symbols (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    qualified_name TEXT,
    kind        TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    start_line  INTEGER,
    end_line    INTEGER,
    signature   TEXT,
    language    TEXT,
    context     TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name     ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_name_lower ON symbols(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind     ON symbols(kind);

CREATE TABLE IF NOT EXISTS indexed_files (
    file_path   TEXT PRIMARY KEY,
    mtime       REAL NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    indexed_at  REAL NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
    USING fts5(id UNINDEXED, name, signature, context, text, content='');
"""


class SymbolStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def upsert_file(self, file_path: str, mtime: float, chunks: list[Chunk]) -> None:
        """Insert/replace all symbols for a file atomically."""
        cur = self.conn.cursor()
        cur.execute("DELETE FROM symbols WHERE file_path = ?", (file_path,))
        cur.execute("DELETE FROM symbols_fts WHERE id IN (SELECT id FROM symbols WHERE file_path = ?)", (file_path,))

        for c in chunks:
            qualified = f"{c.context} > {c.symbol_name}" if c.context else c.symbol_name
            cur.execute(
                """
                INSERT OR REPLACE INTO symbols
                    (id, name, qualified_name, kind, file_path, start_line, end_line, signature, language, context)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (c.id, c.symbol_name, qualified, c.symbol_kind,
                 c.file_path, c.start_line, c.end_line, c.signature, c.language, c.context),
            )
            cur.execute(
                "INSERT INTO symbols_fts (id, name, signature, context, text) VALUES (?, ?, ?, ?, ?)",
                (c.id, c.symbol_name, c.signature, c.context, c.text[:2000]),
            )

        cur.execute(
            """
            INSERT OR REPLACE INTO indexed_files (file_path, mtime, chunk_count, indexed_at)
            VALUES (?, ?, ?, ?)
            """,
            (file_path, mtime, len(chunks), time.time()),
        )
        self.conn.commit()

    def delete_file(self, file_path: str) -> None:
        self.conn.execute("DELETE FROM symbols WHERE file_path = ?", (file_path,))
        self.conn.execute("DELETE FROM indexed_files WHERE file_path = ?", (file_path,))
        self.conn.commit()

    def get_indexed_files(self) -> dict[str, float]:
        """Return {file_path: mtime} for all indexed files."""
        rows = self.conn.execute("SELECT file_path, mtime FROM indexed_files").fetchall()
        return {r["file_path"]: r["mtime"] for r in rows}

    def search_symbols(
        self,
        name: str,
        kind: str | None = None,
        language: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        query = "SELECT * FROM symbols WHERE LOWER(name) LIKE LOWER(?)"
        params: list[Any] = [f"%{name}%"]
        if kind:
            query += " AND kind = ?"
            params.append(kind)
        if language:
            query += " AND language = ?"
            params.append(language)
        query += f" ORDER BY name LIMIT {limit}"
        rows = self.conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    def get_file_symbols(self, file_path: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line",
            (file_path,),
        ).fetchall()
        return [dict(r) for r in rows]

    def fts_search(self, query: str, limit: int = 20) -> list[dict]:
        """Full-text search over symbol names, signatures, context, and text snippets."""
        try:
            rows = self.conn.execute(
                """
                SELECT s.*, rank FROM symbols s
                JOIN symbols_fts f ON s.id = f.id
                WHERE symbols_fts MATCH ?
                ORDER BY rank LIMIT ?
                """,
                (query, limit),
            ).fetchall()
            return [dict(r) for r in rows]
        except Exception:
            # FTS query syntax error — fall back to LIKE
            return self.search_symbols(query, limit=limit)

    def all_symbols_for_file(self, file_path: str) -> list[dict]:
        return self.get_file_symbols(file_path)

    def close(self) -> None:
        self.conn.close()


# ---------------------------------------------------------------------------
# sqlite-vec vector store (~2 MB RAM, no extra processes)
# ---------------------------------------------------------------------------

_VEC_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS vec_meta (
    rowid      INTEGER PRIMARY KEY,
    chunk_id   TEXT UNIQUE NOT NULL,
    file_path  TEXT NOT NULL,
    start_line INTEGER,
    end_line   INTEGER,
    symbol_name TEXT,
    symbol_kind TEXT,
    language   TEXT,
    signature  TEXT,
    context    TEXT,
    snippet    TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
    embedding float[{_EMBED_DIM}]
);
CREATE INDEX IF NOT EXISTS idx_vec_meta_file ON vec_meta(file_path);
"""


class VectorStore:
    def __init__(self, db_path: Path, embedding_model: str) -> None:
        import sqlite_vec

        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self.conn.enable_load_extension(True)
        sqlite_vec.load(self.conn)
        self.conn.enable_load_extension(False)
        self.embedding_model = embedding_model
        self.conn.executescript(_VEC_SCHEMA)
        self.conn.commit()

    # ------------------------------------------------------------------
    # Embedding via Ollama HTTP API (no extra Python deps)
    # ------------------------------------------------------------------

    def _embed(self, text: str) -> list[float] | None:
        try:
            data = json.dumps({"model": self.embedding_model, "prompt": text}).encode()
            req = urllib.request.Request(
                "http://localhost:11434/api/embeddings",
                data=data,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read()).get("embedding")
        except Exception:
            return None

    def _chunk_to_text(self, chunk: Chunk) -> str:
        """Format chunk for embedding — structured header + source text."""
        return (
            f"language: {chunk.language}\n"
            f"file: {chunk.file_path}\n"
            f"context: {chunk.context}\n"
            f"symbol: {chunk.symbol_name} ({chunk.symbol_kind})\n"
            f"signature: {chunk.signature}\n\n"
            f"{chunk.text}"
        )

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    def upsert_chunks(self, chunks: list[Chunk]) -> None:
        if not chunks:
            return
        cur = self.conn.cursor()
        for chunk in chunks:
            vec = self._embed(self._chunk_to_text(chunk))
            if vec is None:
                continue
            # Remove existing entry for this chunk_id
            cur.execute(
                "DELETE FROM vec_embeddings WHERE rowid = "
                "(SELECT rowid FROM vec_meta WHERE chunk_id = ?)",
                (chunk.id,),
            )
            cur.execute("DELETE FROM vec_meta WHERE chunk_id = ?", (chunk.id,))
            # Insert vector first to get its rowid, then metadata
            cur.execute(
                "INSERT INTO vec_embeddings(embedding) VALUES (?)",
                (struct.pack(f"{_EMBED_DIM}f", *vec),),
            )
            rowid = cur.lastrowid
            cur.execute(
                """
                INSERT INTO vec_meta
                    (rowid, chunk_id, file_path, start_line, end_line,
                     symbol_name, symbol_kind, language, signature, context, snippet)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rowid, chunk.id, chunk.file_path,
                    chunk.start_line, chunk.end_line,
                    chunk.symbol_name, chunk.symbol_kind, chunk.language,
                    chunk.signature, chunk.context, chunk.text[:500],
                ),
            )
        self.conn.commit()

    def delete_file(self, file_path: str) -> None:
        cur = self.conn.cursor()
        cur.execute(
            "DELETE FROM vec_embeddings WHERE rowid IN "
            "(SELECT rowid FROM vec_meta WHERE file_path = ?)",
            (file_path,),
        )
        cur.execute("DELETE FROM vec_meta WHERE file_path = ?", (file_path,))
        self.conn.commit()

    def search(
        self,
        query: str,
        language: str | None = None,
        limit: int = 10,
    ) -> list[dict]:
        vec = self._embed(query)
        if vec is None:
            return []
        query_blob = struct.pack(f"{_EMBED_DIM}f", *vec)
        sql = """
            SELECT m.chunk_id, m.file_path, m.start_line, m.end_line,
                   m.symbol_name, m.symbol_kind, m.language,
                   m.signature, m.context, m.snippet,
                   e.distance
            FROM vec_embeddings e
            JOIN vec_meta m ON e.rowid = m.rowid
            WHERE e.embedding MATCH ?
        """
        params: list[Any] = [query_blob]
        if language:
            sql += " AND m.language = ?"
            params.append(language)
        sql += f" ORDER BY e.distance LIMIT {limit}"
        try:
            rows = self.conn.execute(sql, params).fetchall()
        except Exception:
            return []
        return [
            {
                "chunk_id": r[0],
                "file_path": r[1],
                "start_line": r[2],
                "end_line": r[3],
                "symbol_name": r[4],
                "symbol_kind": r[5],
                "language": r[6],
                "signature": r[7],
                "context": r[8],
                "snippet": r[9],
                # sqlite-vec distance is cosine distance (0=identical); convert to score
                "relevance_score": round(max(0.0, 1.0 - float(r[10])), 4),
            }
            for r in rows
        ]

    def is_available(self) -> bool:
        """Check if Ollama embedding service is reachable."""
        try:
            urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2)
            return True
        except Exception:
            return False

    def close(self) -> None:
        self.conn.close()


# ---------------------------------------------------------------------------
# Unified store
# ---------------------------------------------------------------------------

class IndexStore:
    def __init__(self, data_dir: Path, embedding_model: str) -> None:
        self.symbol_store = SymbolStore(data_dir / "symbols.db")
        self._embedding_model = embedding_model
        self._vector_store: VectorStore | None = None
        self._vector_available: bool | None = None
        self._vec_db_path = data_dir / "vectors.db"

    @property
    def vector_store(self) -> VectorStore | None:
        if self._vector_available is None:
            try:
                vs = VectorStore(self._vec_db_path, self._embedding_model)
                self._vector_available = vs.is_available()
                if self._vector_available:
                    self._vector_store = vs
                else:
                    print("Warning: Ollama not running — semantic search disabled. Start Ollama for full functionality.")
            except Exception as e:
                self._vector_available = False
                print(f"Warning: Vector store unavailable ({e}) — falling back to keyword search only.")
        return self._vector_store

    def index_file(self, file_path: Path, project_root: Path) -> int:
        """Parse and index a file. Returns chunk count."""
        from indexer import parse_file
        import os

        rel_path = str(file_path.relative_to(project_root))
        mtime = os.path.getmtime(file_path)
        chunks = parse_file(file_path, project_root)

        self.symbol_store.upsert_file(rel_path, mtime, chunks)
        if self.vector_store:
            self.vector_store.delete_file(rel_path)
            self.vector_store.upsert_chunks(chunks)

        return len(chunks)

    def remove_file(self, rel_path: str) -> None:
        self.symbol_store.delete_file(rel_path)
        if self.vector_store:
            self.vector_store.delete_file(rel_path)

    def search(self, query: str, language: str | None = None, limit: int = 10) -> list[dict]:
        """Hybrid search: vector (semantic) + FTS fallback."""
        if self.vector_store:
            results = self.vector_store.search(query, language=language, limit=limit)
            if results:
                return results
        # Fall back to FTS keyword search
        return self.symbol_store.fts_search(query, limit=limit)

    def get_indexed_files(self) -> dict[str, float]:
        return self.symbol_store.get_indexed_files()

    def close(self) -> None:
        self.symbol_store.close()
        if self._vector_store:
            self._vector_store.close()
