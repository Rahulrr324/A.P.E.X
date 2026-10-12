import os, subprocess, sys
exe = "stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
print("exe:", repr(exe))
print("exists:", os.path.exists(exe), "lexists:", os.path.lexists(exe), "abspath:", os.path.abspath(exe))
print("cwd:", os.getcwd())
rc = os.system('cmd /c echo launch-via-cmd-rc=%errorlevel% && "' + exe + '" --help >/dev/null 2>&1')
print("os.system rc:", rc)
try:
    p = subprocess.run([exe], capture_output=True, text=True, timeout=5)
    print("subprocess direct rc:", p.returncode, "stdout len:", len(p.stdout), "stderr len:", len(p.stderr))
except Exception as e:
    print("subprocess direct error:", type(e).__name__, str(e)[:300])
