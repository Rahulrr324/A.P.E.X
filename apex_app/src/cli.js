// Command-line interface. Exit codes:
//   0  request verified (or a model answer was produced and recorded as unverified,
//      with no proposed action blocked)
//   1  request not completed (denied, rejected, failed, not verified, or no model)
//   2  usage or configuration error
//   3  the outcome could not be written to the audit log
import readline from 'node:readline';
import { createAppFromEnv } from './app.js';
import { APP_EXPANSION, APP_NAME, APP_STAGE, APP_VERSION } from './identity.js';
import { Outcome } from './outcomes.js';
import { Decision } from './controller/decision.js';
import { ValidationError, StoreError } from './errors.js';
import { redactSecrets } from './security/secrets.js';
import { shortId } from './util.js';
import { TaskStatus } from './tasks/model.js';
import { MAX_QUEUED_SUMMARIES } from './tasks/summary-queue.js';
import { TAKEOVER_EPOCHS } from './tasks/lock-recovery.js';
import { State, collectDiagnostics, dataDirLabel, renderDiagnostics, safeText } from './diagnostics.js';
import { MAX_WORLD_LIMIT } from './world/world-state.js';
import { runRuntimeCommand } from './runtime/cli.js';
import { runIntegrationCommand } from './integrations/cli.js';

export const HELP = `${APP_NAME} - ${APP_EXPANSION} (${APP_STAGE} ${APP_VERSION})

Usage:
  node bin/apex.js chat                  interactive conversation (same session across restarts)
  node bin/apex.js ask [--save-answer] <request words...>
  node bin/apex.js new                   start a new conversation session
  node bin/apex.js status [--model]      subsystem counts (--model probes the endpoint; no inference)
  node bin/apex.js capabilities [words...] [--json]   registered actions, optionally filtered (read-only)
  node bin/apex.js model contracts [--json]           declared provider capabilities, limits and trust boundary (no endpoint is contacted)
  node bin/apex.js neural contract [--json]           declared neural runtime boundary, limits and isolation (no runtime is contacted; no inference)
  node bin/apex.js diagnose [--model]    read-only preflight: config, stores, guidance (--model probes; no inference)
  node bin/apex.js workspace roots                     configured workspace roots and their names (read-only)
  node bin/apex.js workspace list [path] [--limit N] [--workspace <name>]        one directory inside a root (read-only)
  node bin/apex.js workspace find [path] --name <text>|--extension <ext> [--max-depth N] [--limit N] [--workspace <name>]
  node bin/apex.js workspace read <path> [--max-bytes N] [--workspace <name>]
  node bin/apex.js workspace extract <path> [--max-bytes N] [--workspace <name>]     PDF, DOCX, XLSX, CSV or text; nothing is executed
  node bin/apex.js workspace summarize <path> [--max-bytes N] [--workspace <name>]   deterministic extract; no model is consulted
  node bin/apex.js workspace compare <a> <b> [--max-bytes N] [--workspace <name>]
  node bin/apex.js workspace report [path] [--max-depth N] [--limit N] [--workspace <name>]
  node bin/apex.js workspace write <path> --content <text> [--expected-sha256 <current hash>] [--workspace <name>]
                                                 create, or replace only when you supply the exact current hash
  node bin/apex.js workspace mkdir <path> [--parents] [--workspace <name>]      create a directory; never replaces a file
  node bin/apex.js workspace move <path> <destination> [--workspace <name>]     rename inside the root; never overwrites
  node bin/apex.js workspace delete <path> [--workspace <name>]                 move to the quarantine; reversible
  node bin/apex.js workspace trash [--limit N] [--workspace <name>]             list the quarantine (read-only)
  node bin/apex.js workspace restore <quarantine-id> [--workspace <name>]       restore a quarantined entry
  node bin/apex.js workspace batch --operations <json> [--workspace <name>]     up to 20 mkdir/move/delete, refused before any change
  node bin/apex.js memory correct --resolve <record-id> <replacement claim...>
  node bin/apex.js memory health         store-wide record, provenance, and corruption counts (read-only)
  node bin/apex.js world [--limit N]     stored beliefs, contradictions, decisions, and unknowns (read-only)
  node bin/apex.js world entity add --category <category> <name> [--alias <name>]... [--external <scheme:id>]... [--description <text>] [--observed-at <iso>]
  node bin/apex.js world entity list|show|find <name>|alias <entity> --alias <name>|retire <entity> --reason <text>
  node bin/apex.js world entity merge <source> <survivor> --reason <text>   explicit, reversible identity merge
  node bin/apex.js world entity unmerge <merge-id> --reason <text>
  node bin/apex.js world identity candidates <entity>|pair <a> <b>|decision <a> <b>|decide|confirm|reject <a> <b> --reason <text>
  node bin/apex.js world fact add --subject <entity> --predicate <name> (--object-entity <entity> | --object-value <value>) [--valid-from <iso>] [--valid-until <iso>] [--observed-at <iso>] [--confidence <0-1> --confidence-basis <text>] [--supersedes <id[,id...]>]
  node bin/apex.js world fact list <entity> [--as-of <iso>] [--current-only] [--include-retracted] [--include-superseded]
  node bin/apex.js world attribute list <entity> [--as-of <iso>]
  node bin/apex.js world relationship add --subject <entity> --type <relationship> --object <entity> [--direction directed|symmetric] [--property <k=v>]... [--valid-from <iso>]
  node bin/apex.js world relationship list <entity> [--type <type>] [--direction both|out|in] [--as-of <iso>]
  node bin/apex.js world event add --type <event-type> --participant <entity>... [--affected <entity>]... [--occurred-at <iso>] [--observed-at <iso>] [--property <k=v>]...
  node bin/apex.js world event list <entity> [--at <iso>] [--limit N]
  node bin/apex.js world statement retract|supersede <id> --target-type fact|relationship|event --reason <text> [--by <replacement-id>]
  node bin/apex.js world statement history <id> --target-type fact|relationship|event    (read-only)
  node bin/apex.js world history <entity>|related <entity> [--depth N] [--limit N]|evidence <entity>|conflicts [<entity>]   (read-only)
  node bin/apex.js world trace <memory|knowledge|fact|relationship|event> <id> [--at <iso historical cutoff>] [--limit N]   (read-only; rebinds nothing to the present)
  node bin/apex.js world changes --from <iso> --to <iso>|state-at --at <iso>|inspect|health|lock   (read-only; state-at reconstructs beliefs at that time)
  node bin/apex.js world entity|fact|relationship|event|statement writes are user-origin only; a model cannot write the world model
  node bin/apex.js history [--limit N]     audited operations, newest first (read-only)
  node bin/apex.js history --at <iso> [--limit N]   what the stores had recorded by a cutoff: experience, predictions, world, goals, plans, tasks, memory, knowledge, and a cutoff-classified current audit view (read-only)
  node bin/apex.js knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]
  node bin/apex.js knowledge retract <id> [--reason <text>]
  node bin/apex.js knowledge resolve <target-id> --choose <claim-id> [--reason <text>]
  node bin/apex.js knowledge history <id>
  node bin/apex.js knowledge health          store-wide counts, conflicts, and lifecycle anomalies (read-only)
  node bin/apex.js knowledge list [--limit N]
  node bin/apex.js knowledge search <query words...>
  node bin/apex.js knowledge digest [query words...] [--limit N]   memory and knowledge together, with conflicts and history (read-only)
  node bin/apex.js knowledge show <id>
  node bin/apex.js note add --title <text> --body <text> [--tag <tag>]... [--source <kind:ref>]... [--private]
  node bin/apex.js note update <id> [--title <text>] [--body <text>] [--tag <tag>]... [--source <kind:ref>]... [--private|--normal]
  node bin/apex.js note list [--limit N] [--include-private]
  node bin/apex.js note show <id> [--include-private]
  node bin/apex.js note search <query words...> [--limit N] [--include-private]
  node bin/apex.js note history <id>
  node bin/apex.js note save-digest [query words...] [--title <text>] [--tag <tag>]... [--limit N] [--private]
                                                 store what APEX holds as a note citing every record it used
  node bin/apex.js experience record <operation-id> --subject <text> [--replaces <id[,id...]>]
  node bin/apex.js experience list [--limit N]
  node bin/apex.js experience show <experience-or-operation-id>
  node bin/apex.js experience timeline|trends|patterns [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]
  node bin/apex.js experience compare [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]
  node bin/apex.js experience health       experiences, feedback, adaptation states, and evidence checks (read-only)
  node bin/apex.js feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]
  node bin/apex.js adaptation derive [--min-support N]     turn repeated feedback and evaluated predictions into candidates (never active)
  node bin/apex.js adaptation eligibility [--capability <name>] [--limit N]   which evaluated predictions could become a candidate, and why others cannot
  node bin/apex.js adaptation effectiveness [--adaptation <id>] [--limit N]   what happened after an approved rule changed a decision (read-only; claims no cause)
  node bin/apex.js adaptation list [--limit N] [--exclude-retired]
  node bin/apex.js adaptation approve <id> [--reason <text>]     your decision; the only way a rule takes effect
  node bin/apex.js adaptation reject <id> [--reason <text>]
  node bin/apex.js adaptation guide <id> [--order O] [--avoid a,b] [--prefer a,b] [--max-steps N] [--reason <text>]
                                                            record the shape you meant: what order, what to avoid, how many steps is too many
  node bin/apex.js adaptation retire <id> [--reason <text>]      stop using a rule; its history stays readable
  node bin/apex.js adaptation reviews [--limit N]                which adaptations need a governance review (read-only)
  node bin/apex.js adaptation review show|reconcile <id>         one review's evidence, its live reconciliation, and its history
  node bin/apex.js adaptation review open <id> [--reason <text>] open a review on the evidence the stores now hold
  node bin/apex.js adaptation review keep|dismiss|retire <review-id> [--reason <text>]
                                                            record your lifecycle decision; retire uses adaptation.retire
  node bin/apex.js learning observe <plan-id>              judge a plan run against its objective and criteria, and record the evaluation
  node bin/apex.js learning patterns [--capability <name>] [--min-observations N] [--limit N]
                                                            repeated success, failure, corrections, inefficiency, ordering (read-only)
  node bin/apex.js learning propose [--min-observations N]  turn a supported pattern into a candidate adaptation with its risks and validation
  node bin/apex.js learning measure <adaptation-id>        compare recorded outcomes before and after your approval (read of counts, not a cause)
  node bin/apex.js learning rollback <adaptation-id> [--measurement <id>] [--reason <text>]
                                                            take a rule out of force after a measured regression; history stays
  node bin/apex.js learning status [--limit N]             what was learned, what it proposes, what improved, what was reversed
  node bin/apex.js situation ingest --source <s> --source-id <id> --type <text> --category <c> [--payload <json>] [--goal <id>] [--plan <id>] [--task <id>] [--entity <id[,id]>] [--confidence 0-1] [--valid-until <iso>]
                                                            record one structured observation; its fact or world event goes to the World Model
  node bin/apex.js situation state|events|decisions|status [--limit N]
                                                            the current picture, the event log, your decisions, and log health (read-only)
  node bin/apex.js situation evaluate <event-id>          re-read one event against current goals, plans, tasks and world conflicts
  node bin/apex.js situation decide <event-id> --response <ignore|record|investigate|notify|recommend|request_approval|execute> --reason <text> [--action <name> --input <json>]
                                                            record your choice; choose execute only with a named registered action
  node bin/apex.js situation execute <decision-id> --input <json>
                                                            run the one action that decision approved (the registry authorizes it again)
  node bin/apex.js runtime start [--interval <ms>]         start the opt-in executive runtime in the foreground (Ctrl+C stops it)
  node bin/apex.js runtime tick                            run one bounded cycle: publish, process, schedule, record
  node bin/apex.js runtime status|diagnose                 lifecycle, queue, schedule, retries, health and dependencies
  node bin/apex.js runtime stop                            graceful shutdown; queued work and checkpoints are preserved
  node bin/apex.js runtime pause|resume                    stop or resume scheduling without stopping event processing
  node bin/apex.js runtime schedule <plan-id> --at <iso> [--reason <text>]
  node bin/apex.js runtime unschedule|cancel <plan-id> [--reason <text>]
  node bin/apex.js runtime notifications [--all]           active, suppressed and expired notices (acknowledge <id> clears one)
  node bin/apex.js source list|status [provider]|health        external providers, scopes, health and counts
                                                              (construction and disabled providers do nothing)
  node bin/apex.js source enable|disable <provider>
  node bin/apex.js source configure <provider> [--root <dir>]... [--extension <ext>]...
                      [--interval <ms>] [--max-files N] [--max-depth N] [--entity <id>]
                      [--path <dir>]... [--memory-percent N] [--disk-percent N]
                      [--events-file <json>] [--endpoint <url>] [--allowlist <origin>]...
  node bin/apex.js source poll [provider] [--force]             one bounded poll, or every due provider
  node bin/apex.js source observations [--provider <id>] [--limit N]
  node bin/apex.js source pause|resume                         stop or allow all external observation
  node bin/apex.js source reset <provider> --reason <text>     invalidate one checkpoint (events are preserved)
  node bin/apex.js source diagnose
  node bin/apex.js evidence integrity                      cross-store read consistency and per-store health (read-only; repairs nothing)
  node bin/apex.js prediction record --capability <name> --expect <kind> --subject <text> (--expires <iso> | --in-days N) [--supports <id[,id...]>] [--contradicts <id[,id...]>] [--feedback <id[,id...]>] [--pattern <kind[,kind...]>] [--replaces <id[,id...]>]
  node bin/apex.js prediction list [--limit N] [--capability <name>] [--status <name>]
  node bin/apex.js prediction show <prediction-id>
  node bin/apex.js prediction history <prediction-id>
  node bin/apex.js prediction evaluate <prediction-id>
  node bin/apex.js prediction invalidate <prediction-id> --reason <text>
  node bin/apex.js prediction summary [--capability <name>] [--limit N]
  node bin/apex.js prediction longitudinal [--capability <name>] [--limit N]   recorded-outcome patterns per scope (read-only)
  node bin/apex.js prediction health      record kinds, standing expectations, and anomalies (read-only)
  node bin/apex.js goal add [--criterion <text>]... [--priority N] [--deadline <iso>] [--depends-on <id>]... <request>
  node bin/apex.js goal list [--limit N]
  node bin/apex.js goal show <id>
  node bin/apex.js goal assess <id>      whether the goal's recorded proof still holds (read-only)
  node bin/apex.js goal update <id> <status> [--reason <text>] [--by <goal-id>]
  node bin/apex.js goal revise <id> --criterion <text>... --reason <text> [--request <text>] [--priority N] [--deadline <iso>]
  node bin/apex.js goal confirm <id> --criterion <c1> --decision required|suggested|declined --reason <text> [--operation <audit-id>]
  node bin/apex.js goal evidence <id> --criterion <c1> --kind supports|contradicts [--operation <audit-id>] [--detail <text>] [--reopen]
  node bin/apex.js goal complete <id> [--reason <text>]
  node bin/apex.js goal link <id> (--plan <id> | --task <id> | --entity <world-entity-id> | --world-event <world-event-id>)
  node bin/apex.js plan add --outcome <text> --step <json>... [--goal <id>] [--precondition <text>]... [--assertion <json>]... [--estimate N] [--reason <text>]
  node bin/apex.js plan list [--limit N]
  node bin/apex.js plan show <id>
  node bin/apex.js plan validate <id>     check a stored plan against live state (read-only)
  node bin/apex.js plan history <id>       recorded versions of a plan (read-only)
  node bin/apex.js plan compare <id> [--from N] [--to N]   compare two recorded versions (read-only)
  node bin/apex.js plan outline "<objective>" [--goal <id>] [--cannot-use <action,action>] [--json]   what a plan for a free-form objective would be (read-only)
  node bin/apex.js plan candidates <goal-id> [--work <text>] [--cannot-use <action,action>] [--json]   the approaches this goal supports now, compared gate by gate (read-only)
  node bin/apex.js plan replan <plan-id> [--reason <text>] [--cannot-use <action,action>] [--json]   revised approaches for a plan that stopped being viable (read-only)
  node bin/apex.js plan outcome <plan-id> [--json]   what a plan's run established and what it left open (read-only)
  node bin/apex.js plan assess <plan-id>  record that outcome reading; changes no plan status, approval, or timestamp
  node bin/apex.js plan revise <id> --outcome <text> --step <json>... --reason <text> [--precondition <text>]... [--assertion <json>]... [--estimate N]
  node bin/apex.js plan approve <id>
  node bin/apex.js plan start <id>        create a user-origin task from an approved plan, then run it
  node bin/apex.js plan reconcile <id>    re-read the linked task and record its terminal outcomes
  node bin/apex.js plan continuation <id>  which steps a stopped run may still take up, and what forbids it (read-only)
  node bin/apex.js plan continue <id>     take up the steps the records prove never started
  node bin/apex.js plan cancel <id> --reason <text>
  node bin/apex.js plan supersede <id> --by <plan-id> --reason <text>
  node bin/apex.js recover                interrupted, uncertain, resumable, and blocked work (read-only)
  node bin/apex.js work [--limit N]      ranked next work from the records (read-only, executes nothing)
  node bin/apex.js next                  the single top recommendation and why (read-only)
  node bin/apex.js review [--limit N] [--days N]   the whole board: goals, plans, tasks, and recorded deadlines (read-only)
  node bin/apex.js deadline list [--days N] [--limit N]   recorded deadlines within a horizon, with their source file and line (read-only)
  node bin/apex.js deadline import <path> [--max-bytes N] [--workspace <name>]   import dates from a JSONL, NDJSON, CSV, or TSV file
  node bin/apex.js backup export <archive-path>   one versioned archive of the APEX data files, with a digest per file (user only)
  node bin/apex.js backup inspect <archive-path>  check an archive without restoring anything (read-only)
  node bin/apex.js backup restore <archive-path> --confirm <digest-prefix> [--replace-existing]
                                     replace the APEX data files from a validated archive; a pre-restore archive is written first
  node bin/apex.js propose [--kind goal_create|goal_clarify|plan_create|plan_revise|advice] [--goal <id>] [--plan <id>] <request>
  node bin/apex.js proposal list [--limit N]
  node bin/apex.js proposal show <id>
  node bin/apex.js proposal accept <id> [--reason <text>]
  node bin/apex.js proposal reject <id> --reason <text>
  node bin/apex.js proposal invalidate <id> --reason <text>
  node bin/apex.js task plan <goal...>   plan a multi-step task (checked; nothing runs yet)
  node bin/apex.js task list
  node bin/apex.js task show <id>
  node bin/apex.js task explain <id> [view]   what the records say about one task
                                             view: status (default) | finished | outcome | steps | pending | why | approval | recovery
  node bin/apex.js task approve <id> [--step <stepId>]   approve a proposed plan, or one write step
  node bin/apex.js task run <id>         run a pending task, stopping at the first failure
  node bin/apex.js task resume <id>      continue a paused task (never re-runs a completed step)
  node bin/apex.js task retry <id> <stepId>   retry a failed read-only step
  node bin/apex.js task cancel <id>
  node bin/apex.js task feedback <id> <assessment> [--guidance text] [--reason text] [--supersedes id]
                                     your assessment of a completed task's verified outcome; changes nothing yet
  node bin/apex.js queue                 deferred task summaries and their state (read-only)
  node bin/apex.js audit health          operation-log integrity and outcome counts (read-only)
  node bin/apex.js repair locks          inspect task, queue, memory, knowledge, experience, prediction and world model write locks; remove only abandoned takeover tokens
  node bin/apex.js help

Exit codes:
  0  completed (a verified result, a created plan, or a model answer recorded as unverified)
  1  not completed (denied, rejected, failed, unverified, or no model configured)
  2  usage or configuration error; nothing was run
  3  the outcome could not be written to the audit log

Lock recovery never takes a lock, never removes a lock claim, and refuses while any
holder or takeover process is live. A dead claim is taken over by the next normal task
or queue update through the same election that already handles a crashed process.

Request examples (no model needed; use them with ask, or type the same words in chat):
  remember that the project codename is Lighthouse
  remember privately that my pin is kept at the bank   (never sent to a model)
  recall codename
  list memory
  memory correct --resolve <full-record-id> <replacement claim...>
  calc (2+3)*4          (or: what is 2+3*4?)
  status
  list src/             list one directory inside the authorized root (no model needed)
  read README.md        read a bounded text file inside the authorized root
  extract report.pdf    bounded PDF/DOCX/XLSX/CSV text extraction (no model, nothing executed)
  summarize notes.md    deterministic counts, headings, and frequent terms (no model)
  find files named notes under docs/    bounded discovery inside the authorized root
  compare notes.md with docs/notes.md   positional line comparison (no model)
  workspace report      file counts, extensions, largest and newest files (read-only)
  task plan "calc 1+1; calc 2+2"   plan a checked task; nothing runs yet
                                     task run <task-id> runs it, task show <task-id> shows the record
  diagnose              read-only preflight, including recovery guidance
  what conflicts do you have   stored contradictions, answered from the stores (no model)

Knowledge examples (explicit relationships; user-origin write only):
  knowledge add --subject APEX --relationship has_subsystem --object "Cognitive Controller"
  knowledge add --subject APEX --relationship has_subsystem --object "Memory Store" --evidence "README section 3"
  knowledge add --subject Engine --relationship fuel --object Electric --supersedes a1b2c3d4
  knowledge retract a1b2c3d4 --reason "superseded by a later service record"
  knowledge resolve a1b2c3d4 --choose 9f8e7d6c --reason "confirmed by the service record"
  knowledge history a1b2c3d4
  knowledge health
  knowledge list
  knowledge search subsystem
  knowledge show <record-id>

Note examples (your own composition; every revision is kept):
  note add --title "Release checklist" --body "Verify export/restore before tagging." --tag release
  note add --title "Server note" --body "..." --private    excluded from list bodies and search unless asked for
  note save-digest backup restore --title "What APEX holds about backups"
  note show <note-id>              the current revision, its sources, and its history
  note history <note-id>           every revision, oldest first, with the conflict state
  note update <note-id> --body "..."   appends a revision; refuses if another edit moved the head first

Experience and adaptation examples (what APEX did, what you thought, what to change):
  history                     find the operation id of something APEX already did
  experience record <operation-id> --subject "stored the review date"
  feedback record <experience-id> --assessment not_useful --guidance "give one dated fact, not a reminder"
  feedback record <experience-id> --assessment incorrect --reason "the file it names does not exist"
      assessments: correct | incorrect | partially_correct | useful | not_useful
                 | user_correction | outcome_succeeded | outcome_failed
  adaptation derive           repeated feedback or an evaluated prediction becomes a candidate; a candidate does nothing yet
  adaptation eligibility      which evaluated predictions could become a candidate, and why the rest cannot
  adaptation effectiveness    trace an approved rule through the decisions it changed and the outcomes recorded after them
  adaptation list             shows each state: candidate, approved, in effect, rejected, retired, ambiguous
  adaptation approve <id>     your decision; only an approved rule is offered to future answers
  adaptation guide <id>       say what shape the approved rule asks future work to take
  adaptation retire <id>      stop using a rule without deleting the history of it
  adaptation reviews          which adaptations the evidence says need governance attention
  adaptation review show <id> open a governed question on the exact evidence now recorded
  adaptation review reconcile <id>  what changed since a review was opened; a diff is not a verdict
  adaptation review keep|dismiss|retire <review-id>   record your own lifecycle decision
  evidence integrity          one read window over every store, with each store's own health check
  experience health           re-checks every recorded experience against the audit log
  experience timeline --days 7     recorded events in the window, newest first, corrections marked
  experience trends --days 30      per-capability outcome counts and an early/late trend
  experience patterns              repeated success/failure, alternation, regression, recurring corrections
  experience compare               the last 30 days against the 30 days before them
A timeline, trends, patterns, or comparison describes recorded order. It is not a cause and not a
prediction, and no pattern becomes an adaptation: a rule still needs your corrective feedback and
your explicit approval. Records without a usable timestamp are listed separately, never placed in a
window.
An experience is recorded when you ask, or by APEX itself for a verified successful operation when
APEX_EXPERIENCE_CAPTURE=verified-success. Either route records only that the event happened; an
assessment of it is written only by you. "experience list" and "experience show" name which route
each record came from, and "experience health" states the current setting.
An experience names one audited operation; it is not a fact about you. Feedback is your own
assessment and is never invented from silence. A rule takes effect only after you approve it
here, and even then it guides wording, never permission: APEX still asks before any write.

Prediction examples (what you expect to happen, kept apart from what happened):
  prediction record --capability memory.add --expect success --subject "the corrected record is read back on the next search" --in-days 30
  prediction record --capability knowledge.search --expect failure --subject "the stale claim still wins" \
      --expires 2026-12-01T00:00:00.000Z --supports <experience-id> --pattern repeated_failure
      expectations: success | failure | blocked
      pattern kinds: repeated_failure | repeated_success | alternating_outcomes
                   | regression_after_success | improvement_after_correction | recurring_corrections
      citations: name an experience, a feedback record, or a prediction by the id a read prints, its
                 first eight characters; APEX stores the whole id it resolves to and refuses a prefix
                 that matches more than one record
  prediction list [--status awaiting_evaluation]   what stands, and in which of its states
  prediction show <prediction-id>       the expectation, the evidence it cited, and what is known now
  prediction history <prediction-id>    every record about that one expectation, oldest first
  prediction evaluate <prediction-id>   the ledger compares the expectation to recorded outcomes
  prediction invalidate <prediction-id> --reason "the condition it assumed no longer holds"
  prediction summary                    what the verdicts support, their denominator, and their limits
  prediction longitudinal               repeated, alternating, or directional recorded outcomes in one scope
  prediction health                     the ledger parses, and every withdrawal and verdict names a prediction
A prediction is an expectation you record, not an observation: nothing about it has happened. It lives
in predictions.jsonl, separate from experiences.jsonl, so no read of what happened can count it, and it
never enters the world-state observations. Recording, evaluating, and withdrawing are writes, and they
are yours alone: a model cannot create, evaluate, or withdraw a prediction, and no prediction authorizes
an action or approves an adaptation. You give only the expected kind, the horizon, and the evidence you
relied on; the verdict is computed from recorded outcomes, so "prediction evaluate" reports insufficient
or unavailable evidence rather than inventing one, and an expired horizon is not a wrong prediction.
This build stores no confidence in any record and computes none: the reads say it is unavailable.

Goal and plan examples (recorded intent; never permission to execute):
  goal add "ship the corrected memory index" --criterion "the stale claim no longer wins" \
      --criterion "search reads it back on the next run" --priority 2 --deadline 2026-12-01
  goal update <goal-id> accepted
  goal evidence <goal-id> --criterion c1 --kind supports --operation <audit-id>
  goal complete <goal-id>              refused unless every criterion cites a verified audit record
  goal assess <goal-id>                live check of the proof a goal cites (read-only)
  plan add --goal <goal-id> --outcome "the corrected claim is stored and read back" \
      --step '{"id":"s1","action":"knowledge.add","description":"store the correction","input":{"subject":"Engine","relationship":"fuel","object":"Electric"},"expectedResult":"the record is stored","verification":"read it back","criterion":"c1"}' \
      --step '{"id":"s2","action":"knowledge.search","description":"read it back","input":{"query":"Engine fuel"},"dependsOn":["s1"],"expectedResult":"the new claim is first","verification":"the search names it","criterion":"c2"}'
  plan validate <plan-id>              live check: approval binding, goal revision, actions, evidence (read-only)
  plan history <plan-id>               every recorded version with its reason (read-only)
  plan compare <plan-id> [--from N] [--to N]   differences between two recorded versions (read-only)
  plan outline "<objective>"           what a plan for a free-form objective would be, none recorded (read-only)
  plan candidates <goal-id>            the approaches it supports, gate by gate, none recorded (read-only)
  plan replan <plan-id>                revised approaches; the plan it answers is left as it was (read-only)
  plan outcome <plan-id>               what the run established, and what only you can confirm (read-only)
  plan assess <plan-id>                record that reading against the plan; it authorizes nothing
  plan approve <plan-id>               binds approval to this exact content; every step is still authorized again
  plan start <plan-id>                 creates a user-origin task, runs it, and records each step's outcome
  plan reconcile <plan-id>             after an interrupted run, re-reads the task and records outcomes
  plan continuation <plan-id>          which steps a stopped run may still take up, and what forbids it (read-only)
  plan continue <plan-id>              takes up the steps the records prove never started; replays nothing
  recover                              states what was interrupted, what is uncertain, and what can resume
  work                                 ranks the next work from goals, plans, tasks, and execution state
  next                                 states the single top recommendation; nothing is executed
A goal records what you intend; a plan records how you propose to get there; neither grants any
action permission. A task completing does not complete a goal: completion needs verified evidence
for every success criterion. Goal and plan writes are yours alone; a model cannot create, approve,
start, reconcile, continue, or complete one, and cannot smuggle one into a plan. Starting a plan
authorizes only the steps it names, each through the same registry authorization as any other action,
and an interrupted step is reported as uncertain rather than assumed not to have happened.

With a configured model endpoint, any other request is answered from that model,
using relevant memory and the recent conversation. Without one, APEX says so.
A model answer is unverified, and a proposed action is checked by APEX itself: a
denied proposal is reported and does not run. Model output is never authorization.
APEX connects only to an endpoint you have configured and chosen yourself. It does
not install, download, start, or recommend a model server of any kind.

Filesystem inspection is available only when APEX_FILESYSTEM_ROOT is set to an
absolute directory. Paths are relative to it; it cannot be changed by a request.

Environment:
  APEX_DATA_DIR            data directory (default: ~/.apex/local-alpha)
  APEX_DATA_ISOLATED       1: refuse to start unless APEX_DATA_DIR names a directory inside the OS
                           temporary directory. A test, benchmark, or diagnostic runs with this set
                           cannot reach a real user store; a missing or mistyped value is a startup
                           error, never a silent return to normal operation. Unset or 0 is normal
                           operation, and any store you chose stays available.
  APEX_FILESYSTEM_ROOT     absolute directory APEX may inspect (unset: no filesystem access)
  APEX_FILESYSTEM_MAX_READ_BYTES  maximum file size for a read (default: 1048576)
  APEX_MODEL_URL           endpoint URL of a model server you have configured (unset: no model)
  APEX_MODEL_PROVIDER      protocol of that endpoint: openai (default) or ollama
  APEX_MODEL_NAME          model name to request (default: local; required for ollama)
  APEX_MODEL_TIMEOUT_MS    model call timeout in ms, 100-600000 (default: 30000)
  APEX_MODEL_MAX_TOKENS    maximum answer length in tokens, 1-8192 (default: 512)
  APEX_MODEL_RETRIES       retries for unreachable or interrupted calls, 0-3 (default: 1)
  APEX_CONTEXT_TURNS       recent conversation turns sent to the model, 0-50 (default: 6)
  APEX_ALLOW_REMOTE_MODEL  set to 1 to allow a non-loopback endpoint (not recommended)
  APEX_EXPERIENCE_CAPTURE  off (default) or verified-success: whether APEX records an experience of
                           a verified successful operation without being asked. It never records
                           feedback; "experience record <operation-id>" is always available.
`;

// The views `task explain` prints. Each one is the same view the conversation uses when it
// answers that class of question about a task, so the CLI states nothing the follow-up path
// does not. Choosing a view is a display decision only: it never resolves an ambiguous
// reference, and it grants no approval and starts no run.
const TASK_EXPLAIN_VIEWS = {
  status: 'status',
  finished: 'finished',
  outcome: 'achieved',
  steps: 'steps_succeeded',
  pending: 'pending',
  why: 'why_stopped',
  approval: 'approval',
  recovery: 'recovery',
};

function parseFlags(args, allowed, repeat = []) {
  const flags = {};
  const rest = [];
  // Options that may be repeated. Each occurrence adds one value, so a goal can name
  // several criteria and a plan several steps without inventing a separator. `evidence`
  // is repeatable only where the command says so: the World Model cites several records,
  // while `knowledge add --evidence` is one text field.
  const repeatable = new Set(['criterion', 'step', 'precondition', 'assertion', 'depends-on', 'alias', 'external', 'participant', 'affected', 'property', ...repeat]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--') && a !== '--') {
      const name = a.slice(2);
      if (!allowed.includes(name)) throw new ValidationError(`unknown option --${name}`, 'USAGE');
      if (repeatable.has(name)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ValidationError(`--${name} needs a value`, 'USAGE');
        flags[name] = [...(flags[name] ?? []), v];
        i += 1;
      } else if (name === 'limit') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--limit needs a whole number', 'USAGE');
        flags.limit = Number(v);
        i += 1;
      } else if (name === 'days') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--days needs a whole number', 'USAGE');
        flags.days = Number(v);
        i += 1;
      } else if (name === 'priority' || name === 'estimate' || name === 'depth' || name === 'max-depth' || name === 'max-bytes') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError(`--${name} needs a whole number`, 'USAGE');
        flags[name] = Number(v);
        i += 1;
      } else if (name === 'confidence') {
        const v = args[i + 1];
        if (v === undefined || !/^(?:0|1|0?\.\d+)$/.test(v)) throw new ValidationError('--confidence needs a number from 0 to 1', 'USAGE');
        flags.confidence = Number(v);
        i += 1;
      } else if (name === 'min-support') {
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--min-support needs a whole number', 'USAGE');
        flags['min-support'] = Number(v);
        i += 1;
      } else if (name === 'in-days') {
        // A whole number here, so a mistaken value is a usage error that says what to type rather
        // than an action refusal about a field the user never meant to write badly. The ledger's own
        // bound (1 to MAX_PREDICTION_HORIZON_DAYS) is still enforced by the action.
        const v = args[i + 1];
        if (v === undefined || !/^\d+$/.test(v)) throw new ValidationError('--in-days needs a whole number of days', 'USAGE');
        flags['in-days'] = Number(v);
        i += 1;
      } else if (['title', 'body', 'subject', 'relationship', 'object', 'evidence', 'supersedes', 'choose', 'reason', 'assessment', 'guidance', 'replaces', 'since', 'until', 'capability', 'a-since', 'a-until', 'b-since', 'b-until', 'expect', 'expires', 'status', 'supports', 'contradicts', 'feedback', 'pattern', 'goal', 'outcome', 'deadline', 'plan', 'task', 'kind', 'operation', 'detail', 'by', 'category', 'name', 'description', 'observed-at', 'valid-from', 'valid-until', 'occurred-at', 'type', 'predicate', 'relation', 'direction', 'object-entity', 'object-value', 'value-type', 'unit', 'language', 'confidence-basis', 'evidence-relation', 'merge', 'left', 'right', 'decision', 'target-type', 'at', 'as-of', 'from', 'to', 'entity', 'world-event', 'work', 'cannot-use', 'extension', 'content', 'expected-sha256', 'workspace', 'operations', 'confirm',
      'events-file', 'endpoint', 'allowlist', 'root', 'exclude', 'path', 'interval', 'timeout',
      'max-observations', 'max-files', 'max-depth', 'memory-percent', 'disk-percent', 'provider'].includes(name)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new ValidationError(`--${name} needs a value`, 'USAGE');
        flags[name] = v;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

// A command that takes no positional arguments must not ignore one: silently accepting
// "status extra" says the request was understood when it was not.
function rejectUnexpected(rest, usage) {
  if (rest.length > 0) throw new ValidationError(`usage: ${usage}`, 'USAGE');
}

// A comma-separated list of record ids on the command line. Blank entries are dropped, so
// "a,,b" is the same list as "a,b" instead of a reference to nothing.
function idList(value) {
  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

// Note source references are "kind:ref". Only the first colon is a separator, so a Windows path
// after "file:" survives intact. The kind is checked by the note store, not guessed here.
function noteSources(values) {
  if (values === undefined) return [];
  return values.map((value) => {
    const at = value.indexOf(':');
    if (at <= 0 || at === value.length - 1) {
      throw new ValidationError('--source needs <kind:ref>, for example knowledge:<id> or file:notes.txt', 'USAGE');
    }
    return { kind: value.slice(0, at), ref: value.slice(at + 1) };
  });
}

// Steps and assertions are JSON objects given one per repeated option. A value that is not
// JSON, or is not an object, is a usage error: it is never passed on to the action to be
// guessed at.
function jsonObjects(values, label) {
  return (values ?? []).map((value, i) => {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError(`${label} ${i + 1} is not valid JSON`, 'USAGE');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError(`${label} ${i + 1} must be a JSON object`, 'USAGE');
    }
    return parsed;
  });
}

// World model command-line values. Each helper only assembles what was typed; the action
// validates it again, so a malformed flag is refused twice rather than trusted here.

// Evidence defaults to the user's own statement, because the command itself is a user-origin
// record. A stored record is named as `<sourceType>:<id>` and is checked against its own store.
function worldEvidence(flags) {
  const relation = flags['evidence-relation'] ?? 'supports';
  const values = flags.evidence ?? ['user'];
  return values.map((value) => {
    const text = String(value).trim();
    if (text === 'user') return { relation, sourceType: 'user', sourceId: 'user' };
    const at = text.indexOf(':');
    if (at < 1 || at === text.length - 1) {
      throw new ValidationError('--evidence must be "user" or <memory|knowledge|experience|task|operation|prediction>:<id>', 'USAGE');
    }
    return { relation, sourceType: text.slice(0, at), sourceId: text.slice(at + 1) };
  });
}

function worldExternal(values) {
  return (values ?? []).map((value) => {
    const at = String(value).indexOf(':');
    if (at < 1 || at === String(value).length - 1) {
      throw new ValidationError('--external must be <scheme>:<value>', 'USAGE');
    }
    return { scheme: String(value).slice(0, at), value: String(value).slice(at + 1) };
  });
}

function worldProperties(values) {
  const properties = {};
  for (const value of values ?? []) {
    const text = String(value);
    const at = text.indexOf('=');
    if (at < 1) throw new ValidationError('--property must be <key>=<value>', 'USAGE');
    const key = text.slice(0, at);
    if (Object.hasOwn(properties, key)) throw new ValidationError(`--property names "${key}" twice`, 'USAGE');
    properties[key] = text.slice(at + 1);
  }
  return Object.keys(properties).length > 0 ? properties : null;
}

function worldObject(flags) {
  const value = flags['object-value'];
  const entity = flags['object-entity'];
  if (value !== undefined && entity !== undefined) {
    throw new ValidationError('give either --object-entity or --object-value, not both', 'USAGE');
  }
  if (entity !== undefined) return { kind: 'entity', entityId: entity };
  if (value === undefined) throw new ValidationError('a fact needs --object-entity or --object-value', 'USAGE');
  const valueType = flags['value-type'] ?? 'string';
  let typed = value;
  if (valueType === 'number') {
    typed = Number(value);
    if (!Number.isFinite(typed)) throw new ValidationError('--object-value is not a number', 'USAGE');
  } else if (valueType === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new ValidationError('--object-value must be true or false for a boolean', 'USAGE');
    typed = value === 'true';
  }
  const object = { kind: 'scalar', valueType, value: typed };
  if (flags.unit !== undefined) object.unit = flags.unit;
  if (flags.language !== undefined) object.language = flags.language;
  return object;
}

function worldConfidence(flags) {
  if (flags.confidence === undefined) {
    if (flags['confidence-basis'] !== undefined) throw new ValidationError('--confidence-basis requires --confidence', 'USAGE');
    return null;
  }
  if (flags['confidence-basis'] === undefined) {
    throw new ValidationError('--confidence requires --confidence-basis: a number without a stated basis is not recorded', 'USAGE');
  }
  return { value: flags.confidence, basis: flags['confidence-basis'] };
}

function worldQuote(words) {
  return words.join(' ').trim();
}

function describeStepLine(step) {
  const auth = step.authorization ? `authorization ${step.authorization.decision} (${step.authorization.reason})` : 'authorization n/a';
  const exec = `execution ${step.execution?.status ?? 'not_run'}`;
  const ver = `verification ${step.verification?.outcome ?? 'not_run'}`;
  const name = step.action ?? '(unparsed)';
  return `  - ${name} [origin ${step.origin}]: ${auth}; ${exec}; ${ver}\n    ${redactSecrets(String(step.summary ?? ''))}`;
}

export function formatResult(res) {
  const lines = [];
  lines.push(`Operation: ${res.operation.id}`);
  lines.push(`Status:    ${res.status}`);
  const hits = res.operation.retrieval || [];
  lines.push(`Context:   ${hits.length} memory record(s) retrieved${hits.length ? ` [${hits.map((h) => shortId(h.id)).join(', ')}]` : ''}`);
  if (res.operation.prompt) {
    lines.push(`Prompt:    ${res.operation.prompt.memoryIds.length} memory record(s) and ${res.operation.prompt.turnIds.length} earlier turn(s) sent to the model`);
    const world = res.operation.prompt.world;
    if (world) {
      lines.push(world.unavailable
        ? 'Projection: could not be read for this answer, so APEX cannot say whether other stored records disagree.'
        : `Projection: ${world.included ? 'sent to the model' : 'omitted to keep the context within its budget'} (${world.unresolvedConflicts} unresolved knowledge group(s), ${world.memoryConflictGroups} memory group(s), ${world.unknowns} explicit unknown(s)${world.complete === false ? ', incomplete read' : ''})`);
    }
  }
  if (res.operation.steps.length) {
    lines.push('Steps:');
    for (const s of res.operation.steps) lines.push(describeStepLine(s));
  }
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') {
    lines.push('Note:      model answer; APEX cannot independently verify a model conclusion.');
  }
  if (res.status === Outcome.SUCCESS_DETERMINISTIC) {
    lines.push('Note:      deterministic answer derived from stored records; no model was used and no action was executed.');
  }
  // A corrupt store refuses before the action runs. Say that plainly: nothing was
  // changed, and a retry is only meaningful after repair, not while the damage remains.
  if (res.operation.steps.some((s) => s.execution?.status === 'failed' && /corrupt/i.test(s.execution?.error?.message ?? ''))) {
    lines.push('Note:      a stored data file is damaged, so this step was refused before it ran. Nothing in that store was changed. Run "node bin/apex.js diagnose" for what is readable and what is uncertain; retrying is safe only after the store is repaired.');
  }
  // A write whose executor reported a failure may already have changed data: the body was
  // invoked, so the outcome after the error is unknown. A rejected input never reached the
  // body and is reported above as rejected; this note is only for failures that started.
  // A coordination refusal is the exception that proves the rule the other way: the lock is
  // taken before any byte of the record is written, so `LOCKED` and the store's own
  // "nothing was written" refusals are known not to have changed anything, and telling the
  // user otherwise would invite them to treat a safe retry as dangerous.
  const writeActions = new Set([
    'memory.add', 'memory.correct', 'memory.save_conclusion', 'knowledge.add', 'knowledge.retract', 'knowledge.resolve',
    'experience.record', 'feedback.record', 'adaptation.derive', 'adaptation.decide', 'adaptation.guide', 'adaptation.retire',
    'learning.observe', 'learning.propose', 'learning.measure', 'learning.rollback',
    'situation.ingest', 'situation.evaluate', 'situation.decide', 'situation.response',
    'prediction.record', 'prediction.evaluate', 'prediction.invalidate',
  ]);
  const refusedBeforeWriting = (s) => s.execution?.error?.code === 'LOCKED'
    || /nothing was written/i.test(s.execution?.error?.message ?? '');
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && writeActions.has(s.action)
    && !/corrupt/i.test(s.execution?.error?.message ?? '')
    && !refusedBeforeWriting(s))) {
    lines.push('Note:      a write reported a failure after it started. APEX cannot establish whether it changed stored data, so do not repeat it unless you can confirm it did not take effect; run "node bin/apex.js diagnose" for a read-only report.');
  }
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && writeActions.has(s.action)
    && refusedBeforeWriting(s))) {
    lines.push('Note:      this write was refused before it began, so nothing was written. The reason above names what was in the way; retrying after that no longer applies is safe. Run "node bin/apex.js diagnose" for a read-only report of the lock.');
  }
  // An unusable data directory is an environment failure, not a rejected request. A retry
  // cannot help until the path is usable, so say what to check instead of implying that the
  // request itself was wrong.
  if (res.operation.steps.some((s) => s.execution?.status === 'failed'
    && /^cannot (?:read|write|prepare)\b.*\b(?:memory|knowledge|experienc\w*|prediction\w*|conversation|operations|session|tasks?|queue)\b/i.test(s.execution?.error?.message ?? ''))) {
    lines.push('Note:      a data file could not be read or written, so this request was not completed and nothing was confirmed. Check APEX_DATA_DIR, its permissions, and free space; run "node bin/apex.js diagnose" for a read-only report.');
  }
  lines.push('Output:');
  lines.push(res.display ?? res.output ?? '(none)');
  lines.push(res.recorded
    ? `Audit:     recorded in operations.jsonl (${res.operation.id})`
    : `Audit:     NOT RECORDED (${res.recordError ?? 'no audit record was written'})`);
  if (res.recorded === false) {
    lines.push('Note:      the result above is what this run observed, but the audit trail will not contain it. Do not repeat the request just to obtain a record; if it ran an action, that action may already have happened.');
  }
  return lines.join('\n');
}

// Compact reply for the chat loop. Full detail stays in `history` and the audit log.
export function formatChatReply(res) {
  // The source of the text is part of the tag: a model answer says so, and says it is unverified.
  const isModelAnswer = res.operation.capability === 'model.answer' && res.status === Outcome.VERIFICATION_UNAVAILABLE;
  const source = isModelAnswer ? `model answer, unverified (${res.operation.backend ?? 'model'}) · ` : '';
  const tag = `[${res.status} · ${source}${shortId(res.operation.id)}${res.recorded ? '' : ' · NOT RECORDED in audit log'}]`;
  return `${res.display ?? res.output ?? '(none)'}\n${tag}`;
}

// An operation can succeed while carrying a recorded failure that changes what the user
// actually got: when the session pointer cannot be read the action still runs, but the
// request has no conversation continuity, so the audit record says "session" while the
// outcome says "success_verified". The record is authoritative and must be disclosed.
// The notice goes to stderr and never changes the outcome or the exit code: the requested
// action did run and was verified.
function sessionNotice(res) {
  const failure = (res?.operation?.errors ?? []).find((e) => e?.stage === 'session');
  if (!failure) return null;
  return `Session: this request ran without conversation continuity (${safeText(failure.message, 200)})`;
}

// An error line is presentation, not evidence: the audit record keeps the original
// message. The text can still quote a user-supplied command, option, or store path,
// so it is bounded, stripped, and redacted like every other terminal line.
function errorText(e) {
  return safeText(e?.message ?? e, 400);
}

function exitCodeFor(res) {
  if (!res.recorded) return 3;
  if (res.status === Outcome.SUCCESS_VERIFIED) return 0;
  // A deterministic answer derived from the stores with no model call is a completed answer. It is
  // not a verified action and not model prose; the record's own status says what it means.
  if (res.status === Outcome.SUCCESS_DETERMINISTIC) return 0;
  // A plan that was checked and stored is a success of planning. Nothing has run yet.
  if (res.status === Outcome.PLAN_CREATED || res.status === Outcome.PLAN_PROPOSED) return 0;
  // A goal or plan record that was written and read back is a completed command. It is not
  // a claim that any work ran: the record's own status says what it means.
  if (res.status === Outcome.GOAL_CREATED || res.status === Outcome.GOAL_UPDATED
    || res.status === Outcome.GOAL_COMPLETED || res.status === Outcome.PLAN_STORED) return 0;
  // A stored proposal and a recorded user decision are completed commands. A proposal is not
  // approval or execution; the record's own status and validation say what it means.
  if (res.status === Outcome.PROPOSAL_CREATED || res.status === Outcome.PROPOSAL_DECIDED) return 0;
  if (res.status === Outcome.VERIFICATION_UNAVAILABLE && res.operation.capability === 'model.answer') {
    // Answer text alone is usable, but when a proposal was denied, failed, or could
    // not be verified the request only partly succeeded; the operation's own
    // decision already says refuse_or_block, so the exit code must not say success.
    return res.decision === Decision.REFUSE_OR_BLOCK ? 1 : 0;
  }
  return 1;
}

function modelLine(model) {
  if (model.state === State.NOT_CONFIGURED) {
    return 'Model backend: none configured. Non-model functions are available.';
  }
  const m = model.describe;
  const who = `${safeText(m.endpoint)} (provider ${safeText(m.provider, 32)}, model "${safeText(m.model, 80)}")`;
  if (model.state === State.NOT_CHECKED) {
    return `Model backend: ${who} - connectivity not checked (run "status --model")`;
  }
  if (model.state === State.OK) return `Model backend: ${who} - available (model list checked; no inference was run)`;
  if (model.state === State.UNCONFIRMED) return `Model backend: ${who} - reachable, model not confirmed: ${safeText(model.detail)} (model list only; no inference was run)`;
  return `Model backend: ${who} - unavailable: ${safeText(model.detail)}`;
}

// One bounded line on a terminal before the model is asked. The transport is not
// streaming, so it says only what APEX is waiting for and for how long; it never shows
// progress, partial text, or a claim that the model is working on an answer.
function modelWaiting(err) {
  return (event) => {
    const seconds = event && Number.isFinite(event.timeoutMs) ? Math.round(event.timeoutMs / 1000) : null;
    err(seconds
      ? `Waiting for the model (up to ${seconds} s; no partial output is shown)...`
      : 'Waiting for the model (no partial output is shown)...');
  };
}

function sessionLine(session) {
  if (session.state === State.OK) return `Session: ${shortId(session.sessionId)}`;
  if (session.state === State.MISSING) {
    return session.orphanTurns > 0
      ? `Session: missing (${session.orphanTurns} stored conversation turn(s) will not be replayed; a new session starts on the first request)`
      : 'Session: none yet (a new session starts on the first request)';
  }
  if (session.state === State.CORRUPT) return 'Session: corrupt (the current session cannot be loaded)';
  return 'Session: unavailable';
}

function holderText(report) {
  if (report.error) return `unreadable (${safeText(report.error)})`;
  if (report.alive === null) return 'holder not identifiable';
  // "live" is a statement about the recorded number, not proof that the process that wrote
  // it still runs: a recycled number is indistinguishable here.
  return `holder process ${report.pid} is ${report.alive ? 'live (liveness only; identity is not checked)' : 'not running'}`;
}

// Read-only view of the deferred task summaries. The queue is a delivery work list, not
// evidence: printing it never writes and never reissues a turn. Entry text is not printed;
// the task and audit logs remain the records of what happened.
async function showQueue({ app, limit, out, err }) {
  const max = MAX_QUEUED_SUMMARIES;
  let entries;
  try {
    entries = await app.summaryQueue.entries();
  } catch (e) {
    err(`Queue: unavailable (${errorText(e)})`);
    err('No entry was read or changed. Preserve task-summary-queue.json; there is no supported repair command. A corrupt queue blocks only the reissue of unsaved task summaries.');
    return 1;
  }
  if (entries.length === 0) {
    out('Queue: empty (no task summary is waiting to be reissued)');
  } else {
    const shown = entries.slice(0, Math.max(1, limit));
    out(`Queue: ${entries.length} deferred task summar${entries.length === 1 ? 'y' : 'ies'}${entries.length > shown.length ? ` (showing ${shown.length})` : ''}`);
    for (const entry of shown) {
      out(`  task ${shortId(entry.taskId)} session ${shortId(entry.sessionId)} queued ${safeText(entry.queuedAt, 40)}${entry.verified ? '' : ' (result not verified)'} text ${entry.text.length} char(s)`);
    }
    if (entries.length >= max) {
      out(`Queue: full (${entries.length}/${max}); a further task summary will be refused and disclosed, not queued. Entries are reissued at the next successful task write.`);
    }
  }
  let lock;
  try {
    lock = await app.summaryQueue.lockReport();
  } catch (e) {
    err(`Queue lock: inspection failed (${errorText(e)})`);
    return 1;
  }
  if (!lock.present) {
    out('Queue lock: no lock file (no queue update is in progress)');
  } else {
    out(`Queue lock: ${holderText(lock)}; takeover tokens ${lock.tokens.total} recorded (${lock.tokens.dead} dead for this claim)`);
    // Say what is known and what a retry would mean. This view never waits for or takes
    // the lock, so a held update is not a failure of the read.
    if (lock.alive === true) {
      out('A queue update is refused while that process holds the lock. This view is read-only; retrying the update after it finishes is safe.');
    } else if (lock.error || lock.alive === null) {
      out('The lock holder cannot be identified, so a queue update may be refused as "in use by unknown". This view is read-only; run "node bin/apex.js diagnose" and, if no update is active, "node bin/apex.js repair locks".');
    } else if (lock.tokens.current >= TAKEOVER_EPOCHS && lock.tokens.live === 0) {
      out('The holder is not running, but every takeover slot is abandoned, so the next update will be refused. Run "node bin/apex.js repair locks" after confirming no update is active.');
    } else {
      out('The holder is not running; the next queue update takes the claim over through its normal election. This view is read-only.');
    }
  }
  return 0;
}

// Removes abandoned takeover tokens only. It never removes a claim: the ordinary election
// is the only path that removes a lock, so recovery cannot displace a process that takes
// the dead claim over while recovery is running.
async function repairLocks({ app, out, err }) {
  // One fixed order for every lock, so a run always reports and recovers the same set of
  // stores. Recovery touches only abandoned takeover tokens, so the order cannot decide
  // which store wins - but the output is comparable across runs only if it is stable.
  const targets = [
    { label: 'Task lock', store: app.taskStore },
    { label: 'Summary queue lock', store: app.summaryQueue },
    { label: 'Memory lock', store: app.memory },
    { label: 'Knowledge lock', store: app.knowledge },
    { label: 'Experience lock', store: app.experience },
    { label: 'Prediction lock', store: app.predictions },
    { label: 'World model lock', store: app.worldModel },
  ];
  let failed = 0;
  for (const target of targets) {
    let report;
    try {
      report = await target.store.lockReport();
    } catch (e) {
      err(`${target.label}: inspection failed: ${errorText(e)}`);
      failed += 1;
      continue;
    }
    if (!report.present) {
      out(`${target.label}: no lock file; nothing to recover`);
      continue;
    }
    const tokens = report.tokens;
    out(`${target.label}: present; ${holderText(report)}; takeover tokens ${tokens.total} recorded (${tokens.current} for this claim: ${tokens.dead} dead, ${tokens.live} live, ${tokens.unknown} unidentified)`);
    if (report.guard.present) {
      out(`${target.label}: recovery claim present (process ${report.guard.pid ?? 'unknown'}, ${report.guard.alive === true ? 'live' : report.guard.alive === false ? 'not running' : 'unreadable'})`);
    }
    try {
      const result = await target.store.recover();
      if (result.reason === 'no-lock') {
        out(`${target.label}: no claim now; nothing was removed`);
      } else if (result.removedTokens > 0) {
        out(`${target.label}: removed ${result.removedTokens} abandoned takeover token(s); the claim was left for the next normal run to take over`);
      } else {
        out(`${target.label}: no abandoned takeover tokens for this claim; the claim was left for the next normal run to take over`);
      }
    } catch (e) {
      err(`${target.label}: not recovered: ${errorText(e)}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    err('Recovery did not complete. No live holder or takeover was displaced, and no lock claim was deleted. Retrying is safe once the reported condition no longer applies.');
  }
  return failed > 0 ? 1 : 0;
}

export async function main(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  appFactory = createAppFromEnv,
} = {}) {
  const [command, ...args] = argv;
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  const emit = (res, asData = null) => {
    out(asData !== null ? JSON.stringify(asData, null, 2) : (res.display ?? res.output ?? '(none)'));
    if (res.recorded === false) {
      err(`Audit: NOT RECORDED (${res.recordError ?? 'no audit record was written'})`);
      // The result is what this run observed; the evidence trail is incomplete. Repeating
      // the request cannot restore a record, and an action that already ran would run again.
      err('The result above is what this run observed, but the audit trail will not contain it. Do not repeat the request just to obtain a record; if it ran an action, that action may already have happened.');
    } else if (res.operation) {
      out(`Audit: recorded in operations.jsonl (${res.operation.id})`);
    }
    if (res.auditGaps) err(`Audit: ${res.auditGaps} step record(s) could not be written to the operation log`);
    const session = sessionNotice(res);
    if (session) err(session);
    return exitCodeFor(res);
  };

  // A read answer as data. `--json` replaces only the printed view: the operation, its audit line and
  // its exit code stay the ones the read already had. What prints is the result the audit record
  // carries - the same values the answer was built from, before that answer was bounded to fit the
  // terminal - and a read that returned no result at all falls back to its own printed answer.
  const emitRead = (res, flags) => emit(res, flags.json ? (res.operation?.steps?.[0]?.result?.data ?? null) : null);

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return 0;
  }
  if (command === 'version') {
    out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION}`);
    return 0;
  }

  let app;
  try {
    app = appFactory(env);
  } catch (e) {
    // Configuration is validated before any store is opened, so this failure
    // cannot have read or changed persistent data.
    err(`configuration error: ${errorText(e)}`);
    err('No data was read or changed. Check the APEX_* settings in "node bin/apex.js help".');
    return 2;
  }

  // Which store this run is on, stated once, whenever its location came from the fallback rather
  // than from the operator. Every command below can reach that store - the writing families
  // through their records, the reading ones through the audit line an audited read appends - so
  // the line is about the run rather than about one command. `status` and `diagnose` name the
  // directory in their own output and are left out to avoid saying it twice.
  if (app.config?.dataDirIsDefault === true && app.config?.isolated !== true && command !== 'status' && command !== 'diagnose') {
    err(`Data: this run uses the default data directory (${safeText(app.dataDir)}); APEX_DATA_DIR is not set. Set it to keep your store where you chose it.`);
  }

  try {
    if (command === 'status') {
      const { flags, rest } = parseFlags(args, ['model']);
      rejectUnexpected(rest, 'status [--model]');
      const diag = await collectDiagnostics(app, { checkModel: Boolean(flags.model) });
      const { session, conversation, memory, experience, predictions, goals, plans, audit, queue, model, filesystem } = diag.subsystems;
      out(`${APP_NAME} ${APP_STAGE} ${APP_VERSION} (${APP_EXPANSION})`);
      out(dataDirLabel(diag));
      out(sessionLine(session));
      const skipped = (s) => (s.state !== State.UNAVAILABLE && s.corruptLines > 0
        ? ` (corrupt lines skipped: ${s.corruptLines})`
        : '');
      out(`Memory records: ${memory.state === State.UNAVAILABLE ? 'unavailable' : memory.count} (corrupt lines skipped: ${memory.corruptLines})`);
      out(`Conversation turns: ${conversation.state === State.UNAVAILABLE ? 'unavailable' : conversation.count}${skipped(conversation)}`);
      out(`Operation records: ${audit.state === State.UNAVAILABLE ? 'unavailable' : audit.count}${skipped(audit)}`);
      // Named separately from memory on purpose: an experience references one audited event and
      // an adaptation in effect changes how APEX answers, so both counts belong where the user
      // can see what is currently being applied without running a second command.
      out(`Experiences: ${experience.state === State.UNAVAILABLE ? 'unavailable' : `${experience.experiences} record(s), ${experience.feedback} feedback record(s), ${experience.activeAdaptations} approved adaptation(s) in effect`}${skipped(experience)}`);
      if (experience.state !== State.UNAVAILABLE) {
        // How each experience arrived is printed with the counts because the two lead to different
        // questions: a record the user asked for, and a record of an outcome APEX verified on its own.
        out(`Experience capture: ${experience.capture?.setting ?? 'not reported'}; ${experience.recordedByUser} recorded by you, ${experience.capturedAutomatically} captured automatically`);
        if (experience.unknownCapture > 0) {
          out(`Experience capture: ${experience.unknownCapture} record(s) carry capture provenance no writer produces; run "node bin/apex.js experience health"`);
        }
      }
      if (experience.state !== State.UNAVAILABLE && experience.conflicts.scopes > 0) {
        out(`Experiences: ${experience.conflicts.scopes} capability scope(s) hold approved adaptations that disagree; run "node bin/apex.js adaptation list"`);
      }
      // Counted apart from experiences because it answers a different question: what the user
      // recorded expecting, not what happened. The two live in separate logs for that reason.
      out(`Predictions: ${predictions.state === State.UNAVAILABLE ? 'unavailable' : `${predictions.predictions} expectation(s) recorded, ${predictions.live} standing, ${predictions.evaluations} evaluated against recorded outcomes`}${skipped(predictions)}`);
      if (predictions.state !== State.UNAVAILABLE && predictions.predictions > 0) {
        out('  Expectations the user recorded, not observations, and no confidence is stored in any of them; run "node bin/apex.js prediction list" or "prediction summary".');
      }
      // Recorded intent, apart from work: an open goal or plan is unfinished intent, and a task
      // completing does not complete either one.
      out(`Goals: ${goals.state === State.UNAVAILABLE ? 'unavailable' : `${goals.count} record(s), ${goals.open} open`}${skipped(goals)}`);
      out(`Plans: ${plans.state === State.UNAVAILABLE ? 'unavailable' : `${plans.count} record(s), ${plans.open} open`}${skipped(plans)}`);
      // The World Model is a separate append-only store. A damaged log is reported as such,
      // never as an empty world. Run "world inspect" for the detail behind these counts.
      const wm = await app.worldModel.status();
      out(`World model: ${wm.available
        ? `${wm.records} record(s), ${wm.counts?.entities ?? 0} entity(ies), ${wm.counts?.facts ?? 0} fact(s), ${wm.counts?.relationships ?? 0} relationship(s), ${wm.counts?.events ?? 0} event(s)${wm.complete ? '' : '; damaged'}`
        : `unavailable (${safeText(wm.detail)})`}`);
      out(`Deferred task summaries: ${queue.count === null ? queue.state : `${queue.count}/${queue.max}${queue.full ? ' (full)' : ''}`}`);
      if (diag.locks?.task?.state === State.CORRUPT || diag.locks?.queue?.state === State.CORRUPT) {
        out('Locks: abandoned takeover tokens require recovery; run "node bin/apex.js repair locks".');
      }
      out(modelLine(model));
      if (model.state === State.UNAVAILABLE) {
        out(model.reachable === true
          ? 'Model: no inference was tested. The endpoint answered but readiness failed (see above); correct the model name you configured, then re-run "status --model".'
          : 'Model: no inference was tested. The endpoint you configured did not answer; re-running "status --model" is safe because that probe only reads the model list. APEX does not install, start, or recommend a model server; check that the server you configured is running and reachable at that URL.');
      }
      out(filesystem.state === State.OK
        ? `Filesystem root: ${safeText(filesystem.root)} (validated at startup; reads are bounded, and only a user-origin command can write)`
        : 'Filesystem root: none configured. Workspace commands and filesystem inspection are unavailable.');
      if (diag.needsAttention) {
        // A model probe failure is not a storage or audit failure. Only say
        // "integrity" when a local check actually found something.
        const localAttention = diag.localDefects
          || diag.integrity.suspicions.length > 0
          || diag.taskState.uncertainSteps.length > 0
          || diag.taskState.runningTasks.some((task) => task.live !== true);
        if (localAttention) {
          out('Integrity: attention required; run "node bin/apex.js diagnose" for read-only details and recovery guidance.');
        } else {
          out('Local integrity: no defects found; the model backend is unavailable (see above).');
        }
        const unavailable = Object.values(diag.subsystems).find((s) => s.key !== 'model' && s.state === State.UNAVAILABLE);
        if (unavailable) err(`data store unavailable: ${safeText(unavailable.detail)}. Check APEX_DATA_DIR and its permissions.`);
      }
      return diag.needsAttention ? 1 : 0;
    }

    if (command === 'capabilities' || command === 'capability') {
      // A direct, unaudited read of the live registry. Positional words narrow the list; the
      // filter is a plain substring, so the same words always return the same capabilities.
      const { flags, rest } = parseFlags(args, ['json']);
      const query = rest.join(' ').trim();
      const res = await app.controller.capabilitiesReport({ query: query === '' ? null : query });
      out(flags.json ? JSON.stringify(res.data, null, 2) : res.display);
      return res.verified ? 0 : 1;
    }

    if (command === 'model') {
      // Declarations only. Unlike `status --model`, this never probes the endpoint: it reports what
      // the configured backend and APEX's transport declare, each marked unverified.
      const { flags, rest } = parseFlags(args, ['json']);
      if (rest.length !== 1 || rest[0] !== 'contracts') {
        err('usage: node bin/apex.js model contracts [--json]');
        return 2;
      }
      const res = await app.controller.modelContracts();
      out(flags.json ? JSON.stringify(res.data, null, 2) : res.display);
      return res.verified ? 0 : 1;
    }

    if (command === 'neural') {
      // A declaration only. There is no route that invokes a neural runtime, and this command
      // contacts nothing; the deterministic simulated transport stays in tests.
      const { flags, rest } = parseFlags(args, ['json']);
      if (rest.length !== 1 || rest[0] !== 'contract') {
        err('usage: node bin/apex.js neural contract [--json]');
        return 2;
      }
      const res = await app.controller.neuralContract();
      out(flags.json ? JSON.stringify(res.data, null, 2) : res.display);
      return res.verified ? 0 : 1;
    }

    if (command === 'diagnose') {
      const { flags, rest } = parseFlags(args, ['model']);
      rejectUnexpected(rest, 'diagnose [--model]');
      const diag = await collectDiagnostics(app, { checkModel: Boolean(flags.model) });
      out(renderDiagnostics(diag));
      return diag.needsAttention ? 1 : 0;
    }

    if (command === 'new') {
      rejectUnexpected(parseFlags(args, []).rest, 'new');
      const state = await app.session.rotate();
      out(`Started a new session: ${state.sessionId}`);
      out('Earlier conversation stays in history but is not sent to the model.');
      return 0;
    }

    if (command === 'workspace') {
      const [sub, ...rest] = args;
      const usage = 'workspace roots | list [path] [--limit N] [--workspace <name>] | find [path] --name <text>|--extension <ext> [--max-depth N] [--limit N] [--workspace <name>] | read <path> [--max-bytes N] [--workspace <name>] | extract <path> [--max-bytes N] [--workspace <name>] | summarize <path> [--max-bytes N] [--workspace <name>] | compare <a> <b> [--max-bytes N] [--workspace <name>] | report [path] [--max-depth N] [--limit N] [--workspace <name>] | write <path> --content <text> [--expected-sha256 <hash>] [--workspace <name>] | mkdir <path> [--parents] [--workspace <name>] | move <path> <destination> [--workspace <name>] | delete <path> [--workspace <name>] | trash [--limit N] [--workspace <name>] | restore <quarantine-id> [--workspace <name>] | batch --operations <json> [--workspace <name>]';
      if (sub === 'roots') {
        rejectUnexpected(rest, 'workspace roots');
        const roots = app.controller.workspaceRoots();
        out(roots.length === 0 ? '(no workspace roots configured)' : roots.map((entry) => `${entry.name}${entry.default ? ' (default)' : ''}  ${entry.path}`).join('\n'));
        return 0;
      }
      if (sub === 'list') {
        const { flags, rest: paths } = parseFlags(rest, ['limit', 'workspace']);
        if (paths.length > 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceList({
          path: paths[0] ?? '.',
          ...(flags.limit === undefined ? {} : { limit: flags.limit }),
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'find') {
        const { flags, rest: paths } = parseFlags(rest, ['name', 'extension', 'max-depth', 'limit', 'workspace']);
        if (paths.length > 1 || (flags.name === undefined && flags.extension === undefined)) {
          err(`usage: ${usage}`);
          return 2;
        }
        const input = { path: paths[0] ?? '.' };
        if (flags.name !== undefined) input.name = flags.name;
        if (flags.extension !== undefined) input.extension = flags.extension;
        if (flags['max-depth'] !== undefined) input.maxDepth = flags['max-depth'];
        if (flags.limit !== undefined) input.limit = flags.limit;
        if (flags.workspace !== undefined) input.workspace = flags.workspace;
        return emit(await app.controller.workspaceFind(input));
      }
      if (sub === 'read' || sub === 'summarize' || sub === 'extract') {
        const { flags, rest: paths } = parseFlags(rest, ['max-bytes', 'workspace']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        const input = { path: paths[0] };
        if (flags['max-bytes'] !== undefined) input.maxBytes = flags['max-bytes'];
        if (flags.workspace !== undefined) input.workspace = flags.workspace;
        if (sub === 'read') return emit(await app.controller.workspaceRead(input));
        if (sub === 'extract') return emit(await app.controller.workspaceExtract(input));
        return emit(await app.controller.workspaceSummarize(input));
      }
      if (sub === 'compare') {
        const { flags, rest: paths } = parseFlags(rest, ['max-bytes', 'workspace']);
        if (paths.length !== 2) {
          err(`usage: ${usage}`);
          return 2;
        }
        const input = { a: paths[0], b: paths[1] };
        if (flags['max-bytes'] !== undefined) input.maxBytes = flags['max-bytes'];
        if (flags.workspace !== undefined) input.workspace = flags.workspace;
        return emit(await app.controller.workspaceCompare(input));
      }
      if (sub === 'report') {
        const { flags, rest: paths } = parseFlags(rest, ['max-depth', 'limit', 'workspace']);
        if (paths.length > 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        const input = { path: paths[0] ?? '.' };
        if (flags['max-depth'] !== undefined) input.maxDepth = flags['max-depth'];
        if (flags.limit !== undefined) input.limit = flags.limit;
        if (flags.workspace !== undefined) input.workspace = flags.workspace;
        return emit(await app.controller.workspaceReport(input));
      }
      if (sub === 'write') {
        const { flags, rest: paths } = parseFlags(rest, ['content', 'expected-sha256', 'workspace']);
        if (paths.length !== 1 || typeof flags.content !== 'string') {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceWrite({
          path: paths[0],
          content: flags.content,
          expectedSha256: flags['expected-sha256'] ?? null,
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'mkdir') {
        const { flags, rest: paths } = parseFlags(rest, ['parents', 'workspace']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceMkdir({
          path: paths[0],
          parents: flags.parents === true,
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'move') {
        const { flags, rest: paths } = parseFlags(rest, ['workspace']);
        if (paths.length !== 2) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceMove({
          path: paths[0],
          to: paths[1],
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'delete') {
        const { flags, rest: paths } = parseFlags(rest, ['workspace']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceDelete({
          path: paths[0],
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'trash') {
        const { flags, rest: paths } = parseFlags(rest, ['limit', 'workspace']);
        if (paths.length > 0) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceTrash({
          ...(flags.limit === undefined ? {} : { limit: flags.limit }),
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'restore') {
        const { flags, rest: paths } = parseFlags(rest, ['workspace']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.workspaceRestore({
          id: paths[0],
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      if (sub === 'batch') {
        const { flags, rest: paths } = parseFlags(rest, ['operations', 'workspace']);
        if (paths.length > 0 || typeof flags.operations !== 'string') {
          err(`usage: ${usage}`);
          return 2;
        }
        let operations;
        try {
          operations = JSON.parse(flags.operations);
        } catch {
          err('usage: --operations must be a JSON array of {type, path, ...} objects');
          return 2;
        }
        return emit(await app.controller.workspaceBatch({
          operations,
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      err(`usage: ${usage}`);
      return 2;
    }

    if (command === 'memory') {
      const [sub, ...rest] = args;
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'memory health');
        // A direct, unaudited read. Exit 0 only when the store was fully inspected and
        // nothing requires attention; damage or an unreadable store exits 1.
        const res = await app.controller.memoryHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
      }
      if (sub !== 'correct') {
        err('usage: memory correct --resolve <full-record-id> <replacement claim...> | memory health');
        return 2;
      }
      const { flags, rest: values } = parseFlags(rest, ['resolve']);
      if (!flags.resolve || values.length < 2) {
        throw new ValidationError('usage: memory correct --resolve <full-record-id> <replacement claim...>', 'USAGE');
      }
      return emit(await app.controller.correctMemory({ targetId: values[0], content: values.slice(1).join(' '), resolve: true }));
    }

    if (command === 'knowledge') {
      const [sub, ...rest] = args;
      if (sub === 'add') {
        const { flags, rest: extra } = parseFlags(rest, ['subject', 'relationship', 'object', 'evidence', 'supersedes']);
        rejectUnexpected(extra, 'knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]');
        if (!flags.subject || !flags.relationship || !flags.object) {
          err('usage: knowledge add --subject <text> --relationship <text> --object <text> [--evidence <text>] [--supersedes <id[,id...]>]');
          return 2;
        }
        const supersedes = typeof flags.supersedes === 'string'
          ? flags.supersedes.split(',').map((value) => value.trim()).filter(Boolean)
          : [];
        return emit(await app.controller.knowledgeAdd({
          subject: flags.subject,
          relationship: flags.relationship,
          object: flags.object,
          evidence: flags.evidence ?? null,
          supersedes,
        }));
      }
      if (sub === 'retract') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err('usage: knowledge retract <record-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.knowledgeRetract({
          target: ids[0],
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'resolve') {
        const { flags, rest: ids } = parseFlags(rest, ['choose', 'reason']);
        if (ids.length !== 1 || typeof flags.choose !== 'string' || flags.choose.trim().length === 0) {
          err('usage: knowledge resolve <target-id> --choose <claim-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.knowledgeResolve({
          target: ids[0],
          choose: flags.choose,
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'history') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: knowledge history <record-id>');
          return 2;
        }
        // A direct, unaudited read, like `knowledge show`: no operation record exists,
        // so the exit code reports whether the lifecycle could be resolved.
        const res = await app.controller.knowledgeHistory(ids[0]);
        out(res.display ?? res.output ?? '(none)');
        return res.status === Outcome.SUCCESS_VERIFIED ? 0 : 1;
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'knowledge health');
        // A direct, unaudited read. Exit 0 only when the store was fully inspected and
        // nothing requires a decision; damage, ambiguity, anomalies, and unresolved
        // conflicts exit 1 without changing anything.
        const res = await app.controller.knowledgeHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'knowledge list [--limit N]');
        return emit(await app.controller.knowledgeList({ limit: flags.limit }));
      }
      if (sub === 'search') {
        const { rest: words } = parseFlags(rest, []);
        if (words.length === 0) {
          err('usage: knowledge search <query words...>');
          return 2;
        }
        return emit(await app.controller.knowledgeSearch(words.join(' ')));
      }
      if (sub === 'digest') {
        const { flags, rest: words } = parseFlags(rest, ['limit']);
        return emit(await app.controller.knowledgeDigest({
          query: words.length > 0 ? words.join(' ') : null,
          limit: flags.limit ?? 5,
        }));
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: knowledge show <record-id>');
          return 2;
        }
        // A direct, unaudited read, like `task show`: there is no operation record,
        // so exit 0/1 reflects whether the record was found, not audit persistence.
        const res = await app.controller.knowledgeShow(ids[0]);
        out(res.display ?? res.output ?? '(none)');
        return res.status === Outcome.SUCCESS_VERIFIED ? 0 : 1;
      }
      err('usage: knowledge add|retract|resolve|history|health|list|search|digest|show');
      return 2;
    }

    if (command === 'note') {
      const [sub, ...rest] = args;
      if (sub === 'add') {
        const { flags, rest: extra } = parseFlags(rest, ['title', 'body', 'tag', 'source', 'private', 'normal'], ['tag', 'source']);
        rejectUnexpected(extra, 'note add --title <text> --body <text> [--tag <tag>]... [--source <kind:ref>]... [--private]');
        if (typeof flags.title !== 'string' || typeof flags.body !== 'string') {
          err('usage: note add --title <text> --body <text> [--tag <tag>]... [--source <kind:ref>]... [--private]');
          return 2;
        }
        if (flags.private && flags.normal) {
          err('usage: choose --private or --normal, not both');
          return 2;
        }
        return emit(await app.controller.noteAdd({
          title: flags.title,
          body: flags.body,
          tags: flags.tag ?? [],
          sources: noteSources(flags.source),
          sensitivity: flags.private ? 'private' : 'normal',
        }));
      }
      if (sub === 'update') {
        const { flags, rest: ids } = parseFlags(rest, ['title', 'body', 'tag', 'source', 'private', 'normal'], ['tag', 'source']);
        if (ids.length !== 1) {
          err('usage: note update <note-id> [--title <text>] [--body <text>] [--tag <tag>]... [--source <kind:ref>]... [--private|--normal]');
          return 2;
        }
        if (flags.private && flags.normal) {
          err('usage: choose --private or --normal, not both');
          return 2;
        }
        const input = { target: ids[0] };
        if (typeof flags.title === 'string') input.title = flags.title;
        if (typeof flags.body === 'string') input.body = flags.body;
        if (flags.tag !== undefined) input.tags = flags.tag;
        if (flags.source !== undefined) input.sources = noteSources(flags.source);
        if (flags.private) input.sensitivity = 'private';
        if (flags.normal) input.sensitivity = 'normal';
        if (Object.keys(input).length === 1) {
          err('usage: note update <note-id> needs at least one of --title, --body, --tag, --source, --private, --normal');
          return 2;
        }
        return emit(await app.controller.noteUpdate(input));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'include-private']);
        rejectUnexpected(extra, 'note list [--limit N] [--include-private]');
        return emit(await app.controller.noteList({
          limit: flags.limit ?? 20,
          includePrivate: flags['include-private'] === true,
        }));
      }
      if (sub === 'show') {
        const { flags, rest: ids } = parseFlags(rest, ['include-private']);
        if (ids.length !== 1) {
          err('usage: note show <note-id> [--include-private]');
          return 2;
        }
        return emit(await app.controller.noteShow({
          target: ids[0],
          includePrivate: flags['include-private'] === true,
        }));
      }
      if (sub === 'search') {
        const { flags, rest: words } = parseFlags(rest, ['limit', 'include-private']);
        if (words.length === 0) {
          err('usage: note search <query words...> [--limit N] [--include-private]');
          return 2;
        }
        return emit(await app.controller.noteSearch({
          query: words.join(' '),
          limit: flags.limit ?? 5,
          includePrivate: flags['include-private'] === true,
        }));
      }
      if (sub === 'history') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: note history <note-id>');
          return 2;
        }
        return emit(await app.controller.noteHistory({ target: ids[0] }));
      }
      if (sub === 'save-digest') {
        const { flags, rest: words } = parseFlags(rest, ['title', 'tag', 'limit', 'private', 'normal'], ['tag']);
        if (flags.private && flags.normal) {
          err('usage: choose --private or --normal, not both');
          return 2;
        }
        return emit(await app.controller.noteFromDigest({
          query: words.length > 0 ? words.join(' ') : null,
          limit: flags.limit ?? 5,
          title: typeof flags.title === 'string' ? flags.title : null,
          tags: flags.tag ?? [],
          sensitivity: flags.private ? 'private' : 'normal',
        }));
      }
      err('usage: note add|update|list|show|search|history|save-digest');
      return 2;
    }

    if (command === 'experience') {
      const [sub, ...rest] = args;
      if (sub === 'record') {
        const { flags, rest: ids } = parseFlags(rest, ['subject', 'replaces']);
        if (ids.length !== 1 || !flags.subject) {
          err('usage: experience record <operation-id> --subject <text> [--replaces <id[,id...]>]');
          return 2;
        }
        return emit(await app.controller.experienceRecord({
          operationId: ids[0],
          subject: flags.subject,
          replaces: idList(flags.replaces),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'experience list [--limit N]');
        return emit(await app.controller.experienceList({ limit: flags.limit }));
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: experience show <experience-or-operation-id>');
          return 2;
        }
        return emit(await app.controller.experienceShow({ target: ids[0] }));
      }
      // Temporal reads. The window is resolved by the temporal engine, so an unparseable bound is
      // refused as usage here only when it has the wrong shape; a well-formed but unknown date is
      // reported by the action as rejected input.
      if (['timeline', 'trends', 'patterns'].includes(sub)) {
        const { flags, rest: extra } = parseFlags(rest, ['since', 'until', 'days', 'capability', 'limit']);
        rejectUnexpected(extra, `experience ${sub} [--since <date>] [--until <date>] [--days N] [--capability <name>] [--limit N]`);
        const query = { since: flags.since, until: flags.until, days: flags.days, capability: flags.capability, limit: flags.limit };
        const method = sub === 'timeline' ? 'experienceTimeline' : sub === 'trends' ? 'experienceTrends' : 'experiencePatterns';
        return emit(await app.controller[method](query));
      }
      if (sub === 'compare') {
        const { flags, rest: extra } = parseFlags(rest, ['a-since', 'a-until', 'b-since', 'b-until', 'days', 'capability']);
        rejectUnexpected(extra, 'experience compare [--a-since <date>] [--a-until <date>] [--b-since <date>] [--b-until <date>] [--days N] [--capability <name>]');
        return emit(await app.controller.experienceCompare({
          aSince: flags['a-since'],
          aUntil: flags['a-until'],
          bSince: flags['b-since'],
          bUntil: flags['b-until'],
          days: flags.days,
          capability: flags.capability,
        }));
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'experience health');
        // A direct, unaudited read. Exit 0 only when the log was fully inspected, nothing needs
        // a decision, and every recorded experience still matches the audit event it names.
        const res = await app.controller.experienceHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention || res.evidenceMismatch > 0 ? 1 : 0;
      }
      err('usage: experience record|list|show|timeline|trends|patterns|compare|health');
      return 2;
    }

    if (command === 'feedback') {
      const [sub, ...rest] = args;
      if (sub !== 'record') {
        err('usage: feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]');
        return 2;
      }
      const { flags, rest: ids } = parseFlags(rest, ['assessment', 'guidance', 'reason', 'supersedes']);
      if (ids.length !== 1 || !flags.assessment) {
        err('usage: feedback record <experience-or-operation-id> --assessment <kind> [--guidance <text>] [--reason <text>] [--supersedes <id[,id...]>]');
        return 2;
      }
      return emit(await app.controller.feedbackRecord({
        target: ids[0],
        assessment: flags.assessment,
        guidance: flags.guidance ?? null,
        reason: flags.reason ?? null,
        supersedes: idList(flags.supersedes),
      }));
    }

    if (command === 'adaptation') {
      const [sub, ...rest] = args;
      if (sub === 'derive') {
        const { flags, rest: extra } = parseFlags(rest, ['min-support']);
        rejectUnexpected(extra, 'adaptation derive [--min-support N]');
        return emit(await app.controller.adaptationDerive({ minSupport: flags['min-support'] }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'exclude-retired']);
        rejectUnexpected(extra, 'adaptation list [--limit N] [--exclude-retired]');
        return emit(await app.controller.adaptationList({
          limit: flags.limit,
          includeRetired: flags['exclude-retired'] ? false : undefined,
        }));
      }
      if (sub === 'eligibility') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'limit']);
        rejectUnexpected(extra, 'adaptation eligibility [--capability name] [--limit N]');
        return emit(await app.controller.adaptationEligibility({
          capability: flags.capability ?? null,
          limit: flags.limit,
        }));
      }
      if (sub === 'effectiveness') {
        const { flags, rest: extra } = parseFlags(rest, ['adaptation', 'limit']);
        rejectUnexpected(extra, 'adaptation effectiveness [--adaptation <id>] [--limit N]');
        return emit(await app.controller.adaptationEffectiveness({
          target: flags.adaptation ?? null,
          limit: flags.limit,
        }));
      }
      if (sub === 'reviews') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'adaptation reviews [--limit N]');
        return emit(await app.controller.adaptationReviews({ limit: flags.limit }));
      }
      if (sub === 'review') {
        const [action, ...rest] = rest;
        if (action === 'show' || action === 'inspect' || action === 'reconcile') {
          const { rest: ids } = parseFlags(rest, []);
          if (ids.length !== 1) {
            err(`usage: adaptation review ${action} <review-or-adaptation-id>`);
            return 2;
          }
          return emit(await (action === 'reconcile'
            ? app.controller.adaptationReviewReconcile({ target: ids[0] })
            : app.controller.adaptationReviewInspect({ target: ids[0] })));
        }
        if (action === 'open') {
          const { flags, rest: ids } = parseFlags(rest, ['reason']);
          if (ids.length !== 1) {
            err('usage: adaptation review open <adaptation-id> [--reason <text>]');
            return 2;
          }
          return emit(await app.controller.adaptationReviewOpen({ target: ids[0], reason: flags.reason ?? null }));
        }
        if (action === 'keep' || action === 'dismiss' || action === 'retire') {
          const { flags, rest: ids } = parseFlags(rest, ['reason']);
          if (ids.length !== 1) {
            err(`usage: adaptation review ${action} <review-id> [--reason <text>]`);
            return 2;
          }
          // The decision is the command that was typed, never a default: a bare
          // `adaptation review` cannot decide anything.
          const decision = action === 'keep' ? 'keep_active' : action;
          return emit(await app.controller.adaptationReviewDecide({
            review: ids[0],
            decision,
            reason: flags.reason ?? null,
          }));
        }
        err('usage: adaptation review show|reconcile <id> | open <adaptation-id> | keep|dismiss|retire <review-id>');
        return 2;
      }
      if (sub === 'approve' || sub === 'reject') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err(`usage: adaptation ${sub} <adaptation-id> [--reason <text>]`);
          return 2;
        }
        // The decision is the command that was typed. There is no default: a bare
        // `adaptation decide` cannot approve anything.
        return emit(await app.controller.adaptationDecide({
          target: ids[0],
          decision: sub === 'approve' ? 'approved' : 'rejected',
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'guide') {
        const { flags, rest: ids } = parseFlags(rest, ['order', 'avoid', 'prefer', 'max-steps', 'reason']);
        if (ids.length !== 1) {
          err('usage: adaptation guide <adaptation-id> (--order reads_first|writes_first | --avoid a,b | --prefer a,b | --max-steps N) [--reason <text>]');
          return 2;
        }
        const list = (value) => (value === undefined ? [] : String(value).split(',').map((n) => n.trim()).filter((n) => n.length > 0));
        return emit(await app.controller.adaptationGuide({
          target: ids[0],
          order: flags.order ?? null,
          avoid: list(flags.avoid),
          prefer: list(flags.prefer),
          maxSteps: flags['max-steps'] === undefined ? null : flags['max-steps'],
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'retire') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) {
          err('usage: adaptation retire <adaptation-id> [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.adaptationRetire({ target: ids[0], reason: flags.reason ?? null }));
      }
      err('usage: adaptation derive|eligibility|effectiveness|list|approve|reject|guide|retire|reviews|review');
      return 2;
    }

    if (command === 'learning') {
      const [sub, ...rest] = args;
      if (sub === 'observe') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: learning observe <plan-id>');
          return 2;
        }
        return emit(await app.controller.learningObserve({ plan: ids[0] }));
      }
      if (sub === 'patterns') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'min-observations', 'limit']);
        rejectUnexpected(extra, 'learning patterns [--capability <name>] [--min-observations N] [--limit N]');
        return emit(await app.controller.learningPatterns({
          capability: flags.capability ?? null,
          minObservations: flags['min-observations'],
          limit: flags.limit,
        }));
      }
      if (sub === 'propose') {
        const { flags, rest: extra } = parseFlags(rest, ['min-observations']);
        rejectUnexpected(extra, 'learning propose [--min-observations N]');
        return emit(await app.controller.learningPropose({ minObservations: flags['min-observations'] }));
      }
      if (sub === 'measure') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: learning measure <adaptation-id>');
          return 2;
        }
        return emit(await app.controller.learningMeasure({ target: ids[0] }));
      }
      if (sub === 'rollback') {
        const { flags, rest: ids } = parseFlags(rest, ['measurement', 'reason']);
        if (ids.length !== 1) {
          err('usage: learning rollback <adaptation-id> [--measurement <id>] [--reason <text>]');
          return 2;
        }
        return emit(await app.controller.learningRollback({
          target: ids[0],
          measurement: flags.measurement ?? null,
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'status') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'learning status [--limit N]');
        return emit(await app.controller.learningStatus({ limit: flags.limit }));
      }
      err('usage: learning observe|patterns|propose|measure|rollback|status');
      return 2;
    }

    if (command === 'situation') {
      const [sub, ...rest] = args;
      const ingestUsage = 'situation ingest --source <apex|user|test_provider|external_provider> --source-id <id> --type <text> --category <task|plan|goal|memory|knowledge|prediction|adaptation|observation|external|system> [--payload <json>] [--confidence 0-1] [--entity <id[,id]>] [--goal <id[,id]>] [--plan <id[,id]>] [--task <id[,id]>] [--observed-at <iso>] [--valid-until <iso>] [--operation-id <id>] [--reporter <text>]';
      if (sub === 'ingest') {
        const { flags, rest: extra } = parseFlags(rest, [
          'source', 'source-id', 'type', 'category', 'observed-at', 'payload', 'confidence',
          'entity', 'goal', 'plan', 'task', 'valid-until', 'operation-id', 'reporter',
        ]);
        rejectUnexpected(extra, ingestUsage);
        if (!flags.source || !flags['source-id'] || !flags.type || !flags.category) {
          err(`usage: ${ingestUsage}`);
          return 2;
        }
        let payload = {};
        if (flags.payload !== undefined) {
          try {
            payload = JSON.parse(flags.payload);
          } catch {
            err('--payload must be JSON');
            return 2;
          }
        }
        const list = (value) => (value === undefined ? [] : String(value).split(',').map((v) => v.trim()).filter(Boolean));
        return emit(await app.controller.situationIngest({
          source: flags.source,
          sourceEventId: flags['source-id'],
          type: flags.type,
          category: flags.category,
          observedAt: flags['observed-at'] ?? null,
          payload,
          confidence: flags.confidence === undefined ? null : Number(flags.confidence),
          entityRefs: list(flags.entity),
          goalRefs: list(flags.goal),
          planRefs: list(flags.plan),
          taskRefs: list(flags.task),
          validUntil: flags['valid-until'] ?? null,
          operationId: flags['operation-id'] ?? null,
          reporter: flags.reporter ?? null,
        }));
      }
      if (sub === 'evaluate') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err('usage: situation evaluate <event-id>');
          return 2;
        }
        return emit(await app.controller.situationEvaluate({ event: ids[0] }));
      }
      if (sub === 'decide') {
        const { flags, rest: ids } = parseFlags(rest, ['response', 'action', 'input', 'reason']);
        if (ids.length !== 1 || !flags.response || !flags.reason) {
          err('usage: situation decide <event-id> --response <ignore|record|investigate|notify|recommend|request_approval|execute> --reason <text> [--action <name> --input <json>]');
          return 2;
        }
        let input = null;
        if (flags.input !== undefined) {
          try {
            input = JSON.parse(flags.input);
          } catch {
            err('--input must be JSON');
            return 2;
          }
        }
        return emit(await app.controller.situationDecide({
          event: ids[0],
          response: flags.response,
          action: flags.action ?? null,
          input,
          reason: flags.reason,
        }));
      }
      if (sub === 'execute') {
        const { flags, rest: ids } = parseFlags(rest, ['input']);
        if (ids.length !== 1 || flags.input === undefined) {
          err('usage: situation execute <decision-id> --input <json> (the same input the decision approved)');
          return 2;
        }
        let input;
        try {
          input = JSON.parse(flags.input);
        } catch {
          err('--input must be JSON');
          return 2;
        }
        return emit(await app.controller.situationExecute({ decision: ids[0], input }));
      }
      if (sub === 'state') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'situation state [--limit N]');
        return emit(await app.controller.situationState({ limit: flags.limit }));
      }
      if (sub === 'events') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'situation events [--limit N]');
        return emit(await app.controller.situationEvents({ limit: flags.limit }));
      }
      if (sub === 'decisions') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'event']);
        rejectUnexpected(extra, 'situation decisions [--limit N] [--event <id>]');
        return emit(await app.controller.situationDecisions({ limit: flags.limit, event: flags.event ?? null }));
      }
      if (sub === 'status') {
        const { rest: extra } = parseFlags(rest, []);
        rejectUnexpected(extra, 'situation status');
        return emit(await app.controller.situationStatus());
      }
      err('usage: situation ingest|evaluate|decide|execute|state|events|decisions|status');
      return 2;
    }

    if (command === 'runtime') {
      return runRuntimeCommand({ app, args, out, err, parseFlags, rejectUnexpected });
    }

    if (command === 'source') {
      return runIntegrationCommand({ app, args, out, err, parseFlags, rejectUnexpected });
    }

    if (command === 'evidence') {
      const [sub, ...rest] = args;
      if (sub === 'integrity') {
        const { rest: extra } = parseFlags(rest, []);
        rejectUnexpected(extra, 'evidence integrity');
        return emit(await app.controller.evidenceIntegrity());
      }
      err('usage: evidence integrity');
      return 2;
    }

    if (command === 'prediction') {
      const [sub, ...rest] = args;
      const recordUsage = 'prediction record --capability <name> --expect <kind> --subject <text> (--expires <iso> | --in-days N) [--supports <id[,id...]>] [--contradicts <id[,id...]>] [--feedback <id[,id...]>] [--pattern <kind[,kind...]>] [--replaces <id[,id...]>]';
      if (sub === 'record') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'expect', 'subject', 'expires', 'in-days', 'supports', 'contradicts', 'feedback', 'pattern', 'replaces']);
        rejectUnexpected(extra, recordUsage);
        if (!flags.capability || !flags.expect || !flags.subject) {
          err(`usage: ${recordUsage}`);
          return 2;
        }
        // One horizon, stated here rather than left to the action, because the two spellings are a
        // question of what to type: the ledger stores an instant, while "in 30 days" is what the
        // user means. Accepting both and preferring one would quietly record a bound that was not
        // the one asked for.
        if (flags.expires !== undefined && flags['in-days'] !== undefined) {
          err('usage: give the horizon either as --expires or as --in-days, not both');
          return 2;
        }
        if (flags.expires === undefined && flags['in-days'] === undefined) {
          err('usage: prediction record needs a horizon: --expires <iso> or --in-days N');
          return 2;
        }
        return emit(await app.controller.predictionRecord({
          capability: flags.capability,
          expectation: flags.expect,
          subject: flags.subject,
          expiresAt: flags.expires,
          inDays: flags['in-days'],
          evidence: {
            supportingExperienceIds: idList(flags.supports),
            contradictingExperienceIds: idList(flags.contradicts),
            feedbackIds: idList(flags.feedback),
            patternKinds: idList(flags.pattern),
          },
          replaces: idList(flags.replaces),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'capability', 'status']);
        rejectUnexpected(extra, 'prediction list [--limit N] [--capability <name>] [--status <name>]');
        return emit(await app.controller.predictionList({
          limit: flags.limit,
          capability: flags.capability,
          status: flags.status,
        }));
      }
      if (sub === 'show' || sub === 'history' || sub === 'evaluate') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) {
          err(`usage: prediction ${sub} <prediction-id>`);
          return 2;
        }
        // "evaluate" is the only one of these three that writes, and it writes a verdict the ledger
        // computes from recorded outcomes; the command supplies a reference and nothing else.
        const method = sub === 'show' ? 'predictionShow' : sub === 'history' ? 'predictionHistory' : 'predictionEvaluate';
        return emit(await app.controller[method]({ target: ids[0] }));
      }
      if (sub === 'invalidate') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        // The reason is part of the withdrawal, not a comment on it: the ledger keeps it with the
        // record so a later reader knows why the expectation was withdrawn. The store refuses an
        // absent reason, and a usage refusal costs no operation record.
        if (ids.length !== 1 || !flags.reason) {
          err('usage: prediction invalidate <prediction-id> --reason <text>');
          return 2;
        }
        return emit(await app.controller.predictionInvalidate({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'summary') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'limit']);
        rejectUnexpected(extra, 'prediction summary [--capability <name>] [--limit N]');
        return emit(await app.controller.predictionSummary({ capability: flags.capability, limit: flags.limit }));
      }
      if (sub === 'longitudinal') {
        const { flags, rest: extra } = parseFlags(rest, ['capability', 'limit']);
        rejectUnexpected(extra, 'prediction longitudinal [--capability <name>] [--limit N]');
        return emit(await app.controller.predictionLongitudinal({ capability: flags.capability, limit: flags.limit }));
      }
      if (sub === 'health') {
        rejectUnexpected(parseFlags(rest, []).rest, 'prediction health');
        // A direct, unaudited read, like `experience health`: exit 0 only when the ledger was fully
        // inspected and every withdrawal and verdict names a prediction that is in the log.
        const res = await app.controller.predictionHealth();
        out(res.display ?? res.output ?? '(none)');
        return res.health?.attention ? 1 : 0;
      }
      err('usage: prediction record|list|show|history|evaluate|invalidate|summary|longitudinal|health');
      return 2;
    }

    if (command === 'audit') {
      const [sub, ...rest] = args;
      if (sub !== 'health') {
        err('usage: audit health');
        return 2;
      }
      rejectUnexpected(parseFlags(rest, []).rest, 'audit health');
      // A direct, unaudited read. Exit 0 only when the log was fully inspected and
      // nothing requires attention; damage or an unreadable log exits 1.
      const res = await app.controller.auditHealth();
      out(res.display ?? res.output ?? '(none)');
      return res.health?.attention ? 1 : 0;
    }

    if (command === 'queue') {
      const { flags, rest } = parseFlags(args, ['limit']);
      rejectUnexpected(rest, 'queue [--limit N]');
      return await showQueue({ app, limit: flags.limit ?? 20, out, err });
    }

    if (command === 'repair') {
      const [sub, ...rest] = args;
      if (sub !== 'locks') {
        err('usage: repair locks');
        return 2;
      }
      rejectUnexpected(parseFlags(rest, []).rest, 'repair locks');
      return await repairLocks({ app, out, err });
    }

    if (command === 'ask') {
      const { flags, rest } = parseFlags(args, ['save-answer']);
      const text = rest.join(' ');
      if (text.trim() === '') {
        err('usage: ask [--save-answer] <request>');
        return 2;
      }
      const res = await app.controller.handle(text, {
        origin: 'user',
        saveAnswer: Boolean(flags['save-answer']),
        onProgress: stderr.isTTY ? modelWaiting(err) : null,
      });
      out(formatResult(res));
      const session = sessionNotice(res);
      if (session) err(session);
      return exitCodeFor(res);
    }

    if (command === 'chat') {
      rejectUnexpected(parseFlags(args, []).rest, 'chat');
      return await runChat({ app, stdin, stdout, stderr, out });
    }

    if (command === 'history') {
      const { flags, rest } = parseFlags(args, ['limit', 'at', 'json']);
      if (flags.at !== undefined) {
        // A cutoff reconstruction across the stores that can answer one. It runs as an audited,
        // verified read; the plain listing below stays an unaudited direct read of the audit log.
        rejectUnexpected(rest, 'history --at <iso> [--limit N]');
        const res = await app.controller.historyReconstruct({ at: flags.at, limit: flags.limit });
        return emitRead(res, flags);
      }
      // The listing is a fixed line format, not a structured answer: accepting `--json` and
      // printing text would claim a form the command does not have.
      if (flags.json !== undefined) throw new ValidationError('usage: history --at <iso> [--limit N] --json', 'USAGE');
      rejectUnexpected(rest, 'history [--limit N]');
      let listed;
      try {
        listed = await app.operations.list({ limit: flags.limit ?? 10 });
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        err(`Audit: unavailable (${errorText(e)})`);
        err('No operation records could be read. This does not establish that any operation did not run. Run "node bin/apex.js diagnose" for a read-only view of what is readable; do not repeat an action merely because its record cannot be listed.');
        return 1;
      }
      const { records, corrupt } = listed;
      if (records.length === 0) out('No operations recorded yet.');
      for (const op of records) {
        // A record written before the audit mask existed can still hold a credential, so the
        // reader redacts what it prints. Nothing on disk is rewritten.
        out(`${op.requestedAt}  ${op.id}  ${op.status}  ${op.capability}  ${redactSecrets(String(op.request ?? ''))}`);
      }
      if (corrupt) {
        out(`(${corrupt} corrupt audit line(s) skipped)`);
        out(`Audit: ${corrupt} record(s) cannot be read, so this list is incomplete. A missing record does not prove an action did not execute; run "node bin/apex.js diagnose" before repeating anything.`);
      }
      return 0;
    }

    if (command === 'world') {
      // Bare `world` keeps its original meaning: the read-only projection of stored beliefs,
      // contradictions, decisions, and unknowns. Everything after a subcommand records or reads
      // the separately stored World Model; neither route writes to memory, knowledge, or experience.
      if (args.length === 0 || String(args[0]).startsWith('-')) {
        const { flags, rest } = parseFlags(args, ['limit']);
        rejectUnexpected(rest, 'world [--limit N]');
        if (flags.limit !== undefined && (flags.limit < 1 || flags.limit > MAX_WORLD_LIMIT)) {
          err(`usage: world [--limit N]  (N is 1-${MAX_WORLD_LIMIT})`);
          return 2;
        }
        // A direct, unaudited read, like `memory health`: it writes nothing.
        const res = await app.controller.worldState({ limit: flags.limit });
        out(res.display);
        return res.world?.attention ? 1 : 0;
      }

      const [sub, ...rest] = args;
      const request = `world ${sub}`;
      const read = async (action, input) => emit(await app.controller.worldRead(action, input, request));
      const write = async (action, input) => emit(await app.controller.worldWrite(action, input, request));

      if (sub === 'entity') {
        const [verb, ...tail] = rest;
        if (verb === 'add') {
          const { flags, rest: words } = parseFlags(tail, [
            'category', 'name', 'alias', 'description', 'external', 'observed-at',
            'evidence', 'evidence-relation',
          ], ['evidence']);
          const spoken = worldQuote(words);
          if (spoken !== '' && flags.name !== undefined) {
            throw new ValidationError('usage: world entity add gives the name once, positionally or with --name', 'USAGE');
          }
          const name = flags.name ?? spoken;
          if (!name) throw new ValidationError('usage: world entity add --category <category> <name>', 'USAGE');
          if (!flags.category) throw new ValidationError('usage: world entity add needs --category', 'USAGE');
          return await write('world.entity.add', {
            category: flags.category,
            name,
            aliases: flags.alias ?? [],
            description: flags.description ?? null,
            externalIds: worldExternal(flags.external),
            observedAt: flags['observed-at'] ?? null,
            evidence: worldEvidence(flags),
          });
        }
        if (verb === 'list') {
          const { flags, rest: extra } = parseFlags(tail, ['limit', 'include-merged', 'include-retired']);
          rejectUnexpected(extra, 'world entity list [--limit N] [--include-merged] [--include-retired]');
          return await read('world.entity.list', {
            limit: flags.limit ?? 20,
            includeMerged: Boolean(flags['include-merged']),
            includeRetired: Boolean(flags['include-retired']),
          });
        }
        if (verb === 'show') {
          const { flags, rest: refs } = parseFlags(tail, [
            'as-of', 'at', 'limit', 'current-only', 'include-retracted', 'include-superseded',
          ]);
          if (refs.length !== 1) throw new ValidationError('usage: world entity show <entity> [--as-of <iso>]', 'USAGE');
          return await read('world.entity.show', {
            target: refs[0],
            asOf: flags['as-of'] ?? null,
            at: flags.at ?? null,
            currentOnly: Boolean(flags['current-only']),
            includeRetracted: Boolean(flags['include-retracted']),
            includeSuperseded: Boolean(flags['include-superseded']),
            limit: flags.limit ?? null,
          });
        }
        if (verb === 'find') {
          const { rest: words } = parseFlags(tail, []);
          const text = worldQuote(words);
          if (text === '') throw new ValidationError('usage: world entity find <name or alias>', 'USAGE');
          return await read('world.entity.find', { text });
        }
        if (verb === 'alias') {
          const { flags, rest: refs } = parseFlags(tail, ['alias', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 1 || !flags.alias) {
            throw new ValidationError('usage: world entity alias <entity> --alias <another name>', 'USAGE');
          }
          return await write('world.entity.alias', {
            target: refs[0],
            alias: flags.alias,
            evidence: worldEvidence(flags),
          });
        }
        if (verb === 'retire') {
          const { flags, rest: refs } = parseFlags(tail, ['reason', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 1 || !flags.reason) {
            throw new ValidationError('usage: world entity retire <entity> --reason <text>', 'USAGE');
          }
          return await write('world.entity.retire', {
            target: refs[0], reason: flags.reason, evidence: worldEvidence(flags),
          });
        }
        if (verb === 'merge') {
          const { flags, rest: refs } = parseFlags(tail, ['reason', 'merge', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 2 || !flags.reason) {
            throw new ValidationError('usage: world entity merge <source> <survivor> --reason <text>', 'USAGE');
          }
          return await write('world.entity.merge', {
            from: refs[0], to: refs[1], reason: flags.reason, mergeId: flags.merge ?? null, evidence: worldEvidence(flags),
          });
        }
        if (verb === 'unmerge') {
          const { flags, rest: refs } = parseFlags(tail, ['reason', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 1 || !flags.reason) {
            throw new ValidationError('usage: world entity unmerge <merge-id> --reason <text>', 'USAGE');
          }
          return await write('world.entity.unmerge', {
            merge: refs[0], reason: flags.reason, evidence: worldEvidence(flags),
          });
        }
        if (verb === 'candidates') {
          const { flags, rest: refs } = parseFlags(tail, ['limit', 'include-rejected']);
          if (refs.length !== 1) throw new ValidationError('usage: world entity candidates <entity> [--limit N] [--include-rejected]', 'USAGE');
          return await read('world.identity.candidates', {
            target: refs[0], limit: flags.limit ?? 20, includeRejected: Boolean(flags['include-rejected']),
          });
        }
        if (verb === 'pair') {
          const { rest: refs } = parseFlags(tail, []);
          if (refs.length !== 2) throw new ValidationError('usage: world entity pair <left> <right>', 'USAGE');
          return await read('world.pair', { left: refs[0], right: refs[1] });
        }
        if (verb === 'decision') {
          const { rest: refs } = parseFlags(tail, []);
          if (refs.length !== 2) throw new ValidationError('usage: world entity decision <left> <right>', 'USAGE');
          return await read('world.identity.decision', { left: refs[0], right: refs[1] });
        }
        if (verb === 'decide') {
          const { flags, rest: refs } = parseFlags(tail, ['decision', 'reason', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 2 || !flags.decision || !flags.reason) {
            throw new ValidationError('usage: world entity decide <left> <right> --decision confirmed|rejected --reason <text>', 'USAGE');
          }
          return await write('world.identity.decide', {
            left: refs[0], right: refs[1], decision: flags.decision, reason: flags.reason, evidence: worldEvidence(flags),
          });
        }
        throw new ValidationError('usage: world entity add|list|show|find|alias|retire|merge|unmerge|candidates|pair|decision|decide', 'USAGE');
      }

      if (sub === 'identity') {
        const [verb, ...tail] = rest;
        if (verb === 'candidates') {
          const { flags, rest: refs } = parseFlags(tail, ['limit', 'include-rejected']);
          if (refs.length !== 1) throw new ValidationError('usage: world identity candidates <entity>', 'USAGE');
          return await read('world.identity.candidates', {
            target: refs[0], limit: flags.limit ?? 20, includeRejected: Boolean(flags['include-rejected']),
          });
        }
        if (verb === 'pair') {
          const { rest: refs } = parseFlags(tail, []);
          if (refs.length !== 2) throw new ValidationError('usage: world identity pair <left> <right>', 'USAGE');
          return await read('world.pair', { left: refs[0], right: refs[1] });
        }
        if (verb === 'decision') {
          const { rest: refs } = parseFlags(tail, []);
          if (refs.length !== 2) throw new ValidationError('usage: world identity decision <left> <right>', 'USAGE');
          return await read('world.identity.decision', { left: refs[0], right: refs[1] });
        }
        if (verb === 'decide' || verb === 'confirm' || verb === 'reject') {
          const { flags, rest: refs } = parseFlags(tail, ['decision', 'reason', 'evidence', 'evidence-relation'], ['evidence']);
          if (refs.length !== 2 || !flags.reason) {
            throw new ValidationError(`usage: world identity ${verb} <left> <right> --reason <text>`, 'USAGE');
          }
          const decision = verb === 'decide' ? flags.decision : (verb === 'confirm' ? 'confirmed' : 'rejected');
          if (verb === 'decide' && !decision) {
            throw new ValidationError('usage: world identity decide <left> <right> --decision confirmed|rejected --reason <text>', 'USAGE');
          }
          return await write('world.identity.decide', {
            left: refs[0], right: refs[1], decision, reason: flags.reason, evidence: worldEvidence(flags),
          });
        }
        throw new ValidationError('usage: world identity candidates|pair|decision|decide|confirm|reject', 'USAGE');
      }

      if (sub === 'fact') {
        const [verb, ...tail] = rest;
        if (verb === 'add') {
          const { flags, rest: extra } = parseFlags(tail, [
            'subject', 'predicate', 'object-entity', 'object-value', 'value-type', 'unit', 'language',
            'valid-from', 'valid-until', 'observed-at', 'confidence', 'confidence-basis', 'supersedes',
            'evidence', 'evidence-relation',
          ], ['evidence']);
          rejectUnexpected(extra, 'world fact add --subject <entity> --predicate <name> (--object-entity <entity> | --object-value <value>)');
          if (!flags.subject || !flags.predicate) {
            throw new ValidationError('usage: world fact add --subject <entity> --predicate <name> (--object-entity <entity> | --object-value <value>)', 'USAGE');
          }
          return await write('world.fact.add', {
            subject: flags.subject,
            predicate: flags.predicate,
            object: worldObject(flags),
            validFrom: flags['valid-from'] ?? null,
            validUntil: flags['valid-until'] ?? null,
            observedAt: flags['observed-at'] ?? null,
            confidence: worldConfidence(flags),
            supersedes: idList(flags.supersedes),
            evidence: worldEvidence(flags),
          });
        }
        if (verb === 'list') {
          const { flags, rest: refs } = parseFlags(tail, [
            'as-of', 'at', 'limit', 'current-only', 'include-retracted', 'include-superseded',
          ]);
          if (refs.length !== 1) throw new ValidationError('usage: world fact list <entity>', 'USAGE');
          return await read('world.facts', {
            target: refs[0],
            asOf: flags['as-of'] ?? null,
            at: flags.at ?? null,
            currentOnly: Boolean(flags['current-only']),
            includeRetracted: Boolean(flags['include-retracted']),
            includeSuperseded: Boolean(flags['include-superseded']),
            limit: flags.limit ?? null,
          });
        }
        throw new ValidationError('usage: world fact add|list', 'USAGE');
      }

      if (sub === 'attribute' || sub === 'attributes') {
        const verb = sub === 'attribute' ? rest[0] : 'list';
        const tail = sub === 'attribute' ? rest.slice(1) : rest;
        if (verb !== 'list') throw new ValidationError('usage: world attribute list <entity>', 'USAGE');
        const { flags, rest: refs } = parseFlags(tail, ['as-of', 'at']);
        if (refs.length !== 1) throw new ValidationError('usage: world attribute list <entity>', 'USAGE');
        return await read('world.attributes', {
          target: refs[0], asOf: flags['as-of'] ?? null, at: flags.at ?? null,
        });
      }

      if (sub === 'relationship') {
        const [verb, ...tail] = rest;
        if (verb === 'add') {
          const { flags, rest: extra } = parseFlags(tail, [
            'subject', 'type', 'relation', 'object', 'direction', 'property',
            'valid-from', 'valid-until', 'observed-at', 'supersedes', 'evidence', 'evidence-relation',
          ], ['evidence']);
          rejectUnexpected(extra, 'world relationship add --subject <entity> --type <type> --object <entity>');
          const relation = flags.type ?? flags.relation;
          if (!flags.subject || !relation || !flags.object) {
            throw new ValidationError('usage: world relationship add --subject <entity> --type <type> --object <entity>', 'USAGE');
          }
          return await write('world.relationship.add', {
            subject: flags.subject,
            relation,
            object: flags.object,
            directionality: flags.direction ?? null,
            properties: worldProperties(flags.property),
            validFrom: flags['valid-from'] ?? null,
            validUntil: flags['valid-until'] ?? null,
            observedAt: flags['observed-at'] ?? null,
            supersedes: idList(flags.supersedes),
            evidence: worldEvidence(flags),
          });
        }
        if (verb === 'list') {
          const { flags, rest: refs } = parseFlags(tail, [
            'type', 'direction', 'as-of', 'at', 'limit', 'current-only', 'include-retracted', 'include-superseded',
          ]);
          if (refs.length !== 1) throw new ValidationError('usage: world relationship list <entity>', 'USAGE');
          return await read('world.relationships', {
            target: refs[0],
            direction: flags.direction ?? 'both',
            predicate: flags.type ?? null,
            asOf: flags['as-of'] ?? null,
            at: flags.at ?? null,
            currentOnly: Boolean(flags['current-only']),
            includeRetracted: Boolean(flags['include-retracted']),
            includeSuperseded: Boolean(flags['include-superseded']),
            limit: flags.limit ?? null,
          });
        }
        throw new ValidationError('usage: world relationship add|list', 'USAGE');
      }

      if (sub === 'event') {
        const [verb, ...tail] = rest;
        if (verb === 'add') {
          const { flags, rest: extra } = parseFlags(tail, [
            'type', 'participant', 'affected', 'occurred-at', 'observed-at', 'property',
            'evidence', 'evidence-relation',
          ], ['evidence']);
          rejectUnexpected(extra, 'world event add --type <event-type> --participant <entity>');
          if (!flags.type || !(flags.participant ?? []).length) {
            throw new ValidationError('usage: world event add --type <event-type> --participant <entity>', 'USAGE');
          }
          return await write('world.event.add', {
            eventType: flags.type,
            participants: flags.participant,
            affected: flags.affected ?? [],
            occurredAt: flags['occurred-at'] ?? null,
            observedAt: flags['observed-at'] ?? null,
            properties: worldProperties(flags.property),
            evidence: worldEvidence(flags),
          });
        }
        if (verb === 'list') {
          const { flags, rest: refs } = parseFlags(tail, ['at', 'limit', 'include-retracted', 'include-superseded']);
          if (refs.length !== 1) throw new ValidationError('usage: world event list <entity>', 'USAGE');
          return await read('world.events', {
            target: refs[0],
            at: flags.at ?? null,
            includeRetracted: Boolean(flags['include-retracted']),
            includeSuperseded: Boolean(flags['include-superseded']),
            limit: flags.limit ?? null,
          });
        }
        throw new ValidationError('usage: world event add|list', 'USAGE');
      }

      if (sub === 'statement') {
        const [verb, ...tail] = rest;
        if (verb === 'retract' || verb === 'supersede') {
          const { flags, rest: refs } = parseFlags(tail, [
            'target-type', 'by', 'reason', 'evidence', 'evidence-relation',
          ], ['evidence']);
          if (refs.length !== 1 || !flags['target-type'] || !flags.reason) {
            throw new ValidationError(`usage: world statement ${verb} <id> --target-type fact|relationship|event --reason <text>`, 'USAGE');
          }
          const input = {
            targetType: flags['target-type'], target: refs[0], reason: flags.reason, evidence: worldEvidence(flags),
          };
          if (verb === 'retract') return await write('world.statement.retract', input);
          if (!flags.by) {
            throw new ValidationError('usage: world statement supersede <id> --target-type <kind> --by <replacement-id> --reason <text>', 'USAGE');
          }
          return await write('world.statement.supersede', { ...input, by: flags.by });
        }
        if (verb === 'history') {
          const { flags, rest: refs } = parseFlags(tail, ['target-type']);
          if (refs.length !== 1 || !flags['target-type']) {
            throw new ValidationError('usage: world statement history <id> --target-type fact|relationship|event', 'USAGE');
          }
          return await read('world.statement.history', { targetType: flags['target-type'], target: refs[0] });
        }
        throw new ValidationError('usage: world statement retract|supersede|history', 'USAGE');
      }

      if (sub === 'conflicts') {
        const { flags, rest: refs } = parseFlags(rest, ['at']);
        if (refs.length > 1) throw new ValidationError('usage: world conflicts [<entity>] [--at <iso>]', 'USAGE');
        return await read('world.conflicts', { target: refs[0] ?? null, at: flags.at ?? null });
      }

      if (sub === 'related') {
        const { flags, rest: refs } = parseFlags(rest, ['depth', 'limit', 'as-of', 'type']);
        if (refs.length !== 1) throw new ValidationError('usage: world related <entity> [--depth N] [--limit N]', 'USAGE');
        return await read('world.related', {
          target: refs[0],
          depth: flags.depth ?? 1,
          limit: flags.limit ?? 20,
          asOf: flags['as-of'] ?? null,
          predicate: flags.type ?? null,
        });
      }

      if (sub === 'history') {
        const { rest: refs } = parseFlags(rest, []);
        if (refs.length !== 1) throw new ValidationError('usage: world history <entity>', 'USAGE');
        return await read('world.history', { target: refs[0] });
      }

      if (sub === 'trace') {
        const { flags, rest: refs } = parseFlags(rest, ['at', 'limit']);
        if (refs.length !== 2) {
          throw new ValidationError('usage: world trace <memory|knowledge|fact|relationship|event> <id> [--at <iso historical cutoff>] [--limit N]', 'USAGE');
        }
        return await read('world.belief.trace', {
          targetType: refs[0],
          target: refs[1],
          at: flags.at ?? null,
          limit: flags.limit ?? null,
        });
      }

      if (sub === 'evidence') {
        const { flags, rest: refs } = parseFlags(rest, ['target-type']);
        if (flags['target-type']) {
          if (refs.length !== 1) throw new ValidationError('usage: world evidence <id> --target-type fact|relationship|event', 'USAGE');
          return await read('world.evidence', { targetType: flags['target-type'], targetId: refs[0] });
        }
        if (refs.length !== 1) throw new ValidationError('usage: world evidence <entity>', 'USAGE');
        return await read('world.evidence', { target: refs[0] });
      }

      if (sub === 'changes') {
        const { flags, rest: extra } = parseFlags(rest, ['from', 'to']);
        rejectUnexpected(extra, 'world changes --from <iso> --to <iso>');
        if (!flags.from || !flags.to) throw new ValidationError('usage: world changes --from <iso> --to <iso>', 'USAGE');
        return await read('world.changes', { from: flags.from, to: flags.to });
      }

      if (sub === 'state-at' || sub === 'state') {
        const { flags, rest: extra } = parseFlags(rest, ['at']);
        if (extra.length > 1) throw new ValidationError('usage: world state-at --at <iso>', 'USAGE');
        const at = flags.at ?? extra[0];
        if (!at) throw new ValidationError('usage: world state-at --at <iso>', 'USAGE');
        return await read('world.state_at', { at });
      }

      if (sub === 'inspect') {
        rejectUnexpected(parseFlags(rest, []).rest, 'world inspect');
        const res = await app.controller.worldRead('world.inspect', {}, 'world inspect');
        out(res.display ?? res.output ?? '(none)');
        if (res.recorded === false) err('Audit: NOT RECORDED');
        else if (res.operation) out(`Audit: recorded in operations.jsonl (${res.operation.id})`);
        const data = res.operation?.steps?.at(-1)?.result?.data ?? {};
        return data.complete === true ? 0 : 1;
      }

      if (sub === 'health' || sub === 'status') {
        rejectUnexpected(parseFlags(rest, []).rest, `world ${sub}`);
        const res = await app.controller.worldRead('world.status', {}, `world ${sub}`);
        out(res.display ?? res.output ?? '(none)');
        if (res.recorded === false) err('Audit: NOT RECORDED');
        else if (res.operation) out(`Audit: recorded in operations.jsonl (${res.operation.id})`);
        const data = res.operation?.steps?.at(-1)?.result?.data ?? {};
        return data.available === true && data.complete === true ? 0 : 1;
      }

      if (sub === 'lock') {
        rejectUnexpected(parseFlags(rest, []).rest, 'world lock');
        const report = await app.worldModel.lockReport();
        if (!report.present) {
          out('World model lock: no lock file (no write is in progress)');
          return 0;
        }
        out(`World model lock: ${holderText(report)}; takeover tokens ${report.tokens.total} recorded (${report.tokens.current} for this claim: ${report.tokens.dead} dead, ${report.tokens.live} live, ${report.tokens.unknown} unidentified)`);
        out('This view is read-only; it never waits for or takes the lock.');
        return 0;
      }

      throw new ValidationError('usage: world [--limit N] | world entity|identity|fact|attribute|relationship|event|statement|conflicts|related|history|evidence|trace|changes|state-at|inspect|health|lock ...', 'USAGE');
    }

    if (command === 'goal') {
      const [sub, ...rest] = args;
      if (sub === 'add') {
        const { flags, rest: words } = parseFlags(rest, ['criterion', 'priority', 'deadline', 'depends-on']);
        const request = words.join(' ').trim();
        if (request === '') {
          err('usage: goal add [--criterion <text>]... [--priority N] [--deadline <iso>] [--depends-on <id>]... <request>');
          return 2;
        }
        if ((flags.criterion ?? []).length === 0) {
          err('usage: goal add needs at least one --criterion; a goal without success criteria cannot be completed');
          return 2;
        }
        return emit(await app.controller.goalAdd({
          request,
          criteria: flags.criterion,
          priority: flags.priority ?? 3,
          deadline: flags.deadline ?? null,
          dependsOn: flags['depends-on'] ?? [],
        }));
      }
      if (sub === 'revise') {
        const { flags, rest: ids } = parseFlags(rest, ['request', 'criterion', 'priority', 'deadline', 'reason']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal revise <id> --criterion <text>... --reason <text> [--request <text>] [--priority N] [--deadline <iso>]', 'USAGE');
        }
        if ((flags.criterion ?? []).length === 0) {
          throw new ValidationError('goal revise needs at least one --criterion; a goal without success criteria cannot be completed', 'USAGE');
        }
        if (!flags.reason) throw new ValidationError('goal revise needs --reason <text>', 'USAGE');
        return emit(await app.controller.goalRevise({
          target: ids[0],
          request: flags.request ?? undefined,
          criteria: flags.criterion,
          priority: flags.priority,
          deadline: flags.deadline,
          reason: flags.reason,
        }));
      }
      if (sub === 'confirm') {
        const { flags, rest: ids } = parseFlags(rest, ['criterion', 'decision', 'reason', 'operation']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal confirm <id> --criterion <c1> --decision required|suggested|declined --reason <text> [--operation <audit-id>]', 'USAGE');
        }
        if ((flags.criterion ?? []).length !== 1) {
          throw new ValidationError('usage: goal confirm needs exactly one --criterion, such as c1', 'USAGE');
        }
        if (!flags.decision) {
          throw new ValidationError('goal confirm needs --decision required, --decision suggested, or --decision declined', 'USAGE');
        }
        if (!flags.reason) throw new ValidationError('goal confirm needs --reason <text>; a decision that cannot say why cannot be checked later', 'USAGE');
        return emit(await app.controller.goalConfirm({
          target: ids[0],
          criterion: flags.criterion[0],
          decision: flags.decision,
          reason: flags.reason,
          operationId: flags.operation ?? null,
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'goal list [--limit N]');
        out(await app.controller.listGoals({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: goal show <id>', 'USAGE');
        out((await app.controller.showGoal(ids[0])).display);
        return 0;
      }
      if (sub === 'assess') {
        // A read with no operation record, like `goal show` and `plan validate`: it re-opens the
        // audit and knowledge records the goal cites and writes nothing. Non-zero when what the
        // goal claims about its own evidence no longer holds or could not be checked.
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: goal assess <id>', 'USAGE');
        const res = await app.controller.assessStoredGoal(ids[0]);
        out(res.display);
        return res.assessment.ok ? 0 : 1;
      }
      if (sub === 'update') {
        const { flags, rest: words } = parseFlags(rest, ['reason', 'by']);
        if (words.length !== 2) {
          throw new ValidationError('usage: goal update <id> <status> [--reason <text>] [--by <goal-id>]', 'USAGE');
        }
        return emit(await app.controller.goalUpdate({
          target: words[0],
          status: words[1],
          reason: flags.reason ?? null,
          by: flags.by ?? null,
        }));
      }
      if (sub === 'evidence') {
        const { flags, rest: ids } = parseFlags(rest, ['criterion', 'kind', 'operation', 'detail', 'reopen']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal evidence <id> --criterion <c1> --kind supports|contradicts [--operation <audit-id>] [--detail <text>] [--reopen]', 'USAGE');
        }
        if ((flags.criterion ?? []).length !== 1) {
          throw new ValidationError('usage: goal evidence needs exactly one --criterion, such as c1', 'USAGE');
        }
        if (!flags.kind) {
          throw new ValidationError('usage: goal evidence needs --kind supports or --kind contradicts', 'USAGE');
        }
        return emit(await app.controller.goalEvidence({
          target: ids[0],
          criterion: flags.criterion[0],
          kind: flags.kind,
          operationId: flags.operation ?? null,
          detail: flags.detail ?? null,
          reopen: flags.reopen === true,
        }));
      }
      if (sub === 'complete') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) throw new ValidationError('usage: goal complete <id> [--reason <text>]', 'USAGE');
        return emit(await app.controller.goalComplete({
          target: ids[0],
          reason: flags.reason ?? null,
        }));
      }
      if (sub === 'link') {
        const { flags, rest: ids } = parseFlags(rest, ['plan', 'task', 'entity', 'world-event']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: goal link <id> (--plan <id> | --task <id> | --entity <id> | --world-event <id>)', 'USAGE');
        }
        return emit(await app.controller.goalLink({
          target: ids[0],
          planId: flags.plan ?? null,
          taskId: flags.task ?? null,
          entityId: flags.entity ?? null,
          worldEventId: flags['world-event'] ?? null,
        }));
      }
      err('usage: goal add|revise|confirm|list|show|assess|update|evidence|complete|link');
      return 2;
    }

    if (command === 'plan') {
      const [sub, ...rest] = args;
      // Steps and assertions are JSON objects, never a separator-joined string: a malformed
      // one is a usage error here rather than a plan the action silently misreads.
      const content = (flags, requireReason) => {
        if (!flags.outcome) throw new ValidationError('a plan needs --outcome <text>', 'USAGE');
        if ((flags.step ?? []).length === 0) throw new ValidationError('a plan needs at least one --step <json>', 'USAGE');
        if (requireReason && !flags.reason) throw new ValidationError('this plan change needs --reason <text>', 'USAGE');
        return {
          outcome: flags.outcome,
          steps: jsonObjects(flags.step, 'step'),
          preconditions: flags.precondition ?? [],
          assertions: jsonObjects(flags.assertion, 'assertion'),
          estimatedSeconds: flags.estimate ?? null,
          reason: flags.reason ?? null,
        };
      };
      if (sub === 'add') {
        const { flags, rest: extra } = parseFlags(rest, ['goal', 'outcome', 'step', 'precondition', 'assertion', 'estimate', 'reason']);
        rejectUnexpected(extra, 'plan add --outcome <text> --step <json>... [--goal <id>] [--precondition <text>]... [--assertion <json>]... [--estimate N] [--reason <text>]');
        return emit(await app.controller.planAdd({
          goalId: flags.goal ?? null,
          ...content(flags, false),
        }));
      }
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'plan list [--limit N]');
        out(await app.controller.listPlans({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan show <id>', 'USAGE');
        out((await app.controller.showPlan(ids[0])).display);
        return 0;
      }
      if (sub === 'validate') {
        // A read with no operation record, like `plan show`: it checks the stored plan against
        // the live registry and writes nothing.
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan validate <id>', 'USAGE');
        const res = await app.controller.validateStoredPlan(ids[0]);
        out(res.display);
        return res.validation.ok ? 0 : 1;
      }
      if (sub === 'history') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan history <id>', 'USAGE');
        out((await app.controller.planHistory(ids[0])).display);
        return 0;
      }
      if (sub === 'compare') {
        const { flags, rest: ids } = parseFlags(rest, ['from', 'to']);
        if (ids.length !== 1) throw new ValidationError('usage: plan compare <id> [--from N] [--to N]', 'USAGE');
        const res = await app.controller.planCompare(ids[0], { from: flags.from ?? null, to: flags.to ?? null });
        out(res.display);
        return res.diff.unchanged ? 0 : 1;
      }
      if (sub === 'outline') {
        // The read that answers a free-form objective before anything is recorded: typed parts, the
        // step each matched part becomes, the parts no capability can take, derived alternatives, and
        // the risks, uncertainty, revalidation and recovery the existing machinery states. Nothing is
        // written; recording the draft is `plan add` and approving it is the user's own decision.
        const { flags, rest: words } = parseFlags(rest, ['goal', 'cannot-use', 'json']);
        if (words.length !== 1) {
          throw new ValidationError('usage: plan outline "<objective>" [--goal <id>] [--cannot-use <action,action>] [--json]', 'USAGE');
        }
        return emitRead(await app.controller.planOutline({
          objective: words[0],
          goal: flags.goal ?? null,
          cannotUse: idList(flags['cannot-use']),
        }), flags);
      }
      if (sub === 'candidates') {
        // The read the readiness and status answers name. It generates and compares the approaches the
        // recorded goal supports and writes nothing: a candidate becomes a record only through
        // `plan add`, and an approval is a further act of the user's own.
        const { flags, rest: ids } = parseFlags(rest, ['work', 'cannot-use', 'json']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: plan candidates <goal-id> [--work <text>] [--cannot-use <action,action>] [--json]', 'USAGE');
        }
        return emitRead(await app.controller.planCandidates({
          goal: ids[0],
          work: flags.work ?? null,
          cannotUse: idList(flags['cannot-use']),
        }), flags);
      }
      if (sub === 'replan') {
        // A read, like `plan candidates`: the plan it answers keeps its bytes, its version and its
        // approval, and the revision it prints needs its own recording and its own approval. The
        // reason is what the read answers, so it is stated rather than invented when the user gives
        // none - the command itself is the request.
        const { flags, rest: ids } = parseFlags(rest, ['reason', 'cannot-use', 'json']);
        if (ids.length !== 1) {
          throw new ValidationError('usage: plan replan <plan-id> [--reason <text>] [--cannot-use <action,action>] [--json]', 'USAGE');
        }
        return emitRead(await app.controller.planReplan({
          plan: ids[0],
          reason: flags.reason ?? null,
          cannotUse: idList(flags['cannot-use']),
        }), flags);
      }
      if (sub === 'outcome') {
        const { flags, rest: ids } = parseFlags(rest, ['json']);
        if (ids.length !== 1) throw new ValidationError('usage: plan outcome <plan-id> [--json]', 'USAGE');
        return emitRead(await app.controller.planOutcome({ plan: ids[0] }), flags);
      }
      if (sub === 'assess') {
        // The one command here that records. It writes the verdict the outcome read derives from the
        // audit log, and no verdict is accepted as input: a plan that ran and verified is not thereby
        // completed, approved, or closed.
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan assess <plan-id>', 'USAGE');
        return emit(await app.controller.planAssess({ target: ids[0] }));
      }
      if (sub === 'revise') {
        const { flags, rest: ids } = parseFlags(rest, ['outcome', 'step', 'precondition', 'assertion', 'estimate', 'reason']);
        if (ids.length !== 1) throw new ValidationError('usage: plan revise <id> --outcome <text> --step <json>... --reason <text>', 'USAGE');
        return emit(await app.controller.planRevise({
          target: ids[0],
          ...content(flags, true),
        }));
      }
      if (sub === 'approve') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan approve <id>', 'USAGE');
        return emit(await app.controller.planApprove({ target: ids[0] }));
      }
      if (sub === 'start' || sub === 'activate') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError(`usage: plan ${sub} <id>`, 'USAGE');
        return emit(await app.controller.planActivate(ids[0], { mode: 'run' }));
      }
      if (sub === 'reconcile') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan reconcile <id>', 'USAGE');
        return emit(await app.controller.planReconcile(ids[0]));
      }
      if (sub === 'continuation') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan continuation <id>', 'USAGE');
        return emit(await app.controller.planContinuation(ids[0]));
      }
      if (sub === 'continue') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: plan continue <id>', 'USAGE');
        return emit(await app.controller.planContinue(ids[0]));
      }
      if (sub === 'cancel') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) {
          throw new ValidationError('usage: plan cancel <id> --reason <text>', 'USAGE');
        }
        return emit(await app.controller.planCancel({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'supersede') {
        const { flags, rest: ids } = parseFlags(rest, ['by', 'reason']);
        if (ids.length !== 1 || !flags.by || !flags.reason) {
          throw new ValidationError('usage: plan supersede <id> --by <plan-id> --reason <text>', 'USAGE');
        }
        return emit(await app.controller.planSupersede({
          target: ids[0],
          by: flags.by,
          reason: flags.reason,
        }));
      }
      err('usage: plan add|list|show|validate|history|compare|candidates|replan|outcome|assess|revise|approve|start|reconcile|continuation|continue|cancel|supersede');
      return 2;
    }

    if (command === 'propose') {
      const { flags, rest: words } = parseFlags(args, ['kind', 'goal', 'plan']);
      const request = words.join(' ').trim();
      if (request === '') {
        throw new ValidationError('usage: propose [--kind goal_create|goal_clarify|plan_create|plan_revise|advice] [--goal <id>] [--plan <id>] <request>', 'USAGE');
      }
      return emit(await app.controller.proposeExecutive({
        kind: flags.kind ?? null,
        request,
        goal: flags.goal ?? null,
        plan: flags.plan ?? null,
        onProgress: modelWaiting(err),
      }));
    }

    if (command === 'proposal') {
      const [sub, ...rest] = args;
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit']);
        rejectUnexpected(extra, 'proposal list [--limit N]');
        out(await app.controller.listProposals({ limit: flags.limit ?? null }));
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: proposal show <id>', 'USAGE');
        out((await app.controller.showProposal(ids[0])).display);
        return 0;
      }
      if (sub === 'accept') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1) throw new ValidationError('usage: proposal accept <id> [--reason <text>]', 'USAGE');
        return emit(await app.controller.acceptProposal({ target: ids[0], reason: flags.reason ?? null }));
      }
      if (sub === 'reject') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) throw new ValidationError('usage: proposal reject <id> --reason <text>', 'USAGE');
        return emit(await app.controller.rejectProposal({ target: ids[0], reason: flags.reason }));
      }
      if (sub === 'invalidate') {
        const { flags, rest: ids } = parseFlags(rest, ['reason']);
        if (ids.length !== 1 || !flags.reason) throw new ValidationError('usage: proposal invalidate <id> --reason <text>', 'USAGE');
        return emit(await app.controller.invalidateProposal({ target: ids[0], reason: flags.reason }));
      }
      err('usage: proposal list|show|accept|reject|invalidate');
      return 2;
    }

    if (command === 'recover') {
      rejectUnexpected(parseFlags(args, []).rest, 'recover');
      // A direct, unaudited read: it reports what the stores say about unfinished work and
      // writes nothing. It never resumes, retries, or cancels anything by itself.
      const res = await app.controller.recoveryReport();
      out(res.display ?? res.output ?? '(none)');
      return res.attention ? 1 : 0;
    }

    if (command === 'work' || command === 'next') {
      const { flags, rest: extra } = parseFlags(args, ['limit']);
      rejectUnexpected(extra, command === 'next' ? 'next' : 'work [--limit N]');
      const res = await app.controller.continuationReport(
        command === 'next' ? { limit: 1, top: true } : { limit: flags.limit ?? null },
      );
      out(res.display);
      // Candidates are not errors. Only an unreadable or damaged record makes the answer
      // incomplete, and that is reported as a nonzero exit.
      return res.problems.length > 0 ? 1 : 0;
    }

    if (command === 'review') {
      const { flags, rest: extra } = parseFlags(args, ['limit', 'days']);
      rejectUnexpected(extra, 'review [--limit N] [--days N]');
      return emit(await app.controller.workReview({
        limit: flags.limit ?? 20,
        horizonDays: flags.days ?? 7,
      }));
    }

    if (command === 'deadline') {
      const [sub, ...rest] = args;
      const usage = 'deadline list [--days N] [--limit N] | deadline import <path> [--max-bytes N] [--workspace <name>]';
      if (sub === 'list') {
        const { flags, rest: extra } = parseFlags(rest, ['limit', 'days']);
        rejectUnexpected(extra, 'deadline list [--days N] [--limit N]');
        return emit(await app.controller.deadlineList({
          limit: flags.limit ?? 50,
          horizonDays: flags.days ?? 30,
        }));
      }
      if (sub === 'import') {
        const { flags, rest: paths } = parseFlags(rest, ['max-bytes', 'workspace']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(await app.controller.deadlineImport({
          path: paths[0],
          ...(flags['max-bytes'] === undefined ? {} : { maxBytes: flags['max-bytes'] }),
          ...(flags.workspace === undefined ? {} : { workspace: flags.workspace }),
        }));
      }
      err(`usage: ${usage}`);
      return 2;
    }

    if (command === 'backup') {
      const [sub, ...rest] = args;
      const usage = 'backup export <archive-path> | backup inspect <archive-path> | backup restore <archive-path> --confirm <digest-prefix> [--replace-existing]';
      if (sub === 'export' || sub === 'inspect') {
        const { rest: paths } = parseFlags(rest, []);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        return emit(
          sub === 'export'
            ? await app.controller.backupExport({ path: paths[0] })
            : await app.controller.backupInspect({ path: paths[0] }),
        );
      }
      if (sub === 'restore') {
        const { flags, rest: paths } = parseFlags(rest, ['confirm', 'replace-existing']);
        if (paths.length !== 1) {
          err(`usage: ${usage}`);
          return 2;
        }
        // The confirmation is passed through as given. Whether it matches this archive is decided
        // from the archive's own digest, not from anything the command line asserts about it.
        return emit(await app.controller.backupRestore({
          path: paths[0],
          confirm: flags.confirm,
          replaceExisting: flags['replace-existing'] === true,
        }));
      }
      err(`usage: ${usage}`);
      return 2;
    }

    if (command === 'task') {
      const [sub, ...rest] = args;
      if (sub === 'plan') {
        const { rest: words } = parseFlags(rest, []);
        if (words.join(' ').trim() === '') {
          // An empty goal is a usage error, like an empty `ask`: nothing is planned,
          // so there is no operation to record in the audit log.
          err('usage: task plan <goal...>');
          return 2;
        }
        const res = await app.controller.planTask(words.join(' '), {
          onProgress: stderr.isTTY ? modelWaiting(err) : null,
        });
        return emit(res);
      }
      if (sub === 'list') {
        rejectUnexpected(parseFlags(rest, []).rest, 'task list');
        out(await app.controller.listTasks());
        return 0;
      }
      if (sub === 'show') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: task show <id>', 'USAGE');
        out((await app.controller.showTask(ids[0])).display);
        return 0;
      }
      if (sub === 'explain') {
        const { rest: words } = parseFlags(rest, []);
        if (words.length < 1 || words.length > 2) {
          throw new ValidationError('usage: task explain <id> [status|finished|outcome|steps|pending|why|approval|recovery]', 'USAGE');
        }
        const view = words[1] ?? 'status';
        if (!TASK_EXPLAIN_VIEWS[view]) {
          throw new ValidationError(`unknown view "${view}"; use ${Object.keys(TASK_EXPLAIN_VIEWS).join(', ')}`, 'USAGE');
        }
        // A read with no operation record, like `task show`: the exit code reports what the
        // records establish, not whether the read was audited. 0 means the task log records
        // the work as complete and the audit holds a record for every verified step; anything
        // incomplete, held, failed, or unsupported by its own record is 1.
        const res = await app.controller.describeTask(words[0], TASK_EXPLAIN_VIEWS[view]);
        out(res.display);
        return res.task.status === TaskStatus.COMPLETED && res.evidenceState === 'complete' ? 0 : 1;
      }
      if (sub === 'run' || sub === 'resume') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError(`usage: task ${sub} <id>`, 'USAGE');
        return emit(await app.controller.runTask(ids[0], sub === 'resume' ? 'resume' : 'run'));
      }
      if (sub === 'approve') {
        const { flags, rest: ids } = parseFlags(rest, ['step']);
        if (ids.length !== 1) throw new ValidationError('usage: task approve <id> [--step <stepId>]', 'USAGE');
        if ((flags.step ?? []).length > 1) throw new ValidationError('usage: task approve <id> [--step <stepId>]', 'USAGE');
        return emit(await app.controller.approveTask(ids[0], { stepId: flags.step?.[0] ?? null }));
      }
      if (sub === 'retry') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 2) throw new ValidationError('usage: task retry <id> <stepId>', 'USAGE');
        return emit(await app.controller.retryTask(ids[0], ids[1]));
      }
      if (sub === 'cancel') {
        const { rest: ids } = parseFlags(rest, []);
        if (ids.length !== 1) throw new ValidationError('usage: task cancel <id>', 'USAGE');
        return emit(await app.controller.cancelTask(ids[0]));
      }
      if (sub === 'feedback') {
        const { flags, rest: words } = parseFlags(rest, ['guidance', 'reason', 'supersedes'], ['supersedes']);
        if (words.length !== 2) {
          throw new ValidationError('usage: task feedback <id> <assessment> [--guidance text] [--reason text] [--supersedes id]', 'USAGE');
        }
        return emit(await app.controller.taskFeedback(words[0], {
          assessment: words[1],
          guidance: flags.guidance ?? null,
          reason: flags.reason ?? null,
          supersedes: flags.supersedes === undefined ? [] : [].concat(flags.supersedes),
        }));
      }
      err('usage: task plan|list|show|explain|approve|run|resume|retry|cancel|feedback');
      return 2;
    }

    err(`unknown command: ${safeText(command, 200)}`);
    err('run "node bin/apex.js help" for usage');
    return 2;
  } catch (e) {
    if (e instanceof ValidationError) {
      err(`usage error: ${errorText(e)}`);
      return 2;
    }
    if (e instanceof StoreError) {
      if (e.code === 'LOCKED') {
        err(`lock contention: ${errorText(e)}`);
        err('No data was changed: the command was refused before it could run. This is not a data-directory permission problem. If no task run or recovery is active, run "node bin/apex.js repair locks" to inspect abandoned takeover tokens; a dead lock claim is taken over by the next normal run. Retrying after the active run finishes is safe.');
        return 1;
      }
      if (/corrupt/i.test(e.message)) {
        // A damaged store is not a permissions problem, and the repair is not a retry.
        err(`data store corrupt: ${errorText(e)}`);
        err('No file was changed. Run "node bin/apex.js diagnose" for what is readable, what is uncertain, and recovery guidance; there is no supported automatic repair for this store.');
        return 1;
      }
      err(`data store unavailable: ${errorText(e)}. No file was changed. Check APEX_DATA_DIR, its permissions, and free space; run "node bin/apex.js diagnose" for details.`);
      return 1;
    }
    err(`unexpected error: ${errorText(e)}`);
    return 1;
  }
}

// Interactive loop. Reads lines until end of input or /exit. Each line is one
// request through the controller, in the current session.
async function runChat({ app, stdin, stdout, stderr, out }) {
  const interactive = Boolean(stdin.isTTY);
  const err = (s) => stderr.write(`${s}\n`);
  out('APEX chat. Type a message. /new starts a new session, /exit ends. Memory and history persist.');
  const rl = readline.createInterface({ input: stdin, output: interactive ? stdout : undefined, terminal: false });
  if (interactive) stdout.write('you> ');
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '') {
      if (interactive) stdout.write('you> ');
      continue;
    }
    if (line === '/exit' || line === '/quit') break;
    if (line === '/new') {
      const state = await app.session.rotate();
      out(`Started a new session: ${shortId(state.sessionId)}`);
    } else {
      try {
        const res = await app.controller.handle(line, {
          origin: 'user',
          onProgress: interactive ? modelWaiting(err) : null,
        });
        out(formatChatReply(res));
        const session = sessionNotice(res);
        if (session) stderr.write(`${session}\n`);
      } catch (e) {
        out(`error: ${errorText(e)}`);
      }
    }
    if (interactive) stdout.write('you> ');
  }
  rl.close();
  return 0;
}
