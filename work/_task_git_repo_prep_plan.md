# Task: Prepare and Safely Publish the Clean APEX Project to GitHub

## Read-only state confirmed so far

- Project root: `E:\My Local AI`.
- Local Git: not present at the root and no nested `.git` found anywhere scanned. There is therefore no
  existing local Git history to preserve.
- Git CLI available: `C:\Program Files\Git\cmd\git.exe` 2.55.0.windows.3. Git commands fail to start
  through the MSYS2 bash for unclear reasons, so Git operations should use the Git for Windows CLI path.
- GitHub target `Rahulrr324/A.P.E.X`: public API returned 404. I also tried several spelling variants and
  all returned 404.

## Researcher findings (read-only web check)

- The GitHub account `Rahulrr324` exists and its public profile lists five public repositories:
  `ai-video-generator`, `blue-wave-pdf-tools`, `pdfmasterpro`, `Telegram-Shopping-Deals`, and
  `robin_dark_web_OSINT`. None is named A.P.E.X, APEX, STARK, AMBER, or SteeringAI.
- `Rahulrr324/A.P.E.X` and `Rahulrr324/APEX` both return 404 via the public API.
- A private repo is still possible: GitHub can return 404 for a private resource to avoid confirming its
  existence to an unauthenticated request. So 404 does not reliably distinguish "does not exist" from
  "private and not accessible to this request."
- No public-facing evidence ties this account to APEX / A.P.E.X / STARK / AMBER / SteeringAI.

Bottom line: the target repo could not be confirmed from public information. If it exists, it is most likely
private and needs authorized access to verify.

## Project layout (read-only)

- `stark/` — main source tree (src, tests, CMakeLists.txt, design, fixtures, math, reports, many build-*
  trees, build/, build-b7diag-20261011/, libstark_phase1.a, test_phase1_gates.exe, two source zips, a
  zero-byte `nul`, and a `work/` subfolder). Contains build artifacts + source.
- `build/` — root level; contains bm_b7_diagnostic/run_..., results/, test_records_tmp/ (likely generated).
- `reports/` — root level; contains `g7-campaign-affinityfix/highres_v4_analysis.txt` (important report).
- `archive_recovery/` — root level; contains aggregator_input/, original_build_results/,
  original_historical_records/ (incl. RECOVERY_MANIFEST.json + tiny_dense_2l_weights.bin), v21_diagnostics/,
  v21_evidence/. Looks like a historical recovery archive; needs review before publishing.
- `work/` — task probe scripts, b7_diag trees, paired_capture (43 items), scripts/, plus probe .py files and
  the .vscode settings backup I created (`work/_vscode_settings_backup.json`).
- Loose root files (mangled names, likely accidental artifacts):
  - `workb7_diag_20261011_paired_capturerun10_probe_stderr.txt` (120 B)
  - `workb7_diag_20261011_paired_capturerun10_probe_stdout.txt` (0 B)
  - `workb7_diag_20261011_paired_capturerun10_smoke_stderr.txt` (1325 B)
  - `workb7_diag_20261011_paired_capturerun10_smoke_stdout.txt` (149 B)
- `.vscode/settings.json` — `"cmake.sourceDirectory": "E:/My Local AI/stark"` (backed up to
  `work/_vscode_settings_backup.json`).

## Sensitive / oversized notes (read-only)

- No `.env` found in root or `stark/`. Keyword scan over small files in `stark/` showed many false-positive
  hits from prose words (key/token/secret/sk-) and no obviously committed secret value.
- Files > 10 MB under `stark/`: `libstark_phase1.a`, `test_phase1_gates.exe`, `stark-M0-v1.5-source.zip`,
  plus duplicate static libs under `build-v23-debug/` and `build-v24-debug/`. None found over 100 MB, but
  committing static libs/binaries/zips is usually undesirable for a source repo.
- `archive_recovery/*/tiny_dense_2l_weights.bin` is a weights binary (not a source file).

## Outstanding questions to answer before any Git work

1. Is `Rahulrr324/A.P.E.X` the correct target, and does it actually exist (private)? Public API says 404.
   If it exists, I should confirm access through GitHub Desktop auth or the correct API path.
2. Should the published project be framed as "APEX" or as the "STARK" codebase? Do any files need to be
   renamed from STARK to APEX, or kept historically accurate?
3. Which large/binary artifacts should be excluded vs. retained for reproducibility?
4. Should `archive_recovery/` be published, kept private, or excluded?
5. What should happen to the four mangled loose files in the root — move into `work/` and track, or leave
   out of the repo entirely?

## Recommended next action

I should ask the user these questions and wait for answers before initializing Git, writing `.gitignore`,
or staging anything. After answers, I can produce a narrow `.gitignore`, do a final staged-file audit, and
give exact GitHub Desktop review/commit/push steps.
