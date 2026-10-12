#!/usr/bin/env python3
import os

root = r'E:\My Local AI'

def walk_git(p):
    hits = []
    try:
        for entry in os.scandir(p):
            if entry.is_dir():
                if entry.name == '.git':
                    hits.append(entry.path)
                else:
                    hits.extend(walk_git(entry.path))
    except Exception as e:
        hits.append('ERR ' + repr(e))
    return hits

print('=== TASK PHASE 1: nested git check (read-only) ===')
print('nested .git dirs:', walk_git(root))
print()

for dirname in ['archive_recovery', 'build', 'reports']:
    print(f'=== {dirname} contents ===')
    p = os.path.join(root, dirname)
    try:
        for e in sorted(os.scandir(p)):
            if e.is_dir():
                print('  ', e.name, '(dir)')
            else:
                try:
                    sz = os.path.getsize(e.path)
                except Exception as ex:
                    sz = 'ERR'
                print('  ', e.name, f'(file {sz} bytes)')
    except Exception as e:
        print('  error listing:', repr(e))
    print()
