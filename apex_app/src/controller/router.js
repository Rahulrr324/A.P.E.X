// Deterministic capability routing. Requests that match a known pattern are routed
// to that action. Everything else goes to the model path, which is subject to the
// same authorization policy. This is a small, explicit table, not a substitute for
// the controller's retrieval, verification, and audit steps.
//
// The filesystem rules deliberately match only path-shaped text (a separator, a file
// extension, or "."), so ordinary questions such as "list services" still go to the
// model instead of being turned into a directory request. Even when a request is
// routed here, the action re-validates the path: routing is never authorization.

import { taskQuestionCandidate } from './task-context.js';

function looksLikePathToken(token) {
  if (typeof token !== 'string') return false;
  const t = token.trim();
  if (t.length === 0) return false;
  if (/[\u0000-\u001f\u007f]/.test(t)) return false;
  if (t.length > 200) return false;
  if (t === '.' || t === './' || t === '.\\') return true;
  if (/[/\\]/.test(t)) return true;
  // A bare file name is recognised by its extension, so "list services" stays a
  // normal request while "read notes.txt" is a file read.
  return /\.[A-Za-z0-9_]{1,16}$/.test(t);
}

function filesystemRoute(kind, token) {
  const path = token.trim().replace(/^["']|["']$/g, '');
  if (!looksLikePathToken(path)) return null;
  return {
    kind: 'action',
    capability: `filesystem.${kind}`,
    action: `filesystem.${kind}`,
    input: { path },
  };
}

// A follow-up question about a task is answered from APEX's own records rather than
// from a model: whether a step ran, was verified, or was interrupted is a fact in the
// task log and the audit, and a model must not be the one to say it. What makes a
// request such a question is decided by the question classes and referent rules in
// task-context.js, not by a list of sentence templates. This stays a routing decision
// only: the controller resolves the referent against the task log and the task ids this
// session recorded, and asks when the records do not single out one task. A request that
// names no task and points at nothing recorded stays on the ordinary path.
function taskQuestionRoute(request) {
  const candidate = taskQuestionCandidate(request);
  if (!candidate) return null;
  return {
    kind: 'task_question',
    capability: 'task.explain',
    action: null,
    input: null,
    intent: candidate.intent,
    taskIds: candidate.ids,
    recency: candidate.recency,
  };
}

export function route(request) {
  const r = String(request).trim();
  let m;

  // "remember privately" must be tested first: it is never sent to a model.
  m = /^remember\s+privately\b(?:\s+that)?\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.add', action: 'memory.add', input: { content: m[1], sensitivity: 'private' } };

  m = /^remember\b(?:\s+that)?\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.add', action: 'memory.add', input: { content: m[1] } };

  m = /^(?:recall|search\s+memor(?:y|ies)(?:\s+for)?)\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.search', action: 'memory.search', input: { query: m[1] } };

  m = /^what\s+do\s+you\s+(?:remember|know)\s+about\s+([\s\S]*?)\s*\??$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.search', action: 'memory.search', input: { query: m[1] } };

  if (/^(?:list|show)\s+(?:my\s+)?(?:memory|memories)$/i.test(r)) {
    return { kind: 'action', capability: 'memory.list', action: 'memory.list', input: {} };
  }

  if (/^(?:status|who\s+are\s+you)\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'app.status', action: 'app.status', input: {} };
  }

  // "What can you do" is a question about the registered capabilities, so it is answered from
  // the live registry. A topic narrows the answer ("... about memory?"); it is passed as a
  // plain substring query, and the action says so when nothing matches rather than inventing
  // a capability.
  m = /^(?:what\s+can\s+you\s+do|what\s+can\s+you\s+help\s+(?:me\s+)?with|what\s+are\s+you\s+able\s+to\s+do|what\s+are\s+(?:your|the)\s+capabilities|(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:your\s+)?capabilities|capabilities)(?:\s+(?:with|about|for|on)\s+(.+?))?\s*\??$/i.exec(r);
  if (m) {
    return {
      kind: 'action',
      capability: 'app.capabilities',
      action: 'app.capabilities',
      input: m[1] ? { query: m[1].trim() } : {},
    };
  }

  m = /^(?:calc|calculate|compute)\s*:?\s+([\s\S]+)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'calc.evaluate', action: 'calc.evaluate', input: { expression: m[1] } };

  m = /^what\s+is\s+([0-9+\-*/().\s]*\d[0-9+\-*/().\s]*?)\s*\??$/i.exec(r);
  if (m) return { kind: 'action', capability: 'calc.evaluate', action: 'calc.evaluate', input: { expression: m[1] } };

  // Read-only filesystem inspection. The authorized root comes from configuration,
  // never from the request; the request names only a relative path.
  m = /^(?:ls|list|dir)\s+(?:the\s+)?(?:contents?\s+of\s+)?(.+)$/i.exec(r);
  if (m) {
    const routed = filesystemRoute('list', m[1]);
    if (routed) return routed;
  }

  m = /^show\s+(?:the\s+)?contents?\s+of\s+(.+)$/i.exec(r);
  if (m) {
    const routed = filesystemRoute('list', m[1]);
    if (routed) return routed;
  }

  m = /^(?:read|cat|print|peek|display|open)\s+(?:the\s+)?(?:file\s+)?(.+)$/i.exec(r);
  if (m) {
    const routed = filesystemRoute('read', m[1]);
    if (routed) return routed;
  }

  // Questions about APEX's own stored state are answered from the stores, not by a
  // model. The patterns are narrow: a question about a topic ("what do you believe
  // about X") stays on the model path, where retrieval applies.
  if (/^(?:what|which)\s+(?:conflicts|contradictions)\s+(?:do\s+you\s+(?:have|know)|are\s+(?:stored|unresolved|known))\s*\??$/i.test(r)
    || /^what\s+is\s+(?:currently\s+)?unresolved\s*\??$/i.test(r)
    || /^what\s+do\s+you\s+(?:currently\s+)?believe\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'world.state', action: 'world.state', input: {} };
  }

  const taskQuestion = taskQuestionRoute(r);
  if (taskQuestion) return taskQuestion;

  return { kind: 'model', capability: 'model.answer', action: null, input: null };
}
