# C3 Machine Verification — 2026-10-23 (identification attempt; no designation)

Immediate-task scope only: identify the concrete acceptance machine available
for this campaign and verify it against `work/C3_READINESS_NOTE_20261023.md`
§2. **No machine is designated here; no campaign, preflight, build, or
measurement was run; no historical evidence was touched.** Status unchanged:
M0 = FAIL, M1 = LOCKED, addendum UNSIGNED.

## 1. Candidate A — this session's sandbox: DISQUALIFIED

Live fingerprint (2026-10-23 04:15 IST, `bash` on the workspace host):

| Property | Value | Match to P1-PROFILE-24-0 container |
|---|---|---|
| CPU | Intel(R) Xeon(R) Processor @ 2.60GHz; 1 socket × 1 core × 2 threads; KVM | identical string/topology |
| Memory | MemTotal 4,034,452 kB = **4,131,278,848 bytes** | **byte-exact match** |
| OS | Linux 6.1.158+ `e2b.local` x86_64 (fresh boot 2026-10-23 03:55:06) | same kernel family/host class |
| Toolchain | g++ 12.2.0 (Debian 12.2.0-14+deb12u1); taskset; sha256sum; no cmake | same build path as prior rounds |

This is the same shared container class that produced all three G7-failing
campaigns. It is excluded from further campaigns by explicit owner direction
("do not run a campaign on the existing shared container again") and fails §2's
hard minimum **"Dedicated during the campaign: no co-tenant workloads"** (the
demonstrated ±17–38% sustained throughput shifts exceed the frozen ±15/±20%
tolerances as a matter of course on this host). No campaign may be run here.

## 2. Candidate B — any other reachable machine: NONE

Reachability probes from this session: no SSH keys/config (`~/.ssh` absent),
`/etc/hosts` is local-only (`e2b.local`), no mounted remote volumes, no
environment hints of a lab host, and outbound network is restricted to
github.com / npmjs.org / pypi.org. No connected app provides machine access
(google_drive is connected but off and is not a compute target). **No machine
other than the disqualified sandbox is reachable or verifiable from this
session.**

## 3. Candidate C — the documented target laptop (owner's machine): UNVERIFIED

The only concrete machine named in the project corpus is the V009 target
hardware: **HP Victus — i5-12450H, RTX 2050 4 GB VRAM, 24 GB RAM,
Windows-first** (`stark/design/V009_phase1_M0_specification.md` L16, L113;
`stark/design/decision.md` L18; `stark/design/synapse_decision.md` L21). The
M0-recovery roadmap calls this "the acceptance machine class"
(`work/G7_DIAGNOSIS_AND_M0_RECOVERY_20261023.md` §5 item 8). Historical
Windows/MSVC build artifacts in-tree (`work/b7_diag_*`, VS2019-era
`stark/build-b7diag-fresh-p39b/`) indicate that box previously built and ran
this suite.

§2 verification against available evidence (spec-documented facts only; no
live access to the machine from this session):

| §2 requirement | Status | Basis |
|---|---|---|
| CPU x86-64, ≥ 2 logical cores, affinity pinning | CPU **documented ✓** (12 threads); pinning **MISSING** | spec vs live |
| Memory ≥ 4 GB | **documented ✓** (24 GB) | spec |
| OS Linux ≥ 5.x or Windows 10/11 + MSVC | **PARTIAL — MISSING** exact OS build + MSVC version ("Windows-first" + VS2019-era artifacts only) | spec/history |
| Storage ≥ 1 GB free, writable `build/` | **MISSING** | live fact |
| Permissions: set/query High Performance plan (+ affinity) | **MISSING** (historical affinity experiments suggest yes) | live fact |
| Offline during the campaign | **MISSING** (owner commitment) | procedural |
| Dedicated, on AC power, ~60–90 min window | **MISSING** (owner commitment) | procedural |
| (operational) homogeneous cores | hybrid P/E (4P+4E) — recorded risk per §2 preference, not a hard fail | spec CPU model |

**Conclusion: the proposed machine cannot be confirmed available, and its §2
compliance cannot be verified from this session.** Per the owner's instruction,
the exact missing facts are listed below and nothing is substituted or
invented. No designation has been made (U1's historic designation stands until
the owner's §9 text supersedes it).

## 4. Exact missing facts requested (and nothing else)

1. **Machine identity** — hostname/asset name of the designated machine, and
   confirmation it is the HP Victus target laptop (or another host, with its
   CPU model + OS).
2. **OS + toolchain** — OS edition/version and compiler version (MSVC on
   Windows; g++ on Linux).
3. **Storage** — ≥ 1 GB free on the repo volume (yes/no).
4. **Permissions** — can the runner pin CPU affinity and set + query the
   High Performance power plan (Windows) or `performance` governor (Linux)?
5. **Dedication** — machine free of co-tenant load and on AC power for one
   continuous ~60–90 minute campaign window.
6. **Execution topology** — can this session reach the machine (so steps
   build → preflight → campaign run are executed here), or does the owner run
   the §6 command package on the machine and return the store + logs for
   evaluation here?

Plus the gate on all post-identification work: the **§9 C3 authorization**
(`work/C3_READINESS_NOTE_20261023.md` §9 — machine designation superseding U1
only; exactly one frozen campaign; current-machine evidence preserved per §4).
Until those facts and that authorization are supplied: no machine designated,
no campaign executed, M0 remains FAIL, M1 remains LOCKED.
