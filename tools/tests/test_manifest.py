import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_target_manifest import declared_sources, check


class ManifestTests(unittest.TestCase):
    def test_current_manifest_matches_all_declared_sources(self):
        self.assertEqual(check(Path(__file__).resolve().parents[2]), 58)

    def test_library_expands(self):
        text = 'set(SOURCES a.cpp b.cpp)\nadd_library(core STATIC ${SOURCES})\nadd_executable(test test.cpp)\ntarget_link_libraries(test PRIVATE core)'
        self.assertEqual(declared_sources(text), {'test': ['a.cpp', 'b.cpp', 'test.cpp']})

    def test_loop_expands(self):
        text = 'foreach(t one two)\nadd_executable(test_${t} tests/${t}.cpp)\nendforeach()'
        self.assertEqual(declared_sources(text), {'test_one': ['tests/one.cpp'], 'test_two': ['tests/two.cpp']})

    def test_reject_unknown_expression(self):
        with self.assertRaises(ValueError):
            declared_sources('add_executable(test ${UNRESOLVED})')

    def test_reject_unbound_variable(self):
        with self.assertRaises(ValueError):
            declared_sources('add_executable(test_${t} one.cpp)')

    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):
            declared_sources('add_executable(test one.cpp)\nadd_executable(test two.cpp)')

    def test_comments_not_treated_as_targets(self):
        self.assertEqual(declared_sources('# add_executable(bad x.cpp)\nadd_executable(ok y.cpp)'), {'ok':['y.cpp']})
