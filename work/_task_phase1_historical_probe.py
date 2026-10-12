#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
reports = os.path.join(root, 'stark', 'reports')

print('=== TASK PHASE 1: protected historical directories under stark/reports ===')
for sub in ['historical', 'gate_results', 'host_capture', 'host_capture_csv']:
    p = os.path.join(reports, sub)
    print(f'--- {sub} ---')
    if not os.path.isdir(p):
        print('  (not present)')
        continue
    n = 0
    for entry in sorted(os.listdir(p)):
        full = os.path.join(p, entry)
        if os.path.isdir(full):
            try:
                subn = sum(1 for _ in os.scandir(full))
            except Exception:
                subn = '?'
            print(f'  {entry}/  (dir, {subn} items)')
            n += 1
        else:
            try:
                sz = os.path.getsize(full)
            except Exception:
                sz = -1
            print(f'  {entry}  (file {sz} bytes)')
            n += 1
    print(f'  total entries: {n}')
    print()
