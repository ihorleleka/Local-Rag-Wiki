"""Optional ONNX cross-encoder reranker for high-precision top-N reordering.

Dense + lexical fusion produces a strong candidate set, but a cross-encoder that
reads the (query, note) pair jointly is far more precise at ordering the final
few results. This reuses the ONNX Runtime already shipped with the image (via
ChromaDB) and the ``tokenizers`` dependency, so it adds no external service and
no query-time network calls.

The reranker is opt-in: it activates only when ``KB_RERANKER`` is enabled and a
model directory (``model.onnx`` + ``tokenizer.json``) is available. Any load or
inference failure degrades gracefully to fusion-only ordering.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

LOGGER = logging.getLogger(__name__)

_MAX_PAIR_TOKENS = 512


class Reranker(Protocol):
    def score(self, query: str, texts: list[str]) -> list[float]:
        ...


class OnnxCrossEncoderReranker:
    """Sequence-classification cross-encoder (e.g. ms-marco-MiniLM) over ONNX."""

    def __init__(self, model_dir: str) -> None:
        import onnxruntime  # Imported lazily; only needed when reranking is on.
        from tokenizers import Tokenizer

        directory = Path(model_dir)
        model_file = directory / "model.onnx"
        tokenizer_file = directory / "tokenizer.json"
        if not model_file.is_file() or not tokenizer_file.is_file():
            raise FileNotFoundError(
                f"reranker model requires model.onnx and tokenizer.json in {directory}"
            )
        self._tokenizer = Tokenizer.from_file(str(tokenizer_file))
        self._tokenizer.enable_truncation(max_length=_MAX_PAIR_TOKENS)
        self._session = onnxruntime.InferenceSession(
            str(model_file),
            providers=["CPUExecutionProvider"],
        )
        self._input_names = {item.name for item in self._session.get_inputs()}

    def score(self, query: str, texts: list[str]) -> list[float]:
        if not texts:
            return []
        import numpy as np

        encodings = self._tokenizer.encode_batch([(query, text) for text in texts])
        max_len = max(len(encoding.ids) for encoding in encodings)
        input_ids = np.zeros((len(encodings), max_len), dtype=np.int64)
        attention = np.zeros((len(encodings), max_len), dtype=np.int64)
        token_types = np.zeros((len(encodings), max_len), dtype=np.int64)
        for row, encoding in enumerate(encodings):
            length = len(encoding.ids)
            input_ids[row, :length] = encoding.ids
            attention[row, :length] = encoding.attention_mask
            token_types[row, :length] = encoding.type_ids

        feeds = {"input_ids": input_ids, "attention_mask": attention}
        if "token_type_ids" in self._input_names:
            feeds["token_type_ids"] = token_types
        feeds = {name: value for name, value in feeds.items() if name in self._input_names}

        logits = self._session.run(None, feeds)[0]
        flattened = np.asarray(logits).reshape(len(texts), -1)
        # Binary/relevance cross-encoders emit a single logit; multi-class models
        # (e.g. NLI-derived) put the relevant class last.
        column = 0 if flattened.shape[1] == 1 else flattened.shape[1] - 1
        return [float(value) for value in flattened[:, column]]


def load_reranker(settings) -> Reranker | None:
    """Build the cross-encoder reranker, or return None when unavailable."""
    if not bool(getattr(settings, "reranker_enabled", False)):
        return None
    model_path = str(getattr(settings, "reranker_model_path", "") or "").strip()
    if not model_path:
        LOGGER.warning(
            "KB_RERANKER is enabled but KB_RERANKER_MODEL_PATH is unset; "
            "continuing without cross-encoder reranking."
        )
        return None
    try:
        reranker = OnnxCrossEncoderReranker(model_path)
        LOGGER.info("Cross-encoder reranker loaded from %s", model_path)
        return reranker
    except Exception:
        LOGGER.warning(
            "Failed to load cross-encoder reranker from %s; "
            "continuing without reranking.",
            model_path,
            exc_info=True,
        )
        return None
