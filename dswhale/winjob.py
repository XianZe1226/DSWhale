"""Windows child launcher whose lifetime owns a kill-on-close Job Object.

Assign the launcher itself BEFORE spawning the target: every descendant inherits
the job even if intermediate parents exit. No process-attachment race, no shell.
API: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
This module is invoked as a script, so it depends only on the standard library.
"""

import ctypes
import os
import subprocess
import sys


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_int64),
        ("job_time", ctypes.c_int64),
        ("flags", ctypes.c_uint32),
        ("minimum_working_set", ctypes.c_size_t),
        ("maximum_working_set", ctypes.c_size_t),
        ("active_processes", ctypes.c_uint32),
        ("affinity", ctypes.c_size_t),
        ("priority", ctypes.c_uint32),
        ("scheduling", ctypes.c_uint32),
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", BasicLimits),
        ("io_counters", ctypes.c_uint64 * 6),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t),
        ("peak_job_memory", ctypes.c_size_t),
    ]


def own_job():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel.CreateJobObjectW.restype = ctypes.c_void_p
    kernel.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    kernel.SetInformationJobObject.restype = ctypes.c_int
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.AssignProcessToJobObject.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    info = ExtendedLimits()
    info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
    if not kernel.SetInformationJobObject(
        handle, 9, ctypes.byref(info), ctypes.sizeof(info)
    ) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    return handle


def main():
    if os.name != "nt" or len(sys.argv) < 2:
        return 2
    try:
        handle = own_job()
    except OSError:
        print("Windows 无法建立工具进程保护；未启动工具。", file=sys.stderr, flush=True)
        return 2
    # Keep this non-inheritable handle open until ExitProcess closes it. Closing
    # explicitly would terminate this launcher before it can report the exit code.
    try:
        code = subprocess.call(sys.argv[1:])
    except OSError:
        code = 2
    assert handle
    os._exit(code)


if __name__ == "__main__":
    raise SystemExit(main())
