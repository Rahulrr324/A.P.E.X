# APEX v2 canonical requirements inventory

**Authority:** `APEX v2 Concept, Capability Fusion & Stark-Style Experience Brief.pdf` (12 pages, dated 2026-11-18). The original `1.2APEX_Project_Concept_and_Architecture (1).pdf` (16 pages) was also located and compared. The v2 brief supersedes it and says its canonical principles and ownership rules are retained; this inventory preserves both the v2 requirements and the identifiable original requirements rather than treating the new document as implementation evidence.

This is a requirements inventory, not an implementation report. Each row has an **evidence tier** and an independent **implementation maturity** label. Evidence tier C/P/V is not maturity. For mixed/partial capabilities the row records the tier of the complete v2 requirement, with the current implementation described separately.

| Evidence tier | Meaning |
|---|---|
| C — Concept | Designed, not built as the complete requirement. |
| P — Prototype | Exists, unverified. |
| V — Verified | Demonstrated by repeatable tests with a defined baseline. |

Maturity labels are exactly: `Not started`, `Contract only`, `Prototype`, `Implemented`, `Integrated`, `Locally validated`, `Real-world validated`.

## V2 clause-by-clause inventory

### §0 — Use and evidence governance

| ID | Requirement (preserved meaning) | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0001 | Treat this brief as design intent, not implementation status. | Existing README and architecture distinguish evidence from claims; prompt governance must preserve this rule. | V | Locally validated |
| V2-0002 | Every prompt, task and test carries a C/P/V evidence tier; never describe C-tier features as working. | T-01–T-16 currently use maturity labels in the ledger; C/P/V is a separate new axis. | C | Not started |
| V2-0003 | Prompt analyser rejects any specification that weakens a §12 invariant. | No canonical prompt analyser existed at the start of T-17. | C | Not started |

### §1 — Vision and five capability fusions

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0101 | One persistent personal intelligence, not five products or personas. | Identity, controller, stores and interaction are one app; no cross-device persistent identity. | C | Integrated |
| V2-0102 | JARVIS: natural conversation, controlled systems assistance, configurable dry-wit tone. | Conversation and deterministic actions exist; no voice; persona is not implemented. | C | Integrated |
| V2-0103 | FRIDAY: calm tactical briefing, proactive alerts and fast situational summaries. | Historical T-16 snapshot. Since T-22, a deterministic briefing engine/API exists (`src/briefing/`); persona modes remain absent. The full calendar/mail and voice target is not claimed. | C | Integrated |
| V2-0104 | EDITH: perception, scene/target analysis and owner-only scoped access. | Document understanding and local UI exist; camera/spatial perception and owner authentication do not. | C | Contract only |
| V2-0105 | ULTRON: distributed presence and persistent goal pursuit with controlled evolution. | Historical T-16 snapshot. Goals/runtime remain local; Presence Mesh is still absent. T-23 added an evolution-lifecycle foundation, not a sandboxed Evolution Lab. | C | Integrated |
| V2-0106 | VISION: synthesis of perspectives, calm ethical reasoning and a non-hijackable core. | Historical T-16 snapshot. A Council foundation was added by T-25; model inference remains disabled. A formal Values & Constraints Core remains absent. | C | Integrated |
| V2-0107 | Replace fictional omniscience/instant access with the nearest honest, bounded mechanism. | Project truthfulness rules already prohibit unsupported capability claims. | V | Locally validated |

### §2 — Fictional-trait mapping, realistic mechanism and guardrail

| ID | Fictional trait → required subsystem | Realistic mechanism | Required guardrail | Existing mapping / maturity |
|---|---|---|---|---|
| V2-0201 | JARVIS natural control → Interaction Layer, Voice, Tool Adapters | Streaming speech in/out; device/app control through authorized adapters. | ECP approves every external action. | Local text UI and adapters are partial; voice absent. C / Integrated |
| V2-0202 | JARVIS address/tone → Persona Layer | Configurable tone profile on one identity. | Persona never changes policy. | No persona subsystem. C / Not started |
| V2-0203 | FRIDAY briefing → Briefing Engine | Calendar, mail, system, task summaries with confidence/provenance labels. | Observed and inferred remain distinct. | Historical T-17-start snapshot. T-22 added a deterministic briefing engine/API (`src/briefing/`); full source coverage and confidence-calibrated external data remain unverified. C / Not started |
| V2-0204 | FRIDAY proactive → Sentinel | Event watchers, anomaly detection and scheduled review. | Alerts are proposals; rate-limited and dismissible. | T-09/T-10 provide parts; no named Sentinel / bounded notification policy contract. C / Integrated |
| V2-0205 | EDITH scene/target analysis → Perception + Spatial Overlay | Camera/screen understanding, object/text recognition, overlay HUD. | Interpretation, not fact. | No camera or spatial overlay. C / Not started |
| V2-0206 | EDITH owner lock → Owner Authentication | MFA via voice/device/passphrase and optional biometric before elevated scopes. | ECP-enforced; model cannot grant access. | Local token auth is only UI access, not owner MFA/step-up. C / Prototype |
| V2-0207 | ULTRON self-improvement → Evolution Lab | Sandboxed prompt/routing/planner/neural-rule experiments with evaluation gates. | Controlled evolution only; ECP and hard rules outside learnable path. | T-08 adaptation/evaluation is not a sandboxed Evolution Lab. C / Integrated |

### §3 — Canonical architecture and new layers

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0301 | Keep two independently evolving tracks: APEX Intelligence and APEX Neural Research. | `apex_app/` and `stark/` are separate; historical STARK identifiers preserved. | V | Locally validated |
| V2-0302 | Join tracks only through a versioned, validated Neural–Cognitive Bridge. | Versioned neural proposal contract is tested; no runtime/bridge transport is connected. | C | Contract only |
| V2-0303 | Retain Identity/Context, Cognitive Runtime, Global Workspace, Attention/Salience, Reasoning/Evaluation. | Context, cognition and reasoning exist; a bounded global workspace/attention owner is not explicit. | C | Integrated |
| V2-0304 | Keep Memory, Knowledge, World Model and Neural Associative Memory distinct. | Memory/knowledge/world model are separate; neural associative memory is research-only/not connected. | V | Integrated |
| V2-0305 | Goals, Planner, TaskGraph and closed-loop plan→authorize→execute→observe→verify→update. | Goals, bounded planning, plans/tasks, the ECP facade over the existing registry, and independent verification exist; the general planner remains incomplete. | C | Integrated |
| V2-0306 | ECP is sole authorization authority; Resource Fabric is sole resource-allocation authority; preserve Model Gateway. | Historical T-16 snapshot: the registry was the direct authorization owner and no Resource Fabric owner was recorded. Superseded 2026-11-19: `src/executive/control-plane.js` is the ECP authorization facade over that same registry, and `src/resources/` provides a local Resource Fabric foundation. Neither implies owner MFA, mesh allocation or the full v2 target. | C | Integrated |
| V2-0307 | Retain Perception, Interaction, Identity/Continuity, computational emotion indicators, Reliability/Recovery. | Text/document perception, UI, continuity and recovery exist; emotion indicators absent. | C | Integrated |
| V2-0308 | Persona & Voice modes: Classic, Tactical, Overwatch, Synthesis; alter tone, verbosity, theme and defaults only. | Not implemented; policy separation must be enforced. | C | Not started |
| V2-0309 | Sentinel watches calendar, mail, files, health, network, tasks; proposals/briefings obey notification budget. | T-09/T-10/T-11 cover some sources and events; mail/network/provider completeness and notification budget gaps remain. | C | Integrated |
| V2-0310 | Briefing Engine creates morning, mission, incident and debrief reports from TaskGraph, World Model and memory with provenance. | Historical T-17-start claim, superseded by the T-22 deterministic briefing engine/API (`src/briefing/`); the complete morning/mission/incident/debrief requirement remains partial. | C | Not started |
| V2-0311 | Council supports specialist proposals via Model Gateway; synthesizer reports synthesis and disagreement; no authority. | A Council foundation and UI exist since T-25. Multi-model/provider deliberation is not claimed and inference remains prohibited unless explicitly reauthorized. | C | Not started |
| V2-0312 | Presence Mesh shares one identity, memory sync and task handoff with per-node permissions. | No nodes, network sync, or cross-device handoff. | C | Not started |
| V2-0313 | Workshop provides interactive visual design/simulation/inspection for code architecture, circuits, CAD-like models, data and plans. | Historical T-17-start claim, superseded by the T-26/T-27 bounded design-composition, inspection and deterministic arithmetic-simulation foundation. It is not a holographic 3D CAD system or code runner. | C | Not started |
| V2-0314 | Evolution Lab is the only path for proposing/testing self-improvements. | T-08 approved adaptation and a T-23 evolution-lifecycle foundation exist; neither is sandboxed self-modification or a complete Evolution Lab. | C | Not started |
| V2-0315 | Owner Authentication and step-up gives stronger proof for high-risk scopes. | No owner identity/MFA/step-up subsystem. | C | Not started |
| V2-0316 | Conceptual flow includes environment/user→Perception/Interaction→Identity+stores→Cognitive Runtime/Workspace/Attention/Council→Goals/Planner/TaskGraph→ECP→authorized environment; return via observation/verification/update; Sentinel uses same flow. | Existing controller flow provides a subset; component contracts must converge on one authorization path. | C | Integrated |
| V2-0317 | Values & Constraints Core: owner-defined values and hard rules evaluated before action. Hard rules are ECP policy, not prompts. | No separately specified values core; hard-coded safety constraints are distributed. | C | Not started |
| V2-0318 | Tamper resistance: signed/versioned policy, owner-approved changes, step-up for edits. | No signed policy configuration or approval lifecycle. | C | Not started |

### §4 — L0–L5 autonomy and kill switch

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0401 | Autonomy is explicit, per-domain, owner-set and ECP-enforced. | Historical T-16 snapshot, superseded 2026-11-19: `APEX_AUTONOMY_LEVELS` is parsed at startup and ECP enforces per-domain levels 0–5. It is process configuration, read-only in the UI, not live-editable and not owner authentication/MFA; it is only a partial match for the owner-set v2 requirement. | C | Integrated |
| V2-0402 | L0 Observe: read-only answers and briefings. | Historical T-16 snapshot, superseded 2026-11-19: ECP uses startup-only `APEX_AUTONOMY_LEVELS`; the conservative default assigns reads level 0. This does not create a richer Suggest interaction mode. | C | Integrated |
| V2-0403 | L1 Suggest: proposes actions; owner executes. | Historical T-16 snapshot, superseded 2026-11-19: ECP uses startup-only `APEX_AUTONOMY_LEVELS`; level 1 blocks writes like level 0 and does not by itself provide a full Suggest workflow. | C | Integrated |
| V2-0404 | L2 Confirm: prepares and executes only after each approval. | User-origin writes and plan approvals exist; not every write is represented as a separate approval card. | C | Integrated |
| V2-0405 | L3 Delegate: pre-approved task classes, bounded scope/budget, reports after. | ECP now supports bounded, in-process delegation grants with capability, scope, budget, expiry and action limits; grants are not a persistent or connected agent-execution boundary. | C | Not started |
| V2-0406 | L4 Mission: multi-step TaskGraph with checkpoints; pauses at defined risk gates. | Plans/tasks/checkpoints and ECP levels exist; bounded mission grants require a checkpoint reference. The complete per-risk mission policy and end-to-end L4 workflow remain unverified. | C | Integrated |
| V2-0407 | L5 Standing Orders: recurring low-risk routines only, with audit review. | ECP has a bounded in-process standing-order grant check for explicitly granted low-risk work; there is no persistent recurring-routine owner or full audit-review workflow. | C | Integrated |
| V2-0408 | Irreversible, financial, destructive, security-relevant and privacy-exposing actions default to no more than L2. | Some actions are user-only/unplannable and registered capabilities may declare risk/max-autonomy; complete coverage and the v2 irreversible-action classification are not established. | C | Integrated |
| V2-0409 | Voice phrase, hotkey or hardware kill switch operates outside model path and halts execution immediately. | Historical T-16 snapshot, superseded 2026-11-19: a durable software latch is owned by ECP at `dataDir/kill-switch.json`, with user-origin safety actions. T-30 Package 3 verifies a local UI-token/anti-CSRF ECP lockdown/release path with a reason, explicit release confirmation, operation-audit evidence, and no automatic resume. No voice/hardware switch or owner MFA/step-up exists; browser interaction remains unverified. | C | Not started |

### §5 — Stark-style experience

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0501 | Interface evokes Stark lab/Avengers HUD while remaining readable and honest; original assets only. | Current UI is functional/local and not the target experience; no film assets should be copied. | C | Prototype |
| V2-0502 | Pillars: alive; layered glass/depth/parallax/glow; dense hierarchy with one focal point; honest verified state; cinematic but fast, skippable, reduced-motion aware. | Current browser UI has basic state panels; no complete design system or motion/accessibility acceptance suite. | C | Prototype |
| V2-0503 | Palette: #05080F–#0A1220 base; cyan #00E5FF; gold #FFB000; alert red #E10600; sparse success green #2BFF88; off-white #DCEBFF; steel-blue #7FA3C7. | Not implemented consistently. | C | Not started |
| V2-0504 | Themes: Classic cyan/gold; Tactical cool cyan/white + orange alerts; Overwatch red/amber; Synthesis warm gold/white and calm slower motion; Lockdown red/minimal. | No persona themes. | C | Not started |
| V2-0505 | Typography: geometric display; readable humanist body; monospaced telemetry. | Generic system typography. | C | Prototype |
| V2-0506 | Materials: thin glowing outlines, corner brackets, hex/circular grids, subtle scanline/noise, selective bloom and transition-only chromatic aberration. | No target material system. | C | Not started |
| V2-0507 | Technical line-iconography, original designs, no Marvel logos. | No iconography system. | C | Not started |
| V2-0508 | Core orb/ring states: idle breathing; listening amplitude; thinking rotation/particles; speaking waveform; executing task rings; approval amber; degraded steady amber; lockdown contracted red. | Historical T-16 snapshot. T-30 Package 3 now projects the seven versioned owners with full precedence and local idle/thinking/executing/approval/uncertain/degraded/lockdown treatments; idle breathing and contracted red Lockdown are implemented. Listening/Speaking remain reserved; the full cinematic visual target and browser rendering/screenshots are unverified. | C | Not started |
| V2-0509 | Command Deck: centered Core; left active TaskGraph missions; right Sentinel alerts/briefings; top time/mode/CPU/RAM/GPU/storage/connectivity/autonomy; bottom command/voice bar. | Existing UI panels expose some tasks/system state; not this layout or telemetry. | C | Prototype |
| V2-0510 | Holographic Workshop: manipulable 3D models/graphs/wireframes, explode/annotate/simulate; mouse/touch and optional hand tracking (pinch/grab, swipe/dismiss, two-hand scale). | A bounded deterministic Workshop design/simulation surface exists since T-26/T-27; holographic 3D manipulation and gesture input remain absent. | C | Not started |
| V2-0511 | Tactical/System Map: radial/node graph for mesh/network/files/project dependencies with data flows. | No map. | C | Not started |
| V2-0512 | Memory Timeline: scrub episodic/knowledge/world-model changes with observed/inferred/assumed/predicted provenance chips. | Historical reconstruction exists through CLI; no timeline UI. | C | Integrated |
| V2-0513 | Approval Card clearly states action, why, scope, risk and undo path; Approve/Deny/Modify; toned-down visual effects. | Hash-bound approvals exist; no focused UI card or deny/modify workflow in browser. | C | Integrated |
| V2-0514 | Overlay/HUD tags recognized objects/text/screen regions with confidence; interpretation labels. | No overlay or visual perception. | C | Not started |
| V2-0515 | Council View shows role nodes around Core; synthesized answer and on-demand disagreement. | A Council foundation and browser surface exist since T-25; no multi-model inference is claimed or enabled. | C | Not started |
| V2-0516 | Boot/shutdown cinematic sequence reports actual subsystem statuses/failures; quick boot available. | T-30 Package 3 corrects the historical gap: the boot overlay reads `/api/state`, `/api/health`, and `/api/killswitch`, reports event reconciliation, and both Quick boot buttons skip the overlay. A shutdown cinematic and browser-level verification remain absent. | C | Integrated |
| V2-0517 | Motion 150–400ms fast-in/soft-out; continuous low-amplitude data streams. | No measured motion system. | C | Not started |
| V2-0518 | Sounds: UI ticks, load-related hum, distinct listen/approval/success/failure tones; master mute and category volumes. | No audio. | C | Not started |
| V2-0519 | Haptics for approval/alerts on supported devices. | No haptic output. | C | Not started |
| V2-0520 | Emotion-inspired indicators explicitly labelled computational, never feelings. | No such UI indicators. | C | Not started |
| V2-0521 | No fake progress; progress reflects real task state only. | Existing UI reads task/runtime state; no fabricated progress bars. | V | Locally validated |
| V2-0522 | Accessibility: high contrast, adjustable glow/motion, screen-reader labels, full keyboard access, captions for all speech. | Some semantic HTML; no full accessibility validation, voice/captions absent. | C | Prototype |
| V2-0523 | Responsiveness on lowest supported hardware; effects degrade using Resource Fabric pressure. | No Resource Fabric or measured supported-hardware budget. | C | Not started |
| V2-0524 | Suggested architecture (non-binding): Tauri/Electron desktop, React/WebGL/Three.js/shaders, local IPC/WebSocket, mobile companion. | Non-binding option only; current zero-dependency loopback Node UI remains. | C | Not started |

### §6 — Capability domains

| ID | Domain requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0601 | Conversation/voice: continuous dialogue, follow-ups, clarification, interruption, multilingual support where models allow. | Local text conversation/continuity/clarification; voice, barge-in, multilingual inference inactive/absent. | C | Integrated |
| V2-0602 | Personal executive: calendar, mail drafting, notes, reminders, document work, research briefs, travel/logistics via authorized adapters. | Notes, documents, local calendar schedule provider and plans partly exist; mail, reminders and travel adapters absent. | C | Integrated |
| V2-0603 | Systems control: app launch, scoped files, system settings, smart-home/devices, scripts/automation. | Bounded filesystem actions exist; shell execution deliberately absent; app/system/smart-home connectors absent. | C | Integrated |
| V2-0604 | Engineering partner: code reading/generation, tests, architecture diagrams, hardware/circuit planning and Workshop simulation. | Filesystem/developer tasks can be user-driven and Workshop has bounded deterministic arithmetic simulation; there is no integrated code agent, CAD engine or full engineering Workshop. | C | Prototype |
| V2-0605 | Research/analysis: gather sources, compare/cite/summarize, provenance and uncertainty. | Evidence/retrieval/document reasoning exists; external research connectors limited/unconfigured. | C | Integrated |
| V2-0606 | Perception/awareness: screen/camera/image, document OCR, audio events, overlay tags. | Documents/text and system observations partly exist; camera/audio/spatial perception absent. | C | Integrated |
| V2-0607 | Security/monitoring: local health, unusual activity alerts, credential hygiene, defensive-only posture. | Health and situational monitoring exist; full anomaly/credential hygiene not established. | C | Integrated |
| V2-0608 | Owner learning: editable provenance-tagged preferences/routines, never silently promoted to fact. | Memory corrections, goals and outcome feedback/adaptation exist; routine learning remains bounded. | C | Integrated |
| V2-0609 | Self-maintenance: diagnostics, backups, integrity checks, model updates through controlled evolution. | Diagnostics/backups/integrity exist; model updates/Evolution Lab absent and inference prohibited. | C | Integrated |

### §7 — Interaction examples (acceptance targets)

| ID | Example requirement | Verification expectation | Tier | Maturity |
|---|---|---|---|---|
| V2-0701 | Context answer discloses calendar gap, failed build evidence and that tests have not been rerun; asks permission. | Must distinguish observed/stored from not verified and ask before rerun. | C | Not started |
| V2-0702 | Approval text explains replying and moving a meeting sends email; offers approve/deny/edit. | Explicit consequential-effect disclosure, scope and decision choices. | C | Not started |
| V2-0703 | Timeout says upload completion uncertain; verify destination before retry. | No false success and no duplicate side effect. | C | Integrated |
| V2-0704 | Disk-space alert offers largest-file listing; explicitly refuses silent deletion. | Observation-backed alert, read-only recommendation, no deletion. | C | Integrated |
| V2-0705 | Policy refusal names protected out-of-scope files, stops and offers a preview. | Scope refusal and no side effect. | C | Integrated |

### §8 — Presence Mesh and Resource Fabric

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0801 | Nodes (PC/laptop/phone/wearable/home server/optional remote GPU) register capabilities and constraints with Resource Fabric. | No Presence Mesh nodes or cross-device Fabric registry exist. A local Resource Fabric telemetry/admission foundation is present; it is not multi-node routing or inference allocation. | C | Not started |
| V2-0802 | Route heavy inference to strongest available node; UI identifies execution node. | Explicitly inactive due inference restriction; no routing mesh. | C | Not started |
| V2-0803 | State sync encrypted, versioned and conflict-aware; each node independently revocable. | No cross-node sync. | C | Not started |
| V2-0804 | Offline-first: local permitted models/memory/tools remain usable; degraded state shown honestly. | Local deterministic operations work; models remain unconfigured/prohibited; offline status disclosure exists partially. | C | Integrated |

### §9 — Controlled evolution lifecycle

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-0901 | Owner or APEX may propose prompt/routing/planner/neural/tool-adapter change. | T-08 creates bounded adaptation proposals; no general change-spec store. | C | Integrated |
| V2-0902 | Run proposed change in sandbox against defined baselines and representative tasks. | No Evolution Lab sandbox. | C | Not started |
| V2-0903 | Record results, configuration and provenance; track regressions. | Evaluation artifacts exist for fixed suites; no change-candidate provenance lifecycle. | C | Integrated |
| V2-0904 | Owner approves promotion; promoted change versioned and reversible. | Some adaptation decisions are explicit/reversible; no general promotion system. | C | Integrated |
| V2-0905 | Experimental behavior remains labelled experimental until verified. | Model/neural contracts disclose unverified status; no universal artifact tier. | C | Integrated |
| V2-0906 | APEX may never modify ECP, its permission scopes, kill-switch logic, hard rules or own success conditions. | No Evolution Lab; policy immutable in current code but no enforcement contract over future mutations. | C | Not started |

### §10 — Neural research track

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-1001 | Adaptive-threshold spiking cells. | Historical STARK source/design exists; separate research. | C | Prototype |
| V2-1002 | Exponentially decaying synapses. | Historical STARK source/design exists. | C | Prototype |
| V2-1003 | Sparse connectivity, flat synapse array plus adjacency lists. | Historical STARK research. | C | Prototype |
| V2-1004 | STDP with bounded and stable updates. | Historical STARK research/tests; no APEX runtime integration. | C | Prototype |
| V2-1005 | Hierarchical, recurrent and predictive processing. | Research direction only; do not infer general cognition. | C | Prototype |
| V2-1006 | Neural Associative Memory produces candidate associations only. | No APEX-connected authoritative store; Neural–Cognitive Bridge disconnected. | C | Contract only |
| V2-1007 | All neural outputs go through versioned bridge validating shape/type/range/provenance/compatibility before shared cognitive state. | Proposal boundary tests exist; no runtime consumer. | C | Contract only |
| V2-1008 | Spiking computation does not imply language, planning, reasoning or self-awareness; each needs separate mechanism/evidence. | Preserved by project boundaries and STARK separation. | V | Locally validated |

### §11 — Safety, privacy and trust

| ID | Requirement | Existing APEX mapping / gap | Tier | Maturity |
|---|---|---|---|---|
| V2-1101 | Proposal is not permission; model output, plan, persona and UI cannot grant authority. | Registry, hash-bound approvals and model trust boundary enforce major parts. | V | Locally validated |
| V2-1102 | Nothing leaves device unless policy and owner allow; every transfer logged. | Remote model endpoints prohibited by current instruction; configured integrations are bounded, but complete egress policy absent. | C | Integrated |
| V2-1103 | Every consequential action attributable through request, plan, authorization, execution, observation and verification. | Operation records/task audit/handoff provide significant lineage; full attributable chain not universal. | C | Integrated |
| V2-1104 | Ambiguity, missing permission or failed policy means stop/ask/deny, never weaken controls. | Existing fail-closed paths, clarification and verifier enforce subsets. | V | Locally validated |
| V2-1105 | Never modify/delete state not owned by current operation. | Filesystem scope, quarantine delete, guarded writes, backup/restore controls exist; broad system control absent. | V | Locally validated |
| V2-1106 | Offensive or unauthorized-access capability out of scope; defensive work restricted to owner-controlled systems. | No offensive capability implemented; future security adapters need explicit allowlists. | V | Locally validated |

### §12 — Twelve binding invariants (verbatim policy meaning)

| ID | Invariant | Current enforcement/evidence | Tier | Maturity |
|---|---|---|---|---|
| V2-I01 | One persistent APEX identity across models, modes and sessions. | One local app/session identity; no modes or mesh; continuity tests. | C | Integrated |
| V2-I02 | ECP is the only authorization authority; kill switch is outside model path. | Historical T-16 snapshot, superseded 2026-11-19: ECP is the sole authorization authority and owns the durable local software latch. Owner MFA and the complete T-30 release/UI safety acceptance are still absent or unverified. | C | Integrated |
| V2-I03 | Resource Fabric is the only resource-allocation authority. | Historical T-16 snapshot, superseded 2026-11-19: `src/resources/` provides a local Resource Fabric owner for implemented telemetry/admission behavior. Distributed node capacity/allocation is not implemented. | C | Not started |
| V2-I04 | Memory, Knowledge, World Model, Perception and Neural Associative Memory have distinct owners and meanings. | Distinct stores/services; neural associative memory remains research-side. | V | Integrated |
| V2-I05 | Observation, inference, assumption and prediction always distinguishable. | Provenance, world model, evidence-state and prediction contracts/tests. | V | Locally validated |
| V2-I06 | Personas and UI themes change presentation only, never policy. | Persona/theme absent; future invariant. | C | Not started |
| V2-I07 | Emotion-inspired variables never override ECP or create permissions. | Variables absent; future invariant. | C | Not started |
| V2-I08 | Self-improvement only through Evolution Lab with owner approval. | Evolution Lab absent; deterministic adaptation is separately user-governed and not model training. | C | Integrated |
| V2-I09 | Experimental components never silently become trusted capabilities. | Neural/model declarations unverified; no automatic registration path. | V | Contract only |
| V2-I10 | UI never shows action done until verified. | Task/action outcome surfaces use verified status; no fake progress. | V | Locally validated |
| V2-I11 | Persistent state recoverable and protected from unrelated destructive cleanup. | Append-only stores, backup/restore, quarantine deletion and recovery tests. | V | Locally validated |
| V2-I12 | Evidence tiers C/P/V preserved in all derived documents. | Not previously standardized; new inventory/prompt-governance requirement. | C | Not started |

### §13 — Prompt maker

| ID | Requirement | Status at T-17 start | Tier | Maturity |
|---|---|---|---|---|
| V2-1301 | One subsystem-specific prompt/spec per subsystem (examples: ECP, Sentinel, Council, Workshop UI, Presence Mesh). | No canonical maker. | C | Not started |
| V2-1302 | Every prompt includes purpose, inputs, outputs, owner, interfaces, invariants touched, acceptance tests and evidence tier. | No canonical maker. | C | Not started |
| V2-1303 | Separate implementation instructions from concepts; never present C-tier work as working. | README maturity ledger exists but prompt output contract absent. | C | Not started |
| V2-1304 | Execution/memory/self-modification prompts include applicable §12 invariants verbatim. | No enforcement. | C | Not started |
| V2-1305 | UI prompts include palette, typography, signature elements, motion and accessibility; require visuals reflect real state. | No enforcement. | C | Not started |
| V2-1306 | Capability prompts state realistic mechanism and guardrail from §2. | No enforcement. | C | Not started |
| V2-1307 | Measurable acceptance: baseline, test protocol, timing definition and aggregation rule. | Existing benchmarks have protocols; no prompt gate. | C | Not started |
| V2-1308 | Original assets only; mood inspiration, not logos, footage, UI frames or voices. | Copyright boundary to retain. | C | Not started |

### §14 — Prompt analyser pass/fail rubric

| ID | Check; failure means reject, not warning | Tier | Maturity at start |
|---|---|---|---|
| V2-1401 | Respects every §12 invariant. | C | Not started |
| V2-1402 | Separates proposal from authorization. | C | Not started |
| V2-1403 | Labels evidence tier and provenance expectations. | C | Not started |
| V2-1404 | Gives measurable acceptance criteria. | C | Not started |
| V2-1405 | Defines failure, timeout and rollback behavior. | C | Not started |
| V2-1406 | Specifies least privilege and autonomy level for any action. | C | Not started |
| V2-1407 | Separates persona/UI from policy. | C | Not started |
| V2-1408 | Avoids unverifiable claims such as “instantly”, “all”, “perfectly” or “conscious”. | C | Not started |
| V2-1409 | Uses original creative assets only. | C | Not started |

### §15 — Glossary

| Term | Required meaning |
|---|---|
| Core | Central animated status element of the UI. |
| Command Deck | Home screen. |
| Sentinel | Proactive monitoring and proposal engine. |
| Council | Multi-model deliberation with a synthesizer. |
| Presence Mesh | Multi-device network sharing one identity. |
| Workshop | Holographic 3D design and simulation space. |
| Evolution Lab | Sandbox for controlled self-improvement. |
| Autonomy level (L0–L5) | Owner-set execution freedom per domain. |
| Persona mode | Presentation skin (Classic, Tactical, Overwatch, Synthesis) over one identity. |
| Evidence tier | C (Concept), P (Prototype), V (Verified). |

## Original Concept & Architecture crosswalk

The original PDF was located in the repository and compared. Its 21-section content remains part of the authority chain; v2 explicitly says canonical principles and ownership rules are retained. The complete historical requirements include: one persistent/offline-first/model-independent APEX system; two independently evolving tracks; versioned bridge; identity/context; capacity-bounded Global Workspace and attention/salience; evidence-based reasoning; distinct Memory/Knowledge/World Model/Perception/Neural Associative Memory with provenance and lifecycle; goals/Planner/TaskGraph/checkpoints/dependencies/retries; closed-loop execute/observe/verify/replan; ECP policy/scope/cancellation/audit; Resource Fabric inventory/availability/scheduling/degraded reporting; Model Gateway routing/context limits/timeouts/provenance; text/audio/visual/system/temporal perception; interaction, voice and inspectable UI; identity/continuity/personalization boundaries; computational regulation variables; controlled learning/evolution; reliability, observability, recovery, reproducible metrics; sole ownership table; four conceptual workflows (contextual answer, tool task, neural contribution, failed action); and glossary definitions for every original architecture term.

The original ownership rules are retained as canonical constraints: identity owns continuity; Memory retained experience; Knowledge validated facts/procedures; World Model current/predicted external state; Perception observations; Neural Associative Memory candidate associations; ECP authorization; Resource Fabric resource inventory/availability/allocation; Neural–Cognitive Bridge versioned integration; TaskGraph dependencies/state/checkpoints. None may silently take another owner's authority.

## T-30 dated implementation annotation (2026-11-19)

The row-level T-16/T-17-start wording above is retained where it is historical, and each superseded `no ECP`, `no L0–L5`, `no kill switch`, `no Workshop`, `no Council` or `no briefing engine` statement is annotated with its current code boundary. Evidence remains distinct from the complete v2 requirement: current local tests validate the implemented subset, not the fictional/target system.

- The ECP facade, startup-only per-domain autonomy configuration, durable local software kill switch, local Resource Fabric foundation, deterministic briefing, Council foundation and bounded Workshop are present. Their code paths and limitations are described in `ARCHITECTURE_V2.md` and the T-30 progress report.
- The authoritative Core state/source/precedence table and state ownership register are at [`ARCHITECTURE_V2.md`](../ARCHITECTURE_V2.md#t-30-current-core-state-source-and-precedence-contract-2026-11-19). `tests/core-state-contract.test.js` is the acceptance guard for the ten-state vocabulary and reserved states. The UI remains a consumer, not an authority.
- Numbering is preserved rather than inferred from missing commit history: the separate `T19_PROGRESS.md` records its two local commits as `e9d0880` and `301ba97`; `T24_IMPLEMENTATION_REPORT.md` summarizes T-20 through T-24; the progress ledger covers T-25 through T-29. This Arena clone has only the shallow `fb09e73` baseline object, so earlier milestone commits cannot be independently replayed from local Git history. Reported historical tests/screenshots remain historical evidence unless rerun here.
- As of this annotation, no claim is made that T-30 Packages 1–3 or the full command-experience target is complete. Package 2 must verify/complete event transport and cross-process reconciliation; Package 3 must wire and test the UI/safety/telemetry defects. Browser execution is separately reported as unverified when no browser binary is available.

### T-30 Package 3 verified follow-up (2026-11-19)

The preceding “not complete” and pending-work sentences remain the dated pre-Package-3 checkpoint. The later T-30 follow-up now records Packages 0–3 as complete to their bounded scope in [`reports/T30_PROGRESS.md`](../reports/T30_PROGRESS.md); Packages 4–6 were not started. Package 3 connects all seven versioned owner snapshots to the served Core projection using **Lockdown > Degraded > Awaiting Approval > Uncertain > Executing > Thinking > Idle**, while reserved states remain unavailable and malformed/missing owners fail closed. The T-18 UI corrections include truthful boot diagnostics and working Quick boot controls, explicit visual status for reachable states, request-scoped Thinking, and a stale-latch safety surface. Authenticated local ECP release requires a reason and explicit confirmation, exposes audit evidence, and does not resume paused work. The local UI token is not owner MFA; browser execution/screenshots remain unverified, and no full v2 design completion is implied.

## Capability/reconciliation use

The requirements above are design obligations, not a feature list claiming completion. T-17's current implementation work and tests are recorded in [the T-17 reconciliation](T17_RECONCILIATION.md). The implementation maturity and evidence tier remain separate columns there. Inference remains inactive unless the owner explicitly changes the repository instruction.
