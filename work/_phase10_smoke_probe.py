#!/usr/bin/env python3
import subprocess, pathlib, sys

REL = 'stark/build-b7diag-20261011/bm_b7_diagnostic.exe'
EXPECTED = 'a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6'

def sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()

def main():
    resolved = pathlib.Path(REL).resolve()
    exe_str = str(resolved)
    print('resolved:', exe_str)
    print('sha256:', sha256_file(exe_str))
    print('matches expected:', sha256_file(exe_str) == EXPECTED, file=sys.stderr)

    cmd = [exe_str]
    print('cmd:', cmd, file=sys.stderr)
    print('cwd:', str(resolved.parent), file=sys.stderr)

    r = subprocess.run(cmd, capture_output=True, text=True,
                       cwd=str(resolved.parent), shell=False, timeout=90)
    print('rc:', r.returncode, file=sys.stderr)

    out_path = pathlib.Path('work/b7_diag_20261011_paired_capture/run10_probe_stdout.txt')
    err_path = pathlib.Path('work/b7_diag_20261011_paired_capture/run10_probe_stderr.txt')
    out_path.write_text(r.stdout)
    err_path.write_text(r.stderr)
    print('wrote', out_path, err_path, file=sys.stderr)

    print('--- stdout (first 3000 chars) ---', file=sys.stderr)
    print(r.stdout[:3000], file=sys.stderr)
    print('--- stderr (first 500 chars) ---', file=sys.stderr)
    print(r.stderr[:500], file=sys.stderr)
    return 0

if __name__ == '__main__':
    sys.exit(main())
