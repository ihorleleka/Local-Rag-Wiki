from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class StatefulCollection:
    """In-memory Chroma stand-in that stores adds and serves get()/query()."""

    def __init__(self) -> None:
        self.records: dict[str, dict] = {}
        self.dense_ids: list[str] = []
        self.dense_distance = 0.2

    def add(self, ids, embeddings=None, documents=None, metadatas=None):
        for position, doc_id in enumerate(ids):
            self.records[doc_id] = {
                "document": documents[position],
                "metadata": metadatas[position],
            }

    def delete(self, ids=None, **kwargs):
        for doc_id in ids or []:
            self.records.pop(doc_id, None)

    def get(self, ids=None, include=None):
        selected = list(self.records) if ids is None else list(ids)
        got_ids, docs, metas = [], [], []
        for doc_id in selected:
            record = self.records.get(doc_id)
            if record is None:
                continue
            got_ids.append(doc_id)
            docs.append(record["document"])
            metas.append(record["metadata"])
        return {"ids": got_ids, "documents": docs, "metadatas": metas}

    def query(self, query_embeddings=None, n_results=None, include=None):
        limit = n_results or len(self.dense_ids)
        ids = [doc_id for doc_id in self.dense_ids if doc_id in self.records][:limit]
        docs = [self.records[doc_id]["document"] for doc_id in ids]
        metas = [self.records[doc_id]["metadata"] for doc_id in ids]
        distances = [self.dense_distance for _ in ids]
        return {
            "ids": [ids],
            "documents": [docs],
            "metadatas": [metas],
            "distances": [distances],
        }


class StatefulClient:
    shared = StatefulCollection()

    def __init__(self, path):
        self.path = path

    def get_or_create_collection(self, *args, **kwargs):
        return StatefulClient.shared


class DummyProvider:
    def __init__(self, model):
        self.model = model

    def embed(self, texts):
        return [[0.0] for _ in texts]

    @property
    def max_input_tokens(self):
        return 256

    def token_count(self, text):
        return len(text.split()) + 2

    def truncate_to_tokens(self, text, max_tokens):
        return " ".join(text.split()[:max_tokens])

    def split_to_token_windows(self, text, max_tokens):
        words = text.split()
        return [" ".join(words[start : start + max_tokens]) for start in range(0, len(words), max_tokens)]


def install_fakes():
    chromadb_module = types.ModuleType("chromadb")
    chromadb_module.PersistentClient = StatefulClient
    sys.modules["chromadb"] = chromadb_module

    real_frontmatter = importlib.import_module("frontmatter") if _has_frontmatter() else None
    if real_frontmatter is None:
        frontmatter_module = types.ModuleType("frontmatter")
        frontmatter_module.loads = lambda raw: types.SimpleNamespace(content=raw, metadata={})
        sys.modules["frontmatter"] = frontmatter_module

    embeddings_module = types.ModuleType("kb_service.embeddings")
    embeddings_module.OnnxMiniLmProvider = DummyProvider
    sys.modules["kb_service.embeddings"] = embeddings_module


def _has_frontmatter() -> bool:
    try:
        import frontmatter  # noqa: F401

        return True
    except Exception:
        return False


AUTH_NOTE = """# Authentication

## Use this when
Signing users in.

## Summary
Login sessions rely on rotating refresh tokens.

## Key facts
- Tokens expire hourly.

## Evidence
- src/auth.py

## Retrieval hints
- login
"""

MONGO_NOTE = """# Mongo writes

## Use this when
Handling duplicate key failures.

## Summary
Mongo raises E11000 on duplicate key violations during upsert.

## Key facts
- E11000 duplicate key error means a unique index conflict.

## Evidence
- src/mongo.py

## Retrieval hints
- duplicate key
"""


class StubReranker:
    def __init__(self, order: list[str]) -> None:
        self.order = order
        self.calls: list[tuple[str, list[str]]] = []

    def score(self, query, texts):
        self.calls.append((query, list(texts)))
        # Higher score for texts whose source appears earlier in ``order``.
        scores = []
        for text in texts:
            rank = next(
                (len(self.order) - i for i, name in enumerate(self.order) if name in text),
                0,
            )
            scores.append(float(rank))
        return scores


class HybridSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        StatefulClient.shared = StatefulCollection()
        sys.modules.pop("kb_service.indexer", None)
        self.indexer_module = importlib.import_module("kb_service.indexer")

    def _settings(self, root: Path, **overrides):
        wiki_root = root / "wiki"
        base = dict(
            wiki_root=wiki_root,
            repository_root=root,
            kb_root=root / "kb",
            embedding_model="dummy",
            staleness_days=90,
            top_k=8,
            max_top_k=20,
            min_relevance=0.35,
            merge_adjacent_window=0,
            evidence_max_anchors=12,
            note_max_lines=200,
            chunk_tokens=220,
            embedding_batch_size=64,
            hybrid_search=True,
            lexical_candidates=50,
            rrf_k=60,
            dense_weight=1.0,
            lexical_weight=1.0,
            lexical_min_score=0.35,
            evidence_changed_penalty=0.05,
            reranker_enabled=False,
            reranker_model_path="",
            reranker_top_n=20,
        )
        base.update(overrides)
        return types.SimpleNamespace(**base)

    def _build_index(self, root: Path, **overrides):
        wiki_root = root / "wiki"
        wiki_root.mkdir(parents=True, exist_ok=True)
        (wiki_root / "auth.md").write_text(AUTH_NOTE, encoding="utf-8")
        (wiki_root / "mongo.md").write_text(MONGO_NOTE, encoding="utf-8")
        settings = self._settings(root, **overrides)
        index = self.indexer_module.KnowledgeIndex(settings)
        index.reindex()
        # Dense retrieval only surfaces the auth packet, simulating a dense miss
        # of the identifier-heavy mongo note.
        index.collection.dense_ids = ["auth.md::packet::0"]
        return index

    def test_lexical_pass_recovers_identifier_dense_missed(self) -> None:
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp))
            results = index.search("E11000 duplicate key")
            sources = {result.source_file for result in results}
            self.assertIn("mongo.md", sources)
            self.assertIn("auth.md", sources)

    def test_dense_only_misses_identifier_when_hybrid_disabled(self) -> None:
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp), hybrid_search=False)
            results = index.search("E11000 duplicate key")
            sources = {result.source_file for result in results}
            self.assertNotIn("mongo.md", sources)
            self.assertEqual(sources, {"auth.md"})

    def test_negative_query_stays_a_miss(self) -> None:
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp))
            index.collection.dense_ids = []  # dense finds nothing either
            results = index.search("kubernetes ingress helm chart deployment")
            self.assertEqual(results, [])

    def test_single_common_word_lexical_only_is_rejected(self) -> None:
        # "sessions" is a single, non-identifier common word present in auth.md.
        # With dense retrieval finding nothing, the lexical-only admission rule
        # must reject it so a lone shared word cannot fabricate a match.
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp))
            index.collection.dense_ids = []
            results = index.search("sessions")
            self.assertEqual(results, [])

    def test_evidence_provenance_is_surfaced_in_packet(self) -> None:
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp))
            results = index.search("E11000 duplicate key")
            packets = [r.context_packet for r in results if r.context_packet]
            provenance = [
                entry
                for packet in packets
                for entry in packet.get("evidence_provenance", [])
            ]
            self.assertTrue(provenance)
            targets = {entry["target"] for entry in provenance}
            self.assertTrue(targets & {"src/auth.py", "src/mongo.py"})
            for entry in provenance:
                self.assertIn(entry["state"], {"present", "missing", "modified"})

    def test_reranker_reorders_final_pool(self) -> None:
        with TemporaryDirectory() as tmp:
            index = self._build_index(Path(tmp))
            index.collection.dense_ids = ["auth.md::packet::0"]
            # Force mongo ahead of auth via the stub cross-encoder.
            index.reranker = StubReranker(order=["mongo.md", "auth.md"])
            results = index.search("E11000 duplicate key")
            self.assertTrue(index.reranker.calls)
            self.assertEqual(results[0].source_file, "mongo.md")


if __name__ == "__main__":
    unittest.main()
