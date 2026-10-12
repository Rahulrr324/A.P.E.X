#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
print('=== TASK PHASE 1: flat files in root ===')
for e in sorted(os.listdir(root)):
    full = os.path.join(root, e)
    print(e, '(dir)' if os.path.isdir(full) else f'(file {os.path.getsize(full)} bytes)')
