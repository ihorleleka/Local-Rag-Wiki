from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.atomic_io import atomic_write_text


class AtomicWriteTests(unittest.TestCase):
    def test_preserves_utf8_and_newlines_and_creates_parents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / "note.md"
            content = "# Café\r\nUnicode: λ\n"
            atomic_write_text(target, content)
            self.assertEqual(target.read_bytes(), content.encode("utf-8"))
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_encoding_failure_cleans_staging_file_and_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "note.md"
            target.write_text("original", encoding="utf-8")
            with self.assertRaises(UnicodeEncodeError):
                atomic_write_text(target, "invalid surrogate: \ud800")
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_fsync_failure_cleans_staging_file_and_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "manifest.json"
            target.write_text("{}", encoding="utf-8")
            with patch("kb_service.atomic_io.os.fsync", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    atomic_write_text(target, '{"changed": true}')
            self.assertEqual(target.read_text(encoding="utf-8"), "{}")
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_failed_creation_leaves_no_staging_file_or_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "note.md"
            with patch("kb_service.atomic_io.os.fsync", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    atomic_write_text(target, "new note")
            self.assertEqual(list(target.parent.iterdir()), [])

    def test_transient_permission_error_retries_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "note.md"
            real_replace = os.replace
            calls = 0

            def replace(source, destination):
                nonlocal calls
                calls += 1
                if calls < 3:
                    raise PermissionError("temporarily busy")
                return real_replace(source, destination)

            with patch("kb_service.atomic_io.os.replace", side_effect=replace), patch("kb_service.atomic_io.time.sleep") as sleep:
                atomic_write_text(target, "replacement")
            self.assertEqual(calls, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(target.read_text(encoding="utf-8"), "replacement")
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_persistent_permission_error_is_bounded_and_cleans_staging(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "note.md"
            target.write_text("original", encoding="utf-8")
            with (
                patch("kb_service.atomic_io.os.replace", side_effect=PermissionError("busy")) as replace,
                patch("kb_service.atomic_io.time.sleep") as sleep,
            ):
                with self.assertRaises(PermissionError):
                    atomic_write_text(target, "replacement")
            self.assertEqual(replace.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
