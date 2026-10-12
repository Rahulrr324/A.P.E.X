#!/usr/bin/env python3
import sys, pathlib, hashlib, ctypes, threading
from ctypes import wintypes

REL = 'stark/build-b7diag-20261011/bm_b7_diagnostic.exe'
EXPECTED = 'a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6'
SHA_STDOUT = 'work/b7_diag_20261011_paired_capture/run10_winapi_stdout.txt'
SHA_STDERR = 'work/b7_diag_20261011_paired_capture/run10_winapi_stderr.txt'

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
ERROR_BROKEN_PIPE = 232
ERROR_HANDLE_EOF = 38

def main():
    resolved = pathlib.Path(REL).resolve()
    exe = str(resolved)
    log('resolved: ' + exe)
    log('sha256: ' + sha256_file(exe))
    log('matches expected: ' + repr(sha256_file(exe) == EXPECTED))

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

    stdout_parts = []
    stderr_parts = []
    stdout_done = threading.Event()
    stderr_done = threading.Event()

    def drain(read_handle, parts, done):
        if not read_handle or read_handle == wintypes.HANDLE(-1).value:
            done.set()
            return
        try:
            while True:
                buf = ctypes.create_string_buffer(65536)
                rd = wintypes.DWORD()
                rr = kernel32.ReadFile(read_handle, buf, ctypes.sizeof(buf), ctypes.byref(rd), None)
                if not rr:
                    err = ctypes.get_last_error()
                    if err in (ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF):
                        break
                    log('read failed; last_error=' + repr(err))
                    break
                if rd.value == 0:
                    break
                try:
                    parts.append(buf.raw[:rd.value].decode('utf-8', 'replace'))
                except Exception:
                    parts.append(repr(buf.raw[:rd.value]))
        finally:
            done.set()

    t1 = threading.Thread(target=drain, args=(hp_read, stdout_parts, stdout_done), daemon=True)
    t2 = threading.Thread(target=drain, args=(he_read, stderr_parts, stderr_done), daemon=True)
    t1.start(); t2.start()
    t1.join(timeout=5); t2.join(timeout=5)
    stdout_data = ''.join(stdout_parts)
    stderr_data = ''.join(stderr_parts)

    exit_code = wintypes.DWORD()
    gok = GE(pi.hProcess, ctypes.byref(exit_code))
    log('GetExitCodeProcess ok=' + repr(gok) + ' exit_code=' + str(exit_code.value))

    log('--- stdout (len %d) ---' % len(stdout_data))
    log(stdout_data[:2000] if stdout_data else '(empty)')
    log('--- stderr (len %d) ---' % len(stderr_data))
    log(stderr_data[:500] if stderr_data else '(empty)')

    # write captured stdout/stderr to SHA files
    pathlib.Path(SHA_STDOUT).write_text(stdout_data)
    pathlib.Path(SHA_STDERR).write_text(stderr_data)
    log('wrote stdout -> ' + SHA_STDOUT + ' sha256=' + sha256_file(SHA_STDOUT))
    log('wrote stderr -> ' + SHA_STDERR + ' sha256=' + sha256_file(SHA_STDERR))

    CLI(pi.hProcess)
    return 0

if __name__ == '__main__':
    sys.exit(main())
