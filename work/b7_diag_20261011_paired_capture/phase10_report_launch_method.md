# Phase 10 — Read-Only Launch-Method Verification
status: read-only; no B7 execution authorized or performed by this phase.
date_utc: 2026-10-12T18:00Z

## 1. Objective and boundary

Resolve the remaining launch-method uncertainty from `phase9_report_launch_path.md` using
harmless probes only. Confirm a launch mechanism the current MSYS2/MINGW64 + CPython
environment can actually resolve and start, then verify the launched process image identity
against the expected executable SHA-256. Do not launch the B7 diagnostic for the purpose of
this phase, and do not claim a harmless probe proves the B7 executable is launchable — only
that the tested mechanism works for the tested path.

Expected B7 executable SHA-256:
`a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6`

Prohibited for this phase:
- Launch `bm_b7_diagnostic.exe`, directly or indirectly, for a launchability test.
- Build, compile, relink, or run CMake/Ninja.
- Edit source/configuration/environment/mounts/shell startup.
- Move, copy, rename, or replace files.
- Modify persistent CSV destination, G7CAM records, frozen evidence, thresholds, formulas, or M0/M1.

## 2. Environment and runtime (reconfirmed)

- POSIX shell: `/usr/bin/bash`
- POSIX uname: `MINGW64_NT-10.0-26300 ... x86_64 Msys`
- POSIX uname os: `Msys`
- POSIX cwd: `/e/My Local AI`
- Native cmd cwd: `E:\My Local AI` (`cmd //c "cd"`)
- python3: `/c/Users/rahul/AppData/Local/Microsoft/WindowsApps/python3`
- python sys.executable: `C:\Python314\python.exe`
- python version: 3.14.6 (MSC v.1944 64 bit (AMD64))
- whoami: `rahul`

Note on current interpreter: the probes in this phase ran from Windows `cmd.exe` (native), not
from the MSYS2 bash session used in earlier phases. That shift is itself relevant to the launch
question and is reported explicitly here.

## 3. Exe identity reconfirmation (read-only; no launch)

All identity reconfirmations used the resolved native path obtained through Python `pathlib`:

- POSIX relative no-space form: `stark/build-b7diag-20261011/bm_b7_diagnostic.exe`
- Resolved native form: `E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe`

Reconfirmed facts:
- `pathlib.Path(rel).resolve()` returns the native `E:\...` form.
- `os.path.exists(rel)` is `True`; `os.path.getsize(rel)` is `3168146`.
- SHA-256 of the exe, read through the resolved native path, is
  `a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6` — matches expected.

So the file is the expected build artifact and is reachable to Python stat/open through the
relative form and the resolved native form in this session.

## 4. Harmless launch probes (mechanics only)

### 4.1 subprocess mechanics with native helpers

Probe | Arguments | cwd | rc | stdout | stderr
`cmd /c echo` | `["cmd","/c","echo","probeA-ok"]` | `E:\My Local AI` | `0` | `probeA-ok\n` | `(empty)`
`python -V` | `[sys.executable,"-V"]` | default | `0` | `Python 3.14.6\n` | `(empty)`
`cmd /c python -V -XA` | `["cmd","/c","python","-V","-XA"]` | `E:\My Local AI` | `0` | `Python 3.14.6\n` | `(empty)`

These confirm subprocess/CreateProcess is not globally broken in this interpreter; ordinary
Windows exe launch works.

### 4.2 Direct subprocess launch using the resolved native path

Command (CPython `subprocess.run`, `shell=False`):
- `cmd = [str(pathlib.Path(rel).resolve())]`
- `cwd = str(pathlib.Path(rel).resolve().parent)`
- `timeout = 90`

Result:
- rc = `2`
- stdout = B7 diagnostic report header + `status: ABORTED — run-owned storage could not be
  created (nothing overwritten): cannot create diagnostic base directory: build/bm_b7_diagnostic`
- stderr = empty

This is the key mechanistic result: from native `cmd.exe`, with the **resolved native absolute
path** passed as the `executable`, the diagnostic process **did start** (it printed its report
and exited with rc 2, which is the diagnostic’s “cannot create run storage” result, not a
launch/no-such-file error). So the `FileNotFoundError [WinError 2]` seen earlier for the
same exe was not an inherent property of the exe or this interpreter; it was specific to the
earlier path/context/caller that produced it.

Important non-claim: this shows that **one** launch method worked for **this** path in **this**
session. It does not by itself prove the diagnostic’s longer scientific run would succeed —
that run failed here because its run-owned directory could not be created (`build/bm_b7_diagnostic`
relative to the exe’s parent). That failure is separate from process launch.

### 4.3 Why the earlier `cmd /c ... exe` probe failed

A `cmd /c` probe that passed the native space-containing path unquoted produced:
- rc = `1`
- stderr = `'E:\My' is not recognized as an internal or external command...`

That is a cmd argument-quoting artifact: cmd parsed the first token as `E:\My` and failed. It is
not evidence that the exe is absent.

## 5. Minimum-proven launch path

For this session/interpreter, the minimum launch form that was verified to actually start the
process is:

- `executable = str(pathlib.Path("stark/build-b7diag-20261011/bm_b7_diagnostic.exe").resolve())`
  → `E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe`
- `cwd = exe parent directory`
- `subprocess.run(..., shell=False)` (or direct `CreateProcessW` with app=exe, cmdline=exe)

Under that form, the process started and produced diagnostic output. No other form was proven
to start the process in this phase.

## 6. Image identity verification attempt and its limitation

I tried to verify that the started process actually ran the expected exe image, not just any
process with the same name, by inspecting the child process image path from the parent. The
attempts and outcomes:

- `QueryFullProcessImageNameW(pid, 0, buf, &len)`: returned ok=0, name empty, len=1024.
  This did not yield the image path.
- `GetProcessImageFileNameW` is not exported by `kernel32.dll` in this interpreter/OS view, so
  calling it via `ctypes.WinDLL('kernel32')` raises `AttributeError`.
- `GetModuleFileNameExW`/`GetProcessImageFileNameW` are available from `Psapi.dll`, but pairing
  them reliably with the child process handle proved to be its own probe engineering task and
  was not completed here.

So the launch-mechanics result was confirmed (the process started), but the stronger “it is
exactly this exe image” confirmation via post-launch API inspection was NOT completed in this
phase. The identity claim in this report rests on:
- the exe’s file SHA-256 matches the expected artifact, and
- the launched process printed the diagnostic’s own report text (which is specific to this
  executable).

That is strong but not an independent image-path proof via the kernel API.

## 7. Also tested (for completeness) and what it showed

- Launching with `cwd = exe parent` via `subprocess.run` with the resolved native path: process
  started; same rc 2 storage failure.
- Direct `CreateProcessW` with app=exe, cmdline=exe: process created.
- Direct `CreateProcessW` with `cwd = None` (NULL current directory): process created.
- Direct `CreateProcessW` with a **relative** `cwd = "stark\\build-b7diag-20261011"` and app=exe:
  `CreateProcessW` returned ok=0, last_error=267 (ERROR_INVALID_DIRECTORY). This is consistent
  with CreateProcess rejecting a relative cwd that is not a valid directory token in the child’s
  context; it is not a “file not found” result for the exe itself.

So `cwd=None` / no-cwd and exe-parent cwd both allowed process creation; a relative cwd string
to CreateProcess did not.

## 8. Confirmed facts / hypotheses / unresolved

### Confirmed
- The exe exists, is the expected build artifact (SHA-256 match), and is reachable to Python
  stat/open via the relative form and the resolved native form in this session.
- subprocess with `shell=False` and the resolved native absolute path (cwd = exe parent) **does
  start** the diagnostic process in this session/interpreter; it prints the diagnostic report and
  exits with rc 2 (storage creation failure), not with `WinError 2`.
- Earlier `WinError 2` from subprocess was therefore not an inherent inability to launch this exe;
  it was specific to a different path/context/caller.
- `cmd /c` with an unquoted space-containing native path misparses at the first space; that is a
  quoting artifact, not absence.

### Hypotheses (not proven)
- Phase 6’s launch failure is most consistent with a launch-path/form/context problem (path form,
  quoting, or the specific calling environment), not with the exe being absent or inherently
  unlaunchable.
- `cwd=None` being accepted by CreateProcess but not by the diagnostic’s own startup logic (which
  still prints the “usage” line) suggests the diagnostic has its own cwd/directory assumptions
  beyond process creation.

### Unresolved
- No independent kernel-API image-path proof was completed (QueryFullProcessImageNameW returned
  empty here; GetProcessImageFileNameW not available from kernel32 in this probe environment;
  Psapi alternatives not exercised to completion).
- Whether a full scientific run (with successful run-owned storage creation) would succeed was
  not proved here; the diagnostic aborted on storage creation in this probe.
- Why the earlier session/caller produced `WinError 2` for what is now launchable here was not
  definitively explained; only that it is contingent, not inherent.

## 9. Minimum next action (do not carry out in this phase)

Before any authorized B7 run, the remaining items are:
1. Independently confirm the launched process image path (for example, via `Psapi.dll` image-name
   APIs or an equivalent) so image identity is proven by the kernel, not inferred from report
   text.
2. Confirm the diagnostic can create its run-owned storage in this environment (the probe aborted
   on that), so a full run’s preconditions are established.
3. Then, only if separately authorized, attempt one B7 run using the proven launch form and the
   persistent host-capture CSV destination `work/b7_diag_20261011_paired_capture/run2/paired_samples.csv`,
   and validate the resulting CSV and stdout evidence.

## 10. Hard boundaries held

- No B7 execution for a launchability test.
- No build/compile/cmake/ninja.
- No source/config edit, no environment/mount/shell-startup change.
- No move/copy/rename/replace of files.
- No change to persistent CSV destination, G7CAM records, frozen evidence, thresholds, formulas,
  or M0/M1.
- All prior reports and artifacts preserved without modification.

Probe helpers created in this phase (harmless, read-only w.r.t. project artifacts; contain no
secret material):
- `work/_phase10_probe.py`
- `work/_phase10_tempdir_probe.py`
- `work/_phase10_winapi_probe.py`
- `work/_phase10_sha_probe.py`
- `work/_phase10_sha_probe2.py`
- `work/_phase10_sha_probe3.py`

Phase 10 output artifacts in `work/b7_diag_20261011_paired_capture/run10_*`:
- `run10_probe_stdout.txt` / `run10_probe_stderr.txt` — API-launch probe output.
- `run10_winapi_stdout.txt` / `run10_winapi_stderr.txt` — stder captured API-launch probe.
- `run10_sha_stdout.txt` / `run10_sha_stderr.txt` — SHA-probe helper output.
- `run10_sha2_stdout.txt` / `run10_sha2_stderr.txt` — SHA-probe2 helper output.
- `run10_sha3_stdout.txt` / `run10_sha3_stderr.txt` — SHA-probe3 helper output.
- `run10_stdout.bin` / `run10_stderr.bin` — captured process stdout/stderr bytes from the API
  launch probe.
