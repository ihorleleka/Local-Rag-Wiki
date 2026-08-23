"""Dependency-free in-process lexical retrieval (BM25) for hybrid search.

Dense embeddings miss exact identifiers, error codes, config keys, and acronyms
because those tokens carry little distributional signal. A cheap Okapi BM25 pass
over the same indexed documents recovers them. The index is rebuilt from the
ChromaDB collection contents, so it needs no separate persistence and stays in
lockstep with the vector store.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*")
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")

# Common English/tooling words carry little retrieval signal and would let a
# negative query spuriously match on shared filler. Kept intentionally small.
STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do",
        "does", "for", "from", "how", "i", "if", "in", "into", "is", "it", "its",
        "of", "on", "or", "our", "should", "so", "that", "the", "their", "then",
        "there", "these", "this", "to", "use", "used", "using", "was", "we",
        "what", "when", "where", "which", "who", "why", "will", "with", "you",
        "your",
    }
)

BM25_K1 = 1.5
BM25_B = 0.75

_IDENTIFIER_MARKERS = ("_", ".", "-")


def is_identifier_like(term: str) -> bool:
    """True for tokens that look like code identifiers, codes, or config keys.

    These are exactly the tokens dense retrieval tends to miss and lexical search
    must recover (``e11000``, ``wiki_search``, ``app.py``, ``404``). Plain English
    words are excluded so a single shared common word cannot admit a spurious
    lexical-only match for an otherwise-negative query.
    """
    if not term:
        return False
    if any(char.isdigit() for char in term):
        return True
    return any(marker in term for marker in _IDENTIFIER_MARKERS)


def lexical_terms(text: str) -> list[str]:
    """Tokenize text into lexical terms.

    Emits both the whole identifier (``wiki_search``) and its camel/snake
    subtokens (``wiki``, ``search``) so exact-identifier queries and their word
    parts both match. Stopwords and single characters are dropped, but numeric
    tokens (error codes such as ``404``) are preserved.
    """
    terms: list[str] = []
    for match in _TOKEN_PATTERN.finditer(text or ""):
        raw = match.group(0)
        pieces = {raw}
        for part in re.split(r"[._-]", raw):
            if part:
                pieces.add(part)
                for camel in _CAMEL_BOUNDARY.split(part):
                    if camel:
                        pieces.add(camel)
        for piece in pieces:
            token = piece.lower()
            if token in STOPWORDS:
                continue
            if len(token) < 2 and not token.isdigit():
                continue
            terms.append(token)
    return terms


@dataclass
class BM25Index:
    """Minimal Okapi BM25 over a fixed set of documents."""

    ids: list[str] = field(default_factory=list)
    _doc_terms: list[Counter] = field(default_factory=list)
    _doc_len: list[int] = field(default_factory=list)
    _df: Counter = field(default_factory=Counter)
    _avg_len: float = 0.0

    @classmethod
    def build(cls, documents: list[tuple[str, str]]) -> "BM25Index":
        index = cls()
        total_len = 0
        for doc_id, text in documents:
            terms = lexical_terms(text)
            counts = Counter(terms)
            index.ids.append(doc_id)
            index._doc_terms.append(counts)
            index._doc_len.append(len(terms))
            total_len += len(terms)
            for term in counts:
                index._df[term] += 1
        count = len(index.ids)
        index._avg_len = (total_len / count) if count else 0.0
        return index

    def __len__(self) -> int:
        return len(self.ids)

    def _idf(self, term: str) -> float:
        df = self._df.get(term, 0)
        if df == 0:
            return 0.0
        total = len(self.ids)
        # Standard BM25 idf with the +1 shift that keeps values non-negative.
        return math.log(1.0 + (total - df + 0.5) / (df + 0.5))

    def search(
        self, query: str, limit: int, max_df_ratio: float = 0.5
    ) -> list[tuple[str, float, list[str]]]:
        """Return ``(id, normalized_score, matched_terms)`` for the best matches.

        Query terms present in more than ``max_df_ratio`` of the corpus are
        dropped as non-discriminative, so a shared common word cannot manufacture
        a spurious match for an otherwise-negative query. Scores are min-max
        normalized against the best hit so the top document maps to ``1.0``,
        keeping them comparable to the cosine relevance scale used by dense
        retrieval and the ``min_relevance`` gate. ``matched_terms`` lets callers
        apply an admission rule (e.g. require an identifier-like term).
        """
        total = len(self.ids)
        if not total:
            return []
        max_df = max(1, int(max_df_ratio * total))
        query_terms = [
            term
            for term in set(lexical_terms(query))
            if 0 < self._df.get(term, 0) <= max_df
        ]
        if not query_terms:
            return []
        idf = {term: self._idf(term) for term in query_terms}
        scored: list[tuple[str, float, list[str]]] = []
        for position, doc_id in enumerate(self.ids):
            counts = self._doc_terms[position]
            length = self._doc_len[position]
            score = 0.0
            matched: list[str] = []
            for term in query_terms:
                tf = counts.get(term, 0)
                if not tf:
                    continue
                matched.append(term)
                denom = tf + BM25_K1 * (
                    1.0 - BM25_B + BM25_B * (length / self._avg_len if self._avg_len else 0.0)
                )
                score += idf[term] * (tf * (BM25_K1 + 1.0)) / denom if denom else 0.0
            if score > 0.0:
                scored.append((doc_id, score, matched))
        if not scored:
            return []
        scored.sort(key=lambda item: (-item[1], item[0]))
        best = scored[0][1]
        normalized = [
            (doc_id, (raw / best) if best > 0 else 0.0, matched)
            for doc_id, raw, matched in scored[: max(1, limit)]
        ]
        return normalized
