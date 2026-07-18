from __future__ import annotations

import argparse
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, TYPE_CHECKING

from .app import compact_context_packet
from .indexer import KnowledgeIndex

if TYPE_CHECKING:
    from .indexer import SearchResult


@dataclass(frozen=True)
class EvaluationCase:
    case_id: str
    query: str
    expected_owner: str | None
    acceptable_alternatives: tuple[str, ...]
    expected_miss: bool
    max_payload_bytes: int


def load_dataset(path: Path) -> tuple[dict[str, Any], list[EvaluationCase]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    cases = []
    for item in raw.get("cases", []):
        expected_miss = bool(item.get("expected_miss", False))
        owner = item.get("expected_owner")
        if not expected_miss and not owner:
            raise ValueError(f"{item.get('id', '<unknown>')}: expected_owner is required")
        cases.append(
            EvaluationCase(
                case_id=str(item["id"]),
                query=str(item["query"]),
                expected_owner=str(owner) if owner else None,
                acceptable_alternatives=tuple(str(value) for value in item.get("acceptable_alternatives", [])),
                expected_miss=expected_miss,
                max_payload_bytes=int(item["max_payload_bytes"]),
            )
        )
    if not cases:
        raise ValueError("evaluation dataset contains no cases")
    return raw, cases


def result_source(result: "SearchResult") -> str:
    packet = result.context_packet or {}
    return str(packet.get("source") or result.source_file)


def serialize_result(result: "SearchResult") -> dict[str, Any]:
    if result.record_type == "packet":
        packet = dict(result.context_packet or {})
        packet.setdefault("source", result.source_file)
        return {
            "record_type": "packet",
            "relevance_score": result.score,
            "packet": compact_context_packet(packet),
        }
    return {
        "record_type": "chunk",
        "source_file": result.source_file,
        "chunk_id": result.chunk_id,
        "relevance_score": result.score,
        "context": result.context,
    }


def serialized_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def evaluate(index: KnowledgeIndex, cases: list[EvaluationCase], top_k: int) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    reciprocal_ranks: list[float] = []
    owner_top1_hits = 0
    top_k_hits = 0
    positive_count = 0
    expected_miss_count = 0
    correct_misses = 0
    observed_misses = 0
    true_observed_misses = 0
    duplicate_results = 0
    returned_results = 0

    for case in cases:
        results = index.search(case.query, top_k=top_k)
        sources = [result_source(result) for result in results]
        serialized_results = [serialize_result(result) for result in results]
        response = {
            "results": serialized_results,
            "diagnostics": {"miss": not results, "result_count": len(results)},
        }
        response_bytes = serialized_bytes(response)
        result_bytes = [serialized_bytes(item) for item in serialized_results]
        largest_result_bytes = max(result_bytes, default=0)
        duplicate_count = len(sources) - len(set(sources))
        duplicate_results += duplicate_count
        returned_results += len(sources)

        owner_rank = None
        if case.expected_owner in sources:
            owner_rank = sources.index(case.expected_owner) + 1

        acceptable = set(case.acceptable_alternatives)
        acceptable_top1 = bool(sources and (sources[0] == case.expected_owner or sources[0] in acceptable))
        if case.expected_miss:
            expected_miss_count += 1
            if not results:
                correct_misses += 1
        else:
            positive_count += 1
            if sources and sources[0] == case.expected_owner:
                owner_top1_hits += 1
            if owner_rank is not None:
                top_k_hits += 1
                reciprocal_ranks.append(1.0 / owner_rank)
            else:
                reciprocal_ranks.append(0.0)

        if not results:
            observed_misses += 1
            if case.expected_miss:
                true_observed_misses += 1

        records.append(
            {
                "id": case.case_id,
                "query": case.query,
                "expected_owner": case.expected_owner,
                "expected_miss": case.expected_miss,
                "sources": sources,
                "owner_rank": owner_rank,
                "acceptable_top1": acceptable_top1,
                "miss_pass": (not results) == case.expected_miss,
                "response_bytes": response_bytes,
                "largest_result_bytes": largest_result_bytes,
                "max_payload_bytes": case.max_payload_bytes,
                "payload_pass": largest_result_bytes <= case.max_payload_bytes,
                "approximate_response_tokens": index.provider.token_count(json.dumps(response, ensure_ascii=False)),
            }
        )

    return {
        "metrics": {
            "positive_cases": positive_count,
            "expected_miss_cases": expected_miss_count,
            "owner_top1_accuracy": owner_top1_hits / positive_count if positive_count else 1.0,
            "top_k_accuracy": top_k_hits / positive_count if positive_count else 1.0,
            "mean_reciprocal_rank": sum(reciprocal_ranks) / len(reciprocal_ranks) if reciprocal_ranks else 1.0,
            "duplicate_source_rate": duplicate_results / returned_results if returned_results else 0.0,
            "miss_precision": true_observed_misses / observed_misses if observed_misses else 1.0,
            "negative_query_pass_rate": correct_misses / expected_miss_count if expected_miss_count else 1.0,
            "max_response_bytes": max(record["response_bytes"] for record in records),
            "max_result_bytes": max(record["largest_result_bytes"] for record in records),
            "max_approximate_response_tokens": max(record["approximate_response_tokens"] for record in records),
            "payload_pass_rate": sum(record["payload_pass"] for record in records) / len(records),
        },
        "cases": records,
    }


def gate_failures(report: dict[str, Any], thresholds: dict[str, Any]) -> list[str]:
    metrics = report["metrics"]
    checks = {
        "owner_top1_accuracy": metrics["owner_top1_accuracy"] >= float(thresholds["min_owner_top1_accuracy"]),
        "top_k_accuracy": metrics["top_k_accuracy"] >= float(thresholds["min_top_k_accuracy"]),
        "mean_reciprocal_rank": metrics["mean_reciprocal_rank"] >= float(thresholds["min_mean_reciprocal_rank"]),
        "duplicate_source_rate": metrics["duplicate_source_rate"] <= float(thresholds["max_duplicate_source_rate"]),
        "negative_query_pass_rate": metrics["negative_query_pass_rate"] >= 1.0,
        "payload_pass_rate": metrics["payload_pass_rate"] >= 1.0,
    }
    return [name for name, passed in checks.items() if not passed]


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate real wiki retrieval quality.")
    parser.add_argument("--wiki-root", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--embedding-model", help="Override the dataset model for comparative benchmarks.")
    args = parser.parse_args()

    dataset, cases = load_dataset(args.dataset.resolve())
    with tempfile.TemporaryDirectory(prefix="wiki-retrieval-eval-") as temp_dir:
        settings = SimpleNamespace(
            wiki_root=args.wiki_root.resolve(),
            repository_root=args.wiki_root.resolve().parent,
            kb_root=Path(temp_dir),
            embedding_model=str(
                args.embedding_model
                or dataset.get("embedding_model", "all-MiniLM-L6-v2")
            ),
            chunk_tokens=int(dataset.get("chunk_tokens", 220)),
            top_k=args.top_k,
            min_relevance=float(dataset.get("minimum_relevance", 0.35)),
            merge_adjacent_window=0,
            staleness_days=90,
        )
        index = KnowledgeIndex(settings)
        index.reindex()
        report = {
            "dataset": dataset.get("name", args.dataset.name),
            "embedding_model": settings.embedding_model,
            "minimum_relevance": settings.min_relevance,
            "top_k": args.top_k,
            **evaluate(index, cases, args.top_k),
        }

    failures = gate_failures(report, dataset["thresholds"])
    report["gate"] = {"passed": not failures, "failures": failures}
    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
