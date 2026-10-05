from __future__ import annotations

import ctypes
import errno
import importlib
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service import runtime_safety


class RuntimeSafetyTests(unittest.TestCase):
    def test_non_linux_does_not_load_libc(self):
        with patch.object(runtime_safety.sys, "platform", "win32"), patch.object(
            runtime_safety.ctypes, "CDLL"
        ) as load:
            runtime_safety.disable_crash_dumps()
        load.assert_not_called()

    def test_sets_and_verifies_non_dumpable(self):
        libc = Mock()
        libc.prctl.side_effect = [0, 0]
        with patch.object(runtime_safety.sys, "platform", "linux"), patch.object(
            runtime_safety.ctypes, "CDLL", return_value=libc
        ):
            runtime_safety.disable_crash_dumps()
        self.assertEqual(libc.prctl.call_args_list[0].args, (4, 0, 0, 0, 0))
        self.assertEqual(libc.prctl.call_args_list[1].args, (3, 0, 0, 0, 0))

    def test_failure_is_not_silently_ignored(self):
        libc = Mock()
        libc.prctl.return_value = -1
        with patch.object(runtime_safety.sys, "platform", "linux"), patch.object(
            runtime_safety.ctypes, "CDLL", return_value=libc
        ), patch.object(runtime_safety.ctypes, "get_errno", return_value=errno.EPERM):
            with self.assertRaises(OSError) as raised:
                runtime_safety.disable_crash_dumps()
        self.assertEqual(raised.exception.errno, errno.EPERM)

    def test_verification_failure_is_fatal(self):
        libc = Mock()
        libc.prctl.side_effect = [0, 1]
        with patch.object(runtime_safety.sys, "platform", "linux"), patch.object(
            runtime_safety.ctypes, "CDLL", return_value=libc
        ):
            with self.assertRaises(RuntimeError):
                runtime_safety.disable_crash_dumps()

    def test_entry_point_aborts_before_native_imports_if_protection_fails(self):
        entry = importlib.import_module("kb_service.__main__")
        with patch.object(entry, "disable_crash_dumps", side_effect=RuntimeError("blocked")), patch(
            "builtins.__import__", side_effect=AssertionError("import before protection")
        ):
            with self.assertRaisesRegex(RuntimeError, "blocked"):
                entry.main()

    @unittest.skipUnless(sys.platform == "linux", "requires Linux prctl")
    def test_real_linux_process_is_non_dumpable(self):
        # Isolate the change so the test runner retains its own debugging policy.
        code = (
            f"import sys; sys.path.insert(0, {str(SRC)!r}); "
            "from kb_service.runtime_safety import disable_crash_dumps; "
            "disable_crash_dumps(); import ctypes; "
            "assert ctypes.CDLL(None).prctl(3, 0, 0, 0, 0) == 0"
        )
        subprocess.run([sys.executable, "-c", code], check=True)


if __name__ == "__main__":
    unittest.main()
