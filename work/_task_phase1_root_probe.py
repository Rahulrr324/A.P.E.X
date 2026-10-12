#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
print('=== TASK PHASE 1: root loose-file and .gitignore probe (read-only) ===')
print('cwd python:', os.getcwd())
print('.git present:', os.path.isdir(os.path.join(root, '.git')))
print()
print('top-level entries:')
for e in sorted(os.listdir(root)):
    full = os.path.join(root, e)
    if os.path.isdir(full):
        try:
            n = sum(1 for _ in os.scandir(full))
        except Exception:
            n = '?'
        print(f'  {e}/   (dir, {n} items)')
    else:
        print(f'  {e}    (file {os.path.getsize(full)} bytes)')
print()
print('.gitignore present at root:', os.path.isfile(os.path.join(root, '.gitignore')))
