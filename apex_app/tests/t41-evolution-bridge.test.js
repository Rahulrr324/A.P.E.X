// T-41 Step 3 (2026-11-22): the Evolution Lab -> Workshop bridge and the immutable governance boundary.
//
// Three claims are pinned here, and each one is a way the bridge could be wrong:
//
//   1. **The boundary is total.** A proposal that targets the ECP, the safety latch, the policy, the
//      autonomy matrix, an audit ledger or the applier is refused with `IMMUTABLE_GOVERNANCE_BOUNDARY`
//      - at proposal time AND at stage time - and there is no field, flag or override that changes it.
//      Spelling the path differently does not help: the refusal is canonical.
//   2. **Staging is not a shortcut.** Only a proposal whose sandbox verification recorded `true` can be
//      staged. Staging produces a Workshop candidate that is still unverified and still unapplied.
//   3. **The chain is traceable.** The candidate records its `sourceProposalId`, and a causal trace
//      asked for by proposal id contains the whole path: proposal -> stage -> verify -> apply -> audit.
//
// Nothing here contacts a model, reads the real APEX data directory, or writes the repository tree.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';
import { ModelGateway, NoBackend } from '../src/model/gateway.js';
import {
  classifyGovernancePath, governanceBoundaryPolicy, canonicalRelativePath,
  IMMUTABLE_BOUNDARY_CODE,
} from '../src/evolution/governance-boundary.js';
import { WorkshopSandbox } from '../src/workshop/sandbox.js';
import { UI_CLIENT } from '../src/ui/assets.js';

const TOKEN = 't41-bridge-token-0123456789';
const roots = [];
const servers = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t41-bridge-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (servers.length) await servers.pop().stop().catch(() => {});
  while (roots.length) {
    const root = roots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* already removed */ }
  }
});

// The five boundaries the milestone names, in the spelling the policy uses.
const PROTECTED = [
  'src/executive/control-plane.js',
  'src/security/latch.js',
  'src/governance/policy.js',
  'src/autonomy/matrix.js',
  'src/workshop/applier.js',
  'data/safety-latch.json',
  'data/audit.jsonl',
];

describe('T-41 the immutable governance boundary is a policy, not a paragraph', () => {
  test('every named boundary refuses, and names itself', () => {
    for (const target of PROTECTED) {
      const refusal = classifyGovernancePath(target);
      assert.ok(refusal, `${target} must be refused`);
      assert.equal(refusal.code, IMMUTABLE_BOUNDARY_CODE, target);
      assert.ok(refusal.why.length > 20, `${target} must say why it is protected`);
      assert.ok(refusal.category, `${target} must name a category`);
    }
  });

  test('the five safety boundaries the milestone counts are all in the policy', () => {
    const policy = governanceBoundaryPolicy();
    assert.equal(policy.overridable, false, 'there is no override');
    const categories = new Set(policy.entries.map((entry) => entry.category));
    for (const category of ['authorization', 'safety', 'policy', 'autonomy', 'write_path', 'safety_latch', 'audit_ledger']) {
      assert.ok(categories.has(category), `the policy must cover ${category}`);
    }
    const dirs = policy.entries.map((entry) => entry.path);
    for (const required of ['src/executive/', 'src/security/', 'src/governance/', 'src/workshop/applier.js']) {
      assert.ok(dirs.includes(required), `${required} must be named in the policy`);
    }
    assert.ok(policy.total >= 7, `expected at least 7 protected paths, got ${policy.total}`);
  });

  test('spelling the path differently does not get past the boundary', () => {
    const evasions = [
      'SRC/EXECUTIVE/control-plane.js',
      './src/executive/control-plane.js',
      'src/security/../executive/control-plane.js',
      'src//executive//control-plane.js',
      'src\\executive\\control-plane.js',
      'src/workshop/./applier.js',
      'SRC/Workshop/Applier.js',
    ];
    for (const evasion of evasions) {
      const refusal = classifyGovernancePath(evasion);
      assert.ok(refusal, `${evasion} must be canonicalised and refused`);
      assert.equal(refusal.code, IMMUTABLE_BOUNDARY_CODE);
    }
  });

  test('ordinary paths are not refused, so the boundary is not just "everything"', () => {
    for (const allowed of ['src/greeting.js', 'README.md', 'docs/notes.md', 'src/executive-notes.js', 'data/report.json']) {
      assert.equal(classifyGovernancePath(allowed), null, `${allowed} must be allowed`);
    }
    assert.equal(canonicalRelativePath('./a/./b/../c.js'), 'a/c.js');
  });
});

describe('T-41 a proposal cannot stage itself around the boundary', () => {
  async function startUi() {
    const root = tempRoot();
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'greeting.js'), 'export const v = 1;\n', 'utf8');
    const app = createApp({
      dataDir, filesystemRoot: workspace, gateway: new ModelGateway({ backend: new NoBackend() }),
    });
    const ui = createUiServer({ app, token: TOKEN, host: '127.0.0.1', port: 0 });
    const started = await ui.start();
    servers.push(ui);
    const headers = { authorization: `Bearer ${TOKEN}`, 'x-apex-ui': '1', 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${started.port}`;
    const call = async (method, pathname, body) => {
      const response = await fetch(`${base}${pathname}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return {
      dataDir,
      workspace,
      post: (pathname, body) => call('POST', pathname, body),
      get: (pathname) => call('GET', pathname),
    };
  }

  test('targeting the ECP is refused 403 at PROPOSAL time and never recorded', async () => {
    const { post, get } = await startUi();
    const refused = await post('/api/evolution/propose', {
      title: 'rewrite the control plane',
      targetRelativePath: 'src/executive/control-plane.js',
      proposedContent: 'export const bypass = true;\n',
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.code, IMMUTABLE_BOUNDARY_CODE);
    assert.equal(refused.body.boundary.category, 'authorization');
    assert.match(String(refused.body.error), /immutable governance boundary/i);

    // The ledger must not hold it: a refused proposal that was still recorded would be an entry the
    // owner could later try to stage.
    const status = await get('/api/evolution');
    assert.equal(status.status, 200);
    assert.equal(status.body.proposals?.length ?? 0, 0, 'a refused proposal is not recorded');
  });

  test('every protected path is refused with the same code', async () => {
    const { post } = await startUi();
    for (const target of PROTECTED) {
      const refused = await post('/api/evolution/propose', {
        title: `change ${target}`, targetRelativePath: target, proposedContent: 'x\n',
      });
      assert.equal(refused.status, 403, `${target} -> ${refused.status} ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, IMMUTABLE_BOUNDARY_CODE, target);
    }
  });

  test('an unverified proposal cannot be staged', async () => {
    const { post } = await startUi();
    const proposed = await post('/api/evolution/propose', {
      title: 'v2 greeting', targetRelativePath: 'greeting.js', proposedContent: 'export const v = 2;\n',
    });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    const staged = await post(`/api/evolution/proposals/${proposed.body.proposalId}/stage-workshop`, {});
    assert.equal(staged.status, 409, JSON.stringify(staged.body));
    assert.equal(staged.body.code, 'STAGE_REFUSED_UNVERIFIED');
  });

  test('the full chain: propose -> verify -> stage -> sandbox verify -> apply -> trace', async () => {
    const { post, get, workspace } = await startUi();
    const companion = "import test from 'node:test';\nimport assert from 'node:assert';\n"
      + "import { v } from './greeting.js';\ntest('v is 2', () => { assert.equal(v, 2); });\n";
    const proposed = await post('/api/evolution/propose', {
      title: 'v2 greeting',
      hypothesis: 'the greeting carries a version',
      targetRelativePath: 'greeting.js',
      proposedContent: 'export const v = 2;\n',
      testContent: companion,
    });
    assert.equal(proposed.status, 200);
    const id = proposed.body.proposalId;

    const recorded = await post('/api/evolution/verify', { proposalId: id, verified: true, detail: 'sandbox run passed' });
    assert.equal(recorded.status, 200);

    const staged = await post(`/api/evolution/proposals/${id}/stage-workshop`, {});
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.sourceProposalId, id);
    assert.equal(staged.body.verified, false, 'staging is not verification');
    assert.equal(staged.body.applied, false);
    assert.equal(staged.body.hasSandboxTest, true);
    const candidateId = staged.body.candidateId;

    const verified = await post('/api/workshop/verify-file', { candidateId });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.verified, true, JSON.stringify(verified.body.failed));
    assert.ok(verified.body.sandboxTestResult.passedCount >= 1);

    const applied = await post(`/api/workshop/candidates/${candidateId}/apply`, { reason: 't41 chain' });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(fs.readFileSync(path.join(workspace, 'greeting.js'), 'utf8'), 'export const v = 2;\n');

    // The causal trace, asked for by the PROPOSAL id, has to contain the whole chain.
    const trace = await get(`/api/memory/trace/${id}`);
    assert.equal(trace.status, 200, JSON.stringify(trace.body));
    const entries = trace.body.entries ?? [];
    const kinds = entries.map((entry) => entry.kind);
    assert.ok(kinds.includes('workshop_verification'), `trace must hold the verification: ${kinds}`);
    assert.ok(kinds.includes('workshop_apply'), `trace must hold the apply: ${kinds}`);
    assert.ok(kinds.filter((kind) => kind === 'ecp_audit').length >= 2, 'the audit trail must be in the chain');
    // The projection nests a step's fields under `detail`; that is the shape the screen reads, so the
    // assertion reads the same path rather than a top-level field that does not exist.
    const verification = entries.find((entry) => entry.kind === 'workshop_verification');
    assert.equal(verification.detail.sourceProposalId, id, 'the verification names its source proposal');
    assert.equal(verification.detail.candidateId, candidateId);
    assert.ok(verification.detail.sandboxTestResult, 'the verification carries the sandbox test result');
    assert.ok(verification.detail.sandboxTestResult.passedCount >= 1);
    const apply = entries.find((entry) => entry.kind === 'workshop_apply');
    assert.equal(apply.detail.candidateId, candidateId, 'the apply joins the same chain');
    assert.equal(trace.body.complete, true, JSON.stringify(trace.body.missing));
  });

  test('the evolution status counts the boundary and the staging link', async () => {
    const { post, get } = await startUi();
    const proposed = await post('/api/evolution/propose', {
      title: 'v2 greeting', targetRelativePath: 'greeting.js', proposedContent: 'export const v = 2;\n',
    });
    await post('/api/evolution/verify', { proposalId: proposed.body.proposalId, verified: true, detail: 'passed' });
    await post(`/api/evolution/proposals/${proposed.body.proposalId}/stage-workshop`, {});

    const status = await get('/api/evolution');
    assert.equal(status.status, 200);
    const boundary = (status.body.boundaries?.entries ?? []).find((entry) => entry.key === 'protected_paths');
    assert.ok(boundary, 'the boundary report names the protected-path policy');
    assert.equal(boundary.locked, true);
    assert.equal(boundary.policy.overridable, false);
    assert.ok(boundary.policy.total >= 7);

    const proposal = (status.body.proposals ?? []).find((entry) => entry.proposalId === proposed.body.proposalId);
    assert.ok(proposal, 'the proposal is listed');
    assert.equal(proposal.staging.count, 1);
    assert.match(proposal.staging.candidateId, /^wsc-[0-9a-f]{12}$/);
    assert.equal(proposal.targetRelativePath, 'greeting.js');
  });
});

// T-42 Step 1 (2026-11-22): the surfaces the browser walk reads.
//
// The T-41 walk could only prove that a candidate carried `sourceProposalId` on disk. A card cannot read
// the disk, so the link has to reach the API and the client as well - and the client's copy of the
// protected-path list has to agree with the server's policy, or the screen would describe a boundary
// stricter or looser than the one enforced.
describe('T-42 the provenance link reaches every surface, and the UI policy cannot drift', () => {
  test('sandbox.list() reports provenance, the test flag and the verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t42-list-'));
    try {
      const workspace = path.join(root, 'ws');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'a.js'), 'export const v = 1;\n', 'utf8');
      const sandbox = new WorkshopSandbox({ dataDir: path.join(root, 'data'), workspaceRoot: workspace });

      const fromProposal = sandbox.stage({
        relativePath: 'a.js', proposedContent: 'export const v = 2;\n',
        sourceProposalId: 'evo-abc123',
        testContent: "import test from 'node:test';\ntest('x', () => {});\n",
      });
      const fromPanel = sandbox.stage({ relativePath: 'a.js', proposedContent: 'export const v = 3;\n' });

      const before = sandbox.list();
      assert.equal(before.present, true);
      assert.equal(before.candidates.length, 2);
      const linked = before.candidates.find((c) => c.candidateId === fromProposal.candidateId);
      const unlinked = before.candidates.find((c) => c.candidateId === fromPanel.candidateId);
      assert.equal(linked.sourceProposalId, 'evo-abc123');
      assert.equal(linked.hasSandboxTest, true);
      assert.equal(linked.verified, null, 'not verified yet is null, not false');
      assert.equal(unlinked.sourceProposalId, null, 'a panel-staged candidate has no proposal');
      assert.equal(unlinked.hasSandboxTest, false);

      sandbox.verify(fromProposal.candidateId);
      const verified = sandbox.list().candidates.find((c) => c.candidateId === fromProposal.candidateId);
      assert.equal(verified.verified, true);
      assert.ok(verified.sandboxTestResult.passedCount >= 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a read of the sandbox list creates nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-t42-cold-'));
    try {
      const dataDir = path.join(root, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const sandbox = new WorkshopSandbox({ dataDir });
      const result = sandbox.list();
      assert.equal(result.present, false, 'no sandbox directory yet');
      assert.deepEqual(result.candidates, []);
      // The read must not have created the directory: a read-only command leaves the tree as cold as
      // it found it, which is the T-37 regression rule.
      assert.equal(fs.existsSync(path.join(dataDir, 'workshop-sandbox')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the client's protected-path list matches the server policy", () => {
    const policy = governanceBoundaryPolicy();
    const start = UI_CLIENT.indexOf('const EVOLUTION_PROTECTED = [');
    assert.ok(start > -1, 'the client declares the protected list');
    const end = UI_CLIENT.indexOf('];', start);
    const block = UI_CLIENT.slice(start, end);
    // Every directory and file prefix the policy enforces must appear in the client's copy, and the
    // client must not invent one the policy does not have.
    const clientPaths = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    const policyPaths = policy.entries
      .filter((entry) => entry.kind !== 'pattern')
      .map((entry) => entry.path)
      .sort();
    assert.deepEqual(clientPaths, policyPaths);
  });

  test('the stage response and the card both carry the link', () => {
    // The client reads sourceProposalId from the stage response and renders a badge from it.
    assert.ok(UI_CLIENT.includes('sourceProposalId: typeof data.sourceProposalId'));
    assert.ok(UI_CLIENT.includes('from.dataset.sourceProposal = candidate.sourceProposalId'),
      'the card badge carries the proposal id as a data attribute the walk can address');
    // And the button the walk presses carries its proposal id.
    assert.ok(UI_CLIENT.includes('stage.dataset.stageProposal = proposal.proposalId'));
  });
});
