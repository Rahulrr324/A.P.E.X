#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
for name in ['.freebuff', '.vscode']:
    p = os.path.join(root, name)
    print(f'=== {name} ===')
    if not os.path.isdir(p):
        print('  (not a dir)')
        continue
    try:
        for e in sorted(os.listdir(p)):
            full = os.path.join(p, e)
            if os.path.isdir(full):
                print(f'  {e}/ (dir)')
            else:
                print(f'  {e} (file {os.path.getsize(full)} bytes)')
    except Exception as e:
        print('  error:', e)
    print()
