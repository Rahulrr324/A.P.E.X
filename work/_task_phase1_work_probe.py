#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
work = os.path.join(root, 'work')

print('=== TASK PHASE 1: work/ tree probe (read-only) ===')
print('work/ exists:', os.path.isdir(work))
print()

print('--- work/ top-level entries (by name) ---')
try:
    entries = sorted(os.listdir(work))
except Exception as e:
    entries = ['ERR:' + repr(e)]
for e in entries:
    full = os.path.join(work, e)
    if os.path.isdir(full):
        try:
            n = sum(1 for _ in os.scandir(full))
        except Exception as ex:
            n = 'ERR'
        print(f'  {e}/  (dir, {n} items)')
    else:
        try:
            sz = os.path.getsize(full)
        except Exception as ex:
            sz = 'ERR'
        print(f'  {e}  (file {sz} bytes)')
print()

print('--- files > 10 MB under work/ ---')
big = []
for dirpath, dirnames, filenames in os.walk(work):
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        try:
            sz = os.path.getsize(full)
        except Exception as e:
            sz = -1
        if sz > 10_000_000:
            rel = os.path.relpath(full, work)
            big.append((rel, sz))
if big:
    for rel, sz in sorted(big, key=lambda x: -x[1]):
        print(f'  {rel:70s} bytes={sz}')
else:
    print('  (none)')
print()

print('--- secret-string scan over small text-ish files under work/ ---')
KEYWORDS = [
    b'sk-', b'key', b'secret', b'password', b'token', b'bearer', b'x-api-key',
    b'api_key', b'apikey', b'.env', b'aws_access_key_id', b'aws_secret_access_key',
]
def is_textish(p):
    try:
        with open(p, 'rb') as f:
            head = f.read(4096)
    except Exception:
        return False
    if not head:
        return True
    nul_ratio = head.count(b'\x00') / max(1, len(head))
    return nul_ratio < 0.15

count = 0
for dirpath, dirnames, filenames in os.walk(work):
    dirnames.sort()
    for fn in sorted(filenames):
        full = os.path.join(dirpath, fn)
        try:
            sz = os.path.getsize(full)
        except Exception:
            continue
        if sz > 2_000_000:
            continue
        if not is_textish(full):
            continue
        try:
            with open(full, 'rb') as f:
                data = f.read()
        except Exception:
            continue
        hits = [k.decode('ascii') for k in KEYWORDS if k in data]
        if hits:
            rel = os.path.relpath(full, work)
            print(f'  {rel:70s} hits={hits} bytes={sz}')
            count += 1
print(f'  scanned files with hits: {count}')
