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


class DummyEmbeddingFunction:
    DOWNLOAD_PATH = "/tmp/onnx-model"
    EXTRACTED_FOLDER_NAME = "onnx"

    def __init__(self) -> None:
        self.downloaded = False

    def _download_model_if_not_exists(self) -> None:
        self.downloaded = True

    def max_tokens(self) -> int:
        return 256

    def __call__(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]


class DummyEncoding:
    def __init__(self, ids) -> None:
        self.ids = ids


class DummyTokenizer:
    last_instance: "DummyTokenizer | None" = None

    def __init__(self) -> None:
        self.truncation_disabled = False
        self.padding_disabled = False
        DummyTokenizer.last_instance = self

    @classmethod
    def from_file(cls, path):
        instance = cls()
        instance.path = path
        return instance

    def no_truncation(self) -> None:
        self.truncation_disabled = True

    def no_padding(self) -> None:
        self.padding_disabled = True

    def encode(self, text, add_special_tokens=True):
        ids = list(range(len(text.split())))
        if add_special_tokens:
            ids = [101, *[i + 1 for i in ids], 102]
        return DummyEncoding(ids)

    def decode(self, token_ids, skip_special_tokens=True):
        return " ".join(f"tok{token_id}" for token_id in token_ids)


def install_fakes():
    chromadb_module = types.ModuleType("chromadb")
    utils_module = types.ModuleType("chromadb.utils")
    ef_module = types.ModuleType("chromadb.utils.embedding_functions")
    ef_module.ONNXMiniLM_L6_V2 = DummyEmbeddingFunction
    utils_module.embedding_functions = ef_module
    chromadb_module.utils = utils_module
    sys.modules["chromadb"] = chromadb_module
    sys.modules["chromadb.utils"] = utils_module
    sys.modules["chromadb.utils.embedding_functions"] = ef_module

    tokenizers_module = types.ModuleType("tokenizers")
    tokenizers_module.Tokenizer = DummyTokenizer
    sys.modules["tokenizers"] = tokenizers_module


class EmbeddingProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.embeddings", None)
        self.embeddings = importlib.import_module("kb_service.embeddings")

    def test_provider_uses_onnx_embedding_and_untruncated_tokenizer(self) -> None:
        provider = self.embeddings.OnnxMiniLmProvider("all-MiniLM-L6-v2")

        self.assertEqual(provider.max_input_tokens, 256)
        self.assertEqual(provider.embed(["a", "b"]), [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]])
        self.assertTrue(DummyTokenizer.last_instance.truncation_disabled)
        self.assertTrue(DummyTokenizer.last_instance.padding_disabled)

    def test_token_helpers_use_tokenizer(self) -> None:
        provider = self.embeddings.OnnxMiniLmProvider("all-MiniLM-L6-v2")

        # add_special_tokens=True adds two ids to the three word tokens.
        self.assertEqual(provider.token_count("one two three"), 5)
        self.assertEqual(provider.truncate_to_tokens("one two three four", 2), "tok0 tok1")
        self.assertEqual(
            provider.split_to_token_windows("one two three four five", 2),
            ["tok0 tok1", "tok2 tok3", "tok4"],
        )
        self.assertEqual(provider.truncate_to_tokens("anything", 0), "")
        self.assertEqual(provider.split_to_token_windows("anything", 0), [])


if __name__ == "__main__":
    unittest.main()

