#!/usr/bin/env python3
"""MCP Code Index Server.

Exposes 6 tools to Claude Code for fast code navigation:
  - search_code: semantic/keyword search across all indexed code and docs
  - get_symbols: exact/prefix symbol name lookup
  - get_file_summary: all symbols in a file with line ranges
  - get_dependencies: import/include graph for a file
  - get_project_overview: directory tree and file counts
  - refresh_index: force full re-scan

Requires:
  - PROJECT_ROOT env var set to the project directory to index
  - Ollama running with nomic-embed-text model (optional, for semantic search)

Usage:
  python server.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# Must configure before importing local modules that read env at import time
if "PROJECT_ROOT" not in os.environ:
    print("Error: PROJECT_ROOT environment variable is required", file=sys.stderr)
    sys.exit(1)

import config
from freshness import FreshnessManager
from store import IndexStore

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool
import mcp.types as types


# ---------------------------------------------------------------------------
# Globals — initialized once on startup
# ---------------------------------------------------------------------------

_store: IndexStore | None = None
_freshness: FreshnessManager | None = None


def get_store() -> IndexStore:
    assert _store is not None, "Store not initialized"
    return _store


def get_freshness() -> FreshnessManager:
    assert _freshness is not None, "Freshness manager not initialized"
    return _freshness


# ---------------------------------------------------------------------------
# Dependency extraction helpers
# ---------------------------------------------------------------------------

_TS_IMPORT_RE = re.compile(r"""from\s+['"]([^'"]+)['"]""")
_CPP_INCLUDE_RE = re.compile(r"""#include\s+["<]([^">]+)[">]""")


def _extract_imports(file_path: Path) -> list[str]:
    """Extract import/include paths from a source file."""
    try:
        source = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    ext = file_path.suffix.lower()
    if ext in (".ts", ".tsx", ".js", ".jsx"):
        raw = _TS_IMPORT_RE.findall(source)
    elif ext in (".cpp", ".h", ".hpp", ".cc", ".mm", ".m"):
        raw = _CPP_INCLUDE_RE.findall(source)
    else:
        return []

    # Resolve relative imports to project-relative paths
    result = []
    for imp in raw:
        if imp.startswith("."):
            # Relative import: resolve from file's directory
            resolved = (file_path.parent / imp).resolve()
            # Try adding common extensions if no extension
            if not resolved.suffix:
                for ext_try in (".ts", ".tsx", ".js", ".cpp", ".h"):
                    candidate = resolved.with_suffix(ext_try)
                    if candidate.exists():
                        resolved = candidate
                        break
            try:
                rel = str(resolved.relative_to(config.PROJECT_ROOT))
                result.append(rel)
            except ValueError:
                pass
        elif not imp.startswith("/") and "/" in imp:
            # Could be a project-internal absolute path — check if it resolves
            candidate = config.PROJECT_ROOT / imp
            if candidate.exists():
                result.append(imp)
    return result


def _build_import_graph() -> dict[str, list[str]]:
    """Build {file: [imported_files]} for all indexed files."""
    graph: dict[str, list[str]] = {}
    indexed = get_store().get_indexed_files()
    for rel_path in indexed:
        abs_path = config.PROJECT_ROOT / rel_path
        if abs_path.exists():
            graph[rel_path] = _extract_imports(abs_path)
    return graph


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

app = Server("code-index")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="search_code",
            description=(
                "Semantic and keyword search across all indexed code and documentation. "
                "Returns the most relevant code chunks for a natural language query. "
                "Use this first when looking for code related to a concept or behavior."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query, e.g. 'scroll offset correction logic'",
                    },
                    "language": {
                        "type": "string",
                        "description": "Optional filter: ts, tsx, cpp, mm, swift, py, markdown",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10)",
                        "default": 10,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="get_symbols",
            description=(
                "Find symbols (functions, classes, types, interfaces, etc.) by name or prefix. "
                "Use this when you know the name of something you're looking for."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Symbol name or substring, e.g. 'LayoutCache', 'applyMeasurements'",
                    },
                    "kind": {
                        "type": "string",
                        "description": "Optional filter: function, method, class, interface, type, enum, struct",
                    },
                    "language": {
                        "type": "string",
                        "description": "Optional filter: ts, tsx, cpp, mm, swift, py",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 20)",
                        "default": 20,
                    },
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="get_file_summary",
            description=(
                "Get a structural summary of a file: all symbols with their line ranges and signatures. "
                "Use this to understand a file's structure before reading it."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Relative path from project root, e.g. 'packages/rn-collection-view/cpp/LayoutCache.cpp'",
                    },
                },
                "required": ["file_path"],
            },
        ),
        Tool(
            name="get_dependencies",
            description=(
                "Find what a file imports and what files import it. "
                "Useful for understanding which files are affected by a change."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Relative path from project root",
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["imports", "imported_by", "both"],
                        "description": "Direction to trace (default: both)",
                        "default": "both",
                    },
                },
                "required": ["file_path"],
            },
        ),
        Tool(
            name="get_project_overview",
            description=(
                "Returns a high-level overview of the project: directory tree, "
                "file counts by language, and key entry points. "
                "Use this at the start of a session to orient yourself."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="refresh_index",
            description=(
                "Force re-scan all project files and re-index any that have changed. "
                "Call this after large refactors or if search results seem stale."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "search_code":
        return await _tool_search_code(arguments)
    elif name == "get_symbols":
        return await _tool_get_symbols(arguments)
    elif name == "get_file_summary":
        return await _tool_get_file_summary(arguments)
    elif name == "get_dependencies":
        return await _tool_get_dependencies(arguments)
    elif name == "get_project_overview":
        return await _tool_get_project_overview(arguments)
    elif name == "refresh_index":
        return await _tool_refresh_index(arguments)
    else:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def _tool_search_code(args: dict) -> list[TextContent]:
    query = args["query"]
    language = args.get("language")
    limit = int(args.get("limit", 10))

    results = get_store().search(query, language=language, limit=limit)

    if not results:
        return [TextContent(type="text", text="No results found.")]

    lines = [f"Found {len(results)} result(s) for: {query!r}\n"]
    for i, r in enumerate(results, 1):
        score = r.get("relevance_score", "N/A")
        lines.append(
            f"{i}. [{r.get('symbol_kind', '?')}] {r.get('symbol_name', '?')}  "
            f"(score: {score})\n"
            f"   {r['file_path']}:{r['start_line']}-{r['end_line']}\n"
            f"   Context: {r.get('context', '')}\n"
            f"   Signature: {r.get('signature', '')}\n"
        )
        snippet = r.get("snippet", r.get("text", ""))
        if snippet:
            # Show first 8 lines of snippet
            snippet_preview = "\n".join(snippet.splitlines()[:8])
            lines.append(f"   ```\n{snippet_preview}\n   ```\n")

    return [TextContent(type="text", text="\n".join(lines))]


async def _tool_get_symbols(args: dict) -> list[TextContent]:
    name = args["name"]
    kind = args.get("kind")
    language = args.get("language")
    limit = int(args.get("limit", 20))

    results = get_store().symbol_store.search_symbols(name, kind=kind, language=language, limit=limit)

    if not results:
        return [TextContent(type="text", text=f"No symbols found matching '{name}'.")]

    lines = [f"Found {len(results)} symbol(s) matching '{name}':\n"]
    for r in results:
        lines.append(
            f"  [{r['kind']}] {r['qualified_name'] or r['name']}  ({r['language']})\n"
            f"    {r['file_path']}:{r['start_line']}-{r['end_line']}\n"
            f"    {r['signature']}\n"
        )

    return [TextContent(type="text", text="\n".join(lines))]


async def _tool_get_file_summary(args: dict) -> list[TextContent]:
    file_path = args["file_path"]
    symbols = get_store().symbol_store.get_file_symbols(file_path)

    if not symbols:
        # Try fuzzy match
        all_indexed = get_store().get_indexed_files()
        matches = [p for p in all_indexed if file_path.lower() in p.lower()]
        if matches:
            suggestions = "\n".join(f"  - {m}" for m in matches[:5])
            return [TextContent(
                type="text",
                text=f"No symbols found for '{file_path}'.\n\nDid you mean:\n{suggestions}",
            )]
        return [TextContent(type="text", text=f"File '{file_path}' is not indexed.")]

    abs_path = config.PROJECT_ROOT / file_path
    line_count = 0
    if abs_path.exists():
        try:
            line_count = sum(1 for _ in abs_path.open(encoding="utf-8", errors="replace"))
        except Exception:
            pass

    lines = [
        f"File: {file_path}",
        f"Language: {symbols[0]['language']}",
        f"Lines: {line_count}",
        f"Symbols: {len(symbols)}\n",
    ]
    for s in symbols:
        ctx = f"  [{s['context']}]" if s.get("context") else ""
        lines.append(
            f"  {s['start_line']:>5}-{s['end_line']:<5}  "
            f"[{s['kind']}] {s['name']}{ctx}\n"
            f"             {s['signature']}"
        )

    return [TextContent(type="text", text="\n".join(lines))]


async def _tool_get_dependencies(args: dict) -> list[TextContent]:
    file_path = args["file_path"]
    direction = args.get("direction", "both")

    graph = _build_import_graph()

    imports: list[str] = graph.get(file_path, [])
    imported_by: list[str] = [
        f for f, deps in graph.items() if file_path in deps
    ]

    lines = [f"Dependencies for: {file_path}\n"]

    if direction in ("imports", "both"):
        lines.append(f"Imports ({len(imports)}):")
        if imports:
            for imp in sorted(imports):
                lines.append(f"  -> {imp}")
        else:
            lines.append("  (none found)")
        lines.append("")

    if direction in ("imported_by", "both"):
        lines.append(f"Imported by ({len(imported_by)}):")
        if imported_by:
            for f in sorted(imported_by):
                lines.append(f"  <- {f}")
        else:
            lines.append("  (none found)")

    return [TextContent(type="text", text="\n".join(lines))]


async def _tool_get_project_overview(_args: dict) -> list[TextContent]:
    indexed = get_store().get_indexed_files()

    # Count by language
    lang_counts: dict[str, int] = {}
    dir_counts: dict[str, int] = {}
    for rel_path in indexed:
        ext = Path(rel_path).suffix.lower()
        lang = config.detect_language(Path(rel_path))
        lang_counts[lang] = lang_counts.get(lang, 0) + 1
        top_dir = rel_path.split("/")[0] if "/" in rel_path else "."
        dir_counts[top_dir] = dir_counts.get(top_dir, 0) + 1

    # Find likely entry points
    entry_points = []
    for rel in indexed:
        name = Path(rel).name.lower()
        if name in ("index.ts", "index.tsx", "app.tsx", "app.ts", "main.py", "server.py"):
            entry_points.append(rel)

    lines = [
        f"Project: {config.PROJECT_ROOT}",
        f"Total indexed files: {len(indexed)}\n",
        "Files by language:",
    ]
    for lang, count in sorted(lang_counts.items(), key=lambda x: -x[1]):
        lines.append(f"  {lang:<15} {count}")

    lines.append("\nTop-level directories:")
    for d, count in sorted(dir_counts.items(), key=lambda x: -x[1]):
        lines.append(f"  {d:<40} {count} files")

    if entry_points:
        lines.append("\nLikely entry points:")
        for ep in sorted(entry_points):
            lines.append(f"  {ep}")

    vector_status = "enabled" if get_store().vector_store else "disabled (Ollama not running)"
    lines.append(f"\nSemantic search: {vector_status}")

    return [TextContent(type="text", text="\n".join(lines))]


async def _tool_refresh_index(_args: dict) -> list[TextContent]:
    result = get_freshness().scan(verbose=False)
    text = (
        f"Index refresh complete:\n"
        f"  Files checked:    {result.files_checked}\n"
        f"  Re-indexed:       {result.files_reindexed}\n"
        f"  Added (new):      {result.files_added}\n"
        f"  Removed (deleted):{result.files_removed}\n"
        f"  Duration:         {result.duration_ms}ms\n"
    )
    if result.errors:
        text += f"\nErrors ({len(result.errors)}):\n"
        for e in result.errors[:5]:
            text += f"  {e}\n"
    return [TextContent(type="text", text=text)]


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def initialize() -> None:
    global _store, _freshness

    print(f"[code-index] PROJECT_ROOT: {config.PROJECT_ROOT}", file=sys.stderr)
    print(f"[code-index] INDEX_DATA_DIR: {config.INDEX_DATA_DIR}", file=sys.stderr)

    _store = IndexStore(config.INDEX_DATA_DIR, config.EMBEDDING_MODEL)

    _freshness = FreshnessManager(
        project_root=config.PROJECT_ROOT,
        resolve_files_fn=config.resolve_source_files,
        index_file_fn=lambda p: _store.index_file(p, config.PROJECT_ROOT),
        remove_file_fn=_store.remove_file,
        get_indexed_fn=_store.get_indexed_files,
        interval_seconds=config.FRESHNESS_INTERVAL,
    )

    # Initial scan
    print("[code-index] Running initial index scan...", file=sys.stderr)
    result = _freshness.scan(verbose=True)
    print(
        f"[code-index] Initial scan done: "
        f"{result.files_added} added, {result.files_reindexed} updated, "
        f"{result.files_removed} removed, {result.duration_ms}ms",
        file=sys.stderr,
    )

    # Start background freshness thread
    _freshness.start_background()


async def main() -> None:
    initialize()
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
