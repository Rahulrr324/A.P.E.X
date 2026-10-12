#!/usr/bin/env python3
import sys, pathlib, hashlib, ctypes, threading, msvcrt, os, time
from ctypes import wintypes

REL = 'stark/build-b7diag-20261011/bm_b7_diagnostic.exe'
EXPECTED = 'a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6'
OUT_STDOUT = 'work/b7_diag_20261011_paired_capture/run10_stdout.bin'
OUT_STDERR = 'work/b7_diag_20261011_paired_capture/run10_stderr.bin'

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()

def log(line):
    sys.stderr.write(line + '\n'); sys.stderr.flush()

class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', wintypes.HANDLE),
        ('hThread', wintypes.HANDLE),
        ('dwProcessId', wintypes.DWORD),
        ('dwThreadId', wintypes.DWORD),
    ]

class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('lpReserved', wintypes.LPWSTR),
        ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR),
        ('dwX', wintypes.DWORD),
        ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD),
        ('dwYSize', wintypes.DWORD),
        ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD),
        ('dwFillAttribute', wintypes.DWORD),
        ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD),
        ('cbReserved2', wintypes.WORD),
        ('lpReserved2', ctypes.POINTER(wintypes.BYTE)),
        ('hStdInput', wintypes.HANDLE),
        ('hStdOutput', wintypes.HANDLE),
        ('hStdError', wintypes.HANDLE),
    ]

class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ('nLength', wintypes.DWORD),
        ('lpSecurityDescriptor', wintypes.LPVOID),
        ('bInheritHandle', wintypes.BOOL),
    ]

WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x00000102

def main():
    resolved = pathlib.Path(REL).resolve()
    exe = str(resolved)
    log('resolved: ' + exe)
    exe_sha = sha256_file(exe)
    log('sha256: ' + exe_sha)
    log('matches expected: ' + repr(exe_sha == EXPECTED))

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    CreateProcessW = kernel32.CreateProcessW
    CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    CreateProcessW.restype = wintypes.BOOL
    CLI = kernel32.CloseHandle
    CLI.argtypes = [wintypes.HANDLE]
    CLI.restype = wintypes.BOOL
    WAIT = kernel32.WaitForSingleObject
    WAIT.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    WAIT.restype = wintypes.DWORD
    GE = kernel32.GetExitCodeProcess
    GE.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    GE.restype = wintypes.BOOL

    TIMEOUT_MS = 90 * 1000

    sa = SECURITY_ATTRIBUTES()
    sa.nLength = ctypes.sizeof(sa)
    sa.lpSecurityDescriptor = None
    sa.bInheritHandle = True

    hp_read = wintypes.HANDLE()
    hp_write = wintypes.HANDLE()
    ok1 = kernel32.CreatePipe(ctypes.byref(hp_read), ctypes.byref(hp_write), ctypes.byref(sa), 0)
    log('CreatePipe stdout ok=' + repr(ok1) + ' last_error=' + repr(ctypes.get_last_error()))
    he_read = wintypes.HANDLE()
    he_write = wintypes.HANDLE()
    ok2 = kernel32.CreatePipe(ctypes.byref(he_read), ctypes.byref(he_write), ctypes.byref(sa), 0)
    log('CreatePipe stderr ok=' + repr(ok2) + ' last_error=' + repr(ctypes.get_last_error()))

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    si.dwFlags = 0x00000001
    si.hStdOutput = hp_write
    si.hStdError = he_write
    si.hStdInput = wintypes.HANDLE(-1)

    app = ctypes.c_wchar_p(exe)
    cmdline = ctypes.create_unicode_buffer(exe)
    pi = PROCESS_INFORMATION()
    cwd_ptr = ctypes.cast(None, wintypes.LPCWSTR)

    log('--- cwd=None, app=exe, cmdline=exe ---')
    cp_ok = CreateProcessW(
        ctypes.cast(app, wintypes.LPCWSTR),
        ctypes.cast(cmdline, wintypes.LPWSTR),
        None, None, False, 0, None,
        cwd_ptr, ctypes.byref(si), ctypes.byref(pi), None)
    log('CreateProcessW ok=' + repr(cp_ok) + ' last_error=' + repr(ctypes.get_last_error()))
    if not cp_ok:
        CLI(hp_read); CLI(hp_write); CLI(he_read); CLI(he_write)
        return 1

    CLI(hp_write); CLI(he_write)

    log('process id=' + str(pi.dwProcessId))
    r = WAIT(pi.hProcess, TIMEOUT_MS)
    log('WaitForSingleObject=' + str(r))

    # give the kernel a moment to flush any buffered pipe data
    time.sleep(0.3)

    stdout_buf = []
    stderr_buf = []
    stdout_done = threading.Event()
    stderr_done = threading.Event()

    def drain_from_handle(handle, parts, done, label):
        if not handle or handle == wintypes.HANDLE(-1).value:
            done.set()
            return
        try:
            fd = msvcrt.open_osfhandle(handle.value, os.O_RDONLY | os.O_BINARY)
            try:
                with os.fdopen(fd, 'rb', 65536) as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        parts.append(chunk)
            except Exception as e:
                log(label + ' fdopen/read error: ' + repr(e))
        finally:
            done.set()

    t1 = threading.Thread(target=drain_from_handle, args=(hp_read, stdout_buf, stdout_done, 'stdout'), daemon=True)
    t2 = threading.Thread(target=drain_from_handle, args=(he_read, stderr_buf, stderr_done, 'stderr'), daemon=True)
    t1.start(); t2.start()
    t1.join(timeout=8); t2.join(timeout=8)
    stdout_data = b''.join(stdout_buf)
    stderr_data = b''.join(stderr_buf)

    exit_code = wintypes.DWORD()
    gok = GE(pi.hProcess, ctypes.byref(exit_code))
    log('GetExitCodeProcess ok=' + repr(gok) + ' exit_code=' + str(exit_code.value))

    log('--- stdout (len %d) ---' % len(stdout_data))
    try:
        log(stdout_data.decode('utf-8', 'replace')[:2000])
    except Exception:
        log(repr(stdout_data[:2000]))
    log('--- stderr (len %d) ---' % len(stderr_data))
    try:
        log(stderr_data.decode('utf-8', 'replace')[:500])
    except Exception:
        log(repr(stderr_data[:500]))

    pathlib.Path(OUT_STDOUT).write_bytes(stdout_data)
    pathlib.Path(OUT_STDERR).write_bytes(stderr_data)
    log('wrote stdout -> ' + OUT_STDOUT + ' bytes=' + str(len(stdout_data)) + ' sha=' + sha256_file(OUT_STDOUT))
    log('wrote stderr -> ' + OUT_STDERR + ' bytes=' + str(len(stderr_data)) + ' sha=' + sha256_file(OUT_STDERR))

    CLI(pi.hProcess)
    return 0

if __name__ == '__main__':
    sys.exit(main())
