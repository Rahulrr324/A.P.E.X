APEX — PHASE 9 READ-ONLY: EXECUTABLE LAUNCH-PATH VERIFICATION
status: read-only; no B7 execution authorized or performed by this phase.
date_utc: 2026-10-12T11:28Z

========================================================================
1. ENVIRONMENT, COMMANDS, AND PROBE RUNTIME (confirmed)
========================================================================

  POSIX shell      : /usr/bin/bash
  POSIX uname      : MINGW64_NT-10.0-26300 ... x86_64 Msys
  POSIX uname os   : Msys
  POSIX cwd        : /e/My Local AI
  Windows cwd      : E:\My Local AI  (cmd //c "cd")
  whoami           : rahul
  python3          : /c/Users/rahul/AppData/Local/Microsoft/WindowsApps/python3
  python sys.exec  : C:\Python314\python.exe
  python version   : 3.14.6 (MSC v.1944 64 bit (AMD64))
  probes run       : python3 work/_phase9_probe.py  and  python3 work/_phase9_probe2.py
  probe files      : work/_phase9_probe.py , work/_phase9_probe2.py  (harmless only)

  Probes used (all HARMLESS, not the B7 diagnostic):
    probe_cmd_echo                : ["cmd","/c","echo","probe-ok-cmd"]
    probe_python_version          : [sys.executable, "-V"]
    probe_cmd_echo_native_no_space: ["cmd","/c","echo","probe-ok-cmd-native"]
    launch_native_abs_via_cmd     : ["cmd","/c", <native absolute no-space path to exe>]
    (second probe set) cmd /c "set"  and  cmd /c "echo CWD-as-cmd=%CD%"

========================================================================
2. CANDIDATE PATH FORMS — METADATA AND SHA-256
========================================================================

Expected executable SHA-256:
  a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6

Candidate 1 — POSIX relative, no-space:
  path  : stark/build-b7diag-20261011/bm_b7_diagnostic.exe
  ls    : -rwxr-xr-x 1 rahul 197609 3168146 Oct 12 16:00
  stat  : 3168146 bytes, inode=4503599627450122, dev=3767402151, perms=755
  sha256: a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6  MATCH
  test -f: YES
  os.path.exists (relative): True
  pathlib.exists/is_file (relative): True
  pathlib.resolve -> E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe

Candidate 2 — POSIX absolute, space-containing:
  path  : /e/My Local AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe
  ls    : -rwxr-xr-x 1 rahul 197609 3168146 Oct 12 16:00  (visible to ls)
  stat  : 3168146 bytes (visible to stat)
  sha256: a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6  MATCH
  bash test -f: YES
  os.path.exists (absolute /e form): True
  os.path.lexists (absolute /e form): True
  pathlib.resolve -> same E:\ form as candidate 1

Candidate 3 — native Windows absolute, no-space:
  path  : E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe
  ls    : visible (quoted, bash sees it)
  stat  : visible (quoted, bash sees it)
  sha256: a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6  MATCH
  test -f: YES
  os.path.exists (native form): True
  pathlib normalizes it to the same E:\ form

NOTE on earlier confusion: earlier Phase 7/8 steps reported the /e/... absolute form as
invisible and parent-missing. In THIS Phase 9 session, with the SAME cwd, the /e/... form
is now visible to ls/stat/os.path. That indicates the /e mapping visibility is session- or
call-style-dependent in this environment (not a persistent file absence). The file identity
(sha256, size, inode) is the same regardless of which form can read it.

========================================================================
3. HARMLESS LAUNCH-PROBE RESULTS AND EXIT CODES
========================================================================

  probe_cmd_echo                  : ["cmd","/c","echo","probe-ok-cmd"]
    rc=0 stdout="probe-ok-cmd\n" stderr=""

  probe_python_version            : [C:\Python314\python.exe, "-V"]
    rc=0 stdout="Python 3.14.6\n" stderr=""

  probe_cmd_echo_native_no_space  : ["cmd","/c","echo","probe-ok-cmd-native"]
    rc=0 stdout="probe-ok-cmd-native\n" stderr=""

  launch_native_abs_via_cmd       : ["cmd","/c","E:\My Local AI\stark\build-b7diag-20261011\bm_b7_diagnostic.exe"]
    rc=1
    stderr="'E:\My' is not recognized as an internal or external command, operable program or batch file."
    stdout=""
    EXIT CODE 1 (NOT 127; launched via cmd /c, but cmd misparsed the space-containing
    native path as a command name because the path was passed unquoted to cmd /c).

  cmd /c "set" (harmless env dump)
    rc=0 (large stdout; PATH shown includes C:\MinGW\bin and the mingw64 path
    C:\Users\rahul\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin)

  cmd /c "echo CWD-as-cmd=%CD%"
    rc=0 stdout="CWD-as-cmd=E:\My Local AI\n"

  cmd.exe /c echo and python.exe -V both launch fine in this environment. The diagnostic
  exe path, when passed to cmd /c UNOQUOTED as an argument, is misparsed by cmd at the
  first space (E:\My ...), which is why that probe failed with rc=1 and the "E:\My is not
  recognized" message. That failure is a cmd-argument-quoting artifact, NOT evidence that
  the exe is absent.

========================================================================
4. CONFIRMED FACTS vs HYPOTHESES vs UNRESOLVED
========================================================================

CONFIRMED:
  - The executable file exists and is a normal PE32+ console x86-64 exe, size 3168146,
    perms -rwxr-xr-x, inode 4503599627450122, dev 3767402151, sha256 matches the
    expected value. It is reachable by POSIX ls/stat/find/test in this session in BOTH
    the no-space relative form AND, now, the /e/... absolute form (visibility is now
    consistent for stat/ls in this session for the /e form, unlike earlier Phase 7/8
    observations).
  - python pathlib and os.path (relative form) resolve to the E:\ form and report
    exists/lexists/getsize True.
  - Harmless exec helpers (cmd.exe, python.exe) launch fine via subprocess from this
    python.
  - The diagnostic was NOT launched by this phase (probes were harmless only).
  - The Phase 6 failure used the /e/My Local AI/... absolute path and got exit 127 with
    "No such file or directory". That absolute form was, at that time, not visible to
    stat/ls/python os.path in that session.
  - In THIS Phase 9 session, the /e/... absolute form IS now visible to POSIX stat/ls and
    to python os.path.exists. So the discrepancy is session-/call-variant, not purely
    "file never existed."

HYPOTHESES (not proven):
  - The launch path that Phase 6 passed to the executing layer was not in a form the
    launch layer could resolve. The probe "launch_native_abs_via_cmd" shows that passing
    the native space-containing path to cmd /c UNOQUOTED makes cmd misparse it at the first
    space (treats "E:\My" as a command). So if the Phase 6 runner passed the space-
    containing native form to a shell/command interpreter without proper quoting, cmd would
    fail even though the file exists.
  - alternatively, the launch layer expected a form different from what was supplied (e.g.,
    it needed the no-space relative form, or a properly quoted native form, or a path that
    subprocess's msys-to-native translation could resolve). The harmless probes show that
    subprocess CAN launch cmd.exe and python.exe, so the failure is path/form-specific, not
    a general inability to launch anything.
  - the /e mapping visibility itself varies by call style in this environment, which may be
    a separate msys path-translation quirk that contributed to earlier "missing" reports for
    the /e/... form.

UNRESOLVED (not determined in this read-only phase):
  - Whether the no-space relative form "stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
    can be launched by subprocess DIRECTLY (not via cmd /c) in THIS python/msys session.
    The prior Phase 6/7/8 direct-subprocess attempt with that relative path failed with
    WinError 2, but that was a different session/call. This Phase 9 did not rep
