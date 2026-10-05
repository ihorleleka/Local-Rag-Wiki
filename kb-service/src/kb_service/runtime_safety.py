"""Process-local crash-dump protection for the Linux service entry point."""

from __future__ import annotations

import ctypes
import os
import sys

_PR_SET_DUMPABLE = 4
_PR_GET_DUMPABLE = 3


def disable_crash_dumps() -> None:
    """Prevent Linux core collection, including WSL's piped crash collector.

    RLIMIT_CORE alone is ignored for piped core_pattern handlers. Mark the
    Python process non-dumpable instead, before importing native dependencies.
    Fail closed on Linux if protection cannot be established. This also prevents
    ordinary ptrace attachment; it does not change host-wide WSL settings.
    """
    if sys.platform != "linux":
        return

    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.restype = ctypes.c_int
    # prctl is variadic: explicitly pass machine-width arguments after option.
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                      ctypes.c_ulong, ctypes.c_ulong]
    if prctl(_PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, f"Cannot disable service crash dumps: {os.strerror(error)}")
    if prctl(_PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise RuntimeError("Cannot verify service crash-dump protection")
