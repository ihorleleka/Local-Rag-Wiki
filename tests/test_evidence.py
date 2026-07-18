from __future__ import annotations

import subprocess
import sys
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.evidence import EvidenceInspector


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def make_repository(root: Path) -> None:
    git(root, "init")
    git(root, "config", "user.email", "evidence@example.test")
    git(root, "config", "user.name", "Evidence Test")
    (root / "src").mkdir()
    (root / "tests").mkdir()
    (root / "src" / "Owner.cs").write_text("class Owner {}\n", encoding="utf-8")
    (root / "tests" / "OwnerTests.cs").write_text("void works() {}\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "initial evidence")


class EvidenceInspectorTests(unittest.TestCase):
    def test_non_git_environment_falls_back_without_crashing(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "owner.md").write_text("owner", encoding="utf-8")
            with patch("kb_service.evidence.subprocess.run", side_effect=FileNotFoundError):
                report = EvidenceInspector(root).inspect(["owner.md"])

            self.assertEqual(report.state, "present")
            self.assertTrue(report.anchors[0].identity)

    def test_files_directories_symbols_tests_and_missing_paths_are_explicit(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            make_repository(root)
            report = EvidenceInspector(root).inspect(
                [
                    "`src/Owner.cs`",
                    "dir: tests",
                    "symbol: src/Owner.cs#Owner",
                    "test: tests/OwnerTests.cs::works",
                    "path: missing/file.cs",
                    "dotnet test tests/OwnerTests.cs",
                    "`TheBigBang.Foundation.Core` and `.AddComposers()` are symbols, not paths.",
                ]
            )

            self.assertEqual(report.verifiable_count, 5)
            self.assertEqual(report.missing_targets, ("missing/file.cs",))
            self.assertEqual(report.state, "missing")
            self.assertTrue(all(anchor.identity for anchor in report.anchors if anchor.exists))

    def test_uncommitted_and_same_day_committed_changes_are_detected_by_identity(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            make_repository(root)
            first = EvidenceInspector(root).inspect(["src/Owner.cs"])

            (root / "src" / "Owner.cs").write_text("class Owner { int Version = 2; }\n", encoding="utf-8")
            dirty = EvidenceInspector(root).inspect(["src/Owner.cs"], first.snapshot)
            self.assertEqual(dirty.state, "changed_since_verification")

            git(root, "add", "src/Owner.cs")
            git(root, "commit", "-m", "same day evidence change")
            committed = EvidenceInspector(root).inspect(["src/Owner.cs"], first.snapshot)
            self.assertEqual(committed.state, "changed_since_verification")
            self.assertEqual(committed.changed_targets, ("src/Owner.cs",))

    def test_explicit_verification_snapshots_dirty_bytes_and_detects_later_edits(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            make_repository(root)
            clean = EvidenceInspector(root).inspect(["src/Owner.cs"])
            (root / "src" / "Owner.cs").write_text(
                "class Owner { int Version = 2; }\n", encoding="utf-8"
            )

            inspector = EvidenceInspector(root)
            dirty = inspector.inspect(["src/Owner.cs"], clean.snapshot)
            accepted = inspector.inspect(
                ["src/Owner.cs"], clean.snapshot, verification_updated=True
            )
            (root / "src" / "Owner.cs").write_text(
                "class Owner { int Version = 3; }\n", encoding="utf-8"
            )
            changed_again = EvidenceInspector(root).inspect(
                ["src/Owner.cs"], accepted.snapshot
            )

            self.assertEqual(dirty.state, "changed_since_verification")
            self.assertEqual(accepted.state, "present")
            self.assertEqual(accepted.anchors[0].working_tree_state, "modified_or_untracked")
            self.assertEqual(changed_again.state, "changed_since_verification")

    def test_fresh_clone_does_not_use_checkout_mtime_as_drift(self) -> None:
        with TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            source = base / "source"
            source.mkdir()
            make_repository(source)
            clone = base / "clone"
            subprocess.run(
                ["git", "clone", "--quiet", str(source), str(clone)],
                check=True,
                capture_output=True,
                text=True,
            )

            report = EvidenceInspector(clone).inspect(["src/Owner.cs"])

            self.assertEqual(report.state, "present")
            self.assertEqual(report.anchors[0].working_tree_state, "clean")

    def test_large_file_inventory_is_a_maintenance_signal(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            make_repository(root)
            report = EvidenceInspector(root, max_anchors=1).inspect(
                ["src/Owner.cs", "tests/OwnerTests.cs"]
            )

            self.assertTrue(report.excessive_inventory)
            self.assertEqual(report.state, "present")


if __name__ == "__main__":
    unittest.main()
