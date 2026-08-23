"""Local deterministic indexing benchmark; intentionally not part of routine CI.

Run from the repository root with:
    python tests/benchmark_indexing.py --output tests/indexing-performance-baseline.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class DeterministicProvider:
    max_input_tokens = 256

    def __init__(self, _model_name: str) -> None:
        pass

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vector = [0.0] * 64
            for token in text.lower().split():
                slot = int.from_bytes(hashlib.sha256(token.encode()).digest()[:2], "big") % 64
                vector[slot] += 1.0
            vectors.append(vector)
        return vectors

    @staticmethod
    def token_count(text: str) -> int:
        return len(text.split()) + 2

    @staticmethod
    def truncate_to_tokens(text: str, max_tokens: int) -> str:
        return " ".join(text.split()[:max_tokens])

    @staticmethod
    def split_to_token_windows(text: str, max_tokens: int) -> list[str]:
        words = text.split()
        return [" ".join(words[start : start + max_tokens]) for start in range(0, len(words), max_tokens)]


def note(number: int, revision: str = "initial") -> str:
    return f"""---
id: benchmark-{number}
kind: reference
scope: benchmark
status: active
last_verified: 2026-07-18
---
# Benchmark owner {number}
## Summary
Deterministic capability {number} contract, {revision} revision.
## Key facts
- Owner {number} preserves bounded indexing behavior.
## Retrieval hints
benchmark capability {number}
"""


def elapsed(operation) -> tuple[float, dict]:
    started = time.perf_counter()
    result = operation()
    return round(time.perf_counter() - started, 6), result


def measure(scale: int) -> dict:
    from kb_service.indexer import KnowledgeIndex

    with tempfile.TemporaryDirectory(prefix=f"kb-benchmark-{scale}-") as temp:
        root = Path(temp)
        wiki = root / "wiki"
        wiki.mkdir()
        for number in range(scale):
            (wiki / f"note-{number:04}.md").write_text(note(number), encoding="utf-8")
        settings = SimpleNamespace(
            wiki_root=wiki,
            repository_root=root,
            kb_root=root / "kb",
            embedding_model="deterministic",
            chunk_tokens=96,
            top_k=8,
            max_top_k=20,
            embedding_batch_size=64,
            min_relevance=0.0,
            merge_adjacent_window=0,
            staleness_days=90,
            evidence_max_anchors=12,
        )
        with patch("kb_service.indexer.OnnxMiniLmProvider", DeterministicProvider):
            index = KnowledgeIndex(settings)
            initial_seconds, initial = elapsed(index.reindex)
            unchanged_seconds, unchanged = elapsed(index.reindex)
            changed_path = f"note-{scale // 2:04}.md"
            (wiki / changed_path).write_text(note(scale // 2, "changed"), encoding="utf-8")
            targeted_seconds, targeted = elapsed(lambda: index.reindex_paths({changed_path}))
            search_seconds, results = elapsed(lambda: index.search("benchmark capability owner", top_k=20))

    return {
        "notes": scale,
        "initial_seconds": initial_seconds,
        "unchanged_seconds": unchanged_seconds,
        "targeted_seconds": targeted_seconds,
        "search_seconds": search_seconds,
        "initial_changed": initial["changed"],
        "unchanged_changed": unchanged["changed"],
        "targeted_changed": targeted["changed"],
        "targeted_scanned": targeted["scanned"],
        "search_results": len(results),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scales", nargs="+", type=int, default=[20, 100, 500, 1000])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "provider": "deterministic-64d",
        "notes": "Developer baseline only; timings are not routine CI thresholds.",
        "measurements": [measure(scale) for scale in args.scales],
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
