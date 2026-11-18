"""Build the knowledge index in the background so the MCP endpoint can bind first.

Opening the persisted Chroma store, probing it for corruption and loading the
embedding model all happen before the first query can run, and their cost grows
with the index. None of it is needed to *list* the MCP tools or accept a
connection, so the service builds the index on a worker thread and lets every
consumer wait for it. Sync MCP tools already run on worker threads and async
tools call the index through ``asyncio.to_thread``, so blocking inside attribute
access never stalls the event loop. Code that runs on the loop itself must
``await wait_ready()`` first.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Callable

LOGGER = logging.getLogger(__name__)
# Generous on purpose: a timed-out wait makes the startup reindex fail, and the
# service does not retry it. The probe alone is bounded at 30s.
DEFAULT_WAIT_SECONDS = 300.0


class IndexUnavailableError(RuntimeError):
    """The knowledge index failed to build or is still building."""


class DeferredKnowledgeIndex:
    """Stand-in for ``KnowledgeIndex`` that is built lazily on a worker thread."""

    def __init__(self, factory: Callable[[], Any], *, wait_seconds: float = DEFAULT_WAIT_SECONDS) -> None:
        self._factory = factory
        self._wait_seconds = wait_seconds
        self._start_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._done = threading.Event()
        self._index: Any = None
        self._error: BaseException | None = None

    def start(self) -> None:
        """Begin building; safe to call repeatedly and from any thread."""
        with self._start_lock:
            if self._thread is not None:
                return
            # Daemon: a build stuck in native code must not block shutdown.
            self._thread = threading.Thread(target=self._build, name="kb-index-build", daemon=True)
            self._thread.start()

    def _build(self) -> None:
        try:
            self._index = self._factory()
        except BaseException as error:  # noqa: BLE001 - reported to every waiter
            self._error = error
            LOGGER.exception("Knowledge index failed to build")
        finally:
            self._done.set()

    @property
    def is_ready(self) -> bool:
        return self._done.is_set() and self._error is None

    def _resolve(self) -> Any:
        self.start()
        if not self._done.wait(self._wait_seconds):
            raise IndexUnavailableError(
                f"The knowledge index is still starting after {self._wait_seconds:.0f}s; retry shortly."
            )
        if self._error is not None:
            raise IndexUnavailableError(
                f"The knowledge index failed to start: {self._error}"
            ) from self._error
        return self._index

    async def wait_ready(self) -> None:
        """Wait without blocking the event loop; raises if the build failed."""
        self.start()
        await asyncio.to_thread(self._resolve)

    def __getattr__(self, name: str) -> Any:
        # Called only for names not found normally. Never forward private or
        # dunder lookups: copy/pickle probes would otherwise trigger a build.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)
