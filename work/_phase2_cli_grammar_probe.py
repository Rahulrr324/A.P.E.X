#!/usr/bin/env python3
import sys

def parse(argv):
    args = list(argv[1:])
    diag_dir = None
    host_capture_dir = None
    i = 0
    seen_host = False
    while i < len(args):
        a = args[i]
        if a == '--diagnostic-dir':
            if i + 1 >= len(args):
                return None, 'missing value for --diagnostic-dir'
            diag_dir = args[i + 1]
            i += 2
        elif a == '--host-capture-dir':
            if seen_host:
                return None, 'duplicate --host-capture-dir'
            if i + 1 >= len(args):
                return None, 'missing value for --host-capture-dir'
            host_capture_dir = args[i + 1]
            seen_host = True
            i += 2
        elif a == '--help' or a == '-h':
            return None, 'help'
        else:
            return None, 'unknown option: ' + a
    return (diag_dir, host_capture_dir), None

cases = [
    ([], 'legacy no-arg'),
    (['build/bm_b7_diagnostic'], 'legacy one-positional'),
    (['--help'], 'help'),
    (['--host-capture-dir', 'work/b7_diag_20261011_paired_capture/run2'], 'host only'),
    (['--diagnostic-dir', 'build/bm_b7_diagnostic', '--host-capture-dir', 'work/b7_diag_20261011_paired_capture/run2'], 'both'),
    (['--host-capture-dir'], 'missing host value'),
    (['--host-capture-dir', 'a', '--host-capture-dir', 'b'], 'duplicate host'),
    (['--nope'], 'unknown option'),
    (['/e/My Local AI/stark/build/bm_b7_diagnostic'], 'absolute diag (should be treated as unknown option or rejected if positional form changes)'),
]

for argv, label in cases:
    parsed, err = parse(argv)
    print(f'{label:30s} argv={argv} -> err={err!r} parsed={parsed!r}')
