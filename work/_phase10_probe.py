#!/usr/bin/env python3
import subprocess, pathlib, hashlib, sys

REL = 'stark/build-b7diag-20261011/bm_b7_diagnostic.exe'
EXPECTED = 'a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6'

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()

def main():
    resolved = pathlib.Path(REL).resolve()
    print('=== resolved native path ===')
    print(str(resolved))
    print('=== sha256 of resolved exe ===')
    got = sha256_file(str(resolved))
    print(got)
    print('matches expected:', got == EXPECTED)
    print('=== launch probe ===')
    cmd = [str(resolved)]
    print('cmd:', cmd)
    print('cwd:', str(resolved.parent))
    r = subprocess.run(cmd, capture_output=True, text=True,
                       cwd=str(resolved.parent), shell=False, timeout=60)
    print('rc:', r.returncode)
    print('--- stdout (len %d) ---' % len(r.stdout))
    print(r.stdout[:3000] if r.stdout else '(empty)')
    print('--- stderr (len %d) ---' % len(r.stderr))
    print(r.stderr[:1000] if r.stderr else '(empty)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
