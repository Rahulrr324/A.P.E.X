"""Deterministic codec property tests against Python's independent JSON codec.

No model, research arm, training corpus, hardware measurement or gate is run.
Valid cases stay within uint64/int64/double and Unicode scalar representation.
"""
import json
import os
from pathlib import Path
import random
import subprocess
import unittest

BIN = os.environ.get('APEX_NATIVE_BIN')


@unittest.skipUnless(BIN, 'APEX_NATIVE_BIN absent: native codec property checks NOT RUN')
class NativeJsonProperties(unittest.TestCase):
    def exchange(self, lines):
        suffix = '.exe' if os.name == 'nt' else ''
        binary = Path(BIN)/('test_phase1_json_codec'+suffix)
        self.assertTrue(binary.is_file(), str(binary))
        proc = subprocess.run([str(binary), '--parse-lines'], input='\n'.join(lines)+'\n',
                              capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(len(result), len(lines))
        return result

    def test_valid_values_roundtrip_1500_cases(self):
        rng = random.Random(20261026)
        alphabet = list('abcABC012 \\"\t\b\f\r\n') + list('தமிழ்') + ['😀','é','中','\x00']
        def value(depth):
            choices = 4 if depth >= 4 else 6
            kind = rng.randrange(choices)
            if kind == 0: return rng.choice([None, True, False])
            if kind == 1: return rng.randrange(-(2**63), 2**64)
            if kind == 2: return rng.uniform(-1e100, 1e100)
            if kind == 3: return ''.join(rng.choice(alphabet) for _ in range(rng.randrange(50)))
            if kind == 4: return [value(depth+1) for _ in range(rng.randrange(5))]
            return {'key-'+str(i):value(depth+1) for i in range(rng.randrange(5))}
        values = [value(0) for _ in range(1500)]
        encoded = [json.dumps(v, ensure_ascii=bool(i%2), allow_nan=False) for i,v in enumerate(values)]
        results = self.exchange(encoded)
        for i,(expected,observed) in enumerate(zip(values,results)):
            with self.subTest(case=i):
                self.assertTrue(observed['ok'], observed)
                self.assertEqual(observed['value'], expected)

    def test_invalid_grammar_300_cases(self):
        cases = []
        for n in range(1,51):
            cases.extend([f'0{n}',f'+{n}',f'{n}.',f'{n}e+',f'{n}..5',f'{{"x":{n},"x":{n}}}'])
        for i,result in enumerate(self.exchange(cases)):
            with self.subTest(case=i): self.assertFalse(result['ok'])

    def test_resource_bounds_and_recovery_after_error(self):
        lines = ['"'+('a'*65537)+'"', '"unterminated', '{"next":"valid"}']
        results = self.exchange(lines)
        self.assertFalse(results[0]['ok'])
        self.assertFalse(results[1]['ok'])
        self.assertEqual(results[2], {'ok':True, 'value':{'next':'valid'}})
