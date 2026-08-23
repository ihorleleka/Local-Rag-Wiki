from __future__ import annotations

import os

from chromadb.utils import embedding_functions
from tokenizers import Tokenizer


class OnnxMiniLmProvider:
    """`all-MiniLM-L6-v2` embeddings via ONNX Runtime.

    ChromaDB already ships ONNX Runtime and the quantized MiniLM weights, so this
    provider reuses them instead of pulling the PyTorch/transformers stack. A
    second, untruncated tokenizer instance backs token counting and windowing;
    the embedding function itself pads/truncates to the model window internally.
    """

    def __init__(self, model_name: str | None = None) -> None:
        # ONNX MiniLM is the only bundled local model; the setting is kept for
        # health reporting but does not select a different model here.
        del model_name
        self._embedding_function = embedding_functions.ONNXMiniLM_L6_V2()
        self._embedding_function._download_model_if_not_exists()
        tokenizer_path = os.path.join(
            self._embedding_function.DOWNLOAD_PATH,
            self._embedding_function.EXTRACTED_FOLDER_NAME,
            "tokenizer.json",
        )
        self._tokenizer = Tokenizer.from_file(tokenizer_path)
        self._tokenizer.no_truncation()
        self._tokenizer.no_padding()
        self._max_tokens = int(self._embedding_function.max_tokens())

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self._embedding_function(list(texts))
        return [[float(value) for value in vector] for vector in vectors]

    @property
    def max_input_tokens(self) -> int:
        return self._max_tokens

    def token_count(self, text: str) -> int:
        return len(self._tokenizer.encode(text, add_special_tokens=True).ids)

    def truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        if max_tokens <= 0:
            return ""
        token_ids = self._tokenizer.encode(text, add_special_tokens=False).ids[:max_tokens]
        return self._tokenizer.decode(token_ids, skip_special_tokens=True).strip()

    def split_to_token_windows(self, text: str, max_tokens: int) -> list[str]:
        if max_tokens <= 0:
            return []
        token_ids = self._tokenizer.encode(text, add_special_tokens=False).ids
        return [
            self._tokenizer.decode(token_ids[start : start + max_tokens], skip_special_tokens=True).strip()
            for start in range(0, len(token_ids), max_tokens)
            if token_ids[start : start + max_tokens]
        ]

