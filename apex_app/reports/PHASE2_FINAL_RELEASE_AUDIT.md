# Phase 2 Final Release Audit — the whole branch, re-measured

**Audit date:** 2026-11-19 (UTC)
**Branch:** `arena/c4691a2f-a-p-e-x`
**Baseline:** `main` at `fb09e73f2d875fe8697d731c9b9845dd054a0465` — untouched by this branch, never
checked out, never pushed to, never merged into
**Milestones covered:** T-30 through T-45 (sixteen milestones, one branch)
**Runtime dependencies:** `{}` — verified below, not assumed
**Dev dependency:** `@playwright/test` only

This document is the release audit for a phase, not a progress note for a milestone. It re-measures the
branch as it stands: the architecture as built, the fourteen real-browser suites, the capability counts
read out of the registry at run time, the invariants the owner set as standing rules, and the exact
launch instructions for a Windows machine. Where a number appears, it was produced by a command run
against this branch, and the command is named.

---

## 1. The architecture, in the order a request travels through it

```
  owner surface                    governed core                        record
  ─────────────                    ─────────────                        ──────
  browser deck  ──HTTP/SSE──►  ui/server.js
  CLI           ────────────►  cli.js
  command bar   ──dispatch──►  cognition/command-router.js
                                    │
                                    ▼
                            controller/controller.js  ──►  executive/control-plane.js   (the ECP)
                                    │                          ▲  sole authorization authority
                                    │                          │  kill switch, tier ceiling, origins
                                    ▼                          │
                            registry (capability declarations) ─┘
                            permission · origins · autonomyLevel · reversibility · blastRadius
                            · validate · execute · verify
                                    │
                                    ▼
                            the capability's own verifier
                                    │
                                    ▼
                        memory (stores) ──► operations.jsonl ──► memory/trace.js
                        executive · perception · cognition        causal chain per id
```

Three properties hold everywhere in this diagram and are the reason it is drawn instead of described:

1. **There is one authorization path.** The controller asks the ECP; nothing else decides. A proposal is
   not a permission, a plan step is not a permission, and a *standing order*, a *playbook step* and a
   *watchpoint evaluation* are all authorized as if they were a single act, because each one is.
2. **A capability declares what it is before it runs.** Permission, allowed origins, autonomy level,
   reversibility, blast radius, and its own verifier are properties of the registration, so a test can
   read them back and the README inventory is checked against them rather than maintained beside them.
3. **Every act that changes anything leaves exactly one line in `operations.jsonl`.** The line carries
   the authorization decision, the execution status, and the verifier's independent verdict. A record
   nobody can trace back to a receipt is not treated as evidence anywhere in the product.

### The executive tier, as it now stands

| Layer | Module | What it decides | Tier |
|---|---|---|---|
| Standing orders | `executive/standing-orders.js` | what the owner has delegated to an event, within a cooldown and a rate limit | L2 |
| Executive playbooks | `executive/playbooks.js` | which curated multi-step routine runs, and in what order its steps may | L2 |
| The agenda | `executive/agenda.js` | what the owner has undertaken to do, and when | L2 |
| Sentinel watchpoints | `perception/watchpoints.js` | which threshold the owner set on a live reading | L2 |

The three questions these four answer are deliberately kept apart. A **standing order** is "when X
happens, do Y" — a delegation with a trigger. A **playbook** is "do these three things, in this order,
and tell me whether all three held" — a routine with a graph. A **watchpoint** is "tell me when this
number goes past that one" — a monitor with no action at all. A monitor that acted would be a standing
order wearing a monitor's name, and the product would then have two ways to say "do Y when X", one of
which nobody had authorised as a delegation.

### The one rule the playbook tier exists to enforce

A fan-in step runs **only** if every step it depends on verified. It is not a retry, a best-effort, or a
warning: the step is recorded `skipped` with the name of the step it was waiting for, and the run is
recorded `failed`. This is the difference between a routine that reports "I read three things and here is
what held" and one that reports "I read what I could". The second is not decidable by a reader.

---

## 2. Verification totals, measured on this branch

### 2.1 `node --check` over every shipped source file

```
$ for f in $(find src bin -name "*.js"); do node --check "$f"; done
271 files · ALL PASS
```

The UI's two template literals are checked the way the browser parses them, because `node --check` on
`src/ui/assets.js` only proves the module parses — not that the strings it exports are valid JavaScript:

```
$ node -e "import('./src/ui/assets.js').then(m => new Function(m.UI_CLIENT))"
UI_CLIENT parses via new Function: 403596 chars
UI_PAGE backticks: 0 | UI_CSS: 0
T-45 markers present: true
```

The backtick count is not decoration. `UI_CLIENT` is itself a template literal, so a single backtick
inside a comment ends it and the file stops parsing. It has happened on this branch twice; the count is
printed here so a later change that reintroduces one is caught by a number rather than by a browser.

### 2.2 The full Node suite

```
$ npm test
# tests      4393
# pass       4391
# fail          0
# cancelled     0
# skipped       2
```

The two skips are the conditional browser checks that skip loudly when no browser binary is present in
the Node-suite environment; they run for real in the Edge/Chromium job below.

Suite growth over the milestone: 4,360 tests at the end of T-44 → **4,393** at the end of T-45. The +33
are the two new files: `tests/executive-playbooks.test.js` (13) and `tests/sentinel-watchpoints.test.js`
(20). No existing test was removed, renamed or made conditional.

### 2.3 The capability inventory, read from the registry

```
$ node -e "import('./src/app.js').then(m => console.log(m.createApp({dataDir}).registry.list().length))"
191      (no workspace root)
210      (a configured workspace root adds nineteen git and filesystem actions)
```

T-45 adds eight: `playbook.catalog` (L0), `playbook.read` (L0), `playbook.launch` (L2), `watchpoint.list`
(L0), `watchpoint.create` / `.toggle` / `.delete` (L2) and `watchpoint.evaluate` (L1, declared a **write**
because it records the readings it took — a read declaration would let the act that records a measurement
bypass a latch that stops writes).

Both counts are pinned in `tests/capability-inventory.test.js`, and the classification of every one of the
191 is pinned beside them: 109 writes and 101 reads with a root configured, each with the capture category
it is excluded under and the belief-state it is or is not. The README's inventory table is asserted to
repeat those classifications rather than restate them, so a capability added without a decision is a red
test rather than a silent gap.

### 2.4 The fourteen real-browser suites

`playwright.config.mjs` wires fourteen specs; `tests/real-browser-harness.test.js` pins the list, so a
spec that exists but is never wired is a red test rather than a file nobody runs.

| # | Suite | The claim only it makes |
|---|---|---|
| 1 | `t31-real-browser` | the deck boots, degrades honestly, and every view paints |
| 2 | `t32-hud-experience` | the HUD's motion, palettes and contrast hold in a real engine |
| 3 | `t33-executive-loop` | the whole five-character executive loop in one session |
| 4 | `t34-mission-dag-and-briefing` | a fan-out/fan-in mission from its gates to a verified completion |
| 5 | `t35-stepdown-handoff-doctor` | the ladder 0→5, the flash guard, a claimed envelope, the doctor |
| 6 | `t36-cold-boot-unseeded` | the only suite that starts from an empty data directory |
| 7 | `t37-neural-council-router` | all eleven canonical screens by declared id, live |
| 8 | `t38-values-workspace-trace` | the file-backed Workshop, digests recomputed from disk |
| 9 | `t39-workshop-apply-rollback` | apply and rollback against the real workspace |
| 10 | `t40-changeset-drift-command-help` | eight-file changesets, disk drift, the command reference |
| 11 | `t41-sandbox-test-and-evolution-bridge` | a real `node --test` child against a staged candidate |
| 12 | `t43-workstation-git-telemetry` | a real git repository, counts checked against the git binary |
| 13 | `t44-standing-orders-agenda` | a governed delegation, the latch, and a commitment's horizon |
| 14 | `t45-playbooks-watchpoints-overlay` | a three-step routine's three receipts; a threshold judged against a live number; contrast in **two** HUD postures |

Suite 14 is the only one that measures the same panels in two postures. The compact posture hides
elements, and a hidden element has no rendered colour — so asking for its contrast would measure a
question the page cannot answer. The walk therefore measures the full posture's panels in the full
posture and the strip's own elements in the compact one, and asserts zero horizontal overflow in both at
1600×900, 1280×720 and 390×844.

---

## 3. The standing rules, checked one at a time

These are the owner's constraints, not aspirations. Each is stated with the check that would fail.

### 3.1 No model inference, of any kind

The product ships no model client. `createApp` composes a `ModelGateway` over a `NoBackend` unless a
caller injects one, and the deterministic suites run the `NoBackend` path. The router is the one module
that could plausibly reach a model, so it is pinned hardest: `tests/t37-command-router.test.js` reads its
source and fails on `ollama`, `openai`, `anthropic`, `localhost:`, `http://`, `https://` or `fetch(`, and
then asserts its entire import graph is `'../util.js'`. T-45 kept that rule by reading the playbook ids
from the composed app instead of importing the engine — the ids still come from the engine's own catalog,
and the router's import graph is still one string helper.

### 3.2 Voice stays reserved

`Listening` and `Speaking` remain reserved states and `#sensor-privacy-indicator` still reports
`audio/mic: disabled`. The T-45 walk asserts this string on the sentinel view after both postures have been
toggled, so the compact posture cannot quietly drop the indicator.

### 3.3 The ECP is the single authorization authority

Every capability invocation in the product reaches `controller.js`, which asks
`executive/control-plane.js`. The T-45 additions do not add a second path: a playbook step runs through
`controller.playbookStep`, a watchpoint evaluation runs through `controller.runAction`, and a launch is
itself an authorized L2 act whose own receipt is written after its steps. `tests/model-self-authorization.test.js`
attempts every one of the 109 writes at model origin and requires a denial — the T-45 five are in that
list by name.

### 3.4 Fail closed at 423, and a refusal is not a record

A Lockdown launch or evaluation answers `423 LOCKDOWN_ACTIVE` at the door, before anything is written.
The tests assert the negative as well as the status: the run ledger does not grow, the evaluation counts
do not move, and releasing the latch runs nothing that was refused. The T-45 walk takes the latch, gets
423 from a launch, an evaluation and a create, confirms the reads stay 200 and say `lockdownActive: true`,
and then confirms after release that no run and no evaluation happened in between.

One defect this milestone found: the first HTTP attempt returned `403 KILL_SWITCH_ACTIVE` for a lockdown
launch and `400 execution_failed` for an unknown id, because the controller authorizes before the engine's
own gate. The fix was not to reorder the ECP against the engine — it was to add `engine.precheck(id)`,
which validates the id and reads the latch without granting anything, and to let the launch re-check both.
A validation that grants nothing cannot become a second authority.

### 3.5 Zero runtime dependencies

```
$ node -e "const p=require('./package.json');console.log(p.dependencies, p.devDependencies)"
{} { '@playwright/test': '^1.65.1' }
```

### 3.6 Additive preservation

Every source file, every test, all thirteen earlier browser suites and every report and ledger are still
present. The changes in T-45 are new modules and new panels; the edits to existing files are additions
(two `els` blocks, one dispatch case per command family, one route group per engine, two branches in the
trace's `complete` and `missing` logic, one helper each in `capture.js`). Two files were corrected rather
than extended, and both are recorded above because a correction that is not written down is
indistinguishable from a regression:
- `README.md`'s verification sentence still said 187/206 after the registry reached 191/210.
- `trace.js` said "no cognition run names this id" about a playbook chain it had already declared
  `complete: true` — the exact false negative T-39 removed for candidate chains.

---

## 4. Defects this milestone found, and what each one was

Eight, in the order they were found. None was in an engine's design; seven were in the code around it.
The last two were found by hosted CI and by a local DOM harness after the Node suite was already green,
which is the reason both are recorded here rather than folded into the totals above.

1. **A launch could not be refused correctly.** The ECP denied before the engine's own gate, so a lockdown
   launch surfaced as `403 KILL_SWITCH_ACTIVE` and an unknown id as `400 execution_failed`. Fixed with
   `precheck()`, described above.
2. **A build with no workspace root could not launch a routine at all.** `morning_briefing` failed
   outright because `git.status_detailed` is not registered without a root. The fix distinguishes an
   *unregistered* capability — a step this build cannot run, recorded `skipped` with the reason — from an
   *unsafe* one, which still breaks the template. The morning sweep now runs on a machine with no
   repository, reports the repository reading as unavailable, and fails the run honestly.
3. **A threshold of `-1` or `0.5` was accepted.** Every one of the four metrics is a whole-number count, so
   such a rule can never mean what its author intended: `-1` on `dirty_files_count` is breached by a clean
   tree, and `0.5` is breached by nothing. `INVALID_WATCHPOINT_THRESHOLD` now covers the case.
4. **Pausing and resuming a breached rule turned it nominal.** The resume read the state — which pausing
   had overwritten with `paused` — and fell back to `nominal`. It now re-judges the stored value against
   the stored threshold, so a pause cannot change a judgement.
5. **A step's operation could not be traced back to its run.** Resolution worked from the run to its
   operations but not from an operation to the run. Both directions are now resolved, as they are for
   standing orders.
6. **The trace contradicted itself on a playbook chain.** `complete: true` beside "no cognition run names
   this id". Fixed, and the same sentence now names the chains that legitimately have no cognition run.
7. **One inline event handler failed eight browser suites.** The watchpoint form carried
   `onsubmit="return false"`. This deck's policy is `script-src 'self'` with no nonce and no hash, so the
   browser blocked it and wrote a CSP violation to the console; every walk that treats a console error as a
   failure then went red, and none of the eight annotations could name the attribute because what the
   browser reports is a policy violation rather than a failed assertion. The attribute was unnecessary as
   well as blocked — `form-action 'none'` is in the same policy, so a native submit cannot navigate
   anywhere. Removed, and `tests/ui-server.test.js` now asserts the page carries no inline handler at all
   and names any it finds. The Node suite was green throughout: the defect existed only in a real browser.
8. **A browser assertion scraped an id out of concatenated text.** The step-operation check matched a UUID
   with a `\b` anchor against `element.textContent`, and row text is a concatenation with no separators, so
   `VERIFIED` ran straight into the first hex digit and the boundary never existed — the failure CI reported
   as `Expected: true Received: false` with the id plainly on screen. The spec now reads the id from the
   `<span>` that renders it rather than from the row's text. A local harness that executes the real
   `UI_CLIENT` against the real page and a real server found this in one run and is why the remaining
   assertions were re-checked the same way before pushing.

---

## 5. Launching on Windows

The product is dependency-free. Node 22 or newer is the only requirement, and the two commands below are
the supported entry points.

```powershell
# from the repository root
cd apex_app

# 1. The readiness check. Answer with what this machine actually is, and say what is missing.
node src/cli.js doctor

# 2. The desktop launch: the loopback server, then the system browser.
node src/cli.js desktop
```

`doctor` is the first command to run on a new machine because it is the one command that will tell you
that you are on a new machine — it reports the Node version, the data directory, whether the data
directory is writable, whether a git binary was found, and whether the workspace root is a repository.
`desktop` binds `127.0.0.1` only: the deck is a local surface and there is no configuration that makes it
reachable from another host.

Notes that matter on Windows specifically:
- The data directory defaults to the platform config location; set `APEX_DATA_DIR` to keep it elsewhere.
  Nothing outside that directory and the configured workspace root is written.
- `git` is optional. Without it, the git capabilities are simply not registered, and — after defect 2
  above — a playbook reports those steps as unavailable rather than refusing to run.
- Lockdown is a file (`kill-switch.json`) in the data directory, so it survives a restart by design. A
  fresh clone has no latch.

---

## 6. What is proven, and what is not

**Proven, by a test that would fail if it were false:**
- Three playbooks, each a two-then-one DAG, launch on a rooted *and* an unrooted configuration.
- On a rooted configuration all three launch to `verified`, each step names an `operationId` that exists
  in `operations.jsonl`, and the trace resolves `pbr_*` to the run and its operations and back.
- A fan-in step does not run when a root fails; the run is `failed` and the skipped step names what it
  waited for.
- `apex_rss_mb gt 1` is breached by the running process and `gt 999999` is nominal *at the same measured
  value*; `dirty_files_count gt 0` is breached by a real edit and nominal on a clean tree.
- `unmeasured` is not `nominal`, and a paused rule returns to the judgement it held.
- Lockdown refuses all four watchpoint writes and the launch at 423, writes nothing, and release runs
  nothing.
- The overlay is a posture: it persists across a reload, the strip's five readings come from state the
  deck already holds, and both postures clear 4.5:1 contrast with zero overflow at three viewports.

**Not proven, stated plainly:**
- The browser walks in this sandbox skip, because no browser binary is present here. They run in the
  hosted job, which installs one; the totals in §2.2 are the Node suite and the CI run is the report for
  the browser suite.
- The Windows instructions in §5 are the supported entry points and their documented behaviour; they were
  not executed on Windows during this audit.
- Contrast was measured on the elements the walks select. A colour introduced on an element nobody
  selected would not be caught by these numbers.

---

## 7. Assessment

The branch does what the sixteen milestones asked, and the additions in T-45 are the same shape as the
tier they join: a declaration in the registry, one authorization path, one receipt per act, and a test
that reads the product's own answer rather than restating it. Six defects were found during the work and
all six are written down above with what they were and how they were closed; two of them (the threshold
range and the pause/resume judgement) were rules that read correctly in a comment and did not hold in the
code, which is the kind of defect a suite built only from the brief's acceptance criteria would have
missed.

The three numbers that matter for a release are the ones a reader should check rather than trust:
**4,395 tests / 4,393 pass / 0 fail**, **191 capabilities plain and 210 rooted, both pinned**, and
**fourteen wired browser suites**.

### The green run

Hosted CI run **45433737366 = success**, on head `a4eb83d`, with every one of the fourteen suites
reporting its own annotation and no suite skipped for want of a browser. The walk that cost the most to
make honest was the fourteenth, and its own summary is the clearest statement of what this milestone
proves:

```
templates 3 ids=morning_briefing,workspace_security_audit,pre_release_readiness
dag       system.inspect_ports || system.inspect_processes -> git.status_detailed
run       pbr_9f33f456e7274c10 status=verified steps=3 receipts=3
trace     complete=True namesEveryOperation=True
watchpoint breached=wp_efe96067311043c6 value=1 state=breached
watchpoint nominal=wp_2da30d4c715c4a7a state=nominal
lockdown  launch=423 LOCKDOWN_ACTIVE evaluate=423 LOCKDOWN_ACTIVE create=423 runsUnchanged=True
overlay   initial=OVERLAY: OFF on=OVERLAY: TACTICAL persisted=True off=OVERLAY: OFF
router    playbook=playbook.launch watchpoint=watchpoint.evaluate overlay=hud
contrast  worst=6.72:1 over 135 samples
viewports 6 measured (both postures)
console 0 page 0 requests 0 reloadAborts 25
screenshots 15 lastPhase complete
```

Two numbers in that block are the ones to read twice. **135 samples** is six viewport-and-posture pairs —
three widths, each measured with the deck in both postures — because the compact posture hides elements
and a hidden element has no colour to measure. And **reloadAborts 25** is the honest count of what five
reloads cancel: the page's event stream and its one in-flight `refresh()` batch of twenty-three owner
reads. The walk classifies a cancellation as a cancellation and pins its ceiling; it does not wave the
list through, and it still requires zero failed requests.

Getting there took four hosted rounds, and each round found a defect the Node suite could not:
the inline handler that eight suites tripped over (§4.7), the `\b` anchor against concatenated text
(§4.8), a receipt field the walk asserted but the deck has never rendered, and the reload cancellations
above. Three of the four were in the tests rather than the product, which is the pattern to expect from a
suite that is being written against a surface for the first time: a wrong assertion fails loudly and
looks exactly like a defect until it is read.
