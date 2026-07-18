from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class DummyTokenizer:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def encode(self, text, **kwargs):
        self.calls.append({"text": text, **kwargs})
        tokens = list(range(len(text.split())))
        if kwargs.get("add_special_tokens"):
            tokens = [1000, *tokens, 1001]
        max_length = kwargs.get("max_length")
        return tokens[:max_length] if kwargs.get("truncation") and max_length is not None else tokens

    def decode(self, token_ids, **kwargs):
        return " ".join(f"token-{token_id}" for token_id in token_ids)


class DummySentenceTransformer:
    def __init__(self, model_name):
        self.model_name = model_name
        self.max_seq_length = 256
        self.tokenizer = DummyTokenizer()

    def encode(self, texts, normalize_embeddings=False):
        return [types.SimpleNamespace(tolist=lambda: [0.0]) for _ in texts]


class EmbeddingProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        module = types.ModuleType("sentence_transformers")
        module.SentenceTransformer = DummySentenceTransformer
        sys.modules["sentence_transformers"] = module
        sys.modules.pop("kb_service.embeddings", None)
        self.embeddings = importlib.import_module("kb_service.embeddings")

    def test_token_budget_uses_model_tokenizer(self) -> None:
        provider = self.embeddings.LocalSentenceTransformerProvider("dummy")

        self.assertEqual(provider.max_input_tokens, 256)
        self.assertEqual(provider.token_count("one two three"), 5)
        self.assertEqual(provider.truncate_to_tokens("one two three four", 2), "token-0 token-1")
        self.assertTrue(provider._model.tokenizer.calls[0]["add_special_tokens"])
        self.assertEqual(provider._model.tokenizer.calls[1]["max_length"], 2)


if __name__ == "__main__":
    unittest.main()
