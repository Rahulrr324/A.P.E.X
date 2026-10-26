"""Tests for the validator itself; these do not claim a CMake/CTest runtime pass."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import validate


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        (self.source / "stark").mkdir(parents=True)
        (self.source / "stark/main.cpp").write_text("int main(){}\n")
        self.manifest = self.root / "targets.json"
        self.target = dict(name="test_sample", sources=["main.cpp"], test=True,
                           windows_only=False, windows_libraries=[])
        self.manifest.write_text(json.dumps(dict(schema_version=1, targets=[self.target])))

    def runner(self):
        return validate.Runner(self.source, self.root / "output", timeout=1)

    def test_success_command_has_actual_exit_and_log(self):
        runner = self.runner()
        c = runner.command([sys.executable, "-c", "print('observable')"], "success")
        self.assertEqual((c.state, c.exit_code), ("EXECUTED", 0))
        self.assertIn("observable", (runner.output / c.log).read_text())
        self.assertGreater(c.seconds, 0)

    def test_command_failure_not_hidden(self):
        c = self.runner().command([sys.executable, "-c", "raise SystemExit(7)"], "failure")
        self.assertEqual(c.exit_code, 7)

    def test_missing_tool_is_blocked_not_pass(self):
        c = self.runner().command([str(self.root / "nonexistent-tool")], "missing")
        self.assertEqual(c.state, "BLOCKED")
        self.assertIsNone(c.exit_code)

    def test_timeout_is_not_execution_success(self):
        r = self.runner()
        r.timeout = .05
        c = r.command([sys.executable, "-c", "while True: pass"], "timeout")
        self.assertEqual(c.state, "TIMEOUT")
        self.assertIsNone(c.exit_code)

    def test_refuses_reusing_previous_output(self):
        r = self.runner()
        (r.output / "marker").write_text("retain")
        with self.assertRaises(FileExistsError):
            self.runner()
        self.assertEqual((r.output / "marker").read_text(), "retain")

    def test_refuses_source_tree_output(self):
        with self.assertRaises(ValueError):
            validate.Runner(self.source, self.source / "build")
        self.assertFalse((self.source / "build").exists())

    def test_source_path_cannot_escape(self):
        (self.root / "escape.cpp").write_text("private")
        self.target["sources"] = ["../../escape.cpp"]
        self.manifest.write_text(json.dumps(dict(schema_version=1, targets=[self.target])))
        with self.assertRaises(ValueError):
            validate.load_manifest(self.manifest, self.source)

    def test_duplicate_target_rejected(self):
        self.manifest.write_text(json.dumps(dict(schema_version=1, targets=[self.target, self.target])))
        with self.assertRaises(ValueError):
            validate.load_manifest(self.manifest, self.source)

    def test_missing_source_rejected(self):
        (self.source / "stark/main.cpp").unlink()
        with self.assertRaises(ValueError):
            validate.load_manifest(self.manifest, self.source)

    def test_schema_version_rejected(self):
        self.manifest.write_text('{"schema_version":2,"targets":[]}')
        with self.assertRaises(ValueError):
            validate.load_manifest(self.manifest, self.source)

    def test_non_boolean_metadata_rejected(self):
        self.target["test"] = "true"
        self.manifest.write_text(json.dumps(dict(schema_version=1, targets=[self.target])))
        with self.assertRaises(ValueError):
            validate.load_manifest(self.manifest, self.source)

    def test_success_report_and_manifest(self):
        r = self.runner()
        r.result("sample", "test", "PASS")
        self.assertEqual(r.finish("compiler", "now"), 0)
        self.assertTrue(json.loads((r.output / "report.json").read_text())["successful"])
        self.assertIn("report.json", (r.output / "FILES.sha256").read_text())

    def test_failed_report_returns_nonzero(self):
        r = self.runner()
        r.result("sample", "test", "FAIL")
        self.assertEqual(r.finish("compiler", "now"), 1)

    def test_skip_only_is_not_a_success(self):
        r = self.runner()
        r.result("win", "build", "SKIP")
        self.assertEqual(r.finish("compiler", "now"), 1)

    def test_empty_report_is_not_a_success(self):
        self.assertEqual(self.runner().finish("compiler", "now"), 1)

    def test_failed_compile_does_not_link_or_execute(self):
        r = self.runner()
        calls = []
        def fail(argv, label, cwd=None):
            calls.append(label)
            return validate.Command(argv, str(self.source), 9, "EXECUTED", .1, "not-created")
        with patch.object(r, "command", side_effect=fail):
            self.assertFalse(validate.compile_targets(r, [self.target], "not-a-compiler", 1, "none"))
            validate.execute_tests(r, [self.target], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual([x["state"] for x in r.results], ["FAIL", "NOT_RUN"])

    def test_compilation_reuses_shared_translation_unit(self):
        r = self.runner()
        other = dict(self.target, name="test_other")
        calls = []
        def success(argv, label, cwd=None):
            calls.append(label)
            return validate.Command(argv, str(self.source), 0, "EXECUTED", .1, "fixture")
        with patch.object(r, "command", side_effect=success):
            self.assertTrue(validate.compile_targets(r, [self.target, other], "c++", 1, "none"))
        self.assertEqual(sum(x.startswith("compile_") for x in calls), 1)
        self.assertEqual(sum(x.startswith("link_") for x in calls), 2)

    def test_source_change_during_build_invalidates_result(self):
        r = self.runner()
        r.result("sample", "build", "PASS")
        (self.source / "stark/src").mkdir()
        (self.source / "stark/src/new.cpp").write_text("int main(){return 1;}\n")
        self.assertEqual(r.finish("compiler", "now"), 1)
        report = json.loads((r.output / "report.json").read_text())
        self.assertIn("stark/src/new.cpp", report["input_changes"])

    def test_debug_build_has_no_ndebug_and_release_has_it(self):
        for mode in ["Debug", "Release"]:
            r = validate.Runner(self.source, self.root / mode)
            calls = []
            def success(argv, label, cwd=None):
                calls.append(argv)
                return validate.Command(argv, str(self.source), 0, "EXECUTED", .1, "fixture")
            with patch.object(r, "command", side_effect=success):
                validate.compile_targets(r, [self.target], "c++", 1, "none", mode)
            self.assertEqual("-DNDEBUG" in calls[0], mode == "Release")
            self.assertEqual("-O0" in calls[0], mode == "Debug")

    def test_sanitizer_errors_are_not_recoverable_successes(self):
        r = self.runner()
        calls = []
        def success(argv, label, cwd=None):
            calls.append(argv)
            return validate.Command(argv, str(self.source), 0, "EXECUTED", .1, "fixture")
        with patch.object(r, "command", side_effect=success):
            validate.compile_targets(r, [self.target], "c++", 1, "undefined")
        self.assertTrue(all("-fno-sanitize-recover=all" in command for command in calls))

    def test_cmake_failure_prevents_build_and_tests(self):
        r = self.runner()
        calls = []
        def command(argv, label, cwd=None):
            calls.append(label)
            code = 1 if label == "configure" else 0
            return validate.Command(argv, str(self.source), code, "EXECUTED", .1, "fixture")
        with patch.object(r, "command", side_effect=command):
            validate.cmake_checks(r, 1, 1, [])
        self.assertEqual(calls, ["cmake_version", "ctest_version", "configure"])
        self.assertEqual(r.results[-1]["state"], "FAIL")

    def test_cmake_missing_tool_prevents_configure(self):
        r = self.runner()
        with patch.object(r, "command", return_value=validate.Command([], "", None, "BLOCKED", 0, "fixture")) as c:
            validate.cmake_checks(r, 1, 1, [])
        self.assertEqual(c.call_count, 1)
        self.assertEqual(r.results[-1]["state"], "BLOCKED")

    def test_cmake_zero_inventory_is_failure(self):
        r = self.runner()
        (r.output / "empty.txt").write_text("Total Tests: 0\n")
        calls = []
        def command(argv, label, cwd=None):
            calls.append(label)
            return validate.Command(argv, str(self.source), 0, "EXECUTED", .1, "empty.txt")
        with patch.object(r, "command", side_effect=command):
            validate.cmake_checks(r, 1, 1, [])
        self.assertNotIn("ctest_1", calls)
        self.assertEqual(r.results[-1]["state"], "FAIL")

    def test_cmake_test_failure_propagates(self):
        r = self.runner()
        (r.output / "inventory.txt").write_text("Total Tests: 1\n")
        def command(argv, label, cwd=None):
            return validate.Command(argv, str(self.source), 8 if label.startswith("ctest_") and label != "ctest_version" else 0,
                                    "EXECUTED", .1, "inventory.txt")
        with patch.object(r, "command", side_effect=command):
            validate.cmake_checks(r, 1, 1, [])
        self.assertEqual(r.results[-1]["state"], "FAIL")
        self.assertEqual(r.finish("cmake", "now"), 1)

    def test_fixture_missing_is_blocked_before_execution(self):
        r = self.runner()
        t = dict(self.target, name="test_phase1_gates")
        r.result(t["name"], "build", "PASS")
        with patch.object(r, "command") as call:
            validate.execute_tests(r, [t], 1)
        call.assert_not_called()
        self.assertEqual(r.results[-1]["state"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
