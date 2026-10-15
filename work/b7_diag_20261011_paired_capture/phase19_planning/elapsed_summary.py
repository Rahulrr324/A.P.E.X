import pathlib, json

root = pathlib.Path(r'E:\My Local AI')
base = root / 'work/b7_diag_20261011_paired_capture/phase19_runs'
runs = ['p19r1','p19r2','p19r3','p19r4','p19r5','p19r6']
elapsed = []
for r in runs:
    p = base / r / 'ops' / 'exec_meta.json'
    m = json.loads(p.read_text(encoding='utf-8'))
    elapsed.append(m['elapsed_sec'])
print('elapsed per run:', elapsed)
print('sum sec:', sum(elapsed), 'min:', min(elapsed), 'max:', max(elapsed))
print('mean sec:', round(sum(elapsed)/len(elapsed), 3))
