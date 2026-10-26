#!/usr/bin/env python3
"""Reproducible, non-acceptance developer checks. Python 3.10+, standard library only.

CMake is authoritative. The explicitly selected compiler engine checks reviewed
source lists, not CMake evaluation. No campaign/experiment program is ever run.
All generated objects, binaries, test state and reports live outside the source.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

SCHEMA = "apex.development-validation/1"


@dataclass
class Command:
    argv: list[str]
    cwd: str
    exit_code: int | None
    state: str
    seconds: float
    log: str


class Runner:
    def __init__(self, source: Path, output: Path, timeout: float = 300):
        self.source = source.resolve()
        self.output = output.resolve()
        # New directory only: never reuse old binaries or overwrite prior reports.
        if self.output == self.source or self.source in self.output.parents:
            raise ValueError("validation output must be outside the source tree")
        self.output.mkdir(parents=True, exist_ok=False)
        (self.output / "logs").mkdir()
        self.timeout = timeout
        self.commands: list[Command] = []
        self.results: list[dict] = []
        self.environment: dict = {}
        self.input_hashes = self.fingerprint()

    def fingerprint(self):
        paths = [self.source / "stark/CMakeLists.txt", self.source / "tools/targets.json"]
        for folder in ["stark/src", "stark/tests", "tools"]:
            paths.extend(p for p in (self.source / folder).rglob("*")
                         if p.is_file() and p.suffix in {".cpp", ".h", ".inc", ".py"})
        return {str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(set(paths)) if p.is_file()}

    def command(self, argv: list[str], label: str, cwd: Path | None = None) -> Command:
        cwd = (cwd or self.source).resolve()
        log = self.output / "logs" / (label + ".txt")
        start = time.monotonic()
        try:
            result = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=self.timeout,
                                    check=False)
            code, state, text = result.returncode, "EXECUTED", result.stdout
        except FileNotFoundError as exc:
            code, state, text = None, "BLOCKED", str(exc).encode()
        except subprocess.TimeoutExpired as exc:
            code, state, text = None, "TIMEOUT", exc.stdout or b""
        except OSError as exc:
            code, state, text = None, "BLOCKED", str(exc).encode()
        seconds = time.monotonic() - start
        with log.open("xb") as stream:
            stream.write((json.dumps({"argv": argv, "cwd": str(cwd)}) + "\n").encode())
            stream.write(text)
            stream.write((f"\nstate={state} exit_code={code} seconds={seconds:.6f}\n").encode())
        cmd = Command(argv, str(cwd), code, state, seconds, str(log.relative_to(self.output)))
        self.commands.append(cmd)
        return cmd

    def result(self, name: str, stage: str, state: str, **extra):
        self.results.append(dict(name=name, stage=stage, state=state, **extra))
        print(f"{stage:10s} {name:36s} {state}", flush=True)

    def finish(self, engine: str, started: str) -> int:
        final_hashes = self.fingerprint()
        changed = sorted(k for k in set(self.input_hashes) | set(final_hashes)
                         if self.input_hashes.get(k) != final_hashes.get(k))
        self.result("source snapshot", "integrity", "FAIL" if changed else "PASS", changed_paths=changed)
        failures = [x for x in self.results if x["state"] in {"FAIL", "BLOCKED", "TIMEOUT"}]
        report = dict(schema=SCHEMA, purpose="development checks, not acceptance",
                      engine=engine, started_utc=started,
                      source=str(self.source), environment=self.environment,
                      input_sha256=self.input_hashes, input_changes=changed,
                      commands=[asdict(c) for c in self.commands], results=self.results,
                      successful=not failures and any(x["state"] == "PASS" and x["stage"] != "integrity" for x in self.results))
        (self.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        with (self.output / "FILES.sha256").open("x") as manifest:
            for path in sorted(self.output.rglob("*")):
                if path.is_file() and path.name != "FILES.sha256":
                    manifest.write(hashlib.sha256(path.read_bytes()).hexdigest() + "  "
                                   + str(path.relative_to(self.output)) + "\n")
        print("Report:", self.output / "report.json")
        return 0 if report["successful"] else 1


def load_manifest(path: Path, source: Path) -> list[dict]:
    # Fail closed when source lists drift. This static check does not evaluate
    # platform conditions, generators or compiler flags and is never called CMake.
    from check_target_manifest import check
    if (source / "stark/CMakeLists.txt").is_file():
        check(source)
    data = json.loads(path.read_text())
    if data.get("schema_version") != 1 or not isinstance(data.get("targets"), list):
        raise ValueError("unsupported target manifest")
    names = set()
    for target in data["targets"]:
        name = target["name"]
        if not re.fullmatch(r"[A-Za-z0-9_]+", name) or name in names:
            raise ValueError("invalid or duplicate target name")
        names.add(name)
        if type(target["test"]) is not bool or type(target["windows_only"]) is not bool:
            raise ValueError("invalid target metadata")
        if not target["sources"]:
            raise ValueError("target without sources")
        for entry in target["sources"]:
            path = (source / "stark" / entry).resolve()
            if not path.is_relative_to((source / "stark").resolve()) or not path.is_file():
                raise ValueError("missing or escaping source: " + entry)
    return data["targets"]


def compile_targets(runner: Runner, targets: list[dict], cxx: str,
                    jobs: int, sanitizer: str) -> bool:
    """Compile each unique (source, flags) once; link separately. Never execute CLIs."""
    root = runner.source / "stark"
    bins = runner.output / "bin"
    objects = runner.output / "objects"
    bins.mkdir()
    objects.mkdir()
    flags = ["-std=c++17", "-O2", "-DNDEBUG", "-Wall", "-Wextra", "-Wpedantic"]
    if sanitizer != "none":
        flags += ["-g", "-fno-omit-frame-pointer", "-fsanitize=" + sanitizer]
    includes = ["-I" + str(root / "src"), "-I" + str(root / "src/phase1"), "-I" + str(root)]
    # Pass command arguments as arrays. No shell, user flags or environment secrets in logs.
    units: dict[tuple, tuple[Path, list[str]]] = {}
    dependencies: dict[str, list[tuple]] = {}
    for target in targets:
        keys = []
        for source in target["sources"]:
            extra = ["-UNDEBUG"] if target["name"] == "test_neuron" else []
            if target.get("threaded"):
                extra += ["-pthread"]
            key = (source, tuple(extra))
            keys.append(key)
            digest = hashlib.sha256(repr(key).encode()).hexdigest()[:20]
            obj = objects / (digest + ".o")
            units[key] = obj, [cxx, *flags, *extra, *includes, "-c", str(root / source), "-o", str(obj)]
        dependencies[target["name"]] = keys

    def compile_one(item):
        key, (obj, argv) = item
        command = runner.command(argv, "compile_" + obj.stem)
        return key, command

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        compiled = dict(pool.map(compile_one, units.items()))
    ok = True
    for target in targets:
        name = target["name"]
        failed = [compiled[k] for k in dependencies[name] if compiled[k].exit_code != 0]
        if failed:
            state = "BLOCKED" if any(c.state == "BLOCKED" for c in failed) else "FAIL"
            runner.result(name, "build", state, reason="translation unit failed", logs=[c.log for c in failed])
            ok = False
            continue
        libraries = ["-l" + name for name in target.get("windows_libraries", [])] if os.name == "nt" else []
        if os.name == "nt" and libraries:
            libraries += ["-static-libgcc", "-static-libstdc++"]
        suffix = ".exe" if os.name == "nt" else ""
        argv = [cxx, *flags, *(["-pthread"] if target.get("threaded") else []), *[str(units[k][0]) for k in dependencies[name]], *libraries,
                "-o", str(bins / (name + suffix))]
        cmd = runner.command(argv, "link_" + name)
        state = "PASS" if cmd.exit_code == 0 else "FAIL"
        runner.result(name, "build", state, log=cmd.log)
        ok = ok and state == "PASS"
    return ok


def execute_tests(runner: Runner, targets: list[dict], repeats: int):
    # Every invocation gets a new cwd. Only immutable fixtures are copied there;
    # C4 persistence scratch and gate temporary records cannot pollute source or each other.
    fixture = runner.source / "stark/fixtures/controlled-valid"
    built = {x["name"]: x["state"] for x in runner.results if x["stage"] == "build"}
    suffix = ".exe" if os.name == "nt" else ""
    for repeat in range(1, repeats + 1):
        for target in targets:
            if not target["test"]:
                continue
            name = target["name"]
            if built.get(name) != "PASS":
                runner.result(name, "test", "NOT_RUN", repeat=repeat, reason="build failed")
                continue
            cwd = runner.output / "run" / str(repeat) / name
            cwd.mkdir(parents=True)
            if name == "test_phase1_gates":
                if not fixture.is_dir():
                    runner.result(name, "test", "BLOCKED", reason="required controlled-valid fixtures absent")
                    continue
                shutil.copytree(fixture, cwd / "fixtures/controlled-valid")
            cmd = runner.command([str(runner.output / "bin" / (name + suffix))],
                                 f"test_{repeat}_{name}", cwd)
            state = "PASS" if cmd.exit_code == 0 else ("TIMEOUT" if cmd.state == "TIMEOUT" else "FAIL")
            runner.result(name, "test", state, repeat=repeat, seconds=cmd.seconds, log=cmd.log)


def cmake_checks(runner: Runner, jobs: int, repeats: int, selected: list[str]):
    build = runner.output / "cmake"
    for tool in ["cmake", "ctest"]:
        cmd = runner.command([tool, "--version"], tool + "_version")
        if cmd.exit_code != 0:
            runner.result(tool, "tool", "BLOCKED", log=cmd.log)
            return
    cmd = runner.command(["cmake", "-S", str(runner.source / "stark"), "-B", str(build),
                          "-DCMAKE_BUILD_TYPE=Release"], "configure")
    runner.result("cmake", "configure", "PASS" if cmd.exit_code == 0 else "FAIL", log=cmd.log)
    if cmd.exit_code != 0:
        return
    argv = ["cmake", "--build", str(build), "--parallel", str(jobs)]
    if selected:
        argv += ["--target", *selected]
    cmd = runner.command(argv, "build")
    runner.result("cmake", "build", "PASS" if cmd.exit_code == 0 else "FAIL", log=cmd.log)
    if cmd.exit_code != 0:
        return
    extra = ["-R", "^(" + "|".join(re.escape(n) for n in selected) + ")$"] if selected else []
    cmd = runner.command(["ctest", "-N", *extra], "registration", build)
    runner.result("ctest", "inventory", "PASS" if cmd.exit_code == 0 else "FAIL", log=cmd.log)
    if cmd.exit_code != 0:
        return
    inventory = (runner.output / cmd.log).read_text(errors="replace")
    total = re.search(r"Total Tests:\s*(\d+)", inventory)
    if total is None or int(total.group(1)) == 0:
        runner.result("ctest", "inventory", "FAIL", reason="no automated tests selected")
        return
    for n in range(repeats):
        cmd = runner.command(["ctest", "--output-on-failure", *extra], f"ctest_{n+1}", build)
        runner.result("ctest", "test", "PASS" if cmd.exit_code == 0 else "FAIL", repeat=n+1, log=cmd.log)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", required=True, type=Path, help="NEW directory OUTSIDE source tree")
    parser.add_argument("--engine", choices=["cmake", "compiler"], default="cmake")
    parser.add_argument("--cxx", default="g++", help="GCC-compatible driver executable (not a shell command)")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--sanitize", choices=["none", "address", "undefined"], default="none")
    parser.add_argument("--target", action="append", default=[])
    parser.add_argument("--include-programs", action="store_true", help="compile CLIs/demos too; never execute them")
    args = parser.parse_args(argv)
    if not 1 <= args.jobs <= 16 or not 1 <= args.repeat <= 20 or not 0 < args.timeout <= 3600:
        parser.error("jobs 1..16, repeats 1..20, timeout (0,3600] required")
    if args.engine == "cmake" and args.sanitize != "none":
        parser.error("--sanitize is available only with the explicit compiler engine")
    source = args.source.resolve()
    try:
        targets = load_manifest(source / "tools/targets.json", source)
        known = {x["name"] for x in targets}
        if set(args.target) - known:
            raise ValueError("unknown targets: " + ", ".join(sorted(set(args.target) - known)))
        if args.engine == "cmake" and any(not x["test"] for x in targets if x["name"] in args.target):
            raise ValueError("CMake --target selection must name automated tests (CTest would otherwise run no tests)")
        targets = [x for x in targets if x["name"] in args.target] if args.target else [x for x in targets if args.include_programs or x["test"]]
        runner = Runner(source, args.output, args.timeout)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    started = datetime.now(timezone.utc).isoformat()
    runner.environment = dict(platform=sys.platform, python=sys.version.split()[0],
                              sanitizer=args.sanitize, compiler_requested=args.cxx)
    git = runner.command(["git", "rev-parse", "HEAD"], "git_head")
    # Missing Git metadata does not imply a different source is verified. Log the failure.
    runner.environment["git_metadata_available"] = git.exit_code == 0
    if args.engine == "cmake":
        cmake_checks(runner, args.jobs, args.repeat, args.target)
    else:
        print("COMPILER ENGINE: this does NOT verify CMake configuration or CTest registration.", flush=True)
        version = runner.command([args.cxx, "--version"], "compiler_version")
        if version.exit_code != 0:
            runner.result(args.cxx, "tool", "BLOCKED", log=version.log)
        else:
            runnable = []
            for target in targets:
                if target["windows_only"] and os.name != "nt":
                    runner.result(target["name"], "build", "SKIP", reason="Windows-only")
                else:
                    runnable.append(target)
            compile_targets(runner, runnable, args.cxx, args.jobs, args.sanitize)
            execute_tests(runner, runnable, args.repeat)
    return runner.finish(args.engine, started)


if __name__ == "__main__":
    sys.exit(main())
