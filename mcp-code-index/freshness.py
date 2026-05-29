"""Freshness tracking: detect changed/new/deleted files and trigger re-indexing.

Strategy: mtime polling. Cheap enough for <1000 files.
- On startup: full scan, re-index all stale files.
- Background thread: full scan every FRESHNESS_INTERVAL seconds.
- On-demand: call scan() from server tools.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class ScanResult:
    files_checked: int = 0
    files_reindexed: int = 0
    files_added: int = 0
    files_removed: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class FreshnessManager:
    def __init__(
        self,
        project_root: Path,
        resolve_files_fn: Callable[[], list[Path]],
        index_file_fn: Callable[[Path], int],
        remove_file_fn: Callable[[str], None],
        get_indexed_fn: Callable[[], dict[str, float]],
        interval_seconds: float = 30.0,
    ) -> None:
        self._project_root = project_root
        self._resolve_files = resolve_files_fn
        self._index_file = index_file_fn
        self._remove_file = remove_file_fn
        self._get_indexed = get_indexed_fn
        self._interval = interval_seconds
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def scan(self, verbose: bool = False) -> ScanResult:
        """Perform a full mtime scan and re-index stale/new files."""
        t0 = time.time()
        result = ScanResult()

        with self._lock:
            source_files = self._resolve_files()
            indexed = self._get_indexed()  # {rel_path: mtime}

            source_rel: dict[str, Path] = {
                str(f.relative_to(self._project_root)): f
                for f in source_files
            }

            result.files_checked = len(source_rel)

            # New or modified files
            for rel_path, abs_path in source_rel.items():
                try:
                    current_mtime = os.path.getmtime(abs_path)
                    stored_mtime = indexed.get(rel_path)
                    if stored_mtime is None:
                        # New file
                        self._index_file(abs_path)
                        result.files_added += 1
                        if verbose:
                            print(f"  + indexed (new):     {rel_path}")
                    elif abs(current_mtime - stored_mtime) > 0.01:
                        # Modified file
                        self._index_file(abs_path)
                        result.files_reindexed += 1
                        if verbose:
                            print(f"  ~ re-indexed:        {rel_path}")
                except Exception as e:
                    result.errors.append(f"{rel_path}: {e}")

            # Deleted files (in index but no longer on disk)
            for rel_path in list(indexed.keys()):
                if rel_path not in source_rel:
                    self._remove_file(rel_path)
                    result.files_removed += 1
                    if verbose:
                        print(f"  - removed (deleted): {rel_path}")

        result.duration_ms = round((time.time() - t0) * 1000, 1)
        return result

    def start_background(self) -> None:
        """Start background thread that scans every interval_seconds."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._background_loop, daemon=True)
        self._thread.start()

    def stop_background(self) -> None:
        self._stop_event.set()

    def _background_loop(self) -> None:
        while not self._stop_event.wait(timeout=self._interval):
            try:
                self.scan()
            except Exception as e:
                print(f"[freshness] background scan error: {e}")
