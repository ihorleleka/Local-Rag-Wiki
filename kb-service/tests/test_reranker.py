from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.reranker import load_reranker


def _settings(**overrides):
    base = dict(reranker_enabled=False, reranker_model_path="", reranker_top_n=20)
    base.update(overrides)
    return types.SimpleNamespace(**base)


class LoadRerankerTests(unittest.TestCase):
    def test_disabled_returns_none(self) -> None:
        self.assertIsNone(load_reranker(_settings(reranker_enabled=False)))

    def test_enabled_without_model_path_returns_none(self) -> None:
        self.assertIsNone(load_reranker(_settings(reranker_enabled=True, reranker_model_path="")))

    def test_enabled_with_missing_model_degrades_gracefully(self) -> None:
        # Neither model.onnx nor tokenizer.json exist (and onnxruntime may be
        # absent) so loading must fail closed to None rather than raising.
        self.assertIsNone(
            load_reranker(
                _settings(reranker_enabled=True, reranker_model_path=str(ROOT / "does-not-exist"))
            )
        )


if __name__ == "__main__":
    unittest.main()
