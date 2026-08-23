"""Explicit integration suite: real Chroma persistence with deterministic embeddings.

Run inside the project image; this file is intentionally excluded from the fast
fake-backed unittest discovery process.
"""

from __future__ import annotations

import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class DeterministicProvider:
    max_input_tokens = 256

    def __init__(self, _model_name: str) -> None:
        pass

    @staticmethod
    def _tokens(text: str) -> list[str]:
        return [token.strip(".,:;!?()[]{}\"'").lower() for token in text.split() if token.strip()]

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            vector = [0.0] * 256
            for token in self._tokens(text):
                slot = int.from_bytes(hashlib.sha256(token.encode("utf-8")).digest()[:2], "big") % len(vector)
                vector[slot] += 1.0
            magnitude = sum(value * value for value in vector) ** 0.5 or 1.0
            vectors.append([value / magnitude for value in vector])
        return vectors

    def token_count(self, text: str) -> int:
        return len(self._tokens(text)) + 2

    def truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        return " ".join(text.split()[:max_tokens])

    def split_to_token_windows(self, text: str, max_tokens: int) -> list[str]:
        words = text.split()
        return [" ".join(words[start : start + max_tokens]) for start in range(0, len(words), max_tokens)]


def note(note_id: str, title: str, terms: str, status: str = "active") -> str:
    return f"""---
id: {note_id}
kind: reference
scope: integration-test
last_verified: 2026-07-18
status: {status}
applies_to: [{note_id}]
---
# {title}
## Use this when
{terms}
## Summary
{terms} owner contract and durable behavior.
## Key facts
- {terms}
## Evidence
- generated: deterministic integration fixture
## Retrieval hints
{terms}
"""


class RealChromaIntegrationTests(unittest.TestCase):
    @staticmethod
    def settings(root: Path, wiki: Path) -> SimpleNamespace:
        return SimpleNamespace(
            wiki_root=wiki,
            repository_root=root,
            kb_root=root / "kb",
            embedding_model="deterministic",
            chunk_tokens=40,
            top_k=3,
            min_relevance=0.35,
            merge_adjacent_window=0,
            staleness_days=90,
            evidence_max_anchors=12,
            watch_interval_seconds=0,
            startup_reindex_timeout_seconds=10,
            health_path="/health",
            mcp_path="/mcp/",
        )

    def test_index_search_mutation_filtering_and_conflicts(self) -> None:
        from kb_service.indexer import KnowledgeIndex

        with tempfile.TemporaryDirectory(prefix="kb-real-integration-") as temp:
            root = Path(temp)
            wiki = root / "wiki"
            wiki.mkdir()
            (wiki / "alpha.md").write_text(
                note("alpha", "Alpha owner", "alpha quartz lifecycle"), encoding="utf-8"
            )
            (wiki / "retired.md").write_text(
                note("retired", "Retired owner", "retired zephyr behavior", "deprecated"),
                encoding="utf-8",
            )
            settings = self.settings(root, wiki)

            with patch("kb_service.indexer.OnnxMiniLmProvider", DeterministicProvider):
                index = KnowledgeIndex(settings)
                first = index.reindex()
                self.assertEqual(first["changed"], 2)
                unchanged_started = time.perf_counter()
                unchanged = index.reindex()
                self.assertEqual(unchanged["changed"], 0)
                self.assertLess(time.perf_counter() - unchanged_started, 2.0)
                self.assertEqual(set(index.list_docs()), {"alpha.md", "retired.md"})
                search_started = time.perf_counter()
                self.assertEqual(index.search("alpha quartz lifecycle", top_k=1)[0].source_file, "alpha.md")
                self.assertLess(time.perf_counter() - search_started, 1.0)
                self.assertEqual(index.search("retired zephyr behavior"), [])
                self.assertEqual(
                    index.search("retired zephyr behavior", include_inactive=True)[0].source_file,
                    "retired.md",
                )
                self.assertEqual(index.search("unrelated security custody telephone"), [])

                current = index.read_doc("alpha.md")
                conflict = index.write_doc("alpha.md", "stale", "wrong-hash")
                self.assertEqual(conflict["reason"], "hash_mismatch")
                updated_text = note("alpha", "Alpha owner", "alpha quartz revised lifecycle")
                updated = index.write_doc("alpha.md", updated_text, current["content_hash"])
                self.assertEqual(updated["status"], "ok")
                changed = index.reindex()
                self.assertEqual(changed["changed"], 1)
                self.assertEqual(index.search("alpha revised lifecycle", top_k=1)[0].source_file, "alpha.md")

                retired = index.read_doc("retired.md")
                self.assertEqual(index.delete_doc("retired.md", retired["content_hash"])["status"], "ok")
                removed = index.reindex()
                self.assertEqual(removed["removed"], 1)
                self.assertEqual(index.list_docs(), ["alpha.md"])

    def test_real_fastapi_lifespan_health_and_fastmcp_mount(self) -> None:
        from fastapi.testclient import TestClient
        from kb_service.app import create_app
        from kb_service.settings import Settings

        with tempfile.TemporaryDirectory(prefix="kb-real-app-") as temp:
            root = Path(temp)
            wiki = root / "wiki"
            wiki.mkdir()
            (wiki / "owner.md").write_text(
                note("owner", "Owner", "fastapi fastmcp transport lifecycle"), encoding="utf-8"
            )
            settings = self.settings(root, wiki)
            with (
                patch("kb_service.indexer.OnnxMiniLmProvider", DeterministicProvider),
                patch.object(Settings, "load", return_value=settings),
                TestClient(create_app()) as client,
            ):
                health = client.get("/health")
                self.assertEqual(health.status_code, 200)
                self.assertEqual(health.json()["status"], "ok")
                version = client.get("/version").json()
                self.assertEqual(version["index_schema_version"], 7)
                self.assertEqual(version["mcp_tool_contract_version"], 5)
                self.assertTrue(any(route.path.startswith("/mcp") for route in client.app.routes))


if __name__ == "__main__":
    unittest.main(verbosity=2)
