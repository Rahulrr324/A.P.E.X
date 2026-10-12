#!/usr/bin/env python3
import os

root = r'E:\My Local AI'
stark = os.path.join(root, 'stark')

print('=== TASK PHASE 1: host-capture path resolution check (read-only) ===')
host_csv = 'work/b7_diag_20261011_paired_capture/run2/paired_samples.csv'

for base in [root, stark]:
    resolved = os.path.normpath(os.path.join(base, host_csv))
    print(f'cwd base: {base}')
    print(f'  relative host_csv : {host_csv}')
    print(f'  resolved          : {resolved}')
    print(f'  exists            : {os.path.exists(resolved)}')
    print()

ref = os.path.normpath(os.path.join(root, host_csv))
print('reference (from project root):', ref)

from_stark = os.path.normpath(os.path.join(stark, host_csv))
print('from stark/        :', from_stark)
print('same as reference  :', ref == from_stark)
print()
print('intended parent (from root):', os.path.normpath(os.path.join(root, 'work/b7_diag_20261011_paired_capture/run2')))
print('parent from stark/        :', os.path.normpath(os.path.join(stark, 'work/b7_diag_20261011_paired_capture/run2')))
print()
print('stark/work/ exists:', os.path.isdir(os.path.join(stark, 'work')))
print('stark/work/b7_diag_20261011_paired_capture/run2 exists:', os.path.isdir(os.path.join(stark, 'work', 'b7_diag_20261011_paired_capture', 'run2')))
print()
print('validate_host_capture_path simulated results:')
def validate(raw):
    if not raw:
        return 'path empty'
    if ':' in raw:
        return 'absolute paths are not allowed (drive letters / schemes)'
    if raw[0] in ('/', '\\'):
        return 'absolute paths are not allowed'
    if '..' in raw:
        return "'..' path traversal is not allowed"
    forbidden = ['g7-campaign', 'g7cam', 'reports', 'records', '.jsonl', 'evidence_manifest', 'gate_results', 'tiny_dense_2l_weights.bin']
    low = raw.lower()
    for f in forbidden:
        if f in low:
            return f"path contains forbidden marker '{f}' (historical/production data must never be touched)"
    return ''
for candidate in [host_csv, '../' + host_csv]:
    print(f'  candidate {candidate!r} -> {validate(candidate)!r}')
