from __future__ import annotations

import os
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.settings import Settings


@contextmanager
def temporary_env(**updates: str | None) -> None:
    original: dict[str, str | None] = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


class SettingsTests(unittest.TestCase):
    def test_load_normalizes_paths_and_applies_defaults(self) -> None:
        with TemporaryDirectory() as tmpdir, temporary_env(
            KB_WIKI_ROOT=str(Path(tmpdir) / "wiki"),
            KB_ROOT=str(Path(tmpdir) / "kb"),
            KB_MCP_PATH="mcp",
            KB_HEALTH_PATH="health",
            KB_PORT="7331",
            KB_REPOSITORY_ROOT=None,
        ):
            settings = Settings.load()

        self.assertTrue(str(settings.wiki_root).endswith("wiki"))
        self.assertEqual(settings.repository_root, settings.wiki_root.parent)
        self.assertTrue(str(settings.kb_root).endswith("kb"))
        self.assertEqual(settings.mcp_path, "/mcp/")
        self.assertEqual(settings.health_path, "health")
        self.assertEqual(settings.host, "0.0.0.0")
        self.assertEqual(settings.port, 7331)
        self.assertEqual(settings.staleness_days, 90)
        self.assertEqual(settings.chunk_tokens, 220)
        self.assertEqual(settings.min_relevance, 0.35)
        self.assertEqual(settings.max_top_k, 20)
        self.assertEqual(settings.embedding_batch_size, 64)
        self.assertEqual(settings.note_max_lines, 200)
        self.assertEqual(settings.evidence_max_anchors, 12)
        self.assertEqual(settings.startup_reindex_timeout_seconds, 3)
        self.assertTrue(settings.hybrid_search)
        self.assertEqual(settings.lexical_candidates, 50)
        self.assertEqual(settings.rrf_k, 60)
        self.assertEqual(settings.dense_weight, 1.0)
        self.assertEqual(settings.lexical_weight, 1.0)
        self.assertEqual(settings.lexical_min_score, 0.35)
        self.assertEqual(settings.evidence_changed_penalty, 0.05)
        self.assertFalse(settings.reranker_enabled)
        self.assertEqual(settings.reranker_model_path, "")
        self.assertEqual(settings.reranker_top_n, 20)

    def test_hybrid_and_reranker_env_overrides(self) -> None:
        with TemporaryDirectory() as tmpdir, temporary_env(
            KB_WIKI_ROOT=str(Path(tmpdir) / "wiki"),
            KB_HYBRID_SEARCH="0",
            KB_RRF_K="40",
            KB_LEXICAL_MIN_SCORE="0.5",
            KB_RERANKER="on",
            KB_RERANKER_MODEL_PATH="/opt/reranker",
            KB_RERANKER_TOP_N="12",
        ):
            settings = Settings.load()

        self.assertFalse(settings.hybrid_search)
        self.assertEqual(settings.rrf_k, 40)
        self.assertEqual(settings.lexical_min_score, 0.5)
        self.assertTrue(settings.reranker_enabled)
        self.assertEqual(settings.reranker_model_path, "/opt/reranker")
        self.assertEqual(settings.reranker_top_n, 12)


if __name__ == "__main__":
    unittest.main()
