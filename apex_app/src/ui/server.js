// The loopback-only browser interface. It is a thin, bounded transport over the same
// controller the CLI uses: every turn goes through controller.handle(), every approval
// through the existing user-origin controller method, and the UI adds no action, no
// store, and no authorization rule of its own. One request is in flight at a time,
// because session turns are ordered and the conversation log is the continuity record.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { UI_CLIENT, UI_CSS, UI_PAGE } from './assets.js';
import { BoundedEventHistory, canQueueEventFrame, EVENT_HEARTBEAT_MS, HEARTBEAT_SCHEMA, MAX_EVENT_FRAME_BYTES, OWNER_POLL_MS, STATE_EVENT_HISTORY_LIMIT, STATE_EVENT_OWNERS, STATE_EVENT_SCHEMA } from './event-contract.js';
import { collectHealth } from '../health.js';
import { buildBriefing } from '../briefing/index.js';
import { APP_NAME } from '../identity.js';
import { planRisk } from '../plans/model.js';
import { COGNITION_STAGES } from '../cognition/pipeline.js';
import { AUTONOMY_LEVELS } from '../executive/control-plane.js';
import { buildWorldState } from '../world/world-state.js';
import { Outcome } from '../outcomes.js';
import { evolutionBoundaries } from '../evolution/lab.js';

export const UI_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024,
  maxMessageChars: 4000,
  maxTurns: 60,
  maxWorkItems: 50,
  maxSubscribers: 8,
  maxBufferedBytes: 1024 * 1024,
  maxEventFrameBytes: MAX_EVENT_FRAME_BYTES,
  maxStateEventHistory: STATE_EVENT_HISTORY_LIMIT,
  heartbeatMs: EVENT_HEARTBEAT_MS,
  ownerPollMs: OWNER_POLL_MS,
  chatTimeoutMs: 120000,
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MONITORED_DATA_FILES = Object.freeze([
  'conversation.jsonl', 'council.jsonl', 'deadlines.jsonl', 'devices.jsonl', 'documents.json',
  'documents.jsonl', 'experiences.jsonl', 'goals.jsonl', 'integrations.json', 'kill-switch.json',
  'knowledge.jsonl', 'memory.jsonl', 'notes.jsonl', 'operations.jsonl', 'plans.jsonl',
  'predictions.jsonl', 'proposals.jsonl', 'reasoning.jsonl', 'runtime.json', 'session.json',
  'situational.jsonl', 'task-summary-queue.json', 'tasks.jsonl', 'workshop.jsonl', 'world-model.jsonl',
]);

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function cookiesOf(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0 && name.length <= 32) out[name] = value;
  }
  return out;
}

function baseHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra }));
  res.end(text);
}

function sendAsset(res, type, text) {
  res.writeHead(200, baseHeaders({ 'content-type': type, 'content-length': Buffer.byteLength(text) }));
  res.end(text);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('the request body is too large');
        error.status = 413;
        // The unread remainder cannot be parsed as another request, so the connection is
        // closed after the refusal is written rather than reused.
        error.closeConnection = true;
        // Stop consuming without destroying the socket, so the refusal can still be written.
        fail(error);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = new Error('the request body is not valid JSON');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', (error) => fail(error));
  });
}

function singleLine(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function projectGoal(goal) {
  const criteria = (Array.isArray(goal.criteria) ? goal.criteria : []).slice(0, 8).map((criterion) => ({
    id: singleLine(criterion.id, 16),
    description: singleLine(criterion.description, 240),
    status: singleLine(criterion.status, 32),
    basis: criterion.basis ?? 'user_stated',
    requirement: criterion.requirement ?? 'required',
    ref: criterion.ref ?? null,
    requiredEvidence: criterion.requiredEvidence ? singleLine(criterion.requiredEvidence, 200) : null,
    confirmation: criterion.confirmation && typeof criterion.confirmation === 'object'
      ? {
        decision: criterion.confirmation.decision ?? null,
        reason: criterion.confirmation.reason ? singleLine(criterion.confirmation.reason, 240) : null,
        operationId: criterion.confirmation.operationId ?? null,
        at: criterion.confirmation.at ?? null,
      }
      : null,
    evidence: (Array.isArray(criterion.evidence) ? criterion.evidence : []).slice(0, 8).map((entry) => ({
      kind: entry.kind ?? null,
      operationId: entry.operationId ?? null,
      detail: entry.detail ? singleLine(entry.detail, 240) : null,
      at: entry.at ?? null,
    })),
  }));
  const decomposition = {};
  for (const key of ['prerequisites', 'constraints', 'resources', 'timeConditions', 'blockers', 'unknowns']) {
    decomposition[key] = (Array.isArray(goal[key]) ? goal[key] : []).slice(0, 8).map((item) => ({
      text: singleLine(item.text, 220),
      basis: item.basis ?? 'user_stated',
      ref: item.ref ?? null,
    }));
  }
  const gating = criteria.filter((criterion) => criterion.requirement !== 'suggested' && criterion.requirement !== 'declined');
  const statusHistory = Array.isArray(goal.statusHistory) ? goal.statusHistory : [];
  const revisionHistory = Array.isArray(goal.revisionHistory) ? goal.revisionHistory : [];
  return {
    id: String(goal.id),
    origin: goal.origin ?? null,
    request: singleLine(goal.request, 400),
    status: singleLine(goal.status, 32),
    priority: Number.isInteger(goal.priority) ? goal.priority : null,
    deadline: goal.deadline ?? null,
    revision: Number.isSafeInteger(goal.revision) ? goal.revision : null,
    blockedReason: goal.blockedReason ? singleLine(goal.blockedReason, 240) : null,
    contradiction: goal.contradiction ? {
      criterionId: goal.contradiction.criterionId ?? null,
      operationId: goal.contradiction.operationId ?? null,
      detail: goal.contradiction.detail ? singleLine(goal.contradiction.detail, 240) : null,
      at: goal.contradiction.at ?? null,
    } : null,
    completion: goal.completion ? {
      at: goal.completion.at ?? null,
      criteria: (Array.isArray(goal.completion.criteria) ? goal.completion.criteria : []).slice(0, 8).map((entry) => ({
        criterionId: entry.criterionId ?? null,
        operationId: entry.operationId ?? null,
      })),
      declined: (Array.isArray(goal.completion.declined) ? goal.completion.declined : []).slice(0, 8),
    } : null,
    supersededBy: goal.supersededBy ?? null,
    dependsOn: (Array.isArray(goal.dependsOn) ? goal.dependsOn : []).slice(0, 8).map((id) => String(id)),
    planIds: (Array.isArray(goal.planIds) ? goal.planIds : []).slice(0, 12).map((id) => String(id)),
    taskIds: (Array.isArray(goal.taskIds) ? goal.taskIds : []).slice(0, 12).map((id) => String(id)),
    entityIds: (Array.isArray(goal.entityIds) ? goal.entityIds : []).slice(0, 12).map((id) => String(id)),
    worldEventIds: (Array.isArray(goal.worldEventIds) ? goal.worldEventIds : []).slice(0, 12).map((id) => String(id)),
    criteria,
    progress: {
      required: gating.length,
      satisfied: gating.filter((criterion) => criterion.status === 'satisfied').length,
      contradicted: gating.filter((criterion) => criterion.status === 'contradicted').length,
      pending: gating.filter((criterion) => criterion.status !== 'satisfied' && criterion.status !== 'contradicted').length,
    },
    decomposition,
    statusHistory: statusHistory.slice(-12).map((entry) => ({
      from: entry.from ?? null,
      to: singleLine(entry.to, 32),
      at: entry.at ?? null,
      reason: entry.reason ? singleLine(entry.reason, 240) : null,
    })),
    statusHistoryTotal: statusHistory.length,
    revisionHistory: revisionHistory.slice(-12).map((entry) => ({
      revision: Number.isSafeInteger(entry.revision) ? entry.revision : null,
      at: entry.at ?? null,
      reason: entry.reason ? singleLine(entry.reason, 240) : null,
    })),
    revisionHistoryTotal: revisionHistory.length,
    createdAt: goal.createdAt ?? null,
    updatedAt: goal.updatedAt ?? null,
  };
}

function projectTask(task) {
  return {
    id: String(task.id),
    goal: singleLine(task.goal, 400),
    goalId: task.goalId ?? null,
    planId: task.planId ?? null,
    origin: task.origin ?? null,
    planner: task.planner ?? null,
    status: singleLine(task.status, 32),
    lastReason: task.lastReason ? singleLine(task.lastReason, 240) : null,
    approvedAt: task.approvedAt ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
    steps: (Array.isArray(task.steps) ? task.steps : []).slice(0, 8).map((step) => ({
      id: singleLine(step.id, 32),
      description: singleLine(step.description, 300),
      action: singleLine(step.action, 80),
      permission: step.permission ?? null,
      status: singleLine(step.status, 32),
      dependsOn: (Array.isArray(step.dependsOn) ? step.dependsOn : []).slice(0, 8).map((id) => String(id)),
      outcome: step.outcome ?? null,
      summary: step.summary ? singleLine(step.summary, 240) : null,
      operationId: step.operationId ?? null,
      approval: step.approval ? {
        approvedBy: step.approval.approvedBy ?? null,
        at: step.approval.at ?? null,
      } : null,
    })),
  };
}

function projectPlan(plan) {
  const stepResults = plan.stepResults && typeof plan.stepResults === 'object' ? plan.stepResults : {};
  const milestones = (Array.isArray(plan.milestones) ? plan.milestones : []).slice(0, 4).map((milestone) => {
    const stepIds = (Array.isArray(milestone.steps) ? milestone.steps : []).slice(0, 8).map((id) => String(id));
    const recorded = stepIds.map((id) => stepResults[id]).filter(Boolean);
    return {
      id: singleLine(milestone.id, 16),
      title: singleLine(milestone.title, 120),
      description: milestone.description ? singleLine(milestone.description, 220) : null,
      dependsOn: (Array.isArray(milestone.dependsOn) ? milestone.dependsOn : []).slice(0, 4).map((id) => String(id)),
      checkpoint: milestone.checkpoint ? singleLine(milestone.checkpoint, 240) : null,
      verification: milestone.verification ? singleLine(milestone.verification, 240) : null,
      steps: stepIds,
      recordedProgress: {
        total: stepIds.length,
        completed: recorded.filter((result) => result.status === 'completed').length,
        failed: recorded.filter((result) => result.status === 'failed').length,
        uncertain: recorded.filter((result) => result.status === 'uncertain').length,
        recorded: recorded.length,
      },
    };
  });
  return {
    id: String(plan.id),
    origin: plan.origin ?? null,
    goalId: plan.goalId ?? null,
    goalRevision: Number.isSafeInteger(plan.goalRevision) ? plan.goalRevision : null,
    outcome: singleLine(plan.outcome, 400),
    status: singleLine(plan.status, 32),
    version: Number.isSafeInteger(plan.version) ? plan.version : null,
    risk: Array.isArray(plan.steps) && plan.steps.length ? planRisk(plan.steps) : 'unknown',
    approved: plan.approval !== null && plan.approval !== undefined,
    approval: plan.approval ? {
      at: plan.approval.at ?? null,
      version: Number.isSafeInteger(plan.approval.version) ? plan.approval.version : null,
      contentHashPrefix: typeof plan.approval.contentHash === 'string' ? plan.approval.contentHash.slice(0, 16) : null,
    } : null,
    activated: Boolean(plan.activation),
    activation: plan.activation ? {
      at: plan.activation.at ?? null,
      taskId: plan.activation.taskId ?? null,
    } : null,
    blockedReason: plan.blockedReason ? singleLine(plan.blockedReason, 300) : null,
    failureReason: plan.failureReason ? singleLine(plan.failureReason, 300) : null,
    cancelledReason: plan.cancelledReason ? singleLine(plan.cancelledReason, 300) : null,
    preconditions: (Array.isArray(plan.preconditions) ? plan.preconditions : []).slice(0, 8).map((text) => singleLine(text, 240)),
    assertions: (Array.isArray(plan.assertions) ? plan.assertions : []).slice(0, 8).map((assertion) => ({
      kind: assertion.kind ?? null,
      text: assertion.text ? singleLine(assertion.text, 240) : null,
      ref: assertion.ref ?? null,
      basis: assertion.basis ?? null,
    })),
    resources: plan.resources && typeof plan.resources === 'object' ? { ...plan.resources } : null,
    milestones,
    steps: (Array.isArray(plan.steps) ? plan.steps : []).slice(0, 8).map((step) => {
      const result = stepResults[step.id] ?? null;
      return {
        id: singleLine(step.id, 32),
        description: singleLine(step.description, 300),
        action: singleLine(step.action, 80),
        dependsOn: (Array.isArray(step.dependsOn) ? step.dependsOn : []).slice(0, 8).map((id) => String(id)),
        expectedResult: step.expectedResult ? singleLine(step.expectedResult, 240) : null,
        verification: step.verification ? singleLine(step.verification, 240) : null,
        criterionId: step.criterionId ?? null,
        risk: step.risk ?? 'unknown',
        reversibility: step.reversibility ?? 'unknown',
        recovery: step.recovery ? singleLine(step.recovery, 240) : null,
        milestoneId: step.milestoneId ?? null,
        priority: step.priority ?? null,
        result: result ? {
          status: result.status ?? null,
          operationId: result.operationId ?? null,
          taskId: result.taskId ?? null,
          at: result.at ?? null,
          detail: result.detail ? singleLine(result.detail, 240) : null,
        } : null,
      };
    }),
    history: (Array.isArray(plan.history) ? plan.history : []).slice(-16).map((entry) => ({
      version: Number.isSafeInteger(entry.version) ? entry.version : null,
      kind: singleLine(entry.kind, 40),
      at: entry.at ?? null,
      reason: entry.reason ? singleLine(entry.reason, 240) : null,
    })),
    historyTotal: Array.isArray(plan.history) ? plan.history.length : 0,
    createdAt: plan.createdAt ?? null,
    updatedAt: plan.updatedAt ?? null,
  };
}

function projectOwnerTasks(tasks) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const pending = [];
  let awaitingApprovalSteps = 0;
  let uncertainSteps = 0;
  let runningTasks = 0;
  let pausedTasks = 0;
  for (const task of rows) {
    if (task.status === 'running') runningTasks += 1;
    if (task.status === 'paused') pausedTasks += 1;
    for (const step of Array.isArray(task.steps) ? task.steps : []) {
      if (step.status === 'awaiting_approval') {
        awaitingApprovalSteps += 1;
        if (pending.length < UI_LIMITS.maxWorkItems) pending.push({ taskId: String(task.id), stepId: String(step.id) });
      }
      if (step.status === 'uncertain') uncertainSteps += 1;
    }
  }
  return {
    available: true,
    total: rows.length,
    truncated: rows.length > UI_LIMITS.maxWorkItems,
    counts: { runningTasks, pausedTasks, awaitingApprovalSteps, uncertainSteps },
    items: rows.slice(0, UI_LIMITS.maxWorkItems).map((task) => ({
      id: String(task.id),
      status: singleLine(task.status, 32),
      steps: (Array.isArray(task.steps) ? task.steps : []).slice(0, 12).map((step) => ({
        id: singleLine(step.id, 32),
        status: singleLine(step.status, 32),
        outcome: typeof step.outcome === 'string' ? singleLine(step.outcome, 160) : null,
      })),
    })),
  };
}

function projectOwnerPlans(plans) {
  const rows = Array.isArray(plans) ? plans : [];
  const counts = { draft: 0, approved: 0, active: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 };
  let approved = 0;
  let unapprovedDrafts = 0;
  for (const plan of rows) {
    if (Object.hasOwn(counts, plan.status)) counts[plan.status] += 1;
    if (plan.approval) approved += 1;
    if (plan.status === 'draft' && !plan.approval) unapprovedDrafts += 1;
  }
  return {
    available: true,
    total: rows.length,
    truncated: rows.length > UI_LIMITS.maxWorkItems,
    counts: { ...counts, recordedApprovals: approved, unapprovedDrafts },
    items: rows.slice(0, UI_LIMITS.maxWorkItems).map((plan) => ({
      id: String(plan.id),
      status: singleLine(plan.status, 32),
      version: Number.isSafeInteger(plan.version) ? plan.version : null,
      approved: plan.approval !== null && plan.approval !== undefined,
      approvalVersion: Number.isSafeInteger(plan.approval?.version) ? plan.approval.version : null,
      activated: Boolean(plan.activation),
    })),
  };
}

function projectApprovals(tasks, plans) {
  const taskSteps = [];
  const draftPlans = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const step of Array.isArray(task.steps) ? task.steps : []) {
      if (step.status === 'awaiting_approval') {
        taskSteps.push({ taskId: String(task.id), stepId: String(step.id) });
      }
    }
  }
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (plan.status === 'draft') {
      draftPlans.push({
        planId: String(plan.id),
        version: Number.isSafeInteger(plan.version) ? plan.version : null,
        approved: plan.approval !== null && plan.approval !== undefined,
      });
    }
  }
  return {
    available: true,
    taskStepCount: taskSteps.length,
    taskSteps: taskSteps.slice(0, UI_LIMITS.maxWorkItems),
    truncatedTaskSteps: taskSteps.length > UI_LIMITS.maxWorkItems,
    draftPlanCount: draftPlans.length,
    draftPlans: draftPlans.slice(0, UI_LIMITS.maxWorkItems),
    truncatedDraftPlans: draftPlans.length > UI_LIMITS.maxWorkItems,
  };
}

function approvalCapability(action, registry, planStep = null, taskStep = null) {
  const definition = typeof registry?.get === 'function' ? registry.get(action) : null;
  const permission = definition?.permission ?? taskStep?.permission ?? null;
  return {
    action: singleLine(action, 80),
    permission,
    risk: planStep?.risk ?? definition?.risk ?? 'unknown',
    scope: definition?.resourceScope
      ? { recorded: true, resource: singleLine(definition.resourceScope, 240) }
      : { recorded: false, resource: null },
    reversibility: planStep?.reversibility ?? (permission === 'read' ? 'read_only' : 'unknown'),
  };
}

function combinedRisk(capabilities) {
  const values = capabilities.map((capability) => capability.risk);
  const rank = { low: 0, medium: 1, high: 2 };
  if (values.length === 0 || values.some((value) => !Object.hasOwn(rank, value))) return 'unknown';
  return values.reduce((worst, value) => rank[value] > rank[worst] ? value : worst, 'low');
}

function projectApprovalItems({ tasks = [], plans = [], situation = null, situationRows = [], registry = null } = {}) {
  const planById = new Map((Array.isArray(plans) ? plans : []).map((plan) => [String(plan.id), plan]));
  const items = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const linkedPlan = task.planId ? planById.get(String(task.planId)) : null;
    if (task.status === 'proposed') {
      const capabilities = steps.map((step) => {
        const planStep = linkedPlan?.steps?.find((candidate) => candidate.id === step.id) ?? null;
        return approvalCapability(step.action, registry, planStep, step);
      });
      items.push({
        id: `task:${String(task.id)}`,
        kind: 'task_plan',
        taskId: String(task.id),
        taskOrigin: task.origin ?? null,
        planner: task.planner ?? null,
        at: task.createdAt ?? null,
        request: singleLine(task.goal, 400),
        capabilities,
        risk: combinedRisk(capabilities),
        reversibility: capabilities.map(({ action, reversibility }) => ({ action, value: reversibility })),
        expiresAt: null,
        expiryStatus: 'not_recorded',
      });
    }
    for (const step of steps) {
      if (step.status !== 'awaiting_approval') continue;
      const planStep = linkedPlan?.steps?.find((candidate) => candidate.id === step.id) ?? null;
      const capability = approvalCapability(step.action, registry, planStep, step);
      items.push({
        id: `task-step:${String(task.id)}:${String(step.id)}`,
        kind: 'task_step',
        taskId: String(task.id),
        stepId: String(step.id),
        taskOrigin: task.origin ?? null,
        planner: task.planner ?? null,
        at: task.updatedAt ?? task.createdAt ?? null,
        request: singleLine(step.description || step.action, 400),
        capabilities: [capability],
        risk: capability.risk,
        reversibility: capability.reversibility,
        expiresAt: null,
        expiryStatus: 'not_recorded',
      });
    }
  }
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (plan.status !== 'draft' || plan.approval) continue;
    const capabilities = (Array.isArray(plan.steps) ? plan.steps : []).map((step) => approvalCapability(step.action, registry, step));
    items.push({
      id: `plan:${String(plan.id)}`,
      kind: 'plan',
      planId: String(plan.id),
      version: Number.isSafeInteger(plan.version) ? plan.version : null,
      at: plan.updatedAt ?? plan.createdAt ?? null,
      request: singleLine(plan.outcome, 400),
      capabilities,
      risk: combinedRisk(capabilities),
      reversibility: capabilities.map(({ action, reversibility }) => ({ action, value: reversibility })),
      expiresAt: null,
      expiryStatus: 'not_recorded',
    });
  }
  const eventRows = Array.isArray(situationRows) ? situationRows : [];
  const situationState = situation && typeof situation === 'object' ? situation : null;
  const pendingSituational = Array.isArray(situationState?.pendingApprovals) ? situationState.pendingApprovals : [];
  for (const pending of pendingSituational) {
    const row = eventRows.find((candidate) => candidate?.event?.id === pending.eventId) ?? null;
    const event = row?.event ?? null;
    items.push({
      id: `situation:${String(pending.decisionId)}`,
      kind: 'situation',
      decisionId: String(pending.decisionId),
      eventId: String(pending.eventId),
      at: pending.at ?? event?.at ?? null,
      request: singleLine(pending.reason || event?.payload?.summary || event?.type || 'situational approval request', 400),
      requestedAction: pending.action ?? null,
      recordedSignificance: row?.assessment?.significance?.level ?? null,
      eventScope: event ? {
        source: singleLine(event.source, 64),
        category: singleLine(event.category, 40),
        type: singleLine(event.type, 160),
        refs: [
          ...(event.goalRefs ?? []).map((id) => `goal:${singleLine(id, 64)}`),
          ...(event.planRefs ?? []).map((id) => `plan:${singleLine(id, 64)}`),
          ...(event.taskRefs ?? []).map((id) => `task:${singleLine(id, 64)}`),
        ].slice(0, 12),
        stale: event.validUntil !== null && event.validUntil !== undefined && Date.parse(event.validUntil) <= Date.parse(situationState.at ?? new Date().toISOString()),
      } : null,
      capabilities: [],
      risk: 'unknown',
      reversibility: 'not_applicable_no_action_named',
      expiresAt: null,
      expiryStatus: 'not_recorded',
      provenance: event?.provenance ? {
        origin: event.provenance.origin ?? null,
        reporter: event.provenance.reporter ?? null,
        operationId: event.provenance.operationId ?? null,
        provider: event.provenance.provider ?? null,
      } : null,
    });
  }
  items.sort((left, right) => Date.parse(right.at ?? 0) - Date.parse(left.at ?? 0));
  return {
    items: items.slice(0, UI_LIMITS.maxWorkItems),
    total: items.length,
    truncated: items.length > UI_LIMITS.maxWorkItems,
    situationalTotal: Number.isSafeInteger(situationState?.counts?.pendingApprovals) ? situationState.counts.pendingApprovals : pendingSituational.length,
    situationalTruncated: Number.isSafeInteger(situationState?.counts?.pendingApprovals)
      && situationState.counts.pendingApprovals > pendingSituational.length,
  };
}

// The T-17 planning read is derived from an objective the user types here and the live registry;
// it is never stored. This projection is bounded and copies strings, like every other one, so the
// page can only display what the controller reported, and it adds no authority: the flags below
// stay false whatever the controller said, because a view cannot record, approve, or run a plan.
function planningItems(items, limit = 10) {
  return (Array.isArray(items) ? items : []).slice(0, limit).map((item) => ({
    text: singleLine(item.text, 240),
    basis: item.basis ?? null,
    field: item.field ?? null,
  }));
}

function projectPlanning(planning) {
  if (!planning || typeof planning !== 'object') return null;
  const intake = planning.intake && typeof planning.intake === 'object' ? planning.intake : {};
  const ambiguity = planning.ambiguity && typeof planning.ambiguity === 'object' ? planning.ambiguity : null;
  return {
    schema: planning.schema ?? null,
    digest: planning.digest ?? null,
    counts: planning.counts ?? null,
    objective: intake.objective
      ? { text: singleLine(intake.objective.text, 400), basis: intake.objective.basis ?? null }
      : null,
    goal: planning.goal ?? null,
    constraints: planningItems(intake.constraints),
    deliverables: planningItems(intake.deliverables),
    resources: planningItems(intake.resources),
    preferences: planningItems(intake.preferences),
    deadlines: planningItems(intake.deadlines),
    priorities: planningItems(intake.priorities),
    successCriteria: planningItems(intake.successCriteria, 8),
    unknowns: planningItems(intake.unknowns),
    assumptions: planningItems(intake.assumptions),
    milestones: (Array.isArray(planning.milestones) ? planning.milestones : []).slice(0, 8).map((milestone) => ({
      id: milestone.id,
      title: singleLine(milestone.title, 120),
      steps: (Array.isArray(milestone.steps) ? milestone.steps : []).slice(0, 12).map((id) => String(id)),
      checkpoint: singleLine(milestone.checkpoint, 200),
      basis: milestone.basis ?? null,
    })),
    tasks: (Array.isArray(planning.tasks) ? planning.tasks : []).slice(0, 24).map((task) => ({
      id: task.id,
      kind: task.kind ?? null,
      class: task.class ?? null,
      description: singleLine(task.description ?? task.text, 200),
      action: task.action ? singleLine(task.action, 60) : null,
      permission: task.permission ?? null,
      dependsOn: (Array.isArray(task.dependsOn) ? task.dependsOn : []).slice(0, 8).map((id) => String(id)),
      milestoneId: task.milestoneId ?? null,
      because: singleLine(task.because, 240),
      nearby: (Array.isArray(task.nearby) ? task.nearby : []).slice(0, 4).map((name) => String(name)),
    })),
    conflicts: planningItems(planning.conflicts, 8),
    ambiguity: ambiguity
      ? {
        material: ambiguity.material === true,
        because: singleLine(ambiguity.because, 240),
        interpretations: (Array.isArray(ambiguity.interpretations) ? ambiguity.interpretations : []).slice(0, 4)
          .map((alt) => ({ title: singleLine(alt.title, 120), note: singleLine(alt.note, 200) })),
        questions: (Array.isArray(ambiguity.questions) ? ambiguity.questions : []).slice(0, 6)
          .map((q) => ({ question: singleLine(q.question, 240), candidates: (Array.isArray(q.candidates) ? q.candidates : []).slice(0, 4).map((c) => String(c)) })),
      }
      : null,
    feasibility: planning.feasibility ? singleLine(planning.feasibility.statement, 300) : null,
    approval: planning.approval
      ? { required: planning.approval.required === true, bound: planning.approval.bound === true, path: singleLine(planning.approval.path, 300) }
      : null,
    draft: planning.draft
      ? { available: planning.draft.available === true, recordable: planning.draft.recordable === true }
      : null,
    uncertainty: (Array.isArray(planning.uncertainty) ? planning.uncertainty : []).slice(0, 8)
      .map((line) => singleLine(line, 240)),
    authorizes: false,
    recorded: false,
    approved: false,
    executable: false,
  };
}

export function createUiServer({
  app,
  token,
  host = '127.0.0.1',
  port = 0,
  heartbeatMs = UI_LIMITS.heartbeatMs,
  ownerPollMs = UI_LIMITS.ownerPollMs,
  stateEventHistoryLimit = UI_LIMITS.maxStateEventHistory,
  chatTimeoutMs = UI_LIMITS.chatTimeoutMs,
  now = () => new Date(),
} = {}) {
  if (!app || typeof app.controller?.handle !== 'function' || typeof app.controller?.approveTask !== 'function') {
    throw new Error('createUiServer requires an APEX application');
  }
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('the UI binds to loopback only');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('heartbeatMs must be a positive integer');
  if (!Number.isSafeInteger(ownerPollMs) || ownerPollMs < 1) throw new Error('ownerPollMs must be a positive integer');
  const authToken = token ?? randomBytes(24).toString('hex');
  if (!TOKEN_RE.test(authToken)) throw new Error('the UI token must be 16-128 letters, digits, dash or underscore');

  const subscribers = new Set();
  const stateEventHistory = new BoundedEventHistory(stateEventHistoryLimit);
  const streamId = randomBytes(16).toString('hex');
  const ownerStates = Object.create(null);
  const ownerVersions = Object.create(null);
  let chatInFlight = false;
  let listeningPort = null;
  let eventSeq = 0;
  let fileWatcher = null;
  let ownerPollTimer = null;
  let ownerRefreshTimer = null;
  let ownerFileSignature = null;
  let ownerRefreshRunning = false;
  let ownerRefreshAgain = false;

  function presented(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = cookiesOf(req.headers.cookie).apex_ui;
    if (typeof cookie === 'string' && cookie.length > 0) return cookie;
    if (url.pathname === '/api/events' && url.searchParams.has('token')) return url.searchParams.get('token');
    return null;
  }

  function authorized(req, url) {
    return tokensMatch(presented(req, url), authToken);
  }

  function makeFrame(event, data, id = null) {
    const idLine = id === null ? '' : `id: ${id}\n`;
    return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function writeFrame(sub, event, data, id = null) {
    if (sub.res.writableEnded || sub.res.destroyed) {
      unsubscribe(sub);
      return false;
    }
    const frame = makeFrame(event, data, id);
    const bytes = Buffer.byteLength(frame);
    if (bytes > UI_LIMITS.maxEventFrameBytes
      || !canQueueEventFrame(sub.res.writableLength, bytes, UI_LIMITS.maxBufferedBytes)) return false;
    try {
      sub.res.write(frame);
      return true;
    } catch {
      unsubscribe(sub);
      return false;
    }
  }

  function writeComment(sub, text) {
    if (sub.res.writableEnded || sub.res.destroyed) {
      unsubscribe(sub);
      return false;
    }
    const frame = `: ${text}\n\n`;
    const bytes = Buffer.byteLength(frame);
    if (!canQueueEventFrame(sub.res.writableLength, bytes, UI_LIMITS.maxBufferedBytes)) return false;
    try {
      sub.res.write(frame);
      return true;
    } catch {
      unsubscribe(sub);
      return false;
    }
  }

  function broadcast(event, data) {
    for (const sub of subscribers) {
      if (sub.needsReconcile) continue;
      writeFrame(sub, event, data);
    }
  }

  function unsubscribe(sub) {
    if (sub.timer) clearInterval(sub.timer);
    subscribers.delete(sub);
  }

  function cursorId(sequence = eventSeq) {
    return `${streamId}:${sequence}`;
  }

  function parseCursor(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const match = /^([a-f0-9]{32}):(0|[1-9][0-9]{0,15})$/.exec(value);
    if (!match) return null;
    const sequence = Number(match[2]);
    return Number.isSafeInteger(sequence) ? { streamId: match[1], seq: sequence } : null;
  }

  async function captureOwner(read, project) {
    try {
      const value = await read();
      return { available: true, ...project(value) };
    } catch (error) {
      return { available: false, error: singleLine(error?.message ?? error, 240) };
    }
  }

  async function captureRows(label, store, project) {
    try {
      if (!store || typeof store.list !== 'function') throw new Error(`${label} is not configured`);
      const rows = await store.list();
      if (!Array.isArray(rows)) throw new Error(`${label} returned an invalid list`);
      return { rows, state: project(rows), error: null };
    } catch (error) {
      const message = singleLine(error?.message ?? error, 240);
      return { rows: null, state: { available: false, error: message }, error: message };
    }
  }

  async function readOwnerStates() {
    const [taskRead, planRead, lockdown, runtime, health, conversation] = await Promise.all([
      captureRows('TaskStore', app.taskStore, projectOwnerTasks),
      captureRows('PlanStore', app.plans, projectOwnerPlans),
      captureOwner(() => {
        if (typeof app.ecp?.killSwitchStatus !== 'function') throw new Error('ECP kill-switch status is unavailable');
        const status = app.ecp.killSwitchStatus();
        if (!status || typeof status !== 'object' || Array.isArray(status)
          || typeof status.active !== 'boolean' || typeof status.policyUnavailable !== 'boolean') {
          throw new Error('ECP kill-switch status is malformed');
        }
        return status;
      }, (status) => ({
        active: status.active,
        policyUnavailable: status.policyUnavailable,
        activatedAt: status.activatedAt ?? null,
        reason: status.reason === null || status.reason === undefined ? null : singleLine(status.reason, 300),
        persistence: singleLine(status.persistence ?? 'unknown', 80),
      })),
      captureOwner(async () => {
        if (typeof app.runtime?.status !== 'function') throw new Error('runtime status is unavailable');
        const status = await app.runtime.status();
        if (!status || typeof status !== 'object' || Array.isArray(status)
          || typeof status.lifecycle !== 'string' || typeof status.paused !== 'boolean') {
          throw new Error('runtime status is malformed');
        }
        return status;
      }, (status) => ({
        lifecycle: singleLine(status.lifecycle, 32),
        runtimeId: status.runtimeId ?? null,
        paused: status.paused,
        ticks: Number.isSafeInteger(status.ticks) ? status.ticks : null,
        backlog: Number.isSafeInteger(status.backlog) ? status.backlog : null,
        lastError: status.lastError ? singleLine(status.lastError, 240) : null,
        corruption: status.corruption ? singleLine(status.corruption.reason ?? status.corruption, 240) : null,
      })),
      captureOwner(async () => collectHealth(app, { checkModel: false }), (status) => {
        const healthStates = ['healthy', 'unknown', 'degraded', 'blocked', 'failed'];
        if (!status || !healthStates.includes(status.overall)
          || !Array.isArray(status.areas) || !Array.isArray(status.attention) || !Array.isArray(status.errors)
          || status.areas.some((area) => !area || typeof area.key !== 'string'
            || typeof area.state !== 'string' || !healthStates.includes(area.state)
            || typeof area.summary !== 'string'
            || (area.advisory !== undefined && typeof area.advisory !== 'boolean'))
          || status.attention.some((item) => !item || typeof item.kind !== 'string' || typeof item.severity !== 'string')) {
          throw new Error('health projection is malformed');
        }
        const coreAttentionCounts = { approval: 0, uncertain: 0, other: 0 };
        for (const item of status.attention) {
          if (item.kind === 'approval' && item.severity === 'blocked') coreAttentionCounts.approval += 1;
          else if (item.kind === 'uncertain-step' && item.severity === 'degraded') coreAttentionCounts.uncertain += 1;
          else coreAttentionCounts.other += 1;
        }
        return {
          overall: status.overall,
          areas: status.areas.slice(0, 32).map((area) => ({
            key: singleLine(area.key, 48),
            state: area.state,
            summary: singleLine(area.summary, 240),
            advisory: area.advisory === true,
          })),
          unhealthyAreaCount: status.areas.filter((area) => area.state !== 'healthy' && area.advisory !== true).length,
          coreAttentionCounts,
          attentionCount: status.attention.length,
          errorCount: status.errors.length,
        };
      }),
      captureOwner(async () => {
        if (typeof app.session?.peek !== 'function' || typeof app.conversation?.status !== 'function') {
          throw new Error('conversation state is unavailable');
        }
        const [session, transcript] = await Promise.all([app.session.peek(), app.conversation.status()]);
        return { session, transcript };
      }, ({ session, transcript }) => ({
        sessionStatus: singleLine(session?.status ?? 'unavailable', 24),
        sessionId: session?.state?.sessionId ?? null,
        turnCount: Number.isSafeInteger(transcript?.turns) ? transcript.turns : null,
        corruptCount: Number.isSafeInteger(transcript?.corrupt) ? transcript.corrupt : null,
      })),
    ]);

    const approval = taskRead.rows && planRead.rows
      ? projectApprovals(taskRead.rows, planRead.rows)
      : {
        available: false,
        error: taskRead.error ?? planRead.error ?? 'task or plan approval state is unavailable',
      };
    return {
      tasks: taskRead.state,
      plans: planRead.state,
      approval,
      lockdown,
      runtime,
      health,
      conversation,
    };
  }

  function availabilityOf(sources) {
    const values = Object.values(sources);
    const available = values.filter((source) => source?.available === true).length;
    return available === values.length ? 'available' : available === 0 ? 'unavailable' : 'partial';
  }

  async function missionControlSnapshot() {
    const [goals, plans, tasks] = await Promise.all([
      captureRows('GoalStore', app.goals, (rows) => ({
        total: rows.length,
        truncated: rows.length > UI_LIMITS.maxWorkItems,
        items: rows.slice(0, UI_LIMITS.maxWorkItems).map(projectGoal),
      })),
      captureRows('PlanStore', app.plans, (rows) => ({
        total: rows.length,
        truncated: rows.length > UI_LIMITS.maxWorkItems,
        items: rows.slice(0, UI_LIMITS.maxWorkItems).map(projectPlan),
      })),
      captureRows('TaskStore', app.taskStore, (rows) => ({
        total: rows.length,
        truncated: rows.length > UI_LIMITS.maxWorkItems,
        items: rows.slice(0, UI_LIMITS.maxWorkItems).map(projectTask),
      })),
    ]);
    const sources = {
      goals: goals.rows ? { available: true, ...goals.state } : goals.state,
      plans: plans.rows ? { available: true, ...plans.state } : plans.state,
      tasks: tasks.rows ? { available: true, ...tasks.state } : tasks.state,
    };
    return { status: availabilityOf(sources), at: now().toISOString(), sources };
  }

  async function approvalCentreSnapshot() {
    const [taskRead, planRead, situationRead] = await Promise.all([
      captureRows('TaskStore', app.taskStore, (rows) => ({ available: true, total: rows.length })),
      captureRows('PlanStore', app.plans, (rows) => ({ available: true, total: rows.length })),
      captureOwner(async () => {
        if (typeof app.situation?.state !== 'function' || typeof app.situation?.events !== 'function') {
          throw new Error('situational approval state is unavailable');
        }
        const [state, eventPage] = await Promise.all([
          app.situation.state({ limit: 20 }),
          app.situation.events({ limit: UI_LIMITS.maxWorkItems }),
        ]);
        if (!state || !Array.isArray(state.pendingApprovals) || !eventPage || !Array.isArray(eventPage.rows)) {
          throw new Error('situational approval state is malformed');
        }
        return { state, eventPage };
      }, ({ state, eventPage }) => ({
        state,
        eventPage,
        total: Number.isSafeInteger(state.counts?.pendingApprovals) ? state.counts.pendingApprovals : state.pendingApprovals.length,
        truncated: eventPage.truncated === true,
      })),
    ]);
    const sources = {
      tasks: taskRead.state,
      plans: planRead.state,
      situation: situationRead.available
        ? { available: true, total: situationRead.total, truncated: situationRead.truncated }
        : { available: false, error: situationRead.error },
    };
    const projection = projectApprovalItems({
      tasks: taskRead.rows ?? [],
      plans: planRead.rows ?? [],
      situation: situationRead.available ? situationRead.state : null,
      situationRows: situationRead.available ? situationRead.eventPage.rows : [],
      registry: app.registry,
    });
    const status = availabilityOf(sources);
    const knownTotal = projection.total;
    const items = projection.items.map((item) => {
      const row = item.kind === 'situation'
        ? (situationRead.eventPage?.rows ?? []).find((candidate) => candidate?.event?.id === item.eventId)
        : null;
      return {
        ...item,
        basis: item.kind === 'situation' ? 'recorded_observation' : 'owner_record',
        ...(row?.event ? {
          event: {
            source: singleLine(row.event.source, 64),
            sourceEventId: singleLine(row.event.sourceEventId, 128),
            summary: singleLine(row.event.payload?.summary ?? row.event.type, 300),
          },
        } : {}),
      };
    });
    const situationalOmitted = Math.max(0, projection.situationalTotal - (situationRead.available ? situationRead.state.pendingApprovals.length : 0));
    return {
      status,
      available: status !== 'unavailable',
      at: now().toISOString(),
      sources,
      items,
      total: knownTotal + situationalOmitted,
      truncated: projection.truncated || projection.situationalTruncated || situationalOmitted > 0,
      note: 'Only owner-recorded requests are listed. Risk, scope, reversibility, and expiry are shown as unknown or not recorded when their owner has no such field.',
    };
  }

  async function timelineSnapshot(limit = UI_LIMITS.maxWorkItems) {
    const bound = Number.isInteger(limit) ? Math.max(1, Math.min(limit, UI_LIMITS.maxWorkItems)) : UI_LIMITS.maxWorkItems;
    const [memoryRead, knowledgeRead, worldRead] = await Promise.all([
      captureOwner(async () => {
        if (typeof app.memory?.list !== 'function' || typeof app.memory?.status !== 'function') throw new Error('memory is not configured');
        const [records, status] = await Promise.all([
          app.memory.list({ limit: bound }),
          app.memory.status(),
        ]);
        if (!Array.isArray(records) || !Number.isSafeInteger(status.records)) throw new Error('memory timeline read is malformed');
        return { records, total: status.records, corrupt: status.corrupt };
      }, ({ records, total, corrupt }) => ({
        total,
        corrupt: Number.isSafeInteger(corrupt) ? corrupt : null,
        truncated: total > records.length,
        items: records.map((record) => ({
          id: String(record.id),
          kind: Array.isArray(record.provenance?.replaces) && record.provenance.replaces.length > 0 ? 'correction' : 'memory',
          at: record.createdAt,
          summary: singleLine(record.content, 1000),
          status: record.status ?? null,
          provenance: {
            source: record.source ?? null,
            memoryKind: record.kind ?? null,
            origin: record.provenance?.origin ?? null,
            operationId: record.provenance?.operationId ?? null,
            updateMode: record.provenance?.updateMode ?? null,
            backend: record.provenance?.backend ?? null,
            replaces: (record.provenance?.replaces ?? []).slice(0, 8),
            replacedBy: (record.replacedBy ?? []).slice(0, 8),
          },
        })),
      })),
      captureOwner(async () => {
        if (typeof app.knowledge?.timeline !== 'function') throw new Error('knowledge timeline is not configured');
        return app.knowledge.timeline({ limit: bound });
      }, (page) => {
        if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total)) throw new Error('knowledge timeline read is malformed');
        return { total: page.total, truncated: page.truncated === true, items: page.items };
      }),
      captureOwner(async () => {
        if (typeof app.worldModel?.timeline !== 'function') throw new Error('world model timeline is not configured');
        return app.worldModel.timeline({ limit: bound });
      }, (page) => {
        if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total)) throw new Error('world model timeline read is malformed');
        return { total: page.total, truncated: page.truncated === true, items: page.items };
      }),
    ]);
    const sources = { memory: memoryRead, knowledge: knowledgeRead, world: worldRead };
    const collected = [];
    for (const [source, result] of Object.entries(sources)) {
      if (result.available !== true || !Array.isArray(result.items)) continue;
      for (const item of result.items) collected.push({ ...item, source });
    }
    collected.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0) || String(a.id).localeCompare(String(b.id)));
    const total = Object.values(sources).reduce((sum, source) => sum + (source.available === true && Number.isSafeInteger(source.total) ? source.total : 0), 0);
    const truncated = collected.length > bound
      || Object.values(sources).some((source) => source.available === true && source.truncated === true);
    const availableSources = Object.values(sources).filter((source) => source.available === true).length;
    const damaged = memoryRead.available === true && Number.isSafeInteger(memoryRead.corrupt) && memoryRead.corrupt > 0;
    const status = availableSources === 0 ? 'unavailable'
      : availableSources < Object.keys(sources).length || damaged ? 'partial' : 'available';
    return {
      status,
      at: now().toISOString(),
      sources,
      items: collected.slice(0, bound),
      total,
      limit: bound,
      truncated,
    };
  }

  async function briefingSnapshot() {
    const [goals, plans, tasks, situation] = await Promise.all([
      captureRows('GoalStore', app.goals, (rows) => ({ total: rows.length })),
      captureRows('PlanStore', app.plans, (rows) => ({ total: rows.length })),
      captureRows('TaskStore', app.taskStore, (rows) => ({ total: rows.length })),
      captureOwner(async () => {
        if (typeof app.situation?.state !== 'function') throw new Error('SituationStore is not configured');
        const value = await app.situation.state({ limit: 20 });
        if (!value || !Array.isArray(value.alerts) || !Array.isArray(value.recent)) throw new Error('SituationStore returned an invalid briefing view');
        return value;
      }, (value) => ({
        total: Number.isSafeInteger(value.counts?.events) ? value.counts.events : value.recent.length,
        alerts: value.alerts,
        observations: value.recent,
      })),
    ]);
    const sources = {
      goals: goals.rows ? { available: true, ...goals.state } : goals.state,
      plans: plans.rows ? { available: true, ...plans.state } : plans.state,
      tasks: tasks.rows ? { available: true, ...tasks.state } : tasks.state,
      situation: situation.available === true
        ? { available: true, total: situation.total }
        : { available: false, error: situation.error },
    };
    const status = availabilityOf(sources);
    const briefing = buildBriefing({
      goals: (goals.rows ?? []).map((goal) => ({ ...goal, title: goal.request ?? goal.title ?? goal.id })),
      plans: plans.rows ?? [],
      tasks: tasks.rows ?? [],
      situation: situation.available === true
        ? { alerts: situation.alerts, observations: situation.observations }
        : null,
      now,
    });
    const counts = { ...briefing.counts };
    if (!goals.rows) counts.goals = null;
    if (!plans.rows) counts.plans = null;
    if (!tasks.rows) {
      counts.tasks = null;
      counts.approvals = null;
      counts.blocked = null;
      counts.running = null;
    }
    if (!situation.available) counts.alerts = null;
    const countText = (key) => sources[key].available === true ? String(sources[key].total) : 'unavailable';
    const concise = [
      'Goals: ' + countText('goals'),
      'Plans: ' + countText('plans'),
      'Tasks: ' + countText('tasks'),
      'Situational events: ' + countText('situation'),
    ].join(' | ');
    return {
      ...briefing,
      status,
      available: status !== 'unavailable',
      sources,
      counts,
      concise,
      inferred: tasks.rows ? briefing.inferred : [],
      note: briefing.note + ' A partial status means at least one owner could not be read; unavailable counts are not zero.',
    };
  }

  async function situationSnapshot(limit = 20) {
    if (typeof app.situation?.state !== 'function' || typeof app.situation?.events !== 'function') {
      throw new Error('situational awareness is not configured');
    }
    const [state, eventPage] = await Promise.all([
      app.situation.state({ limit }),
      app.situation.events({ limit: Math.min(limit, UI_LIMITS.maxWorkItems) }),
    ]);
    const byId = new Map(eventPage.rows.map((row) => [row.event.id, row]));
    return {
      ...state,
      recent: (Array.isArray(state.recent) ? state.recent : []).map((entry) => {
        const row = byId.get(entry.id);
        const event = row?.event;
        return {
          ...entry,
          summary: singleLine(event?.payload?.summary ?? event?.type ?? entry.type, 300),
          sourceEventId: event?.sourceEventId ?? null,
          validUntil: event?.validUntil ?? null,
          basis: 'recorded_observation',
          provenance: event?.provenance ? {
            origin: event.provenance.origin ?? null,
            reporter: event.provenance.reporter ?? null,
            operationId: event.provenance.operationId ?? null,
            provider: event.provenance.provider ?? null,
          } : null,
          refs: event ? {
            entities: (event.entityRefs ?? []).slice(0, 12),
            goals: (event.goalRefs ?? []).slice(0, 12),
            plans: (event.planRefs ?? []).slice(0, 12),
            tasks: (event.taskRefs ?? []).slice(0, 12),
          } : null,
        };
      }),
      recentTruncated: eventPage.truncated === true,
      recentTotal: eventPage.total,
    };
  }

  function publishOwnerSnapshots(next) {
    const emitted = [];
    for (const owner of STATE_EVENT_OWNERS) {
      const value = next[owner];
      if (!Object.hasOwn(ownerStates, owner)) {
        ownerStates[owner] = value;
        ownerVersions[owner] = 1;
        continue;
      }
      if (JSON.stringify(ownerStates[owner]) === JSON.stringify(value)) continue;
      ownerStates[owner] = value;
      ownerVersions[owner] += 1;
      eventSeq += 1;
      const envelope = Object.freeze({
        schema: STATE_EVENT_SCHEMA,
        streamId,
        seq: eventSeq,
        at: now().toISOString(),
        type: 'state-changed',
        category: owner,
        version: ownerVersions[owner],
        payload: value,
        correlationId: null,
      });
      emitted.push(envelope);
    }
    for (const envelope of emitted) {
      stateEventHistory.push(envelope);
      for (const sub of subscribers) sendOwnerEvent(sub, envelope);
    }
  }

  function reconciliationEnvelope(reason) {
    return Object.freeze({
      schema: STATE_EVENT_SCHEMA,
      streamId,
      seq: eventSeq,
      at: now().toISOString(),
      type: 'reconcile',
      versions: Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, ownerVersions[owner]])),
      payload: {
        reason: singleLine(reason, 80),
        snapshotUrl: '/api/state',
        owners: Object.fromEntries(STATE_EVENT_OWNERS.map((owner) => [owner, ownerStates[owner]])),
      },
    });
  }

  function sendReconciliation(sub, reason) {
    const envelope = reconciliationEnvelope(reason);
    const sent = writeFrame(sub, 'reconcile', envelope, cursorId(envelope.seq));
    sub.needsReconcile = !sent;
    return sent;
  }

  function sendOwnerEvent(sub, envelope) {
    if (sub.needsReconcile) return false;
    const sent = writeFrame(sub, 'state-changed', envelope, cursorId(envelope.seq));
    if (!sent) sub.needsReconcile = true;
    return sent;
  }

  function sendHeartbeat(sub) {
    if (sub.res.writableEnded || sub.res.destroyed) {
      unsubscribe(sub);
      return;
    }
    if (sub.needsReconcile && !sendReconciliation(sub, 'subscriber-backpressure')) return;
    if (!writeComment(sub, 'ping')) {
      sub.needsReconcile = true;
      return;
    }
    const heartbeat = { schema: HEARTBEAT_SCHEMA, streamId, headSeq: eventSeq, at: now().toISOString() };
    if (!writeFrame(sub, 'heartbeat', heartbeat)) sub.needsReconcile = true;
  }

  function fileFingerprint(filename) {
    try {
      const stat = fs.statSync(path.join(app.dataDir, filename), { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
    } catch (error) {
      return error?.code === 'ENOENT' ? 'missing' : `error:${error?.code ?? 'unknown'}`;
    }
  }

  function currentOwnerFileSignature() {
    return MONITORED_DATA_FILES.map((filename) => `${filename}=${fileFingerprint(filename)}`).join('\n');
  }

  async function refreshOwnerSources() {
    if (ownerRefreshRunning) {
      ownerRefreshAgain = true;
      return;
    }
    ownerRefreshRunning = true;
    let passes = 0;
    try {
      do {
        ownerRefreshAgain = false;
        const before = currentOwnerFileSignature();
        const next = await readOwnerStates();
        const after = currentOwnerFileSignature();
        ownerFileSignature = after;
        publishOwnerSnapshots(next);
        passes += 1;
        if (before !== after && passes < 2) ownerRefreshAgain = true;
      } while (ownerRefreshAgain && passes < 2);
    } finally {
      ownerRefreshRunning = false;
      if (ownerRefreshAgain) {
        ownerRefreshAgain = false;
        scheduleOwnerRefresh();
      }
    }
  }

  function scheduleOwnerRefresh() {
    if (ownerRefreshRunning) {
      ownerRefreshAgain = true;
      return;
    }
    if (ownerRefreshTimer) clearTimeout(ownerRefreshTimer);
    ownerRefreshTimer = setTimeout(() => {
      ownerRefreshTimer = null;
      refreshOwnerSources().catch(() => {});
    }, 60);
    if (typeof ownerRefreshTimer.unref === 'function') ownerRefreshTimer.unref();
  }

  function startOwnerMonitoring() {
    ownerFileSignature = currentOwnerFileSignature();
    try {
      fileWatcher = fs.watch(app.dataDir, { persistent: false }, (_eventType, filename) => {
        const name = filename === null || filename === undefined ? null : String(filename);
        if (name && (name.endsWith('.lock') || name.endsWith('.tmp'))) return;
        scheduleOwnerRefresh();
      });
      fileWatcher.on('error', () => {
        try { fileWatcher?.close(); } catch { /* the metadata poll remains a fallback */ }
        fileWatcher = null;
      });
    } catch {
      fileWatcher = null;
    }
    ownerPollTimer = setInterval(() => {
      const signature = currentOwnerFileSignature();
      if (signature === ownerFileSignature) return;
      ownerFileSignature = signature;
      scheduleOwnerRefresh();
    }, ownerPollMs);
    if (typeof ownerPollTimer.unref === 'function') ownerPollTimer.unref();
  }

  function stopOwnerMonitoring() {
    try { fileWatcher?.close(); } catch { /* already closed */ }
    fileWatcher = null;
    if (ownerPollTimer) clearInterval(ownerPollTimer);
    ownerPollTimer = null;
    if (ownerRefreshTimer) clearTimeout(ownerRefreshTimer);
    ownerRefreshTimer = null;
  }

  function sendReplayOrReconcile(req, res, url, sub) {
    const rawCursor = req.headers['last-event-id'];
    if (url.searchParams.get('reconcile') === '1') {
      sendReconciliation(sub, 'requested');
      return;
    }
    if (rawCursor === undefined) {
      sendReconciliation(sub, 'initial');
      return;
    }
    const cursor = parseCursor(rawCursor);
    if (!cursor) {
      sendReconciliation(sub, 'invalid-cursor');
      return;
    }
    if (cursor.streamId !== streamId) {
      sendReconciliation(sub, 'stream-changed');
      return;
    }
    const replay = stateEventHistory.replayAfter(cursor.seq);
    if (replay === null) {
      sendReconciliation(sub, 'history-unavailable');
      return;
    }
    for (const envelope of replay) {
      if (!sendOwnerEvent(sub, envelope)) break;
    }
    if (sub.needsReconcile) sendReconciliation(sub, 'replay-backpressure');
  }

  function subscribe(req, res, url) {
    if (subscribers.size >= UI_LIMITS.maxSubscribers) return false;
    res.writeHead(200, baseHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    }));
    res.write('retry: 5000\n\n');
    const sub = { res, timer: null, needsReconcile: false };
    subscribers.add(sub);
    res.on('close', () => unsubscribe(sub));
    writeFrame(sub, 'hello', { streamId, headSeq: eventSeq, at: now().toISOString() });
    sendReplayOrReconcile(req, res, url, sub);
    sub.timer = setInterval(() => sendHeartbeat(sub), heartbeatMs);
    if (typeof sub.timer.unref === 'function') sub.timer.unref();
    return true;
  }

  async function snapshot() {
    let session = { id: null, status: 'missing', unavailable: null };
    let turns = [];
    const inspected = typeof app.session?.peek === 'function' ? await app.session.peek() : null;
    if (inspected && inspected.status === 'ok') {
      session = { id: inspected.state.sessionId, status: 'ok', unavailable: null };
      try {
        // The transcript, not the replay window: the page must show the answer the user received,
        // including turns the model path never replays (a deterministic reading is stored as a notice).
        const rows = await app.conversation.transcript(inspected.state.sessionId, UI_LIMITS.maxTurns);
        if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
          || typeof row.role !== 'string' || typeof row.text !== 'string')) {
          throw new Error('conversation transcript contains an invalid turn');
        }
        turns = rows.map((row) => ({
          role: row.role === 'user' ? 'user' : 'apex',
          origin: row.origin ?? null,
          text: singleLine(row.text, 8000),
          verified: row.verified === true,
          at: row.createdAt ?? null,
          taskId: row.taskId ?? null,
        }));
      } catch (err) {
        session.unavailable = `conversation history is unavailable: ${err.message}`;
      }
    } else if (inspected && (inspected.status === 'corrupt' || inspected.status === 'unavailable')) {
      session = { id: null, status: inspected.status, unavailable: `session state is ${inspected.status}: ${inspected.detail}` };
    }

    let tasks = [];
    try {
      const all = await app.taskStore.list();
      tasks = all.slice(0, UI_LIMITS.maxWorkItems).map(projectTask);
    } catch (err) {
      tasks = [];
      session.unavailable = session.unavailable ?? `task records are unavailable: ${err.message}`;
    }
    let plans = [];
    try {
      const all = await app.plans.list();
      plans = all.slice(0, UI_LIMITS.maxWorkItems).map(projectPlan);
    } catch (err) {
      plans = [];
      session.unavailable = session.unavailable ?? `plan records are unavailable: ${err.message}`;
    }

    let goals = [];
    try {
      const all = await app.goals?.list?.() ?? [];
      goals = (Array.isArray(all) ? all : []).slice(0, UI_LIMITS.maxWorkItems).map(projectGoal);
    } catch (err) {
      goals = [];
      session.unavailable = session.unavailable ?? `goal records are unavailable: ${err.message}`;
    }

    // T-09: the same service the CLI reads. A damaged or unavailable situational log is reported
    // as unavailable-with-detail, never as an empty environment.
    let situation = null;
    try {
      situation = app.situation && typeof app.situation.state === 'function'
        ? await app.situation.state({ limit: 5 })
        : null;
    } catch (err) {
      situation = { unavailable: `situational state is unavailable: ${err.message}` };
    }

    // T-10: the runtime reports its own persisted state. A stopped runtime is shown as stopped;
    // nothing here starts a timer or a lease.
    let runtime = null;
    try {
      runtime = app.runtime && typeof app.runtime.status === 'function'
        ? await app.runtime.status()
        : { unavailable: 'the executive runtime is not configured' };
    } catch (err) {
      runtime = { unavailable: `runtime state is unavailable: ${err.message}` };
    }

    // T-11: provider configuration, health and checkpoints. This is a read-only projection; it
    // starts no poll and constructs no connection.
    let sources = null;
    try {
      sources = app.integrations && typeof app.integrations.status === 'function'
        ? await app.integrations.status()
        : { unavailable: 'external sources are not configured' };
    } catch (err) {
      sources = { unavailable: `external source state is unavailable: ${err.message}` };
    }

    let documentsState = null;
    try {
      if (app.documents) {
        const status = await app.documents.status();
        documentsState = {
          ...status,
          documentsTotal: status.documents,
          documents: await app.documents.list({ limit: 10, includeDeleted: true }),
        };
      } else {
        documentsState = { unavailable: 'document content understanding is not configured' };
      }
    } catch (err) {
      documentsState = { unavailable: `document state is unavailable: ${err.message}` };
    }

    // T-13: the newest bounded session is shown read-only. A conclusion is displayed with its
    // evidence references and limits; it never becomes an action button.
    let reasoningState = null;
    try {
      if (app.reasoning) {
        const page = await app.reasoning.list({ limit: 5 });
        const latest = page.sessions[0] ? await app.reasoning.session(page.sessions[0].sessionId) : null;
        reasoningState = { ...page, session: latest?.found ? latest.session : null };
      } else {
        reasoningState = { unavailable: 'the reasoning workspace is not configured' };
      }
    } catch (err) {
      reasoningState = { unavailable: `reasoning state is unavailable: ${err.message}` };
    }

    let autonomy = null;
    try {
      autonomy = app.ecp && typeof app.ecp.autonomyStatus === 'function' ? app.ecp.autonomyStatus() : { configured: {}, readonly: true };
    } catch (err) {
      autonomy = { unavailable: `autonomy state is unavailable: ${err.message}` };
    }

    let killSwitch = null;
    try {
      killSwitch = app.ecp && typeof app.ecp.killSwitchStatus === 'function' ? app.ecp.killSwitchStatus() : { active: false, policyUnavailable: true };
    } catch (err) {
      killSwitch = { active: null, policyUnavailable: true, unavailable: `kill-switch state is unavailable: ${err.message}` };
    }

    let resources = null;
    try {
      resources = app.resources && typeof app.resources.telemetry === 'function'
        ? await app.resources.telemetry({ storagePaths: [app.dataDir] })
        : { unavailable: 'resource fabric is not configured' };
    } catch (err) {
      resources = { unavailable: `resource state is unavailable: ${err.message}` };
    }

    return {
      app: APP_NAME,
      at: now().toISOString(),
      session,
      turns,
      tasks,
      plans,
      goals,
      situation,
      runtime,
      sources,
      documents: documentsState,
      reasoning: reasoningState,
      autonomy,
      killSwitch,
      resources,
      limits: {
        maxMessageChars: UI_LIMITS.maxMessageChars,
        maxTurns: UI_LIMITS.maxTurns,
        maxWorkItems: UI_LIMITS.maxWorkItems,
        oneRequestAtATime: true,
      },
    };
  }

  async function handleChat(req, res) {
    // The slot is claimed before the first await: Node runs a request handler synchronously
    // up to that point, so two chats arriving together cannot both pass this check.
    if (chatInFlight) {
      sendJson(res, 409, { error: 'a request is already running; wait for it to finish' });
      return;
    }
    chatInFlight = true;
    let timer = null;
    try {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'the body must be a JSON object' });
        return;
      }
      const extra = Object.keys(body).filter((key) => key !== 'text');
      if (extra.length > 0) {
        sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
        return;
      }
      if (typeof body.text !== 'string') {
        sendJson(res, 400, { error: 'text is required' });
        return;
      }
      if (body.text.length > UI_LIMITS.maxMessageChars) {
        sendJson(res, 413, { error: `text is longer than ${UI_LIMITS.maxMessageChars} characters` });
        return;
      }
      if (body.text.trim().length === 0) {
        sendJson(res, 400, { error: 'text is empty' });
        return;
      }

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), chatTimeoutMs);
      const result = await app.controller.handle(body.text, {
        origin: 'user',
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress && typeof progress.stage === 'string') broadcast('progress', { stage: singleLine(progress.stage, 40) });
        },
      });
      const payload = {
        status: result.status,
        display: typeof result.display === 'string' ? result.display : '',
        verified: result.status === 'success_verified',
        recorded: result.recorded !== false,
        operation: result.operation ? { id: result.operation.id, capability: result.operation.capability ?? null } : null,
        timedOut: controller.signal.aborted,
      };
      sendJson(res, 200, payload);
      broadcast('chat', { operationId: payload.operation?.id ?? null, status: payload.status });
      scheduleOwnerRefresh();
    } finally {
      if (timer) clearTimeout(timer);
      chatInFlight = false;
    }
  }

  async function handleTaskAction(req, res, kind, taskId) {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 64) {
      sendJson(res, 400, { error: 'a task id is required' });
      return;
    }
    const body = await readJson(req, UI_LIMITS.maxBodyBytes);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'the body must be a JSON object' });
      return;
    }
    const extra = Object.keys(body).filter((key) => key !== 'stepId');
    if (extra.length > 0) {
      sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
      return;
    }
    const stepId = body.stepId === undefined ? null : body.stepId;
    if (stepId !== null && (typeof stepId !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/.test(stepId))) {
      sendJson(res, 400, { error: 'stepId is not a step id' });
      return;
    }
    // A retry is always a retry of one named step, so there is no stepless form to default to.
    if (kind === 'retry' && stepId === null) {
      sendJson(res, 400, { error: 'retry requires a stepId' });
      return;
    }
    if (kind === 'cancel' && stepId !== null) {
      sendJson(res, 400, { error: 'cancel does not take a stepId' });
      return;
    }
    const result = kind === 'approve'
      ? await app.controller.approveTask(taskId, stepId === null ? {} : { stepId })
      : kind === 'retry'
        ? await app.controller.retryTask(taskId, stepId)
        : await app.controller.cancelTask(taskId);
    sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
    scheduleOwnerRefresh();
  }

  // T-17: reading an objective is the same user-origin `plan.outline` call the CLI makes, on the
  // same operation and audit path. The page may only ask for the read; recording the draft stays a
  // CLI act (`plan add`), and approving it stays the user's own decision.
  async function handlePlanning(req, res) {
    const body = await readJson(req, UI_LIMITS.maxBodyBytes);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: 'the body must be a JSON object' });
      return;
    }
    const extra = Object.keys(body).filter((key) => key !== 'objective' && key !== 'goal');
    if (extra.length > 0) {
      sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
      return;
    }
    if (typeof body.objective !== 'string' || body.objective.trim().length === 0) {
      sendJson(res, 400, { error: 'objective is required' });
      return;
    }
    const goal = body.goal === undefined || body.goal === null ? null : body.goal;
    if (goal !== null && (typeof goal !== 'string' || goal.length > 64)) {
      sendJson(res, 400, { error: 'goal is not a goal id' });
      return;
    }
    const result = await app.controller.planOutline({ objective: body.objective, goal });
    const data = result.operation?.steps?.[0]?.result?.data ?? null;
    const planning = projectPlanning(data?.planning);
    sendJson(res, 200, {
      status: result.status,
      display: typeof result.display === 'string' ? result.display : '',
      planning,
    });
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${listeningPort ?? port}`}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, at: now().toISOString() });
      return;
    }
    if (method === 'GET' && url.pathname === '/style.css') {
      sendAsset(res, 'text/css; charset=utf-8', UI_CSS);
      return;
    }
    if (method === 'GET' && url.pathname === '/app.js') {
      sendAsset(res, 'text/javascript; charset=utf-8', UI_CLIENT);
      return;
    }
    if (method === 'GET' && url.pathname === '/') {
      const queryToken = url.searchParams.get('token');
      if (queryToken !== null && tokensMatch(queryToken, authToken)) {
        res.writeHead(303, baseHeaders({
          'location': '/',
          'set-cookie': `apex_ui=${authToken}; Path=/; HttpOnly; SameSite=Strict`,
        }));
        res.end();
        return;
      }
      if (!authorized(req, url)) {
        sendText(res, 401, 'Open the URL printed by the server; it contains the access token.\n', { 'www-authenticate': 'Bearer' });
        return;
      }
      res.writeHead(200, baseHeaders({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'cross-origin-opener-policy': 'same-origin',
      }));
      res.end(UI_PAGE);
      return;
    }

    const api = url.pathname.startsWith('/api/');
    if (!api) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!authorized(req, url)) {
      sendJson(res, 401, { error: 'the access token is missing or wrong' });
      return;
    }
    if (method === 'POST') {
      const origin = req.headers.origin;
      const expected = `http://${req.headers.host ?? `${host}:${listeningPort ?? port}`}`;
      if (typeof origin === 'string' && origin !== expected) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' });
        return;
      }
      if (req.headers['x-apex-ui'] !== '1') {
        sendJson(res, 403, { error: 'the x-apex-ui header is required' });
        return;
      }
      if (typeof req.headers['content-type'] === 'string' && !req.headers['content-type'].startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, await snapshot());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/mission-control') {
      sendJson(res, 200, await missionControlSnapshot());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/approvals') {
      sendJson(res, 200, await approvalCentreSnapshot());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/timeline') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? UI_LIMITS.maxWorkItems : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > UI_LIMITS.maxWorkItems) {
        sendJson(res, 400, { error: `limit must be an integer between 1 and ${UI_LIMITS.maxWorkItems}` });
        return;
      }
      sendJson(res, 200, await timelineSnapshot(limit));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/autonomy') {
      try {
        sendJson(res, 200, app.ecp && typeof app.ecp.autonomyStatus === 'function' ? app.ecp.autonomyStatus() : { configured: {}, readonly: true });
      } catch (err) {
        sendJson(res, 503, { error: `autonomy state is unavailable: ${err.message}` });
      }
      return;
    }
    // T-31 Step 2: the Presence Mesh surface. Device trust is real (an append-only enrollment log
    // with signed-message authentication); the mesh transport is not implemented, and this route
    // says so with `implemented: false` rather than inventing peers. A device is an identity, never
    // a capability: every action still passes the ECP.
    if (method === 'GET' && url.pathname === '/api/presence') {
      try {
        const trust = app.deviceTrust && typeof app.deviceTrust.list === 'function'
          ? await app.deviceTrust.list()
          : null;
        const trustStatus = app.deviceTrust && typeof app.deviceTrust.status === 'function'
          ? await app.deviceTrust.status()
          : null;
        sendJson(res, 200, {
          schema: 'apex.presence/1',
          deviceTrust: trust === null
            ? { available: false, detail: 'device trust is not configured' }
            : {
              available: true,
              status: trustStatus,
              devices: trust.map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
                status: device.status,
                enrolledAt: device.enrolledAt,
                revokedAt: device.revokedAt,
                revocationReason: device.revocationReason ?? null,
                lastAcceptedSequence: device.lastAcceptedSequence ?? null,
              })),
              total: trust.length,
            },
          mesh: {
            implemented: false,
            detail: 'no device mesh transport is implemented; presence is the local owner session only',
            peers: [],
            connectedPeers: 0,
          },
          note: 'A trusted device authenticates messages. It grants no capability; the ECP authorizes every action.',
          readonly: true,
        });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `presence is unavailable: ${err.message}` });
      }
      return;
    }
    // T-31 Step 3: whether step-up is configured, so the page can show the field only when it is
    // real. The status never carries the secret, a digest of it, or its length.
    if (method === 'GET' && url.pathname === '/api/step-up') {
      try {
        const status = app.ecp && typeof app.ecp.stepUpStatus === 'function'
          ? app.ecp.stepUpStatus()
          : { schema: 'apex.step-up/1', configured: false, appliesTo: [] };
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `step-up status is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/autonomy/matrix') {
      try {
        const status = app.ecp && typeof app.ecp.autonomyStatus === 'function'
          ? app.ecp.autonomyStatus()
          : { configured: {}, readonly: true };
        const configured = status.configured ?? {};
        const rows = typeof app.registry?.list === 'function'
          ? app.registry.list().map((definition) => {
            const domain = definition.domain ?? String(definition.name).split('.')[0];
            const level = typeof app.ecp?.permissionFor === 'function'
              ? app.ecp.permissionFor(definition.name)?.autonomyLevel ?? null
              : null;
            return {
              name: definition.name,
              domain,
              permission: definition.permission,
              level,
              levelName: AUTONOMY_LEVELS.find((entry) => entry.level === level)?.name ?? null,
              configured: Object.prototype.hasOwnProperty.call(configured, domain),
              plannable: definition.plannable !== false,
            };
          })
          : [];
        const domains = [...new Set(rows.map((row) => row.domain))].sort().map((domain) => ({
          domain,
          configuredLevel: Object.prototype.hasOwnProperty.call(configured, domain) ? configured[domain] : null,
          capabilities: rows.filter((row) => row.domain === domain).length,
        }));
        sendJson(res, 200, {
          schema: 'apex.autonomy.matrix/1',
          levels: AUTONOMY_LEVELS,
          configured,
          readonly: status.readonly !== false,
          source: status.source ?? 'APEX_AUTONOMY_LEVELS',
          restartRequired: status.restartRequired !== false,
          domains,
          capabilities: rows,
          note: 'Read-only: autonomy is configured through APEX_AUTONOMY_LEVELS and cannot be changed from the UI.',
        });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `the autonomy matrix is unavailable: ${err.message}` });
      }
      return;
    }
    // The epistemic projection already exists as the read-only `world.state` action; this route
    // exposes the same projection to the client so the UI can label claims instead of flattening them.
    if (method === 'GET' && url.pathname === '/api/world/epistemic') {
      try {
        if (!app.memory || !app.knowledge) { sendJson(res, 503, { unavailable: true, error: 'the epistemic projection needs the memory and knowledge stores' }); return; }
        const temporal = app.experience && typeof app.experience.temporalSummary === 'function'
          ? await app.experience.temporalSummary().then((summary) => ({ available: true, ...summary })).catch((err) => ({ available: false, detail: err?.message ?? String(err) }))
          : null;
        const world = await buildWorldState({ memory: app.memory, knowledge: app.knowledge, now: app.controller?.now ?? undefined, temporal });
        sendJson(res, 200, {
          schema: 'apex.world.epistemic/1',
          beliefs: world.beliefs,
          counts: world.counts,
          contradictions: world.contradictions,
          unknowns: world.unknowns,
          read: world.read,
          complete: world.complete,
          attention: world.attention,
          labels: {
            user_asserted: 'stated by you — not independently observed',
            unverified_model: 'inferred by a model — unverified',
          },
          note: 'A label is a property of the record, never a judgement about whether the claim is true.',
        });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `the epistemic projection is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/resources') {
      try {
        const data = app.resources && typeof app.resources.telemetry === 'function'
          ? await app.resources.telemetry({ storagePaths: [app.dataDir] })
          : { unavailable: 'resource fabric is not configured' };
        sendJson(res, 200, data);
      } catch (err) {
        sendJson(res, 503, { error: `resource state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/killswitch') {
      try {
        const status = app.ecp && typeof app.ecp.killSwitchStatus === 'function' ? app.ecp.killSwitchStatus() : { active: false, policyUnavailable: true };
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 503, { error: `kill-switch state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/safety/lockdown') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0) { sendJson(res, 400, { error: 'reason is required' }); return; }
      if (body.reason.trim().length > 240) { sendJson(res, 400, { error: 'reason must be at most 240 characters' }); return; }
      try {
        const result = await app.controller.safetyLockdown({ reason: body.reason.trim() });
        sendJson(res, 200, {
          status: result.status,
          display: typeof result.display === 'string' ? result.display : '',
          operationId: typeof result.operation?.id === 'string' ? result.operation.id : null,
          recorded: result.recorded === true,
        });
        scheduleOwnerRefresh();
      } catch (err) { sendJson(res, 503, { error: `lockdown unavailable: ${err.message}` }); }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/safety/release') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0) { sendJson(res, 400, { error: 'reason is required' }); return; }
      if (body.reason.trim().length > 240) { sendJson(res, 400, { error: 'reason must be at most 240 characters' }); return; }
      if (body.confirm !== true) { sendJson(res, 400, { error: 'confirmation is required' }); return; }
      const stepUp = typeof body.stepUp === 'string' && body.stepUp.length > 0 ? body.stepUp : null;
      if (stepUp !== null && stepUp.length > 200) { sendJson(res, 400, { error: 'the step-up proof is too long' }); return; }
      try {
        const result = await app.controller.safetyRelease({ reason: body.reason.trim(), stepUp });
        // A refused release (a missing or wrong step-up proof) is a refusal, not an outage: it is
        // reported as a 400 with the ECP's own reason, and the latch is untouched.
        if (result.status !== Outcome.SUCCESS_VERIFIED) {
          sendJson(res, 400, {
            status: result.status,
            error: typeof result.output === 'string' && result.output.length > 0 ? result.output : 'the release was refused',
            display: typeof result.display === 'string' ? result.display : '',
            recorded: result.recorded === true,
            operationId: typeof result.operation?.id === 'string' ? result.operation.id : null,
          });
          return;
        }
        sendJson(res, 200, {
          status: result.status,
          display: typeof result.display === 'string' ? result.display : '',
          operationId: typeof result.operation?.id === 'string' ? result.operation.id : null,
          recorded: result.recorded === true,
        });
        scheduleOwnerRefresh();
      } catch (err) { sendJson(res, 503, { error: `release unavailable: ${err.message}` }); }
      return;
    }
    // T-29: the cognitive pipeline. Reading a run is a read; starting one goes through the
    // registered `cognition.run` capability, and only the owner's own approval can move a gated
    // step out of awaiting_approval.
    if (method === 'GET' && (url.pathname === '/api/cognition/runs' || url.pathname.startsWith('/api/cognition/runs/'))) {
      if (!app.cognition) {
        sendJson(res, 503, { unavailable: true, error: 'the cognitive pipeline is not configured' });
        return;
      }
      const single = url.pathname.startsWith('/api/cognition/runs/');
      try {
        if (single) {
          const runId = decodeURIComponent(url.pathname.slice('/api/cognition/runs/'.length));
          if (!/^cog-[a-z0-9]{1,40}$/.test(runId)) { sendJson(res, 400, { error: 'not a cognition run id' }); return; }
          const run = await app.cognition.get(runId);
          if (!run) { sendJson(res, 404, { error: 'no such cognition run' }); return; }
          sendJson(res, 200, { run, stages: COGNITION_STAGES, authorizesExecution: false });
          return;
        }
        const requested = Number(url.searchParams.get('limit') ?? '10');
        const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 50) : 10;
        const page = await app.cognition.list({ limit });
        sendJson(res, 200, { ...page, stages: COGNITION_STAGES, authorizesExecution: false });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `the cognitive trace is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/cognition/run') {
      if (!app.cognition) {
        sendJson(res, 503, { unavailable: true, error: 'the cognitive pipeline is not configured' });
        return;
      }
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      const extra = Object.keys(body).find((key) => !['intent', 'action', 'input', 'councilRequested'].includes(key));
      if (extra) { sendJson(res, 400, { error: `unknown field: ${extra}` }); return; }
      if (typeof body.intent !== 'string' || body.intent.trim().length === 0 || body.intent.length > 500) {
        sendJson(res, 400, { error: 'an intent of 1-500 characters is required' });
        return;
      }
      if (body.action !== undefined && body.action !== null && (typeof body.action !== 'string' || body.action.length === 0 || body.action.length > 80)) {
        sendJson(res, 400, { error: 'action must be a registered capability name' });
        return;
      }
      if (body.input !== undefined && body.input !== null && (typeof body.input !== 'object' || Array.isArray(body.input))) {
        sendJson(res, 400, { error: 'input must be an object' });
        return;
      }
      try {
        const result = await app.controller.cognitionRun({
          intent: body.intent.trim(),
          action: body.action ?? null,
          input: body.input ?? null,
          councilRequested: body.councilRequested === true,
        });
        const data = result.operation?.steps?.[0]?.result?.data ?? null;
        if (!data || typeof data.runId !== 'string') {
          sendJson(res, 400, { status: result.status, error: result.output ?? 'the pipeline did not record a run', display: result.display });
          return;
        }
        const run = await app.cognition.get(data.runId);
        sendJson(res, 200, {
          run,
          runStatus: run?.status ?? data.status,
          stages: COGNITION_STAGES,
          status: result.status,
          display: result.display,
        });
        broadcast('cognition', { runId: data.runId, status: run?.status ?? data.status });
        scheduleOwnerRefresh();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    const cognitionApprove = /^\/api\/cognition\/runs\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === 'POST' && cognitionApprove) {
      if (!app.cognition) { sendJson(res, 503, { unavailable: true, error: 'the cognitive pipeline is not configured' }); return; }
      const runId = decodeURIComponent(cognitionApprove[1]);
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      const extra = Object.keys(body).find((key) => key !== 'stepId');
      if (extra) { sendJson(res, 400, { error: `unknown field: ${extra}` }); return; }
      try {
        const run = await app.cognition.get(runId);
        if (!run) { sendJson(res, 404, { error: 'no such cognition run' }); return; }
        if (run.status !== 'awaiting_approval') {
          sendJson(res, 409, { error: `this run is ${run.status}; there is nothing awaiting approval` });
          return;
        }
        const stepId = typeof body.stepId === 'string' ? body.stepId : (run.approval?.waitingSteps?.[0] ?? null);
        if (!stepId) { sendJson(res, 409, { error: 'the run records no step awaiting approval' }); return; }
        const approved = await app.controller.approveTask(run.taskId, { stepId });
        if (approved.status !== 'success_verified') {
          sendJson(res, 409, { status: approved.status, error: approved.output ?? 'the approval was not recorded', display: approved.display });
          return;
        }
        const ran = await app.controller.runTask(run.taskId, 'resume');
        const projected = await app.cognition.get(runId);
        sendJson(res, 200, {
          run: projected,
          runStatus: projected?.status ?? 'unknown',
          stages: COGNITION_STAGES,
          status: ran.status,
          display: `${approved.display ?? ''}\n${ran.display ?? ''}`.trim(),
        });
        broadcast('cognition', { runId, status: projected?.status ?? 'unknown' });
        scheduleOwnerRefresh();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/health') {
      // The same composition the CLI prints. It starts no runtime, polls no provider, and calls no
      // model; the optional model check stays off so the page cannot contact an endpoint by itself.
      try {
        const health = await collectHealth(app, { checkModel: false });
        sendJson(res, 200, health);
      } catch (err) {
        sendJson(res, 503, { error: `the health view is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/council') {
      try {
        if (!app.council) {
          sendJson(res, 503, { error: 'Council deliberation is not configured' });
          return;
        }
        const id = url.searchParams.get('session');
        const page = await app.council.list({ limit: 20 });
        const status = await app.council.status();
        if (id) {
          const found = await app.council.session(id);
          sendJson(res, found.found ? 200 : 404, found.found ? { ...page, status, session: found.session } : { ...page, status, error: found.detail });
          return;
        }
        const latest = page.sessions[0] ? await app.council.session(page.sessions[0].sessionId) : null;
        sendJson(res, 200, { ...page, status, session: latest?.found ? latest.session : null, authorizesExecution: false });
      } catch (err) {
        sendJson(res, 503, { error: `the council workspace is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/council/deliberate') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'the body must be a JSON object' });
        return;
      }
      const extra = Object.keys(body).filter((key) => !['objective', 'candidateId', 'useContext'].includes(key));
      if (extra.length > 0) {
        sendJson(res, 400, { error: `unknown field: ${extra[0]}` });
        return;
      }
      if (typeof body.objective !== 'string' || body.objective.trim().length === 0) {
        sendJson(res, 400, { error: 'objective is required' });
        return;
      }
      if (body.candidateId !== undefined && body.candidateId !== null
        && (typeof body.candidateId !== 'string' || body.candidateId.length > 128)) {
        sendJson(res, 400, { error: 'candidateId is not a candidate id' });
        return;
      }
      try {
        // Deliberation is a judgement record, not an execution: it appends one session and
        // authorizes nothing. It still goes through the controller so the append carries the same
        // ECP decision and audit line as every other capability.
        const result = await app.controller.councilDeliberate({
          objective: body.objective,
          candidateId: body.candidateId ?? null,
          useContext: body.useContext !== false,
        });
        const data = result.operation?.steps?.[0]?.result?.data ?? null;
        if (!data || typeof data.sessionId !== 'string') {
          sendJson(res, 400, {
            status: result.status,
            error: result.output ?? 'the deliberation did not record a session',
            display: result.display,
          });
          return;
        }
        sendJson(res, 200, { ...data, status: result.status, display: result.display });
        broadcast('council', { sessionId: data.sessionId });
        scheduleOwnerRefresh();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/workshop') {
      try {
        if (!app.workshop) { sendJson(res, 503, { unavailable: true, error: 'Workshop is not configured' }); return; }
        const [page, status] = await Promise.all([app.workshop.list({ limit: 20 }), app.workshop.status()]);
        sendJson(res, 200, { ...page, status, authorizesExecution: false });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `the Workshop is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/workshop/compose') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      const extra = Object.keys(body).filter((key) => !['title', 'domain', 'budget', 'note', 'components', 'connections'].includes(key));
      if (extra.length) { sendJson(res, 400, { error: `unknown field: ${extra[0]}` }); return; }
      if (typeof body.title !== 'string' || body.title.trim().length === 0 || !Array.isArray(body.components)) {
        sendJson(res, 400, { error: 'a title and components array are required' }); return;
      }
      try {
        const result = await app.controller.workshopCompose({
          title: body.title, domain: body.domain ?? 'generic', components: body.components,
          connections: body.connections ?? [], budget: body.budget ?? null, note: body.note ?? '',
        });
        const data = result.operation?.steps?.[0]?.result?.data ?? null;
        if (!data || typeof data.artifactId !== 'string') {
          sendJson(res, 400, { status: result.status, error: result.output ?? 'the design was not stored', display: result.display }); return;
        }
        sendJson(res, 200, { ...data, status: result.status, display: result.display });
        broadcast('workshop', { artifactId: data.artifactId });
        scheduleOwnerRefresh();
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/workshop/simulate') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'artifactId')
        || typeof body.artifactId !== 'string' || body.artifactId.trim().length === 0) {
        sendJson(res, 400, { error: 'artifactId is required' }); return;
      }
      try {
        const result = await app.controller.workshopSimulate({ artifactId: body.artifactId });
        const data = result.operation?.steps?.[0]?.result?.data ?? null;
        if (!data || typeof data.artifactId !== 'string') {
          sendJson(res, 400, { status: result.status, error: result.output ?? 'the simulation was unavailable', display: result.display }); return;
        }
        sendJson(res, 200, { ...data, status: result.status, display: result.display });
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    // T-31 Step 2: the controlled Evolution Lab. The GET is a read of the ledger plus the live
    // safety boundaries. The POSTs are the four audited capabilities; each one runs through the
    // controller, so the ECP authorizes it and the verifier checks the ledger afterwards.
    if (method === 'GET' && url.pathname === '/api/evolution') {
      try {
        if (!app.evolution) { sendJson(res, 503, { unavailable: true, error: 'the Evolution Lab is not configured' }); return; }
        const [page, status] = await Promise.all([app.evolution.list(), app.evolution.status()]);
        sendJson(res, 200, {
          ...page,
          status,
          boundaries: evolutionBoundaries({ registry: app.registry, ecp: app.ecp, operations: app.operations }),
          policy: {
            states: ['proposal', 'sandbox_result', 'promotion_requested', 'approved', 'rejected'],
            rules: [
              'A proposal authorizes nothing; it is a recorded idea.',
              'Promotion is refused unless a sandbox run recorded a passing result.',
              'Verification is recorded as measured; the lab never sets it on its own.',
              'Only the owner decides a promotion, and the decision is audited.',
            ],
            appliesChanges: false,
            authorizesExecution: false,
          },
        });
      } catch (err) {
        sendJson(res, 503, { unavailable: true, error: `the Evolution Lab is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && (url.pathname === '/api/evolution/propose'
      || url.pathname === '/api/evolution/verify'
      || url.pathname === '/api/evolution/promote'
      || url.pathname === '/api/evolution/decide')) {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'the body must be a JSON object' }); return; }
      const allowed = {
        '/api/evolution/propose': ['title', 'hypothesis', 'evidence'],
        '/api/evolution/verify': ['proposalId', 'verified', 'detail'],
        '/api/evolution/promote': ['proposalId', 'reason'],
        '/api/evolution/decide': ['proposalId', 'decision', 'reason', 'stepUp'],
      }[url.pathname];
      const extra = Object.keys(body).filter((key) => !allowed.includes(key));
      if (extra.length) { sendJson(res, 400, { error: `unknown field: ${extra[0]}` }); return; }
      const call = {
        '/api/evolution/propose': () => app.controller.evolutionPropose({ title: body.title, hypothesis: body.hypothesis ?? null, evidence: body.evidence ?? [] }),
        '/api/evolution/verify': () => app.controller.evolutionVerify({ proposalId: body.proposalId, verified: body.verified, detail: body.detail ?? null }),
        '/api/evolution/promote': () => app.controller.evolutionPromote({ proposalId: body.proposalId, reason: body.reason }),
        '/api/evolution/decide': () => app.controller.evolutionDecide({
          proposalId: body.proposalId,
          decision: body.decision,
          reason: body.reason ?? null,
          stepUp: typeof body.stepUp === 'string' && body.stepUp.length > 0 ? body.stepUp : null,
        }),
      }[url.pathname];
      try {
        const result = await call();
        const data = result.operation?.steps?.[0]?.result?.data ?? null;
        const verified = result.operation?.steps?.[0]?.verification?.outcome === 'success_verified';
        if (!data || verified !== true) {
          const detail = result.operation?.steps?.[0]?.verification?.detail
            ?? result.operation?.steps?.[0]?.summary
            ?? result.output ?? 'the act was not verified';
          sendJson(res, 400, { status: result.status, error: detail, display: result.display });
          return;
        }
        // `actVerified` is the verifier's own outcome; the payload may carry its own `verified`
        // field (a sandbox result), and the two must never be confused.
        sendJson(res, 200, { ...data, status: result.status, actVerified: true, display: result.display });
        broadcast('evolution', { proposalId: data.proposalId ?? null });
        scheduleOwnerRefresh();
      } catch (err) { sendJson(res, 400, { error: err.message }); }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/situation') {
      try {
        sendJson(res, 200, await situationSnapshot(20));
      } catch (err) {
        sendJson(res, 503, { error: `the situational state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/situation/decide') {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'the body must be a JSON object' });
        return;
      }
      const allowed = new Set(['event', 'response', 'reason']);
      const extra = Object.keys(body).find((key) => !allowed.has(key));
      if (extra) { sendJson(res, 400, { error: `unknown field: ${extra}` }); return; }
      const responses = new Set(['ignore', 'record', 'investigate', 'notify', 'recommend']);
      if (typeof body.event !== 'string' || body.event.length === 0 || body.event.length > 64) {
        sendJson(res, 400, { error: 'event is required' }); return;
      }
      if (!responses.has(body.response)) {
        sendJson(res, 400, { error: 'response must be one of ignore, record, investigate, notify, or recommend' }); return;
      }
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.trim().length > 500) {
        sendJson(res, 400, { error: 'a decision reason of 1 to 500 characters is required' }); return;
      }
      try {
        const result = await app.controller.situationDecide({
          event: body.event,
          response: body.response,
          reason: body.reason.trim(),
        });
        sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
        scheduleOwnerRefresh();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/briefing') {
      try {
        sendJson(res, 200, await briefingSnapshot());
      } catch (err) {
        sendJson(res, 503, { error: `the briefing is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/sources') {
      try {
        sendJson(res, 200, await app.integrations.status());
      } catch (err) {
        sendJson(res, 503, { error: `the external source state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/documents') {
      try {
        if (!app.documents) {
          sendJson(res, 503, { error: 'document content understanding is not configured' });
          return;
        }
        const q = url.searchParams.get('q');
        const status = await app.documents.status();
        const documents = await app.documents.list({ limit: 20, includeDeleted: true });
        const results = q ? await app.documents.search(q, { limit: 10 }) : [];
        // `documents` is the row list here; the owner's total is kept under its own name so the page
        // never has to infer a count from a bounded page.
        sendJson(res, 200, { ...status, documentsTotal: status.documents, documents, results, query: q });
      } catch (err) {
        sendJson(res, 503, { error: `the document index is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/reasoning') {
      try {
        if (!app.reasoning) {
          sendJson(res, 503, { error: 'the reasoning workspace is not configured' });
          return;
        }
        const id = url.searchParams.get('session');
        const page = await app.reasoning.list({ limit: 20 });
        if (!id) {
          const latest = page.sessions[0] ? await app.reasoning.session(page.sessions[0].sessionId) : null;
          sendJson(res, 200, { ...page, status: await app.reasoning.status(), session: latest?.found ? latest.session : null });
          return;
        }
        const found = await app.reasoning.session(id);
        if (!found.found) {
          sendJson(res, 404, { error: found.detail });
          return;
        }
        sendJson(res, 200, { ...page, status: await app.reasoning.status(), session: found.session });
      } catch (err) {
        sendJson(res, 503, { error: `the reasoning workspace is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/runtime') {
      try {
        sendJson(res, 200, await app.runtime.status());
      } catch (err) {
        sendJson(res, 503, { error: `the runtime state is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/goals') {
      try {
        if (!app.goals) { sendJson(res, 503, { error: 'goals are not configured' }); return; }
        sendJson(res, 200, { goals: await app.goals.list() });
      } catch (err) {
        sendJson(res, 503, { error: `goals are unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/memory') {
      try {
        if (!app.memory) { sendJson(res, 503, { error: 'memory is not configured' }); return; }
        sendJson(res, 200, { records: await app.memory.list({ limit: 20 }) });
      } catch (err) {
        sendJson(res, 503, { error: `memory is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/knowledge') {
      try {
        if (!app.knowledge) { sendJson(res, 503, { error: 'knowledge is not configured' }); return; }
        sendJson(res, 200, { claims: await app.knowledge.list({ limit: 20 }) });
      } catch (err) {
        sendJson(res, 503, { error: `knowledge is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/world') {
      try {
        if (!app.worldModel) { sendJson(res, 503, { error: 'the world model is not configured' }); return; }
        sendJson(res, 200, await app.worldModel.listEntities({ limit: 20 }));
      } catch (err) {
        sendJson(res, 503, { error: `the world model is unavailable: ${err.message}` });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/events') {
      if (!subscribe(req, res, url)) {
        sendJson(res, 429, { error: 'too many event stream subscribers' });
      }
      return;
    }
    if (method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/planning') {
      await handlePlanning(req, res);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/session/new') {
      if (typeof app.session?.rotate !== 'function') {
        sendJson(res, 503, { error: 'session rotation is unavailable' });
        return;
      }
      const rotated = await app.session.rotate();
      sendJson(res, 200, { status: 'success_verified', display: `Started session ${String(rotated.sessionId).slice(0, 8)}.`, session: { id: rotated.sessionId } });
      scheduleOwnerRefresh();
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)\/(approve|retry|cancel)$/.exec(url.pathname);
    if (method === 'POST' && taskMatch) {
      await handleTaskAction(req, res, taskMatch[2], decodeURIComponent(taskMatch[1]));
      return;
    }
    const planMatch = /^\/api\/plans\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === 'POST' && planMatch) {
      const result = await app.controller.planApprove({ target: decodeURIComponent(planMatch[1]) });
      sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
      scheduleOwnerRefresh();
      return;
    }
    const cancelPlanMatch = /^\/api\/plans\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === 'POST' && cancelPlanMatch) {
      const body = await readJson(req, UI_LIMITS.maxBodyBytes);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'the body must be a JSON object' });
        return;
      }
      const extra = Object.keys(body).find((key) => key !== 'reason');
      if (extra) { sendJson(res, 400, { error: `unknown field: ${extra}` }); return; }
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.trim().length > 500) {
        sendJson(res, 400, { error: 'a plan cancellation reason of 1 to 500 characters is required' });
        return;
      }
      const result = await app.controller.planCancel({
        target: decodeURIComponent(cancelPlanMatch[1]),
        reason: body.reason.trim(),
      });
      sendJson(res, 200, { status: result.status, display: typeof result.display === 'string' ? result.display : '' });
      scheduleOwnerRefresh();
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const status = Number.isInteger(err?.status) ? err.status : 500;
      if (err?.closeConnection === true) {
        // A body that was refused while still arriving leaves unread bytes that cannot
        // start the next request, so this connection ends after the refusal flushes.
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
      }
      sendJson(res, status, { error: status === 500 ? 'the request failed inside APEX' : err.message });
    });
  });

  return {
    server,
    token: authToken,
    async start() {
      await refreshOwnerSources();
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen({ host, port }, () => {
          server.off('error', onError);
          listeningPort = server.address().port;
          startOwnerMonitoring();
          scheduleOwnerRefresh();
          const hostLabel = host === '::1' ? '[::1]' : host;
          resolve({ host, port: listeningPort, token: authToken, url: `http://${hostLabel}:${listeningPort}/?token=${authToken}` });
        });
      });
    },
    async stop() {
      stopOwnerMonitoring();
      for (const sub of [...subscribers]) {
        try { sub.res.end(); } catch { /* already gone */ }
        unsubscribe(sub);
      }
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(() => resolve());
        // A browser keeps its connection open after a response, so a plain close would wait
        // for pages that are still open. Stopping the server ends them instead.
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    },
    // Exposed for tests and diagnostics; read-only.
    stats() {
      return {
        subscribers: subscribers.size,
        chatInFlight,
        port: listeningPort,
        streamId,
        eventSeq,
        retainedStateEvents: stateEventHistory.size,
        ownerVersions: { ...ownerVersions },
        limits: UI_LIMITS,
      };
    },
  };
}
