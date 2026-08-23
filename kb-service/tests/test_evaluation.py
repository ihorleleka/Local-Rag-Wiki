from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class EvaluationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Reuse the lightweight dependency fakes installed by the app tests.
        try:
            from tests.test_app import install_fakes
        except ModuleNotFoundError:
            from test_app import install_fakes

        install_fakes()
        sys.modules.pop("kb_service.evaluation", None)
        cls.module = importlib.import_module("kb_service.evaluation")

    def test_dataset_requires_owner_for_positive_case(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "invalid.json"
            path.write_text(
                json.dumps({"cases": [{"id": "bad", "query": "q", "max_payload_bytes": 10}]}),
                encoding="utf-8",
            )

            with self.assertRaises(ValueError):
                self.module.load_dataset(path)

    def test_gate_reports_failed_quality_metrics(self) -> None:
        report = {
            "metrics": {
                "owner_top1_accuracy": 0.8,
                "top_k_accuracy": 1.0,
                "mean_reciprocal_rank": 0.9,
                "duplicate_source_rate": 0.0,
                "negative_query_pass_rate": 1.0,
                "payload_pass_rate": 1.0,
            }
        }
        thresholds = {
            "min_owner_top1_accuracy": 0.9,
            "min_top_k_accuracy": 0.9,
            "min_mean_reciprocal_rank": 0.85,
            "max_duplicate_source_rate": 0.25,
        }

        self.assertEqual(self.module.gate_failures(report, thresholds), ["owner_top1_accuracy"])

    def test_committed_dataset_is_self_contained(self) -> None:
        dataset_path = ROOT / "tests" / "retrieval-evaluation.json"
        wiki_root = ROOT / "tests" / "fixtures" / "retrieval-wiki"

        dataset, cases = self.module.load_dataset(dataset_path)

        self.assertEqual(dataset["name"], "project-rag-wiki-synthetic-retrieval-v1")
        self.assertEqual(len(cases), 9)
        for case in cases:
            if case.expected_owner:
                self.assertTrue(
                    (wiki_root / case.expected_owner).is_file(),
                    f"missing committed owner fixture: {case.expected_owner}",
                )


if __name__ == "__main__":
    unittest.main()
