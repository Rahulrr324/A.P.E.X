import pathlib, subprocess, sys

root = pathlib.Path(r"E:\My Local AI")
runner = root / "work/b7_diag_20261011_paired_capture/phase19_planning/phase19_validate.py"
run_dir = root / "work/b7_diag_20261011_paired_capture/run2"
stdout_override = root / "work/b7_diag_20261011_paired_capture/run2_stdout.txt"
out_dir = root / "work/b7_diag_20261011_paired_capture/phase21_planning/validator_selftest"

out_dir.mkdir(parents=True, exist_ok=True)

proc = subprocess.run(
    [sys.executable, str(runner), "--run-dir", str(run_dir),
     "--stdout", str(stdout_override), "--out-dir", str(out_dir)],
    cwd=str(root),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    timeout=120,
)

print("validator_rc=", proc.returncode)
print("--- captured validator output ---")
print(proc.stdout)
print("--- validator outputs on disk ---")
for p in sorted(out_dir.iterdir()):
    print(" ", p.relative_to(root), p.stat().st_size, "bytes")
