"""Writes that survive the program being killed or the power going: training data is never left half written.

atomic_write: the whole new content goes to a temp file beside it, is flushed to disk, then renamed over the old one (a rename is all-or-nothing), so a reader after a crash
sees the old file or the new one, never a torn one. append_line: one line appended and flushed to disk before returning, so a line that was reported saved is saved.
"""
from __future__ import annotations

import os
from pathlib import Path


def _sync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path.parent), os.O_RDONLY)
    except OSError:
        return  # (Windows cannot open a directory: the rename is still atomic there)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write(path: Path, text: str) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _sync_dir(path)


def append_line(path: Path, line: str) -> None:
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(line if line.endswith("\n") else line + "\n")
        f.flush()
        os.fsync(f.fileno())
