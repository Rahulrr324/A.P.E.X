// Deterministic capability routing. Requests that match a known pattern are routed
// to that action. Everything else goes to the model path, which is subject to the
// same authorization policy. This is a small, explicit table, not a substitute for
// the controller's retrieval, verification, and audit steps.
//
// The filesystem rules deliberately match only path-shaped text (a separator, a file
// extension, or "."), so ordinary questions such as "list services" still go to the
// model instead of being turned into a directory request. Even when a request is
// routed here, the action re-validates the path: routing is never authorization.

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
// task log and the audit, and a model must not be the one to say it. The patterns are
// deliberately narrow. They need a task or step word, a task id, or one of the short
// pronoun forms listed below, so an ordinary question ("what happened to my file?")
// still goes to the model. A match is a routing decision only: the controller resolves
// the referent from the session's own task records, and asks when it cannot.
const TASK_REF = /\btasks?\s+#?([0-9a-f][0-9a-f-]{3,63})\b/i;
const TASK_WORD = /\b(?:tasks?|steps?)\b/;
const PRONOUN_FORMS = [
  /^(?:did|has|have|is|are)\s+(?:it|that|this|the task)\s+(?:actually\s+)?(?:finish|finished|complete|completed|done|work|worked)\s*[?.!]*$/,
  /^(?:what|which)\s+(?:is|are|remains?|still)\s+\S+.*\b(?:pending|left|remaining|to do)\s*[?.!]*$/,
  /^what\s+(?:else\s+)?(?:is|are)\s+still\s+\S+\s*[?.!]*$/,
  /^(?:can you |could you |please )?(?:explain |tell me\s+)?why\s+(?:did\s+)?(?:it|that|this|the task)\s+(?:stop|stopped|fail|failed|pause|paused|cancel|cancelled|canceled|not run)\b[?.!\s]*$/,
  /^what\s+happened\s+to\s+(?:it|that|this|the task)\s*[?.!]*$/,
];

function intentOf(text) {
  if (/\bwhy\b/.test(text) && /\b(?:stop|stopped|fail|failed|failure|pause|paused|cancel|cancelled|canceled|abort|halt|error)\b/.test(text)) return 'why_stopped';
  if (/\b(?:which|what)\b[^?.!]*\b(?:succeeded|succeed|completed|work|worked|ran|were verified|is verified)\b/.test(text)) return 'steps_succeeded';
  if (/\b(?:pending|left|remaining|still to (?:do|run)|not (?:yet )?(?:been )?(?:run|done|finished|completed)|still to do)\b/.test(text)) return 'pending';
  if (/\b(?:did|does|has|have|is|are|was|were)\b[^?.!]*\b(?:finish|finished|complete|completed|done|over|successful)\b/.test(text)) return 'finished';
  if (/\b(?:what happened|status|state|progress|update|explain|tell me what|how did|did)\b/.test(text)) return 'status';
  return null;
}

function taskQuestionRoute(request) {
  const text = request.toLowerCase();
  const ref = TASK_REF.exec(text);
  if (!TASK_WORD.test(text) && ref === null && !PRONOUN_FORMS.some((re) => re.test(text))) return null;
  const intent = intentOf(text);
  if (!intent) return null;
  return { kind: 'task_question', capability: 'task.explain', action: null, input: null, intent, taskId: ref ? ref[1] : null };
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

  if (/^(?:status|who\s+are\s+you|what\s+can\s+you\s+do)\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'app.status', action: 'app.status', input: {} };
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

  const taskQuestion = taskQuestionRoute(r);
  if (taskQuestion) return taskQuestion;

  return { kind: 'model', capability: 'model.answer', action: null, input: null };
}
