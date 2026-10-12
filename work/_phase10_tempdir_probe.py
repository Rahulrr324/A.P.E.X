#!/usr/bin/env python3
import subprocess, pathlib, tempfile, sys, os

REL = 'stark/build-b7diag-20261011/bm_b7_diagnostic.exe'
EXPECTED = 'a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6'

def sha256_file(path):
    h = __import__('hashlib').sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()

def main():
    resolved = pathlib.Path(REL).resolve()
    got = sha256_file(str(resolved))
    print('sha256', got, 'matches', got == EXPECTED)
    with tempfile.TemporaryDirectory() as td:
        print('tempdir', td)
        cmd = [str(resolved)]
        print('cmd', cmd)
        print('cwd', td)
        r = subprocess.run(cmd, capture_output=True, text=True,
                           cwd=td, shell=False, timeout=90)
        print('rc', r.returncode)
        print('--- stdout (len %d) ---' % len(r.stdout))
        print(r.stdout[:3000] if r.stdout else '(empty)')
        print('--- stderr (len %d) ---' % len(r.stderr))
        print(r.stderr[:1000] if r.stderr else '(empty)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
