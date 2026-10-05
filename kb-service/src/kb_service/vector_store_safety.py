"""Startup isolation and recovery for persisted Chroma vector storage."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

LOGGER = logging.getLogger(__name__)
_PROBE_ARGUMENT = "--probe-vector-store"
_PROBE_TIMEOUT_SECONDS = 30
_VECTOR_DIMENSIONS = 384  # all-MiniLM-L6-v2, the sole supported embedding model


def _has_collection(client, name: str) -> bool:
    collections = client.list_collections()
    return any(getattr(item, "name", item) == name for item in collections)


def probe_vector_store(settings) -> None:
    """Open and query the persisted HNSW index in an isolated process."""
    import chromadb

    chroma_root = Path(settings.kb_root) / "chroma"
    if not chroma_root.exists():
        return
    client = chromadb.PersistentClient(path=str(chroma_root))
    if not _has_collection(client, "wiki_chunks"):
        return
    collection = client.get_collection("wiki_chunks")
    # ``get`` only consults SQLite. A one-vector query forces Chroma's native
    # HNSW reader to open the persisted segment where corrupt metadata can crash.
    if collection.count() > 0:
        collection.query(
            query_embeddings=[[0.0] * _VECTOR_DIMENSIONS],
            n_results=1,
            include=["metadatas"],
        )


def _quarantine(path: Path, suffix: str) -> Path | None:
    if not path.exists():
        return None
    target = path.with_name(f"{path.name}.corrupt-{suffix}")
    path.replace(target)
    return target


def quarantine_vector_store(settings) -> list[Path]:
    """Preserve corrupted derived data, then let normal startup rebuild it."""
    root = Path(settings.kb_root)
    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    quarantined = [
        _quarantine(root / "chroma", suffix),
        _quarantine(root / "manifest.json", suffix),
    ]
    return [path for path in quarantined if path is not None]


def ensure_vector_store_is_safe(settings) -> None:
    """Probe Chroma outside the service process and self-heal a bad index.

    A native HNSW crash cannot be caught by Python in the serving process. The
    probe is deliberately a separate Python process; any nonzero exit leaves the
    parent alive to quarantine only derived index data and start a full rebuild.
    """
    chroma_root = Path(settings.kb_root) / "chroma"
    if not chroma_root.exists():
        return
    command = [sys.executable, "-m", "kb_service", _PROBE_ARGUMENT]
    try:
        result = subprocess.run(
            command,
            env={**os.environ, "KB_VECTOR_STORE_PROBE": "1"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        LOGGER.warning("Chroma startup probe failed; quarantining derived index: %s", error)
    else:
        if result.returncode == 0:
            return
        LOGGER.warning(
            "Chroma startup probe exited with %s; quarantining derived index: %s",
            result.returncode,
            (result.stderr or "").strip()[-1000:],
        )
    quarantined = quarantine_vector_store(settings)
    LOGGER.warning("Quarantined corrupt Chroma data: %s", ", ".join(map(str, quarantined)))
