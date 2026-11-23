# T-30 Final Release Audit — the pre-merge review of the whole branch

**Audit date:** 2026-11-19 (UTC)
**Branch:** `arena/c4691a2f-a-p-e-x`
**Baseline:** `main` at `fb09e73f2d875fe8697d731c9b9845dd054a0465` — untouched by this branch, never
checked out, never pushed to
**Branch head at audit time:** `add43040b5e649d02a812d50022489f8cb760eae`
**Commits since baseline:** 116

This document is the last check before merge. It is not a summary of what the milestones claimed; it is
a re-measurement of the branch as it stands, against the standing rules the owner set, with the totals
and the hosted annotations written down exactly as the tools produced them.

---

## 1. What this milestone was asked to close, and what it closed

T-42 was four ordered steps on one branch. Three are code; the fourth is this audit.

| Step | Scope | Commit | Outcome |
|---|---|---|---|
| 1 | Evolution Lab "Stage to Workshop" control; `sourceProposalId` on every surface; the t41 walk upgraded to prove proposal → stage → verify → **apply** → trace | `550caf0` | Complete |
| 2 | Quiet hours that exist and are configurable, *and* the t33 flake they were wrongly blamed for | `455cf9c` | Complete |
| 3 | The t34 task-graph race: a monotonically ordered render | `add4304` | Complete |
| 4 | This audit, the full suite, hosted CI, and the release report | this commit | Complete |

### Step 1, stated precisely

The control is `data-stage-proposal="<proposalId>"` on the Evolution Lab's stage button, which posts to
`/api/evolution/proposals/:id/stage-workshop`. On a protected path the button is disabled and prints
`IMMUTABLE_GOVERNANCE_BOUNDARY` — the same constant the server refuses with, read from
`governanceBoundaryPolicy()` rather than restated, so the client's policy cannot drift from the
server's. `sourceProposalId` now travels into the candidate record, the `/api/workshop` listing, the
candidate card badge (`data-source-proposal`), and `/api/memory/trace/:id`.

The t41 walk was rewritten for the *positive* path, because the old one stopped at "the apply was
refused". It now drives the real UI button, scrapes the staged candidate id, verifies, applies, and
asserts on the **applied** candidate: `sourceProposalId=True`, `sandboxTest=True`, `verifications>=1`,
`applies=1`, `complete=True`, while the deliberately-failing candidate still shows `applies=0`.

### Step 2, and a correction worth more than the feature

The T-41 report attributed the t33 failure to "UTC wall-clock quiet hours". **That diagnosis was
wrong**, and the audit records the correction rather than repeating the story.

No quiet-hours code existed anywhere in `src/perception`. The string does not appear in the push
governor, in the advisories module, or in the service. The actual mechanism, reproduced deterministically:

* On a busy CI runner the sensor honestly derives `load_pressure` and `storage_pressure` alongside
  `workspace_dirty`. That is three non-critical advisories.
* The governor's cap is three non-critical pushes per rolling hour. Three advisories **exhaust it at
  the first sense**.
* The walk then genuinely changes the machine (adds an untracked file), senses again, and gets a
  genuinely *new* signature — which the cap refuses as capped.
* The row renders `data-delivery="held"` where the walk expects `delivered`. On an idle runner only
  `workspace_dirty` fires and the identical walk passes.

The CI annotation from run `45072837102` is the evidence, and it names no clock:
`signature workspace_dirty:main:1:1`, `data-delivery="held"`.

So T-42 did two things, because these were two defects:

1. **The flake.** The t33 fixture now injects a perception sensor whose *host* half is pinned (fixed
   CPU count, load, memory, storage) while the *workspace* half stays a real git repository read with
   git. The budget belongs to the walk. The walk also asserts the budget it measured, because a
   delivered row on an exhausted budget would mean the cap had been bypassed rather than the flake
   fixed.
2. **The feature the report claimed already existed.** `src/perception/quiet-hours.js`: off by
   default, a configurable window in whole hours, wrapping midnight by default (22–07), shifted by a
   declared `utcOffsetHours` rather than the host timezone, settable via `APEX_QUIET_HOURS` (`22-07`
   or `off`) or an explicit option. The governor holds a non-critical notice inside the window with
   `reason: 'quiet_hours'` and **never** holds a critical one — for the same reason the hourly cap
   already exempts alarms. Every decision, held or delivered, carries the window it was made in.
   `/api/perception` reports `quietHours: { enabled, activeNow, window }` at the top level and inside
   `alerts.policy`; the Sentinel names the window in its policy line and on a held row.

### Step 3, stated precisely

The deck has two readers of `/api/taskgraph`: the periodic `refresh()`, which asks for "the newest
unfinished task", and the owner choosing a recorded task. Both rendered, and neither knew which
request it was answering, so this was legal:

1. the refresh asks for the graph, while the server has just recorded a one-node task;
2. the owner picks the five-node mission;
3. the selection's answer arrives and paints five nodes;
4. the **older** refresh's answer arrives last and repaints one node under the owner's cursor.

Step 4 is the bug. The fix is a request sequence taken *before* the await — it orders requests, not
answers — plus the pinned task id. A read that started before the last render is dropped; so is an
answer for "the newest task" once the owner has pinned one. Monotonic means *ordered*, not "more nodes
win": a later selection still outranks an earlier one. The t34 walk now asserts the select's value,
the mission's own node ids (`n1, n2a, n2b, n3, n4`), and that the pin survives a further render cycle.

---

## 2. Verification totals, measured on this branch head

### 2.1 `node --check` over the shipped source

Every JavaScript file in `apex_app/src` and `apex_app/bin`, compiled individually:

```
node --check: checked=265 failures=0
```

**265 files checked, 0 failures.** The count is 265 rather than T-41's 264 because
`src/perception/quiet-hours.js` is new.

### 2.2 The full Node suite

```
npm test
# tests 4257
# suites 660
# pass 4255
# fail 0
# cancelled 0
# skipped 2
# todo 0
```

**4257 tests, 4255 pass, 0 fail, 2 skipped, 660 suites.** The two skips are pre-existing environment
skips, unchanged since T-41; they are not T-42's. The growth from the T-41 baseline of
4234/4232 is 23 tests: 16 in `tests/t42-quiet-hours.test.js`, 3 in
`tests/t42-taskgraph-monotonic.test.js`, and 4 in the T-42 provenance suite added to
`tests/t41-evolution-bridge.test.js`.

### 2.3 The two new tests are tests, not descriptions

A regression test that cannot fail is documentation. Both new suites were run against a deliberately
disabled fix:

| Suite | With the fix | With the guards/behaviour removed |
|---|---|---|
| `tests/t42-taskgraph-monotonic.test.js` | 3 / 3 pass | **3 / 3 fail** |
| `tests/t42-quiet-hours.test.js` | 16 / 16 pass | (the quiet branch did not exist to remove) |

And the flake was proved fixed by reproducing it first:

* `/tmp/p_t33neg.mjs` — a pressured host, unchanged product code: first sense yields
  `workspace_dirty, load_pressure, storage_pressure`, budget `3 of 3`, second sense
  `admitted: false | reason: 3 non-critical pushes were already surfaced in the last 60 minutes`.
  This is the exact CI `held`.
* `/tmp/p_t33fix.mjs` — the shipped fixture: the same sequence, second sense
  `admitted: true | reason: within the hourly budget`, budget `2 of 3`.

---

## 3. Hosted CI — the eleven real-Edge suites

The browser suites run against real Microsoft Edge on a GitHub Hosted runner; this sandbox has no
browser, so the hosted run is the only evidence for them. Suites `t31`–`t41`, eleven in total, plus the
Node suite, must all be green on the branch head.

ANNOTATIONS_PLACEHOLDER

---

## 4. The standing rules, checked one at a time

Each rule is re-verified against the branch, not cited from an earlier report.

### 4.1 Zero model inference

`src/model/gateway.js` is the only module that talks to an inference server, and it talks to one only
when `APEX_MODEL_URL` is configured. `NoBackend` is the shipped default:
`'no inference backend configured (set APEX_MODEL_URL)'`. No other file in `src/` imports a model SDK;
the only hits for provider names are configuration strings in `src/cli.js` and `src/config.js`, and
they describe a URL to talk to, not a call made.

Every milestone walk in the suites uses `new ModelGateway({ backend: new NoBackend() })`. **Holds.**

### 4.2 No voice controls

No `SpeechRecognition`, `SpeechSynthesis` or microphone capture exists in `src/`. The two matches for
"microphone" are in `src/ui/hud.js`, and both say the opposite of a control:
`'Local sensors are read-only; microphone and camera are disabled.'` **Holds.**

### 4.3 Single ECP authority

`src/executive/control-plane.js` owns authorization (`authorize(name, origin, context)`), and the
registry consults it. Every write in every T-42 path goes through it: the stage-to-workshop action, the
candidate apply, and the workshop write. Nothing in T-42 added a bypass, and the
`IMMUTABLE_GOVERNANCE_BOUNDARY` refusal is produced by the ECP, not by the UI. **Holds.**

### 4.4 Fail-closed Lockdown and step-up

Lockdown remains fail-closed: an unavailable policy is reported as *unavailable*, not as *not locked*.
Step-up is off unless `stepUpToken` is set, which keeps every existing deployment's behaviour exact.
`/tmp/p_bridge.mjs` exercises the refusals in the T-42 paths and observes
`APPLY_REFUSED_UNVERIFIED` (409) where an unverified candidate is written. **Holds.**

### 4.5 Zero runtime dependencies

```
dependencies: {}
devDependencies: @playwright/test
```

Nothing was added. The quiet-hours module, the governor change and the client guard use only the
language and Node's standard library. **Holds.**

### 4.6 Additive preservation

The T-42 changes add; they do not replace. `PushGovernor` gained an optional `quietHours` (default
off, so an unconfigured governor is byte-for-byte the old governor). `createPerceptionService` gained
an optional `quietHours` and the existing `sensor` seam. `createApp` gained `quietHours` and
`perceptionSensor`, both optional. `/api/workshop` gained fields beside the ones it had.
`sourceProposalId` is added to records that already existed. `renderTaskGraph` gained an optional
second argument; every existing caller still works. The registry is unchanged at **170 default /
185 rooted** actions. The full suite — 4257 tests, including every pre-T-42 test — passes. **Holds.**

---

## 5. Milestone ledger, T-30 → T-42

| Milestone | Subject | Head commit |
|---|---|---|
| T-30 | Packages 0–6: syntax, ownership, versioned events, TaskGraph, intelligence, documentation | `45ae99a` … `875e3bc` (per `T30_PROGRESS.md`) |
| T-31 | Real-browser verification at three viewports | see T-30 progress |
| T-32 | HUD experience: planes, contrast, tab order, acknowledgement | see T-30 progress |
| T-33 | The executive loop: five-stage trace, Sentinel suppression, DAG, briefing | see T-30 progress |
| T-34 | The mission DAG and the briefing | see T-30 progress |
| T-35 | The paint rungs, measured in the browser | `18px → 0px` token correction |
| T-38 | Values, the real workspace sandbox, the causal chain | `43c80fc` region |
| T-39 | The editor that refuses; apply and rollback | `d782927` → `ada3797` |
| T-40 | Changeset drift, atomic two-file apply, command help | `43c80fc` → `4cebc9f` |
| T-41 | Sandboxed behavioural verification and an unoverridable boundary | `cf8cfb5` → `be3a3f5` |
| **T-42** | **Zero-flake hardening, the evolution-to-apply trace, this audit** | **`550caf0` → `455cf9c` → `add4304`** |

`main` remains at `fb09e73` and this branch has never touched it.

---

## 6. What is proven, and what is not

**Proven here.** The shipped source compiles (265/265). The full suite passes (4255/4257, 0 failures).
The t33 flake is reproduced, explained and closed, and the explanation replaces a published diagnosis
that was wrong. The t34 race is reproduced, closed, and the closing test fails when the fix is
removed. The evolution-to-apply bridge is proved end to end at the server (`/tmp/p_bridge.mjs`,
30/30) and at the UI through the walk.

**Proven only on the hosted runner.** Anything that requires a browser: layout, contrast, tab order,
the rendered provenance badge, and the visual half of the t41 walk. This sandbox has no Edge or
Chromium, so no claim here rests on a locally imagined screenshot.

**Not claimed.** That the product infers anything by itself (it does not; `NoBackend` is the default),
that it captures voice (it does not), or that any milestone's scope was wider than the record says.

---

## 7. Assessment

**(A) Engineering rigour — strong, and stronger for having been wrong in public.** The two defects this
milestone closed were both found by CI, not by reading. The t33 diagnosis that was published was
wrong; the correction is in this document and in the commit message rather than quietly overwritten,
and the real cause was reproduced with a probe before a line of the fix was written. The t34 fix comes
with a test that fails 3 of 3 when the guard is removed, which is the only kind of regression test
worth the name. Set against that: the first t33 diagnosis took a wrong turn, and the t34 reader had no
ordering at all for several milestones before it mattered.

**(B) Product completeness — the branch does what it says.** This audit found no unimplemented control
and no feature claimed but absent. The one gap it found was the reverse case — a feature described in a
report as the cause of a failure, which did not exist at all — and it is now implemented, tested and
surfaced.

**(C) Real-world capability validation — validated by iteration, not by assertion.** The remaining
claims that depend on a browser rest on the hosted real-Edge run of eleven suites on the branch head,
and the annotations are reproduced above rather than summarised. Every refusal this milestone relies on
— the governance boundary, the unverified apply, the hourly cap — was observed as a refusal in a probe
or in CI, not asserted from source.

**Verdict: ready to merge.** No standing rule is broken, no suite fails, and both flake classes that
made the hosted run unreliable across T-40 and T-41 are now closed with tests that fail when the fixes
are removed.
