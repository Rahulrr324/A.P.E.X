#!/usr/bin/env python3
import os

root = r'E:\My Local AI'

def info(p):
    isdir = os.path.isdir(p)
    n = 0
    if isdir:
        try:
            n = sum(1 for _ in os.scandir(p))
        except Exception as e:
            n = 'ERR:' + repr(e)
    return isdir, n

print('=== TASK PHASE 1: directory digests (read-only) ===')
print('root:', root)
print('root exists:', os.path.isdir(root))
print()
print('--- top-level directories ---')
for name in ['.freebuff', '.vscode', 'archive_recovery', 'build', 'reports', 'stark', 'work']:
    p = os.path.join(root, name)
    isdir, n = info(p)
    print(f'{name:24s} isdir={isdir} children={n}')

print()
print('--- suspicious flat files in root ---')
for f in sorted(os.listdir(root)):
    full = os.path.join(root, f)
    if os.path.isfile(full):
        try:
            sz = os.path.getsize(full)
        except Exception as e:
            sz = 'ERR:' + repr(e)
        print(f'{f:95s} bytes={sz}')
