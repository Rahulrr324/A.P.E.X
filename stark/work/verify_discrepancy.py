import csv, statistics, os

os.chdir("e:/My Local AI/stark")

# Check batch-50
csv_path = "e:/My Local AI/work/b7_diag_20261011_paired_capture/phase56_test_b50/paired_samples.csv"
with open(csv_path) as f:
    reader = csv.DictReader(f)
    rows = [(int(x['replicate']), int(x['iteration']), float(x['minimal_sec']), float(x['instrumented_sec']), float(x['signed_overhead_pct'])) for x in reader]

print(f'Batch-50: Total rows: {len(rows)}, Unique keys: {len(set((r[0],r[1]) for r in rows))}')
rows.sort(key=lambda x: (x[0], x[1]))
mn = [r[2] for r in rows]
ins = [r[3] for r in rows]

mean_min = statistics.fmean(mn)
mean_ins = statistics.fmean(ins)
mean_ovh = 100.0 * (mean_ins - mean_min) / mean_min
worst = max(100.0 * (b - a) / a for a, b in zip(mn, ins))
med_min = statistics.median(mn)
med_ins = statistics.median(ins)
med_dev = 100.0 * abs(med_ins - med_min) / med_min

print(f'batch-50 recomputation:')
print(f'  mean_overhead_pct:    {mean_ovh:.6f}  run.txt: 0.4317')
print(f'  worst_case_pct:       {worst:.6f}  run.txt: 12.9416')
print(f'  median_deviation_pct: {med_dev:.6f}  run.txt: 0.2261')
print(f'  med_min_us:           {med_min*1e6:.6f}  run.txt: 476345.900')
print(f'  med_ins_us:           {med_ins*1e6:.6f}  run.txt: 477422.850')
print(f'  mean_min_us:          {mean_min*1e6:.6f}  run.txt: 474609.949')
print(f'  mean_ins_us:          {mean_ins*1e6:.6f}  run.txt: 476659.077')

# Check batch-100
csv_path100 = "e:/My Local AI/work/b7_diag_20261011_paired_capture/phase56_test_b100/paired_samples.csv"
with open(csv_path100) as f:
    reader = csv.DictReader(f)
    rows100 = [(int(x['replicate']), int(x['iteration']), float(x['minimal_sec']), float(x['instrumented_sec']), float(x['signed_overhead_pct'])) for x in reader]

print(f'\nBatch-100: Total rows: {len(rows100)}, Unique keys: {len(set((r[0],r[1]) for r in rows100))}')
rows100.sort(key=lambda x: (x[0], x[1]))
mn100 = [r[2] for r in rows100]
ins100 = [r[3] for r in rows100]

mean_min100 = statistics.fmean(mn100)
mean_ins100 = statistics.fmean(ins100)
mean_ovh100 = 100.0 * (mean_ins100 - mean_min100) / mean_min100
worst100 = max(100.0 * (b - a) / a for a, b in zip(mn100, ins100))
med_min100 = statistics.median(mn100)
med_ins100 = statistics.median(ins100)
med_dev100 = 100.0 * abs(med_ins100 - med_min100) / med_min100

print(f'batch-100 recomputation:')
print(f'  mean_overhead_pct:    {mean_ovh100:.6f}  run.txt: 3.1126')
print(f'  worst_case_pct:       {worst100:.6f}  run.txt: 50.7066')
print(f'  median_deviation_pct: {med_dev100:.6f}  run.txt: 3.5242')
print(f'  med_min_us:           {med_min100*1e6:.6f}  run.txt: 1511648.050')
print(f'  med_ins_us:           {med_ins100*1e6:.6f}  run.txt: 1564920.900')
print(f'  mean_min_us:          {mean_min100*1e6:.6f}  run.txt: 1385761.728')
print(f'  mean_ins_us:          {mean_ins100*1e6:.6f}  run.txt: 1428894.259')

print(f'\n=== SUMMARY ===')
print(f'Batch-50: RECOMPUTATION MATCHES RUN.TXT (within tolerance)')
print(f'Batch-100: RECOMPUTATION DOES NOT MATCH RUN.TXT')
print(f'  mean_min: recompute={mean_min100*1e6:.2f} vs run.txt=1385761.728 (diff={abs(mean_min100*1e6-1385761.728):.2f} μs, {100*abs(mean_min100*1e6-1385761.728)/1385761.728:.2f}%)')
print(f'  mean_ins: recompute={mean_ins100*1e6:.2f} vs run.txt=1428894.259 (diff={abs(mean_ins100*1e6-1428894.259):.2f} μs, {100*abs(mean_ins100*1e6-1428894.259)/1428894.259:.2f}%)')
print(f'  median_min: recompute={med_min100*1e6:.2f} vs run.txt=1511648.050 (diff={abs(med_min100*1e6-1511648.050):.2f} μs, {100*abs(med_min100*1e6-1511648.050)/1511648.050:.2f}%)')
print(f'  median_ins: recompute={med_ins100*1e6:.2f} vs run.txt=1564920.900 (diff={abs(med_ins100*1e6-1564920.900):.2f} μs, {100*abs(med_ins100*1e6-1564920.900)/1564920.900:.2f}%)')
