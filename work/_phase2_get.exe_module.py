#!/usr/bin/env python3
import ctypes, ctypes.wintypes, os, sys, json

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
Psapi = ctypes.WinDLL('Psapi', use_last_error=True)

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
OPEN_EXISTING = 3

def get_module_file_name(hProcess, hModule, buf=None):
    if buf is None:
        buf = ctypes.create_unicode_buffer(32768)
    buflen = ctypes.c_ulong(len(buf) * 2)
    ret = Psapi.GetModuleFileNameExW(hProcess, hModule, buf, buflen)
    return ret, buf.value

def probe_exe(exe_path):
    stats = os.stat(exe_path)
    hFile = kernel32.CreateFileW(exe_path, GENERIC_READ, FILE_SHARE_READ, None, OPEN_EXISTING, 0x00000080, None)
    if hFile is None or hFile == ctypes.wintypes.HANDLE(-1).value:
        return {'ok': False, 'err': f'CreateFile failed {ctypes.get_last_error()}'}
    try:
        hProcess = kernel32.CreateFileW(exe_path, GENERIC_READ, FILE_SHARE_READ, None, OPEN_EXISTING, 0, None)
        if hProcess is None or hProcess == ctypes.wintypes.HANDLE(-1).value:
            return {'ok': False, 'err': f'CreateFile failed for process handle {ctypes.get_last_error()}'}
        try:
            ret, name = get_module_file_name(hProcess, None)
            return {'ok': True, 'name': name, 'ret': ret, 'stats': {'size': stats.st_size, 'sha256': None}}
        finally:
            kernel32.CloseHandle(hProcess)
    finally:
        kernel32.CloseHandle(hFile)

if __name__ == '__main__':
    exe = sys.argv[1] if len(sys.argv) > 1 else None
    if not exe:
        print('usage: _phase2_get.exe_module.py <exe-path>')
        sys.exit(2)
    print(json.dumps({'exe': exe, 'abspath': os.path.abspath(exe), 'probe': probe_exe(exe)}, indent=2))
