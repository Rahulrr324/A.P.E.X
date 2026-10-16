
import sys, pathlib, subprocess, hashlib
ROOT=pathlib.Path(r"E:\My Local AI")
EXE=str(ROOT/'stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe')
import os
os.chdir(str(ROOT))
# Run the diagnostic once with the expected args to confirm basic smoke on this builder.
p=subprocess.run([EXE,'build/bm_b7_diagnostic/xorprobe','--host-capture-dir','work/sandbox_xor/prob1'],
                 capture_output=True, text=True, timeout=120)
print('RC', p.returncode)
print('stdout lines', len(p.stdout.splitlines()))
print('stderr', p.stderr[:200])
print('has paired_samples.csv:', (ROOT/'work/sandbox_xor/prob1/paired_samples.csv').exists())
if (ROOT/'work/sandbox_xor/prob1/paired_samples.csv').exists():
    raw=(ROOT/'work/sandbox_xor/prob1/paired_samples.csv').read_bytes()
    print('csv sha256', hashlib.sha256(raw).hexdigest())
    print('csv bytes', len(raw))
