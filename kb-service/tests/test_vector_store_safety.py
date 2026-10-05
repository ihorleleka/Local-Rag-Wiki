from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.vector_store_safety import ensure_vector_store_is_safe


class VectorStoreSafetyTests(unittest.TestCase):
    def settings(self, root: Path):
        return SimpleNamespace(kb_root=root)

    def test_healthy_probe_preserves_existing_index(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            chroma = root / "chroma"
            chroma.mkdir()
            (root / "manifest.json").write_text('{"files": {}}', encoding="utf-8")
            with patch("kb_service.vector_store_safety.subprocess.run") as run:
                run.return_value = subprocess.CompletedProcess([], 0, "", "")
                ensure_vector_store_is_safe(self.settings(root))

            self.assertTrue(chroma.exists())
            self.assertTrue((root / "manifest.json").exists())
            command = run.call_args.args[0]
            self.assertEqual(command[-1], "--probe-vector-store")

    def test_failed_probe_quarantines_only_derived_data(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            chroma = root / "chroma"
            chroma.mkdir()
            (chroma / "index_metadata.pickle").write_bytes(b"corrupt")
            (root / "manifest.json").write_text('{"files": {}}', encoding="utf-8")
            wiki = root.parent / "wiki.md"
            wiki.write_text("source survives", encoding="utf-8")
            with patch("kb_service.vector_store_safety.subprocess.run") as run:
                run.return_value = subprocess.CompletedProcess([], -11, "", "segmentation fault")
                ensure_vector_store_is_safe(self.settings(root))

            self.assertFalse(chroma.exists())
            self.assertFalse((root / "manifest.json").exists())
            self.assertEqual(wiki.read_text(encoding="utf-8"), "source survives")
            self.assertTrue(list(root.glob("chroma.corrupt-*")))
            self.assertTrue(list(root.glob("manifest.json.corrupt-*")))

    def test_missing_store_does_not_launch_probe(self):
        with TemporaryDirectory() as temporary:
            with patch("kb_service.vector_store_safety.subprocess.run") as run:
                ensure_vector_store_is_safe(self.settings(Path(temporary)))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
