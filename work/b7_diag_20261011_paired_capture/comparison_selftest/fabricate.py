import csv, io, json, pathlib, statistics

def fabricate_one(run_id):
    out_dir = pathlib.Path('work/b7_diag_20261011_paired_capture/phase19_planning/comparison_selftest') / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'ops').mkdir(exist_ok=True)

    base_min = [0.9e-3, 1e-3, 1.1e-3, 1.5e-3, 0.8e-3, 1e-3]
    outlier_replicate = 2
    outlier_iteration = 7
    outlier_overhead_pct = 109.0882

    rows = []
    for r in range(6):
        base = base_min[r]
        for i in range(50):
            v = base + i * 2e-5
            if r == outlier_replicate and i == outlier_iteration:
                v_ins = v * (1 + outlier_overhead_pct / 100.0)
                p = outlier_overhead_pct
            else:
                v_ins = v * 1.08550597
                p = 100.0 * (v_ins - v) / v
            rows.append({
                'replicate': r,
                'iteration': i,
                'minimal_sec': v,
                'instrumented_sec': v_ins,
                'signed_overhead_pct': p,
            })

    mn = [x['minimal_sec'] for x in rows]
    ins_list = [x['instrumented_sec'] for x in rows]
    mean_pct = 100.0 * (statistics.fmean(ins_list) - statistics.fmean(mn)) / statistics.fmean(mn)
    worst_pct = max(100.0 * (ins_list[i] - mn[i]) / mn[i] for i in range(len(rows)))
    med_dev = 100.0 * abs(statistics.median(ins_list) - statistics.median(mn)) / statistics.median(mn)

    t = io.StringIO()
    w = csv.DictWriter(t, fieldnames=['replicate', 'iteration', 'minimal_sec', 'instrumented_sec', 'signed_overhead_pct'], lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
    (out_dir / 'paired_samples.csv').write_text(t.getvalue())

    lines = [
        f'mean_overhead_pct       = {mean_pct:.6f} %',
        f'worst_case_overhead_pct = {worst_pct:.6f} %',
        f'median_deviation_pct    = {med_dev:.6f} %',
    ]
    (out_dir / 'ops' / 'stdout.txt').write_text('\n'.join(lines) + '\n')

    condition = 'unpinned' if int(run_id[-1]) % 2 == 1 else 'pinned'
    meta = {
        'run': run_id,
        'order': int(run_id[-1]),
        'condition': condition,
        'launch': {
            'mask_intended': None if condition == 'unpinned' else 0x1,
            'mask_cpus': [0],
            'affinity_verified_before_resume': True,
            'exit_code': 0,
        },
    }
    (out_dir / 'ops' / 'exec_meta.json').write_text(json.dumps(meta, indent=2))
    print('fabricated', run_id, 'mean=', round(mean_pct, 6), 'worst=', round(worst_pct, 6), 'meddev=', round(med_dev, 6))

for r in ('p19r1', 'p19r2', 'p19r3'):
    fabricate_one(r)

print('done')
