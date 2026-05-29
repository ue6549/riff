# MCP Code Index Server

A local, folder-agnostic MCP server that gives Claude Code instant structural and semantic code search via pre-indexed tree-sitter parsing + vector embeddings.

## Problem

Claude Code spends 5-10 Grep/Glob calls to orient itself before making edits. A searchable index served via MCP cuts this to a single tool call.

## Architecture

```
Claude Code  ──stdio──▶  MCP Server (Python)
                              │
                    ┌─────────┼──────────┐
                    ▼         ▼          ▼
              Tree-sitter   ChromaDB   SQLite
              (parsing)    (vectors)  (symbols)
```

Single Python process launched by Claude Code. Takes `PROJECT_ROOT` env var — same server works for any project.

### Components

| Component | Role |
|-----------|------|
| `config.py` | Reads env vars, resolves globs, provides defaults |
| `indexer.py` | Tree-sitter parsing, chunk generation per language |
| `store.py` | ChromaDB (vectors) + SQLite (symbols) read/write |
| `freshness.py` | mtime-based staleness detection, incremental re-index |
| `server.py` | MCP tool definitions, wiring, entry point |

### Data Flow

1. On startup: load persisted index from `~/.mcp-code-index/<project-hash>/`
2. Full mtime scan — re-index any files changed since last run
3. On each query: check result-set file mtimes (fast), serve from index
4. Background thread: full mtime scan every 30s
5. On shutdown: index persists to disk automatically (ChromaDB + SQLite)

## Defaults

| Setting | Default | Why |
|---------|---------|-----|
| Embedding provider | Ollama (`nomic-embed-text`) | Local, no API keys, good enough for code |
| Chunking | Symbol-level (tree-sitter) | Best granularity for code search |
| Index scope | Code + docs (markdown) | Docs contain architecture context worth searching |
| Storage | ChromaDB + SQLite | Vectors for semantic search, SQLite for exact lookups |
| Freshness | mtime poll (30s background) | Simple, <5ms for ~200 files, no fswatch needed |

## Configuration

All via environment variables in `.mcp.json`:

| Env Var | Required | Default |
|---------|----------|---------|
| `PROJECT_ROOT` | Yes | — |
| `INDEX_DATA_DIR` | No | `~/.mcp-code-index/<hash>/` |
| `SOURCE_GLOBS` | No | `**/*.ts,**/*.tsx,**/*.cpp,**/*.h,**/*.mm,**/*.swift,**/*.py,**/*.md` |
| `EXCLUDE_PATTERNS` | No | `**/node_modules/**,**/vendor/**,**/.git/**,**/build/**,**/Pods/**` |
| `EMBEDDING_MODEL` | No | `nomic-embed-text` |

## Chunking Strategy

Tree-sitter extracts structural units per language:

| Language | Extracted nodes |
|----------|----------------|
| TS/TSX | `function_declaration`, top-level `arrow_function`, `class_declaration`, `method_definition`, `interface_declaration`, `type_alias_declaration`, `enum_declaration` |
| C++/H | `function_definition`, `class_specifier`, `struct_specifier`, `enum_specifier`, children of `namespace_definition`, `template_declaration` |
| ObjC++ (.mm) | `tree-sitter-c` nodes + regex for `@interface`/`@implementation`/`@protocol` |
| Swift | `class_declaration`, `struct_declaration`, `function_declaration`, `protocol_declaration` |
| Python | `function_definition`, `class_definition` |
| Markdown | Split on `## ` headings |

### Chunk Record

```
{
  id, file_path, start_line, end_line,
  symbol_name, symbol_kind, language,
  signature, context (parent scope), text
}
```

Chunks >200 lines are split at blank-line boundaries with 5-line overlap.

### Embedding Input

Not raw code — structured text prepended with metadata:

```
language: cpp
file: packages/rn-collection-view/cpp/LayoutCache.cpp
context: namespace rncv > class LayoutCache
symbol: LayoutCache::get (method)

<source text>
```

## Storage Schema

### ChromaDB Collections

- **`code_chunks`** — vector embeddings + metadata (file_path, start_line, end_line, symbol_name, symbol_kind, language, signature, context)
- **`doc_chunks`** — markdown section embeddings + metadata (file_path, heading, start_line, end_line)

### SQLite Tables

```sql
CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    qualified_name TEXT,
    kind TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    signature TEXT,
    language TEXT,
    file_mtime REAL
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);

CREATE TABLE indexed_files (
    file_path TEXT PRIMARY KEY,
    mtime REAL NOT NULL,
    chunk_count INTEGER,
    indexed_at REAL
);
```

## MCP Tools

### 1. `search_code` — Semantic search
```
query: string        # e.g. "scroll offset correction logic"
language?: string    # filter: ts, cpp, mm, etc.
limit?: int          # default 10
→ [{file_path, start_line, end_line, symbol_name, symbol_kind, relevance_score, snippet}]
```

### 2. `get_symbols` — Exact/prefix name lookup
```
name: string         # e.g. "LayoutCache"
kind?: string        # function, method, class, interface, type, enum
language?: string
→ [{name, qualified_name, kind, file_path, start_line, end_line, signature}]
```

### 3. `get_file_summary` — File structure overview
```
file_path: string
→ {file_path, language, line_count, symbols: [{name, kind, start_line, end_line, signature}]}
```

### 4. `get_dependencies` — Import/include graph
```
file_path: string
direction?: "imports" | "imported_by" | "both"
→ {imports: [paths], imported_by: [paths]}
```

### 5. `get_project_overview` — High-level project map
```
(no input)
→ {directory_tree, file_counts_by_language, entry_points}
```

### 6. `refresh_index` — Force re-scan
```
(no input)
→ {files_checked, files_reindexed, files_added, files_removed, duration_ms}
```

## Setup

```bash
# 1. Ollama + embedding model
brew install ollama
ollama pull nomic-embed-text

# 2. Python env
cd mcp-code-index
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Wire into Claude Code — add to .mcp.json
```

### `.mcp.json` Example

```json
{
  "mcpServers": {
    "code-index": {
      "command": "<path>/mcp-code-index/.venv/bin/python",
      "args": ["<path>/mcp-code-index/server.py"],
      "env": {
        "PROJECT_ROOT": "/path/to/any/project"
      }
    }
  }
}
```

## Dependencies

```
mcp>=1.0.0
chromadb>=0.5.0,<0.6.0
tree-sitter>=0.23.0
tree-sitter-typescript>=0.23.0
tree-sitter-cpp>=0.23.0
tree-sitter-c>=0.23.0
tree-sitter-swift>=0.23.0
```

## Known Limitations

1. **Ollama must be running** — server checks on startup, clear error if not
2. **ObjC++ parsing imperfect** — no official tree-sitter-objc pip package; hybrid tree-sitter-c + regex
3. **No cross-language semantic linking** — doesn't know a C++ JSI module implements a TS spec
4. **nomic-embed-text is general-purpose** — hybrid search (vector + SQLite LIKE) compensates
5. **First run 5-10s** — subsequent starts <1s from persisted index

## Implementation Order

1. `config.py` — env var reading, defaults, glob resolution
2. `indexer.py` — tree-sitter parsing per language, chunk generation
3. `store.py` — ChromaDB + SQLite init, insert/query/delete
4. `freshness.py` — mtime tracking, staleness detection, incremental re-index
5. `server.py` — MCP tool definitions, wiring
6. Integration test against this repo
7. `.mcp.json` config

## Verification

1. `ollama pull nomic-embed-text` — confirm Ollama serving
2. `python server.py` standalone — should index project and start MCP server
3. Add to `.mcp.json`, restart Claude Code — tools should appear
4. `search_code("sticky header scroll offset")` — should return relevant C++/TS hits
5. Edit a file, `refresh_index` — should detect and re-index the change
6. `get_symbols("LayoutCache")` — should return symbols across languages

---

## Research: Future Configurability

These are options worth making configurable later when extracting the server into its own repo.

### Embedding Provider

| Provider | Pros | Cons |
|----------|------|------|
| **Ollama local** (current default) | Free, no network, fast on Apple Silicon | Requires Ollama running, general-purpose model |
| **OpenAI** (`text-embedding-3-small`) | Better quality, widely available | API key, network dependency, cost |
| **Voyage Code** (`voyage-code-3`) | Best for code specifically | API key, network, cost |
| **None (structural only)** | Zero dependencies beyond tree-sitter | No semantic search, keyword/symbol only |

The "none" mode is interesting — SQLite FTS5 + symbol table covers ~80% of value with zero setup. Could be the default for quick adoption, with embeddings as an upgrade.

### Chunking Granularity

| Strategy | When useful |
|----------|------------|
| **Symbol-level** (current default) | Best for most codebases, precise results |
| **File-level** | Very small files, config-heavy projects |
| **Block-level** (fixed-size + overlap) | Language-agnostic fallback, unknown languages |

### Index Scope

| Scope | What's indexed |
|-------|---------------|
| **Code only** | Source files matching language globs |
| **Code + docs** (current default) | + markdown files |
| **Code + docs + comments** | + extracted JSDoc/Doxygen as separate searchable chunks |

### Storage Backend

| Backend | Pros | Cons |
|---------|------|------|
| **ChromaDB + SQLite** (current default) | Full vector search + exact lookups | Heavier dependency |
| **SQLite-only** (FTS5) | Single dependency, lightweight | No semantic/vector search |
| **LanceDB** | Rust-backed, faster at scale | More complex, overkill for <1000 chunks |

### Freshness Mechanism

| Approach | When useful |
|----------|------------|
| **mtime poll** (current default) | Small-medium codebases (<1000 files) |
| **fswatch/watchman** | Large codebases where polling is slow |
| **Git-based** (`git diff --name-only`) | Only index committed files, skip WIP |

### Potential Config File Format

If extracting to standalone tool, a `.code-index.yaml` per project could replace env vars:

```yaml
source_globs:
  - "src/**/*.ts"
  - "lib/**/*.cpp"
exclude:
  - "**/node_modules/**"
embedding:
  provider: ollama
  model: nomic-embed-text
chunking: symbol
scope: code+docs
storage: chroma+sqlite
```
