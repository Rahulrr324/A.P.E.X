#!/usr/bin/env python3
import os, subprocess, sys

def run(cmd, cwd=None, timeout=60):
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or ''), (r.stderr or '')
    except subprocess.TimeoutExpired:
        return -1, '', 'TIMEOUT'
    except Exception as e:
        return -2, '', repr(e)

def git(cmd, cwd=None, timeout=60):
    exe = r'"C:\Program Files\Git\cmd\git.exe"'
    return run(exe + ' ' + cmd, cwd=cwd, timeout=timeout)

def main():
    cwd = r'E:\My Local AI'
    print('=== TASK PHASE 1: confirm project root and git state ===')
    print('cwd (python):', os.getcwd())
    rc, out, err = run('cmd /c "cd"', cwd=cwd, timeout=30)
    print('cwd (cmd):', out.strip() or err.strip() or 'no output')
    print('git version:')
    rc, out, err = git('--version', cwd=cwd, timeout=30)
    print(out.strip() or err.strip() or 'no output')
    print('git rev-parse is-inside-work-tree:')
    rc, out, err = git('rev-parse --is-inside-work-tree', cwd=cwd, timeout=30)
    print((out.strip() or err.strip() or 'no output'))
    print('git branch --show-current:')
    rc, out, err = git('branch --show-current', cwd=cwd, timeout=30)
    print((out.strip() or err.strip() or 'no output'))
    print('git remote -v:')
    rc, out, err = git('remote -v', cwd=cwd, timeout=30)
    print((out.strip() or err.strip() or 'no output'))
    print('git status --short (first 300 lines):')
    rc, out, err = run('"C:\Program Files\Git\cmd\git.exe" -c core.pager=cat status --short', cwd=cwd, timeout=90)
    lines = (out or err or '').splitlines()
    print('\n'.join(lines[:300]) or 'no output')
    print('git status --short line count:', len(lines))
    return 0

if __name__ == '__main__':
    sys.exit(main())
