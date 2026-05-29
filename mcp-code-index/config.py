"""Configuration for the MCP Code Index Server.

All settings are read from environment variables with sensible defaults.
"""

import hashlib
import os
from pathlib import Path


def _get_project_root() -> Path:
    raw = os.environ.get("PROJECT_ROOT", "")
    if not raw:
        raise RuntimeError("PROJECT_ROOT environment variable is required")
    p = Path(raw).resolve()
    if not p.is_dir():
        raise RuntimeError(f"PROJECT_ROOT is not a directory: {p}")
    return p


def _get_index_data_dir(project_root: Path) -> Path:
    explicit = os.environ.get("INDEX_DATA_DIR", "")
    if explicit:
        return Path(explicit).resolve()
    # Default: ~/.mcp-code-index/<hash-of-project-root>/
    h = hashlib.sha256(str(project_root).encode()).hexdigest()[:12]
    return Path.home() / ".mcp-code-index" / h


def _parse_csv_env(key: str, default: str) -> list[str]:
    raw = os.environ.get(key, default)
    return [s.strip() for s in raw.split(",") if s.strip()]


PROJECT_ROOT: Path = _get_project_root()

INDEX_DATA_DIR: Path = _get_index_data_dir(PROJECT_ROOT)

SOURCE_GLOBS: list[str] = _parse_csv_env(
    "SOURCE_GLOBS",
    "**/*.ts,**/*.tsx,**/*.js,**/*.jsx,"
    "**/*.cpp,**/*.h,**/*.hpp,**/*.cc,"
    "**/*.mm,**/*.m,"
    "**/*.swift,"
    "**/*.py,"
    "**/*.md",
)

EXCLUDE_PATTERNS: list[str] = _parse_csv_env(
    "EXCLUDE_PATTERNS",
    "**/node_modules/**,**/vendor/**,**/.git/**,"
    "**/build/**,**/Pods/**,**/.venv/**,"
    "**/dist/**,**/__pycache__/**",
)

EMBEDDING_MODEL: str = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text")

# Freshness scan interval in seconds
FRESHNESS_INTERVAL: float = float(os.environ.get("FRESHNESS_INTERVAL", "30"))


def resolve_source_files() -> list[Path]:
    """Resolve SOURCE_GLOBS against PROJECT_ROOT, excluding EXCLUDE_PATTERNS."""
    import fnmatch

    all_files: set[Path] = set()
    for glob_pattern in SOURCE_GLOBS:
        for p in PROJECT_ROOT.glob(glob_pattern):
            if p.is_file():
                all_files.add(p)

    # Filter out excluded paths
    filtered: list[Path] = []
    for f in sorted(all_files):
        rel = str(f.relative_to(PROJECT_ROOT))
        excluded = any(fnmatch.fnmatch(rel, pat) for pat in EXCLUDE_PATTERNS)
        if not excluded:
            filtered.append(f)

    return filtered


def detect_language(file_path: Path) -> str:
    """Map file extension to language identifier."""
    ext = file_path.suffix.lower()
    mapping = {
        ".ts": "typescript",
        ".tsx": "tsx",
        ".js": "javascript",
        ".jsx": "jsx",
        ".cpp": "cpp",
        ".cc": "cpp",
        ".h": "cpp",  # Treat .h as C++ by default
        ".hpp": "cpp",
        ".mm": "objcpp",
        ".m": "objc",
        ".swift": "swift",
        ".py": "python",
        ".md": "markdown",
    }
    return mapping.get(ext, "unknown")
