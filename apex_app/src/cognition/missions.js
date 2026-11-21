// T-34 Step 1 (2026-11-19): deterministic multi-node mission compilation.
//
// The T-29 pipeline compiled one action into one step, so every mission was a single node: the
// TaskGraph could show a state and a control but never a real shape, and the owner's "Not
// established: multi-node missions with real fan-out" reading of T-33 was correct.
//
// This module is the missing half, and it is deliberately not a planner. It holds a fixed, named
// template per mission kind, with the steps written out in source: which capability each node runs,
// what its declared input is, and which nodes it depends on. Compiling a mission is therefore
// deterministic, inspectable and reviewable in a diff - there is no inference, no generated plan and
// no hidden branch. Every node is still authorized separately by the ECP and executed by the task
// runner, and every write node still stops at the owner's approval.
//
// The shape each template must keep is the one the TaskGraph seam needed: a root, a fan-out to
// independent branches, a join that depends on all of them, and a completion node that depends on the
// join. `audit_and_stage` is the workspace-audit mission:
//
//        n1  read the perception state        (read)  ┐
//        ├── n2a sense the host: git state    (write) │  <- gated: it appends a reading to the ledger
//        └── n2b list the workshop ledger     (read)  ┴── n3 verify the artifact (write, gated)
//                                                            └── n4 read the verification back (read)
//
// `gate` is the template's own declaration, and it is not inferred from the registry class: an action
// is write-class for two very different reasons. `perception.sense_host` is write-class because it
// appends its reading to the perception ledger, and that append is a change to a store the owner
// reads, so this template gates it and says so. A node whose only effect is read (n1, n2b, n4) is not
// gated. The ECP still authorizes every node at run time whatever its gate says, and a gated node is
// recorded `awaiting_approval` when the mission is created: compiling a mission is never an approval.
export const MISSION_SCHEMA = 'apex.mission/1';

export const MISSION_TEMPLATES = Object.freeze({
  audit_and_stage: Object.freeze({
    name: 'audit_and_stage',
    title: 'Audit the host, then verify and confirm one workshop artifact',
    requires: 'artifactId',
    describe: 'sense the host, read the perception state and the workshop ledger in parallel, verify one stored artifact, then read the verification back',
    nodes: Object.freeze([
      Object.freeze({
        id: 'n1',
        action: 'perception.state',
        role: 'root',
        gate: 'none',
        gateBasis: 'reads the perception ledger and writes nothing',
        description: 'read the perception state: recent host and workspace observations, push budget and suppression rules',
        input: Object.freeze({ limit: 5 }),
        dependsOn: Object.freeze([]),
      }),
      Object.freeze({
        id: 'n2a',
        action: 'perception.sense_host',
        role: 'branch',
        gate: 'approval',
        gateBasis: 'appends a new host and git-state reading to the perception ledger, which is a store the owner reads',
        description: 'sense the host: CPU, memory, storage, uptime and the workspace git branch, HEAD, dirty and untracked counts',
        input: Object.freeze({ reason: 'audit_and_stage mission: inspect the host and the git state' }),
        dependsOn: Object.freeze(['n1']),
      }),
      Object.freeze({
        id: 'n2b',
        action: 'workshop.list',
        role: 'branch',
        gate: 'none',
        gateBasis: 'lists the workshop ledger and writes nothing',
        description: 'list the workshop ledger: which artifacts exist and which of them are verified',
        input: Object.freeze({ limit: 5 }),
        dependsOn: Object.freeze(['n1']),
      }),
      Object.freeze({
        id: 'n3',
        action: 'workshop.verify',
        role: 'join',
        gate: 'approval',
        gateBasis: 'records a verification result that the owner then reads and acts on',
        description: 'run the sandbox verification over the stored artifact',
        input: Object.freeze({ artifactId: null, reason: 'audit_and_stage mission: verify the staged artifact' }), // artifactId filled from the request
        dependsOn: Object.freeze(['n2a', 'n2b']),
      }),
      Object.freeze({
        id: 'n4',
        action: 'workshop.get',
        role: 'completion',
        gate: 'none',
        gateBasis: 'reads one artifact back and writes nothing',
        description: 'read the artifact back after the verification recorded',
        input: Object.freeze({ artifactId: null }), // filled from the request
        dependsOn: Object.freeze(['n3']),
      }),
    ]),
  }),
});

export const MISSION_NAMES = Object.freeze(Object.keys(MISSION_TEMPLATES));

export class MissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MissionError';
    this.code = code;
  }
}

function missionName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 60) {
    throw new MissionError('MISSION_UNKNOWN', `mission must name one of: ${MISSION_NAMES.join(', ')}`);
  }
  const template = MISSION_TEMPLATES[value];
  if (!template) {
    throw new MissionError('MISSION_UNKNOWN', `no mission template is named "${value}"; known: ${MISSION_NAMES.join(', ')}`);
  }
  return template;
}

// The template's own declared needs, filled from the request. Nothing here is inferred: a template
// that needs an artifact refuses without one rather than choosing one for the owner.
function fillInputs(template, { artifactId = null } = {}) {
  if (template.requires === 'artifactId') {
    if (typeof artifactId !== 'string' || artifactId.trim().length === 0 || artifactId.length > 64) {
      throw new MissionError('MISSION_NEEDS_ARTIFACT', `${template.name} needs the workshop artifact it will verify (artifactId)`);
    }
    return { artifactId: artifactId.trim() };
  }
  return {};
}

// Compiles a template into nodes and edges. `roles` is carried through so the TaskGraph can name the
// shape (root, branch, join, completion) instead of guessing it from the edge count.
export function compileMission({ mission, artifactId = null } = {}) {
  const template = missionName(mission);
  const filled = fillInputs(template, { artifactId });
  const nodes = template.nodes.map((node) => ({
    id: node.id,
    action: node.action,
    role: node.role,
    gate: node.gate,
    gateBasis: node.gateBasis,
    description: node.description,
    input: { ...node.input, ...(Object.hasOwn(node.input, 'artifactId') ? { artifactId: filled.artifactId } : {}) },
    dependsOn: [...node.dependsOn],
  }));
  const edges = [];
  for (const node of nodes) for (const from of node.dependsOn) edges.push({ from, to: node.id });
  const fanOut = Math.max(...nodes.map((node) => edges.filter((edge) => edge.from === node.id).length));
  const joins = nodes.filter((node) => node.dependsOn.length > 1).map((node) => node.id);
  return Object.freeze({
    schema: MISSION_SCHEMA,
    name: template.name,
    title: template.title,
    describe: template.describe,
    nodes: Object.freeze(nodes.map((node) => Object.freeze({ ...node, dependsOn: Object.freeze(node.dependsOn), input: Object.freeze(node.input) }))),
    edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
    shape: Object.freeze({
      nodes: nodes.length,
      edges: edges.length,
      fanOut,
      joins: Object.freeze(joins),
      roots: Object.freeze(nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)),
      // Which nodes wait for the owner before they run. Stated here so a reader of the graph does not
      // have to compare registry classes with the request to find out.
      gated: Object.freeze(nodes.filter((node) => node.gate === 'approval').map((node) => node.id)),
    }),
    summary: `${nodes.length} node(s) · ${edges.length} edge(s) · fan-out ${fanOut}${joins.length ? ` · join ${joins.join(', ')}` : ''}${nodes.some((node) => node.gate === 'approval') ? ` · gated ${nodes.filter((node) => node.gate === 'approval').map((node) => node.id).join(', ')}` : ''} · template ${template.name}`,
  });
}
