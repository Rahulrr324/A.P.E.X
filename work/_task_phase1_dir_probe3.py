#!/usr/bin/env python3
import os

root = r'E:\My Local AI'

def listdir_sorted(p):
    try:
        return sorted(os.listdir(p))
    except Exception as e:
        return ['ERR:' + repr(e)]

for dirname in ['archive_recovery', 'build', 'reports']:
    print(f'=== {dirname} contents ===')
    p = os.path.join(root, dirname)
    if not os.path.isdir(p):
        print('  (not a dir)')
    else:
        for name in listdir_sorted(p):
            full = os.path.join(p, name)
            if os.path.isdir(full):
                sub = listdir_sorted(full)
                print(f'  {name}/  (dir, {len(sub)} items)')
                if len(sub) <= 20:
                    for s in sub:
                        print(f'    - {s}')
                else:
                    print('    - ... (%d more)' % (len(sub) - 8))
                    for s in sub[:4]:
                        print(f'    - {s}')
                    print('    - ...')
                    for s in sub[-4:]:
                        print(f'    - {s}')
            else:
                try:
                    sz = os.path.getsize(full)
                except Exception as e:
                    sz = 'ERR'
                print(f'  {name}  (file {sz} bytes)')
    print()
