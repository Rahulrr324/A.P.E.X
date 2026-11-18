# T-17 APEX v2 reconciliation and implementation ledger

## Starting state

- HEAD at T-17 start: `5d779dc414cb282e55959267c4fc56fc793cc98f`, branch `main`, local and recorded `origin/main` refs equal.
- Fetch of configured GitHub origin failed `Repository not found`; remote push/fetch remains blocked by repository access or credentials.
- Worktree preserved inherited uncommitted T-17 planning/UI changes and the attached v2 PDF. No inherited file was reset or discarded.
- Original Concept & Architecture PDF was located at `E:\A.P.E.X\1.2APEX_Project_Concept_and_Architecture (1).pdf` and compared with `APEX v2...pdf`.
- The v2 brief explicitly supersedes the original; its canonical principles and ownership rules are retained. The original was located, extracted and reconciled rather than invented.

## Canonical documents

- Requirements inventory: `apex_app/docs/APEX_V2_REQUIREMENTS.md`
- Target architecture and subsystem ownership: `apex_app/ARCHITECTURE_V2.md`
- Implementation/evidence map: `apex_app/ARCHITECTURE.md`

## T-17 implementation added

- Formal ECP facade over the existing `ActionRegistry` decision path; no second registry/controller/runner.
- Permission representation includes principal, identity-assurance label, domain, capability, bounded resource scope, autonomy level, resource budget, expiry, revocation, provenance and audit reference.
- Enforceable owner-set L0–L5 per-domain configuration through `APEX_AUTONOMY_LEVELS`.
- Bounded in-process L3/L4/L5 delegation grants with scope, capability list, action budget, resource budget, expiry, approval reference and revocation.
- Delegation never widens scope, time, resource or autonomy; it cannot convert a model proposal into write authority.
- Durable software kill-switch latch in `dataDir/kill-switch.json`, integrity digested, bounded, lock-aware and fail-closed on damage. It signals registered cancellable operations and refuses new writes until explicitly cleared by a user action.
- Owner-only `safety.lockdown`/`safety.release` actions and controller methods; clear does not resume tasks or replay work.
- Resource Fabric foundation reports actual OS CPU/RAM and filesystem storage; GPU/network remain honestly unavailable until a real provider reports them. It owns bounded in-memory reservation/release state and expiry.
- Reusable prompt maker and deterministic reject-on-error prompt analyser. The analyser rejects missing fields, invalid invariants, C/V evidence misuse, L3 scope gaps, L5 standing-order misuse, duplicate ownership, reimplementation without reuse, inference activation phrases and unverifiable claims.

## Evidence tiers and maturity

Evidence tiers C/P/V are separate from implementation maturity.

| Workstream | Evidence tier | Maturity | Evidence |
|---|---|---|---|
| ECP boundary / permission representation | P foundation | Prototype | T-17 unit suites + code; controller integration in progress/validated separately |
| L0–L2 enforceability | V deterministic subset | Locally validated | T-17 control-plane tests |
| L3 bounded delegation | V deterministic subset | Locally validated | T-17 control-plane tests |
| L4 mission checkpoint | V deterministic subset | Locally validated | T-17 control-plane tests |
| L5 standing-order restriction | V deterministic subset | Locally validated | T-17 control-plane tests |
| Kill switch software latch | V software-level subset | Locally validated | T-17 tests after implementation; hardware hotkey/button contract remains C |
| Resource Fabric actual telemetry/reservation | V deterministic subset | Locally validated | T-17 OS telemetry/reservation tests |
| GPU/network Presence/Resource routing | C | Not started | No real provider metadata or Mesh nodes |
| Owner MFA / step-up identity | C | Not started | Existing UI bearer token is not owner identity |
| Prompt maker/analyser | V code mechanism | Locally validated | T-17 governance tests |
| Persona/voice | C | Not started | No provider/runtime/UI implementation |
| Sentinel/Briefing/Council/Presence/Workshop/Evolution Lab | C or existing partial integrations | Mostly Not started / partial Integrated | Explicitly separated in requirements and architecture ledgers |

## Known T-17 limitations

- No model endpoint was contacted, no model was downloaded, no inference server was started and no GPU/CPU inference was activated.
- Owner authentication remains local-origin/process/UI-token context only. Real MFA/biometric/passphrase owner identity is not implemented.
- A kill switch is a real software latch and cooperative cancellation mechanism. A voice phrase, hotkey or hardware button has no hardware integration.
- Resource Fabric is a telemetry/reservation foundation, not a completed scheduler or distributed allocation service. GPU and network availability remain unknown unless a real provider reports them.
- The Multi-device Presence Mesh, Council runtime, Holographic Workshop, Evolution Lab, Briefing Engine and Persona/Voice providers remain C-tier until implemented and tested.
- A full package test and real-process pilot remain required against the exact final tree.

## Final verification (this continuation)

- Fixed prompt analyser reimplementation detection to inspect only explicit reimplementation intent.
- Required non-empty `explicitNonGoals` so the minimal rejected spec is rejected.
- Reconciled expired-reservation test with past-expiry rejection rule via `assert.throws`.
- Restored and repaired `src/cli.js` syntax; added `plan pause`/`plan resume` dispatch and `--plan-priority`.
- Synchronized capability inventory, capture classification, README and model authorization lists for new safety/plan actions.
- Full package regression: 3680 tests, 3678 pass, 0 fail, 2 skipped.
- Targeted T-08, T-09, T-10, T-13, T-14, T-15, T-16 suites: all pass.
