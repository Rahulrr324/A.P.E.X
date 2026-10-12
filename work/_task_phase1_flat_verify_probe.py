#!/usr/bin/env python3
import os, hashlib

root = r'E:\My Local AI'
files = [
    'workb7_diag_20261011_paired_capturerun10_probe_stderr.txt',
    'workb7_diag_20261011_paired_capturerun10_probe_stdout.txt',
    'workb7_diag_20261011_paired_capturerun10_smoke_stderr.txt',
    'workb7_diag_20261011_paired_capturerun10_smoke_stdout.txt',
]
print('=== TASK PHASE 1: verify loose root files (read-only) ===')
for fn in files:
    full = os.path.join(root, fn)
    print(fn)
    print('  exists:', os.path.isfile(full))
    if os.path.isfile(full):
        print('  size:', os.path.getsize(full))
        print('  sha256:', hashlib.sha256(open(full, 'rb').read()).hexdigest())
        with open(full, 'rb') as f:
            print('  first 200 bytes:', f.read(200))
    print()
