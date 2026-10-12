#!/usr/bin/env python3
import os, hashlib

root = r'E:\My Local AI'
stark = os.path.join(root, 'stark')

print('=== TASK PHASE 1: stark/ tree probe (read-only) ===')
print('stark/ exists:', os.path.isdir(stark))
print()

print('--- stark/ top-level entries (by name) ---')
try:
    entries = sorted(os.listdir(stark))
except Exception as e:
    entries = ['ERR:' + repr(e)]
for e in entries:
    full = os.path.join(stark, e)
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

print('--- files > 10 MB under stark/ ---')
big = []
for dirpath, dirnames, filenames in os.walk(stark):
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        try:
            sz = os.path.getsize(full)
        except Exception as e:
            sz = -1
        if sz > 10_000_000:
            rel = os.path.relpath(full, stark)
            big.append((rel, sz))
if big:
    for rel, sz in sorted(big, key=lambda x: -x[1]):
        print(f'  {rel:70s} bytes={sz}')
else:
    print('  (none)')
print()

print('--- secret-string scan over small text-ish files under stark/ ---')
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
for dirpath, dirnames, filenames in os.walk(stark):
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
            rel = os.path.relpath(full, stark)
            print(f'  {rel:60s} hits={hits} bytes={sz}')
            count += 1
print(f'  scanned files with hits: {count}')
