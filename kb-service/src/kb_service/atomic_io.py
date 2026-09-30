from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path


def atomic_write_text(target: Path, content: str) -> None:
    """Durably stage UTF-8 text beside its target, then replace it atomically."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        # Concurrent atomic replacements can briefly collide on Windows while
        # the previous handle closes. Retry the filesystem primitive, never a
        # higher-level lock or request queue.
        for attempt in range(3):
            try:
                os.replace(temporary_path, target)
                temporary_path = None
                break
            except PermissionError:
                if attempt == 2:
                    raise
                time.sleep(0.001)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
