import csv, statistics, os, sys

os.chdir("e:/My Local AI/stark")

csv_path = "e:/My Local AI/work/b7_diag_20261011_paired_capture/phase56_test_b100/paired_samples.csv"
with open(csv_path) as f:
    reader = csv.DictReader(f)
    rows = [(int(x['replicate']), int(x['iteration']), float(x['minimal_sec']), float(x['instrumented_sec']), float(x['signed_overhead_pct'])) for x in reader]

print(f'Total rows: {len(rows)}')
print(f'Unique keys: {len(set((r[0],r[1]) for r in rows))}')
rows.sort(key=lambda x: (x[0], x[1]))
mn = [r[2] for r in rows]
ins = [r[3] for r in rows]

# Validator method
mean_min = statistics.fmean(mn)
mean_ins = statistics.fmean(ins)
mean_ovh = 100.0 * (mean_ins - mean_min) / mean_min
worst = max(100.0 * (b - a) / a for a, b in zip(mn, ins))
med_min = statistics.median(mn)
med_ins = statistics.median(ins)
med_dev = 100.0 * abs(med_ins - med_min) / med_min

print(f'\n--- Validator/recompute method (statistics.median) ---')
print(f'mean_min_sec:    {mean_min:.12f}')
print(f'mean_ins_sec:    {mean_ins:.12f}')
print(f'mean_overhead_pct: {mean_ovh:.6f}  run.txt: 3.1126')
print(f'worst_case_pct:   {worst:.6f}  run.txt: 50.7066')
print(f'med_min_sec:     {med_min:.12f}')
print(f'med_ins_sec:     {med_ins:.12f}')
print(f'median_deviation_pct: {med_dev:.6f}  run.txt: 3.5242')
print(f'med_min_us (median): {med_min*1e6:.6f}  run.txt: 1511648.050')
print(f'med_ins_us (median): {med_ins*1e6:.6f}  run.txt: 1564920.900')

# Linear interpolation median
mn_us_sorted = sorted([r[2]*1e6 for r in rows])
ins_us_sorted = sorted([r[3]*1e6 for r in rows])
n = len(mn_us_sorted)
pos = 0.5*(n-1); lo = int(pos); hi = min(lo+1, n-1); frac = pos-lo
lin_min = mn_us_sorted[lo] + frac*(mn_us_sorted[hi]-mn_us_sorted[lo])
lin_ins = ins_us_sorted[lo] + frac*(ins_us_sorted[hi]-ins_us_sorted[lo])
print(f'\n--- Linear interpolation median (compute_statistics) ---')
print(f'med_min_us (lininterp): {lin_min:.6f}  run.txt: 1511648.050')
print(f'med_ins_us (lininterp): {lin_ins:.6f}  run.txt: 1564920.900')

# Means
mean_min_us = sum(r[2] for r in rows)/len(rows)*1e6
mean_ins_us = sum(r[3] for r in rows)/len(rows)*1e6
print(f'\nmean_min_us: {mean_min_us:.6f}  run.txt: 1385761.728')
print(f'mean_ins_us: {mean_ins_us:.6f}  run.txt: 1428894.259')
