from sentence_transformers import SentenceTransformer


class LocalSentenceTransformerProvider:
    def __init__(self, model_name: str) -> None:
        self._model = SentenceTransformer(model_name)

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vectors]

    @property
    def max_input_tokens(self) -> int:
        return int(self._model.max_seq_length)

    def token_count(self, text: str) -> int:
        return len(self._model.tokenizer.encode(text, add_special_tokens=True, verbose=False))

    def truncate_to_tokens(self, text: str, max_tokens: int) -> str:
        if max_tokens <= 0:
            return ""
        token_ids = self._model.tokenizer.encode(
            text,
            add_special_tokens=False,
            truncation=True,
            max_length=max_tokens,
        )
        return self._model.tokenizer.decode(token_ids, skip_special_tokens=True).strip()

    def split_to_token_windows(self, text: str, max_tokens: int) -> list[str]:
        if max_tokens <= 0:
            return []
        token_ids = self._model.tokenizer.encode(
            text,
            add_special_tokens=False,
            verbose=False,
        )
        return [
            self._model.tokenizer.decode(token_ids[start : start + max_tokens], skip_special_tokens=True).strip()
            for start in range(0, len(token_ids), max_tokens)
            if token_ids[start : start + max_tokens]
        ]
