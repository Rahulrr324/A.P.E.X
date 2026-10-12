APEX — PHASE 8 READ-ONLY: EXECUTABLE PATH-MAPPING DIAGNOSIS
status: read-only; no execution, no rebuild, no edit, no retry.
date_utc: 2026-10-12T11:17Z

========================================================================
1. SHELL AND RUNTIME IDENTITY (confirmed)
========================================================================

  POSIX shell       : /usr/bin/bash
  POSIX uname       : MINGW64_NT-10.0-26300 ... x86_64 Msys
  POSIX uname os    : Msys
  POSIX cwd         : /e/My Local AI
  Windows-side cwd  : E:\My Local AI   (from cmd //c "cd")
  whoami            : rahul
  python3           : /c/Users/rahul/AppData/Local/Microsoft/WindowsApps/python3
  python sys.exec   : C:\Python314\python.exe
  python version    : 3.14.6 (MSC v.1944 64 bit (AMD64))

Interpretation:
  This is a MSYS2/MINGW64 POSIX compatibility shell on Windows. The POSIX root /e maps
  to the Windows drive E: (confirmed by cmd //c "cd" returning E:\My Local AI). So the
  POSIX path /e/My Local AI/stark/... corresponds to the Windows path
  E:\My Local AI\stark\....

========================================================================
2. POSIX AND NATIVE PATH MAPPINGS (confirmed)
========================================================================

  POSIX relative path (works to multiple tools):
    stark/build-b7diag-20261011/bm_b7_diagnostic.exe

  POSIX absolute path (works to SOME tools, NOT to others):
    /e/My Local AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe

  Windows absolute path (normal form):
    E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe

  Confirmed mappings:
    - cmd //c "cd" returns E:\My Local AI for the current directory, matching the POSIX
      cwd /e/My Local AI. So /e -> E:\ is confirmed by the native cmd layer.
    - python pathlib Path("stark/build-b7diag-20261011/bm_b7_diagnostic.exe").resolve()
      returns E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe and
      .exists() and .is_file() are True. So Python's pathlib sees the file via the
      no-space relative form and normalizes it to the E:\ form.
    - python os.path.abspath of the no-space relative path also yields the E:\ form, and
      os.path.getsize/exists/lexists are True. So Python's os.stat-based path logic sees
      the file via the relative form.
    - POSIX stat -c on the no-space relative path succeeds and reports size 3168146 and
      inode 4503599627450122, dev 3767402151. ls -la on that form also succeeds.
    - POSIX ls -la and stat on the "/e/My Local AI/..." absolute form fail with "No such
      file or directory". So within the SAME mingw bash session, the /e/My Local AI/...
      form is not resolvable by stat/ls, even though cmd and python pathlib see the E:\
      form as the same directory.

This already localizes the problem: the failure is not "the file does not exist" in any
absolute sense. It is "the exact path string used at launch is not resolvable/launchable
by the layer that attempted the launch."

========================================================================
3. EXECUTABLE EXISTENCE AND SHA-256 (confirmed where reachable)
========================================================================

  File (where reachable): stark/build-b7diag-20261011/bm_b7_diagnostic.exe
  size   : 3168146 bytes
  sha256 : a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6
  PE classification (file cmd) : PE32+ executable for MS Windows 5.02 (console), x86-64,
                                  20 sections
  permissions (ls) : -rwxr-xr-x

So the expected executable and expected hash DO correspond to a present PE file that POSIX
tools can see and stat in the no-space relative form.

History note (preserved, not re-verified here):
  Phase 5 recorded the same file at the same path with the same size and the same hash
  immediately after the build. So the file present now is consistent with that build
  artifact.

========================================================================
4. HARMLESS PATH-RESOLUTION AND PROCESS-LAUNCH PROBES (read-only; no diagnostic launch)
========================================================================

A) cmd.exe itself as a no-op launcher probe:
     subprocess.run(["cmd","/c","echo","probeA-ok"]) -> rc 0, stdout probeA-ok
     subprocess.run(["cmd","/c","rem","probeB-ok"]) -> rc 0
   Interpretation: a subprocess launch of a known Windows native exe (cmd.exe) on the
   same system works fine from this python. So subprocess/CreateProcess is not globally
   broken here; ordinary Windows exe launch works.

B) python itself as a no-op direct-exe launch probe:
     subprocess.run([sys.executable, "-V"]) -> rc 0, stdout Python 3.14.6
   Interpretation: direct-exe launch of another PE (the python.exe that is itself running)
   also works from this python via subprocess with a path that python knows (sys.executable
   is C:\Python314\python.exe). So the subprocess path-resolution machinery can launch a
   known absolute Windows form.

C) What FAILED (already from Phase 6, reconfirmed by the nature of the probes):
     subprocess.run(["stark/build-b7diag-20261011/bm_b7_diagnostic.exe"], ...) ->
       FileNotFoundError [WinError 2] The system cannot find the file specified
   even though:
     - python os.path.exists / lexists / getsize on that same relative string are True
     - pathlib.exists / is_file on that same relative string are True
     - POSIX ls/stat on that same relative string succeed
   and even though the file's resolved absolute form (E:\) is a normal Windows exe path.

So the paradox is NOT that "nothing can see the file." It is specifically that the
subprocess/process-launch path resolution inside THIS python/msys process cannot map the
no-space POSIX relative path to a launchable Windows executable, even though stat/find/ls
and python's own os.path/stat/pathlib can see the file via that same string.

========================================================================
5. MOST LIKELY CAUSE (evidence-based; hypothesis where not proven)
========================================================================

Confirmed:
  - The file exists and is a normal PE32+ console x86-64 exe.
  - Its hash matches the Phase 5 build artifact.
  - POSIX tools in this mingw bash session can stat/ls/find it via the no-space relative
    path and the cmd layer sees the same directory as E:\My Local AI\....
  - python pathlib and os.stat-based calls also see it via the no-space relative path.
  - subprocess launch of OTHER executables (cmd.exe, python.exe) works fine from this
    python.
  - But subprocess direct launch of the diagnostic exe using the SAME no-space relative
    path string fails with WinError 2.

Most likely cause (primary hypothesis):
  This is a path-namespace / subprocess-resolution mismatch inside the MSYS2/Python
  process. In mingw/msys environments, path handling for process creation can diverge from
  plain POSIX stat semantics: a relative path that stat()/open() can resolve in the
  msys-posix filesystem view may not be resolved by the Windows CreateProcess/exec layer
  unless it is presented in a form the Windows loader recognizes (often a native Windows
  absolute path, or a path that msys's subprocess path-munging can translate correctly).
  The fact that:
    - the /e/My Local AI/... absolute form is ALSO invisible to stat/ls here (so the
      mingw session's /e mapping is not uniformly applied to all syscalls), and
    - python subprocess fails on the no-space relative form even though python's own
      os.path/stat see the file
  is consistent with "the launch path-resolution path is not the same as the stat/open
  path logic," rather than "the file is absent."

Secondary possibilities (not ruled out; not proven):
  - The working directory seen by the created child or by CreateProcess differs from the
    shell cwd, so a relative path does not resolve in the child's context.
  - The executable, though a PE with +x permissions, might not be considered launchable in
    this msys/subprocess configuration without an explicit .exe-suffixed native absolute
    path or without appropriate path-translation flags.
  - There could be a locale/encoding/name-mangling issue in how the relative path string is
    handed to CreateProcess from this python/msys build.

I am NOT asserting which one is correct. The observable fact is the mismatch between
stat/ls visibility and subprocess-launchability for the same relative path.

A secondary observation (not a cause, but relevant): the absolute "/e/My Local AI/..."
form fails even for POSIX stat/ls in this session, yet cmd's "cd" sees E:\My Local AI and
python pathlib resolves the relative form to E:\. That itself indicates the /e mapping is
not uniformly honored by all syscalls in this session — which is consistent with a broader
msys path-translation inconsistency rather than a simple "file missing" situation.

========================================================================
6. WHAT IS STILL UNKNOWN / NOT RESOLVED
========================================================================

Unknown (not resolved in this read-only step):
  - The exact mechanism that makes subprocess launch fail while stat/ls/pathlib succeed on
    the same relative path.
  - Whether an absolute Windows-native form (E:\...) presented to subprocess would launch
    (not tested here, because testing it would risk an execution-like probe of the
    diagnostic; harmless probes here used cmd.exe and python.exe only).
  - Whether the launch failure is cwd-related, path-translation-related, permission-related,
    or specific to how this python/msys subprocess passes the path to CreateProcess.
  - Whether the file is actually executable-by-createprocess in this environment even though
    ls shows +x.

Not claimed:
  - That the file is definitely launchable in any form (only that it is a normal PE and is
    visible to stat/ls/pathlib in some forms).
  - That rebuilding would or would not change the outcome (not tested; not allowed here).

========================================================================
7. MINIMUM CORRECTIVE ACTION BEFORE ANOTHER RUN COULD BE CONSIDERED
========================================================================

The minimum action is to find, read-only, a path form and/or launch method that the
executing layer can actually launch, and prove it with a HARMLESS probe (not the B7
diagnostic) before any authorized B7 execution. Concretely, that means:
  - Identify a path string (likely a native Windows absolute no-space form such as the
    E:\...\bm_b7_diagnostic.exe normalized path, or a form subprocess/msys can translate)
    under which the SAME already-built file is both visible to stat/ls AND launchable by a
    HARMLESS probe (e.g. cmd.exe or python.exe style, or a no-op subprocess style).
  - Confirm the candidate path hashes to the expected executable hash without executing the
    diagnostic.
  - Then, only if separately authorized, attempt one B7 execution using that proven
    launch path/method and the persistent host-capture CSV destination.

Rebuilding, moving/copying the exe, changing mounts, or editing source/config would be out
of scope for this read-only diagnosis and would require their own authorization.

========================================================================
8. HARD BOUNDARIES HELD
========================================================================

  - No B7 execution (not even a probe of the diagnostic).
  - No rebuild, no source edit, no config edit, no file move/copy/rename.
  - No change to mounts or to G7CAM records, frozen evidence, thresholds, or M0/M1 status.
  - All existing reports and artifacts preserved without modification.

Report written to:
  work/b7_diag_20261011_paired_capture/phase8_report_path_mapping.md

========================================================================
9. EVIDENCE FILES REFERENCED (preserved, read-only)
========================================================================

  work/b7_diag_20261011_paired_capture/phase5_persistence_fix_build_report.md
  work/b7_diag_20261011_paired_capture/phase6_report_run2_exec_fail.md
  work/b7_diag_20261011_paired_capture/phase7_report_exe_reachability.md
  work/b7_diag_20261011_paired_capture/run2/exec_meta.json
  work/b7_diag_20261011_paired_capture/run2/exitcode.txt
  work/b7_diag_20261011_paired_capture/run2/stderr.txt
  work/b7_diag_20261011_paired_capture/run2/stdout.txt
  stark/build-b7diag-20261011/bm_b7_diagnostic.exe   (present; inspected read-only)
  stark/build-b7diag-20261011/build.ninja
  stark/build-b7diag-20261011/.ninja_log
  stark/build-b7diag-20261011/CMakeCache.txt
  stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp
  stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp.pre_edit
  stark/CMakeLists.txt
