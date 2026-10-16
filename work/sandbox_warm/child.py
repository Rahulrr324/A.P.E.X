
import sys, pathlib, json, csv, shutil, time, datetime, statistics, hashlib, io
ROOT=pathlib.Path(r"E:\My Local AI")
EXE=str(ROOT/'stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe')
sys.path.insert(0, str(ROOT/'stark/src'))
import phase1 as P1
from phase1.diagnostics import bm_b7_diagnostic
from phase1.diagnostics.bm_b7_diagnostic import run_bm_b7_diagnostic, Protocol

blob_relative = 'work/sandbox_warm/bm_b7_diagnostic_weights.bin'
print('CHILD_START')

cry = ROOT/'build'/'bm_b7_diagnostic'/'c8'
if cry.exists():
    shutil.rmtree(cry)
hc = ROOT/'work'/'sandbox_warm'/'c8pop'
if hc.exists():
    shutil.rmtree(hc)

for k in range(3):
    csv_bytes, elapsed_sec, diagnosis = run_bm_b7_diagnostic(
        Protocol(macro_replicates=8),
        exe=EXE,
        workdir=str(ROOT),
        diagnostic_dir_relative='build/bm_b7_diagnostic/c8',
        host_capture_dir_relative=f'work/sandbox_warm/c8pop{k}/',
        blob_relative=blob_relative,
    )
    open(f'work/sandbox_warm/c8pop{k}_out.csv','wb').write(csv_bytes)
    minimal_rows=0; instr_rows=0
    for row in csv.DictReader(io.StringIO(csv_bytes.decode('latin1'))):
        if float(row['minimal_sec'])>0 and float(row['instrumented_sec'])>0:
            minimal_rows+=1; instr_rows+=1
    print('POPmini', minimal_rows, 'instr', instr_rows, 'elapsed_sec', round(elapsed_sec,3), 'csv_bytes', len(csv_bytes))
if __name__ == '__main__':
    print('CHILD_DONE')
