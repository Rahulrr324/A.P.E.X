"""Process-boundary persistence checks, explicitly enabled with APEX_NATIVE_BIN.

Only runs profiler metadata capture and developer safety fixtures, never an
E1/E2/E5 arm, training run, learning driver or acceptance campaign.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BIN = os.environ.get("APEX_NATIVE_BIN")


@unittest.skipUnless(BIN, "APEX_NATIVE_BIN not set: native process integration NOT RUN")
class NativeLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.suffix = '.exe' if os.name == 'nt' else ''

    def executable(self, name):
        p = Path(BIN) / (name + self.suffix)
        self.assertTrue(p.is_file(), 'required binary not built: '+str(p))
        return str(p)

    def test_profiler_restart_keeps_first_records(self):
        exe = self.executable('profiler_cli')
        records = self.root / 'records'
        first = subprocess.run([exe, '--out', str(records)], capture_output=True, text=True, timeout=30)
        self.assertEqual(first.returncode, 0, first.stderr)
        before = {p.name: p.read_bytes() for p in records.glob('*.json')}
        self.assertEqual(len(before), 2)
        second = subprocess.run([exe, '--out', str(records)], capture_output=True, text=True, timeout=30)
        self.assertEqual(second.returncode, 0, second.stderr)
        after = {p.name: p.read_bytes() for p in records.glob('*.json')}
        self.assertEqual(len(after), 4)
        for name, data in before.items(): self.assertEqual(after[name], data)
        for data in after.values(): self.assertEqual(json.loads(data)['schema_version'], 'STARKP1 1')
        self.assertFalse(any(p.name.startswith('.append-') for p in records.iterdir()))

    def test_competing_processes_publish_only_one_complete_record(self):
        exe = self.executable('test_phase1_store_safety')
        records = self.root / 'records'
        # Pre-create only the shared root; staging reservation/publication must still race safely.
        records.mkdir()
        processes = [subprocess.Popen([exe, '--append-once', str(records), 'P1-RACE-PROCESS'],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(12)]
        codes = []
        try:
            for proc in processes:
                proc.communicate(timeout=30)
                codes.append(proc.returncode)
        finally:
            for proc in processes:
                if proc.poll() is None:
                    proc.kill(); proc.communicate()
        self.assertEqual(codes.count(0), 1, codes)
        self.assertEqual(codes.count(7), 11, codes)
        paths = list(records.iterdir())
        self.assertEqual(len(paths), 1)
        record = json.loads(paths[0].read_text())
        self.assertEqual(record['record_id'], 'P1-RACE-PROCESS')
        self.assertEqual(record['schema_version'], 'STARKP1 1')

    def test_record_inspector_reports_corruption_without_modification(self):
        producer = self.executable('profiler_cli')
        inspector = self.executable('record_inspector')
        records = self.root / 'records'
        subprocess.run([producer, '--out', str(records)], check=True, capture_output=True, timeout=30)
        before = {p.name: p.read_bytes() for p in records.iterdir()}
        result = subprocess.run([inspector, str(records)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['record_count'], 2)
        self.assertEqual(data['invalid_count'], 0)
        self.assertEqual(before, {p.name: p.read_bytes() for p in records.iterdir()})
        (records / 'broken.json').write_text('{')
        result = subprocess.run([inspector, str(records)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['invalid_count'], 1)
        self.assertEqual((records/'broken.json').read_text(), '{')
        self.assertEqual(before, {p.name: p.read_bytes() for p in records.iterdir() if p.name != 'broken.json'})

    def test_record_inspector_enforces_budgets(self):
        inspector = self.executable('record_inspector')
        self.assertEqual(subprocess.run([inspector, str(self.root/'missing')], capture_output=True).returncode, 2)
        records = self.root / 'records'; records.mkdir()
        (records/'one.json').write_text('{}')
        (records/'two.json').write_text('{}')
        p = subprocess.run([inspector, str(records), '--max-files', '1'], capture_output=True)
        self.assertEqual(p.returncode, 2)
        p = subprocess.run([inspector, str(records), '--max-bytes', '1'], capture_output=True)
        self.assertEqual(p.returncode, 2)
        for bad in ['0','-1','1000000000000000000000','1x']:
            p = subprocess.run([inspector, str(records), '--max-files', bad], capture_output=True)
            self.assertEqual(p.returncode, 2)

    def test_unsafe_id_does_not_create_outside_file(self):
        exe = self.executable('test_phase1_store_safety')
        proc = subprocess.run([exe, '--append-once', str(self.root/'records'), '../escape'], timeout=30)
        self.assertEqual(proc.returncode, 7)
        self.assertFalse((self.root/'escape.json').exists())
