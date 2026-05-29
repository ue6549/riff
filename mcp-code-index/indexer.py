"""Code indexer: parse source files into structured chunks using tree-sitter.

Each chunk represents one logical unit (function, class, method, etc.) with
its source text, location, and metadata.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Chunk:
    id: str              # hash(file_path + start_line)
    file_path: str       # relative to PROJECT_ROOT
    start_line: int
    end_line: int
    symbol_name: str
    symbol_kind: str     # function, method, class, interface, type, enum, section
    language: str
    signature: str       # first non-blank line or declaration header
    context: str         # parent scope, e.g. "class LayoutCache"
    text: str            # full source text of the chunk
    extra: dict = field(default_factory=dict)


def _chunk_id(file_path: str, start_line: int) -> str:
    import hashlib
    return hashlib.sha256(f"{file_path}:{start_line}".encode()).hexdigest()[:16]


def _first_line(text: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s:
            return s[:120]
    return ""


def _split_large_chunk(chunk: Chunk, max_lines: int = 200) -> list[Chunk]:
    """Split a chunk exceeding max_lines at blank-line boundaries with 5-line overlap."""
    lines = chunk.text.splitlines()
    if len(lines) <= max_lines:
        return [chunk]

    result = []
    start = 0
    part = 0
    overlap = 5

    while start < len(lines):
        end = min(start + max_lines, len(lines))
        # Try to find a blank line to split at
        if end < len(lines):
            for i in range(end, max(start + max_lines // 2, start + 1), -1):
                if not lines[i - 1].strip():
                    end = i
                    break

        text_slice = "\n".join(lines[start:end])
        c = Chunk(
            id=_chunk_id(chunk.file_path, chunk.start_line + start),
            file_path=chunk.file_path,
            start_line=chunk.start_line + start,
            end_line=chunk.start_line + end - 1,
            symbol_name=f"{chunk.symbol_name}[{part}]",
            symbol_kind=chunk.symbol_kind,
            language=chunk.language,
            signature=chunk.signature if part == 0 else f"(continued) {chunk.signature}",
            context=chunk.context,
            text=text_slice,
        )
        result.append(c)
        part += 1
        start = end - overlap
        if start >= len(lines):
            break

    return result


# ---------------------------------------------------------------------------
# TypeScript / TSX / JavaScript / JSX
# ---------------------------------------------------------------------------

def _parse_typescript(source: str, file_path: str, language: str) -> list[Chunk]:
    try:
        import tree_sitter_typescript as ts_ts
        from tree_sitter import Language, Parser
        if language in ("tsx", "jsx"):
            lang = Language(ts_ts.language_tsx())
        else:
            lang = Language(ts_ts.language_typescript())
        parser = Parser(lang)
    except Exception:
        return _fallback_chunks(source, file_path, language)

    tree = parser.parse(source.encode())
    root = tree.root_node

    TARGET_KINDS = {
        "function_declaration",
        "arrow_function",
        "class_declaration",
        "method_definition",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
    }

    lines = source.splitlines()
    chunks: list[Chunk] = []

    def get_name(node) -> str:
        for child in node.children:
            if child.type in ("identifier", "property_identifier", "type_identifier"):
                return child.text.decode() if isinstance(child.text, bytes) else str(child.text)
        # For arrow functions assigned to a variable
        if node.parent and node.parent.type == "variable_declarator":
            name_node = node.parent.child_by_field_name("name")
            if name_node:
                t = name_node.text
                return t.decode() if isinstance(t, bytes) else str(t)
        return "<anonymous>"

    def get_context(node) -> str:
        parts = []
        p = node.parent
        while p:
            if p.type in ("class_declaration", "interface_declaration"):
                for c in p.children:
                    if c.type in ("type_identifier", "identifier"):
                        t = c.text
                        parts.append(t.decode() if isinstance(t, bytes) else str(t))
                        break
            p = p.parent
        return " > ".join(reversed(parts))

    def is_top_level_arrow(node) -> bool:
        """Only extract arrow functions assigned at module/export level."""
        if node.parent and node.parent.type == "variable_declarator":
            gp = node.parent.parent  # lexical_declaration
            if gp and gp.parent and gp.parent.type in ("program", "export_statement"):
                return True
        return False

    def walk(node, depth=0):
        if node.type in TARGET_KINDS:
            skip = node.type == "arrow_function" and not is_top_level_arrow(node)
            # Skip methods inside classes — handled via class body walk
            skip = skip or (node.type == "method_definition" and depth == 0)
            if not skip:
                start = node.start_point[0]
                end = node.end_point[0]
                text = "\n".join(lines[start:end + 1])
                kind_map = {
                    "function_declaration": "function",
                    "arrow_function": "function",
                    "class_declaration": "class",
                    "method_definition": "method",
                    "interface_declaration": "interface",
                    "type_alias_declaration": "type",
                    "enum_declaration": "enum",
                }
                name = get_name(node)
                ctx = get_context(node)
                sig = _first_line(text)
                c = Chunk(
                    id=_chunk_id(file_path, start + 1),
                    file_path=file_path,
                    start_line=start + 1,
                    end_line=end + 1,
                    symbol_name=name,
                    symbol_kind=kind_map.get(node.type, node.type),
                    language=language,
                    signature=sig,
                    context=ctx,
                    text=text,
                )
                chunks.extend(_split_large_chunk(c))
        for child in node.children:
            walk(child, depth + 1)

    walk(root)
    return chunks if chunks else _fallback_chunks(source, file_path, language)


# ---------------------------------------------------------------------------
# C++ / Headers
# ---------------------------------------------------------------------------

def _parse_cpp(source: str, file_path: str, language: str) -> list[Chunk]:
    try:
        import tree_sitter_cpp as ts_cpp
        from tree_sitter import Language, Parser
        lang = Language(ts_cpp.language())
        parser = Parser(lang)
    except Exception:
        return _fallback_chunks(source, file_path, language)

    tree = parser.parse(source.encode())
    root = tree.root_node
    lines = source.splitlines()
    chunks: list[Chunk] = []

    TARGET_KINDS = {
        "function_definition",
        "class_specifier",
        "struct_specifier",
        "enum_specifier",
        "template_declaration",
    }

    def get_name(node) -> str:
        # For class/struct/enum: look for name field
        name_node = node.child_by_field_name("name")
        if name_node:
            t = name_node.text
            return t.decode() if isinstance(t, bytes) else str(t)
        # For function_definition: look for declarator
        decl = node.child_by_field_name("declarator")
        if decl:
            t = decl.text
            return (t.decode() if isinstance(t, bytes) else str(t))[:80]
        return "<anonymous>"

    def get_context(node) -> str:
        parts = []
        p = node.parent
        while p:
            if p.type in ("class_specifier", "struct_specifier", "namespace_definition"):
                name_node = p.child_by_field_name("name")
                if name_node:
                    t = name_node.text
                    parts.append(t.decode() if isinstance(t, bytes) else str(t))
            p = p.parent
        return " > ".join(reversed(parts))

    def walk(node):
        if node.type in TARGET_KINDS:
            start = node.start_point[0]
            end = node.end_point[0]
            text = "\n".join(lines[start:end + 1])
            kind_map = {
                "function_definition": "function",
                "class_specifier": "class",
                "struct_specifier": "struct",
                "enum_specifier": "enum",
                "template_declaration": "template",
            }
            name = get_name(node)
            ctx = get_context(node)
            c = Chunk(
                id=_chunk_id(file_path, start + 1),
                file_path=file_path,
                start_line=start + 1,
                end_line=end + 1,
                symbol_name=name,
                symbol_kind=kind_map.get(node.type, node.type),
                language=language,
                signature=_first_line(text),
                context=ctx,
                text=text,
            )
            chunks.extend(_split_large_chunk(c))
            return  # Don't recurse into class bodies — they're part of the class chunk
        for child in node.children:
            walk(child)

    walk(root)
    return chunks if chunks else _fallback_chunks(source, file_path, language)


# ---------------------------------------------------------------------------
# Objective-C++ (.mm / .m) — tree-sitter-c + regex for ObjC constructs
# ---------------------------------------------------------------------------

_OBJC_INTERFACE_RE = re.compile(
    r"^(@interface|@implementation|@protocol)\s+(\w+)[^\n]*\n(.*?)^@end",
    re.MULTILINE | re.DOTALL,
)

_OBJC_METHOD_RE = re.compile(
    r"^[-+]\s*\([^)]+\)\s*\w[^\n{]*\{",
    re.MULTILINE,
)


def _parse_objcpp(source: str, file_path: str, language: str) -> list[Chunk]:
    lines = source.splitlines()
    chunks: list[Chunk] = []

    for m in _OBJC_INTERFACE_RE.finditer(source):
        keyword = m.group(1)
        name = m.group(2)
        body = m.group(3)
        start_line = source[:m.start()].count("\n") + 1
        end_line = source[:m.end()].count("\n") + 1
        text = m.group(0)

        kind = {
            "@interface": "interface",
            "@implementation": "class",
            "@protocol": "protocol",
        }.get(keyword, "class")

        c = Chunk(
            id=_chunk_id(file_path, start_line),
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            symbol_name=name,
            symbol_kind=kind,
            language=language,
            signature=f"{keyword} {name}",
            context="",
            text=text,
        )
        chunks.extend(_split_large_chunk(c))

        # Also extract individual methods within @implementation blocks
        if keyword == "@implementation":
            for mm in _OBJC_METHOD_RE.finditer(body):
                method_start_abs = source[:m.start()].count("\n") + body[:mm.start()].count("\n") + 1
                method_sig = mm.group(0).rstrip("{").strip()
                mc = Chunk(
                    id=_chunk_id(file_path, method_start_abs),
                    file_path=file_path,
                    start_line=method_start_abs,
                    end_line=method_start_abs,  # end unknown without deeper parsing
                    symbol_name=method_sig[:60],
                    symbol_kind="method",
                    language=language,
                    signature=method_sig,
                    context=name,
                    text=method_sig,
                )
                chunks.append(mc)

    # Fall back to C++ parsing for any C++ class/function definitions in the .mm file
    cpp_chunks = _parse_cpp(source, file_path, language)
    # Deduplicate by start_line
    existing_lines = {c.start_line for c in chunks}
    for c in cpp_chunks:
        if c.start_line not in existing_lines:
            chunks.append(c)
            existing_lines.add(c.start_line)

    return chunks if chunks else _fallback_chunks(source, file_path, language)


# ---------------------------------------------------------------------------
# Swift
# ---------------------------------------------------------------------------

def _parse_swift(source: str, file_path: str, language: str) -> list[Chunk]:
    try:
        import tree_sitter_swift as ts_swift
        from tree_sitter import Language, Parser
        lang = Language(ts_swift.language())
        parser = Parser(lang)
    except Exception:
        return _fallback_chunks(source, file_path, language)

    tree = parser.parse(source.encode())
    root = tree.root_node
    lines = source.splitlines()
    chunks: list[Chunk] = []

    TARGET_KINDS = {
        "class_declaration",
        "struct_declaration",
        "enum_declaration",
        "protocol_declaration",
        "function_declaration",
        "computed_property",
    }

    def get_name(node) -> str:
        for child in node.children:
            if child.type in ("simple_identifier", "type_identifier"):
                t = child.text
                return t.decode() if isinstance(t, bytes) else str(t)
        return "<anonymous>"

    def walk(node):
        if node.type in TARGET_KINDS:
            start = node.start_point[0]
            end = node.end_point[0]
            text = "\n".join(lines[start:end + 1])
            kind_map = {
                "class_declaration": "class",
                "struct_declaration": "struct",
                "enum_declaration": "enum",
                "protocol_declaration": "protocol",
                "function_declaration": "function",
                "computed_property": "property",
            }
            c = Chunk(
                id=_chunk_id(file_path, start + 1),
                file_path=file_path,
                start_line=start + 1,
                end_line=end + 1,
                symbol_name=get_name(node),
                symbol_kind=kind_map.get(node.type, node.type),
                language=language,
                signature=_first_line(text),
                context="",
                text=text,
            )
            chunks.extend(_split_large_chunk(c))
        for child in node.children:
            walk(child)

    walk(root)
    return chunks if chunks else _fallback_chunks(source, file_path, language)


# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------

def _parse_python(source: str, file_path: str, language: str) -> list[Chunk]:
    try:
        import tree_sitter_python as ts_py
        from tree_sitter import Language, Parser
        lang = Language(ts_py.language())
        parser = Parser(lang)
    except Exception:
        return _fallback_chunks(source, file_path, language)

    tree = parser.parse(source.encode())
    root = tree.root_node
    lines = source.splitlines()
    chunks: list[Chunk] = []

    TARGET_KINDS = {"function_definition", "class_definition"}

    def get_name(node) -> str:
        name_node = node.child_by_field_name("name")
        if name_node:
            t = name_node.text
            return t.decode() if isinstance(t, bytes) else str(t)
        return "<anonymous>"

    def walk(node):
        if node.type in TARGET_KINDS:
            start = node.start_point[0]
            end = node.end_point[0]
            text = "\n".join(lines[start:end + 1])
            kind = "function" if node.type == "function_definition" else "class"
            c = Chunk(
                id=_chunk_id(file_path, start + 1),
                file_path=file_path,
                start_line=start + 1,
                end_line=end + 1,
                symbol_name=get_name(node),
                symbol_kind=kind,
                language=language,
                signature=_first_line(text),
                context="",
                text=text,
            )
            chunks.extend(_split_large_chunk(c))
        for child in node.children:
            walk(child)

    walk(root)
    return chunks if chunks else _fallback_chunks(source, file_path, language)


# ---------------------------------------------------------------------------
# Markdown — split on ## headings
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)


def _parse_markdown(source: str, file_path: str, language: str) -> list[Chunk]:
    lines = source.splitlines()
    chunks: list[Chunk] = []

    # Find all heading positions
    heading_positions: list[tuple[int, str]] = []  # (line_index_0based, heading_text)
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,3})\s+(.+)$", line)
        if m:
            heading_positions.append((i, m.group(2).strip()))

    if not heading_positions:
        # No headings — whole file as one chunk
        c = Chunk(
            id=_chunk_id(file_path, 1),
            file_path=file_path,
            start_line=1,
            end_line=len(lines),
            symbol_name=Path(file_path).stem,
            symbol_kind="section",
            language=language,
            signature=Path(file_path).name,
            context="",
            text=source,
        )
        chunks.extend(_split_large_chunk(c))
        return chunks

    for i, (start_idx, heading) in enumerate(heading_positions):
        end_idx = heading_positions[i + 1][0] - 1 if i + 1 < len(heading_positions) else len(lines) - 1
        text = "\n".join(lines[start_idx:end_idx + 1])
        c = Chunk(
            id=_chunk_id(file_path, start_idx + 1),
            file_path=file_path,
            start_line=start_idx + 1,
            end_line=end_idx + 1,
            symbol_name=heading,
            symbol_kind="section",
            language=language,
            signature=heading,
            context="",
            text=text,
        )
        chunks.extend(_split_large_chunk(c))

    return chunks


# ---------------------------------------------------------------------------
# Fallback: block-based chunking (language-agnostic)
# ---------------------------------------------------------------------------

def _fallback_chunks(source: str, file_path: str, language: str, block_size: int = 60) -> list[Chunk]:
    """Split source into fixed blocks when tree-sitter parser is unavailable."""
    lines = source.splitlines()
    chunks = []
    for i in range(0, len(lines), block_size - 5):
        block_lines = lines[i:i + block_size]
        text = "\n".join(block_lines)
        c = Chunk(
            id=_chunk_id(file_path, i + 1),
            file_path=file_path,
            start_line=i + 1,
            end_line=i + len(block_lines),
            symbol_name=f"block_{i // (block_size - 5)}",
            symbol_kind="block",
            language=language,
            signature=_first_line(text),
            context="",
            text=text,
        )
        chunks.append(c)
    return chunks


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_file(file_path: Path, project_root: Path) -> list[Chunk]:
    """Parse a source file into chunks. Returns empty list on unrecoverable error."""
    from config import detect_language

    rel_path = str(file_path.relative_to(project_root))
    language = detect_language(file_path)

    try:
        source = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    if not source.strip():
        return []

    dispatch = {
        "typescript": _parse_typescript,
        "tsx": _parse_typescript,
        "javascript": _parse_typescript,
        "jsx": _parse_typescript,
        "cpp": _parse_cpp,
        "objcpp": _parse_objcpp,
        "objc": _parse_objcpp,
        "swift": _parse_swift,
        "python": _parse_python,
        "markdown": _parse_markdown,
    }

    parser_fn = dispatch.get(language, _fallback_chunks)
    chunks = parser_fn(source, rel_path, language)

    # Deduplicate by id
    seen: set[str] = set()
    unique: list[Chunk] = []
    for c in chunks:
        if c.id not in seen:
            seen.add(c.id)
            unique.append(c)

    return unique
