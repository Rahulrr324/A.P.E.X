#!/usr/bin/env python3
import os

root = r'E:\My Local AI'

def walk_tree(p, depth=0, max_depth=4, max_show_per_dir=25):
    if depth > max_depth:
        return
    if not os.path.isdir(p):
        return
    try:
        entries = sorted(os.scandir(p), key=lambda e: (not e.is_dir(), e.name.lower()))
    except Exception as e:
        print(' ' * (depth * 2) + f'[list error: {e}]')
        return
    dirs, files = [], []
    for e in entries:
        (dirs if e.is_dir() else files).append(e)
    for e in dirs[:max_show_per_dir]:
        full = e.path
        try:
            n = sum(1 for _ in os.scandir(full))
        except Exception:
            n = '?'
        print(' ' * (depth * 2) + f'{e.name}/  ({n} items)')
        walk_tree(full, depth=depth + 1, max_depth=max_depth, max_show_per_dir=max_show_per_dir)
    if len(dirs) > max_show_per_dir:
        print(' ' * (depth * 2) + f'  ... ({len(dirs) - max_show_per_dir} more dirs)')
    for e in files[:max_show_per_dir]:
        full = e.path
        try:
            sz = os.path.getsize(full)
        except Exception:
            sz = -1
        print(' ' * (depth * 2) + f'{e.name}  ({sz} bytes)')
    if len(files) > max_show_per_dir:
        print(' ' * (depth * 2) + f'  ... ({len(files) - max_show_per_dir} more files)')

for name in ['scripts', 'b7_diag_20261011', 'b7_diag_20261011_corrected', 'b7_diag_20261011_paired_capture']:
    p = os.path.join(root, name)
    print(f'=== {name} ===')
    walk_tree(p, max_depth=5, max_show_per_dir=15)
    print()
