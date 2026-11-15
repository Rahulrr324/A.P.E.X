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

// The feedback vocabulary written the way a person says it, normalized to the store's value.
// The map is whitespace/hyphen only: it never guesses an assessment the user did not say.
function feedbackAssessment(phrase) {
  return phrase.toLowerCase().replace(/[\s-]+/g, '_');
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

function workspacePath(token) {
  if (typeof token !== 'string') return null;
  const path = token.trim().replace(/^["']|["']$/g, '');
  return looksLikePathToken(path) ? path : null;
}

// "create directory reports" names one new directory, and a bare name is a normal way to say
// it. Only the directory-creation routes accept this: a delete or move target keeps requiring
// path shape, because a bare word there is more likely to be part of an ordinary sentence.
function directoryNameToken(token) {
  const shaped = workspacePath(token);
  if (shaped !== null) return shaped;
  const name = typeof token === 'string' ? token.trim().replace(/^["']|["']$/g, '') : '';
  if (name === '.' || name === '..') return null;
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : null;
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

  // A digest is a request to summarise what APEX holds across both stores at once. It stays
  // deterministic: the stores answer, and no model is asked to merge or invent a relationship
  // between a memory record and a knowledge claim.
  m = /^(?:knowledge\s+digest|digest\s+(?:my|your|the)\s+knowledge|summari[sz]e\s+(?:what\s+you\s+know|your\s+knowledge|my\s+knowledge))(?:\s+(?:about|for|on|of))?\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) {
    const query = m[1].trim();
    return {
      kind: 'action',
      capability: 'knowledge.digest',
      action: 'knowledge.digest',
      input: query ? { query } : {},
    };
  }

  // The whole board: open goals, plans, and tasks with recorded deadlines and blockers.
  // It is answered from the three stores, not by a model asked to guess what is pending.
  if (/^(?:work\s+review|review\s+(?:my\s+)?work|what\s+am\s+i\s+working\s+on|what(?:'s|\s+is)\s+blocked|what\s+needs\s+(?:my\s+)?attention)(?:\s+now)?\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'work.review', action: 'work.review', input: {} };
  }

  // Recorded deadlines. The ledger holds dates the owner imported from a file; neither route
  // infers one. The import is offered only for a path-shaped target, and the action itself
  // bounds the read, refuses an unsupported format, and records provenance per entry.
  m = /^(?:import|load|read|ingest)\s+(?:the\s+)?deadlines?\s+from\s+(.+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'deadline.import', action: 'deadline.import', input: { path } };
    }
  }

  m = /^(?:(?:the\s+|my\s+)?deadlines?|deadline\s+list|list\s+(?:the\s+|my\s+)?deadlines?|what(?:'s|\s+is)\s+due)(?:\s+within\s+(\d+)\s+days?)?\s*\??$/i.exec(r);
  if (m) {
    return {
      kind: 'action',
      capability: 'deadline.list',
      action: 'deadline.list',
      input: m[1] === undefined ? {} : { horizonDays: Number(m[1]) },
    };
  }

  // The user's own assessment of a completed task. The pattern only decides that the user is
  // stating one and which words they used; whether the records support it is the action's
  // decision, and no model composes or rephrases the assessment.
  const ASSESSMENT_PHRASE = '(correct|incorrect|partially[\\s-]correct|useful|not[\\s-]useful|user[\\s-]correction|outcome[\\s-]succeeded|outcome[\\s-]failed)';
  m = new RegExp(`^(?:rate|judge)\\s+task\\s+([A-Za-z0-9-]+)\\s+(?:as\\s+)?${ASSESSMENT_PHRASE}$`, 'i').exec(r);
  if (m) {
    return { kind: 'action', capability: 'task.feedback', action: 'task.feedback', input: { taskId: m[1], assessment: feedbackAssessment(m[2]) } };
  }
  m = new RegExp(`^(?:record\\s+)?(?:my\\s+)?feedback\\s+(?:on\\s+)?task\\s+([A-Za-z0-9-]+)\\s*[:,]?\\s*${ASSESSMENT_PHRASE}$`, 'i').exec(r);
  if (m) {
    return { kind: 'action', capability: 'task.feedback', action: 'task.feedback', input: { taskId: m[1], assessment: feedbackAssessment(m[2]) } };
  }

  // Notes are the user's own compositions. The patterns below only decide that the user is writing
  // or reading one; the note store validates, the action authorizes, and no model is asked to
  // compose or rewrite the text. A request that merely mentions a note stays on the model path.
  m = /^(?:save\s+|write\s+)?(?:a\s+)?note\s+from\s+(?:the\s+)?(?:knowledge\s+)?digest(?:\s+(?:about|for|on|of)\s+(.+?))?(?:\s+as\s+(.+))?$/i.exec(r);
  if (m) {
    const input = {};
    if (m[1] !== undefined && m[1].trim() !== '') input.query = m[1].trim();
    if (m[2] !== undefined && m[2].trim() !== '') input.title = m[2].trim();
    return { kind: 'action', capability: 'note.from_digest', action: 'note.from_digest', input };
  }

  // The CLI's subcommand spelling, so the same workflow is reachable both ways.
  m = /^note\s+save-digest(?:\s+([\s\S]+))?$/i.exec(r);
  if (m) {
    const input = {};
    if (m[1] !== undefined && m[1].trim() !== '') input.query = m[1].trim();
    return { kind: 'action', capability: 'note.from_digest', action: 'note.from_digest', input };
  }

  m = /^(?:save\s+|write\s+)?(?:a\s+)?priv(?:ate|ately)\s+note\s+(?:titled|called)\s+(.+?)\s*:\s*([\s\S]+)$/i.exec(r);
  if (m) {
    return {
      kind: 'action',
      capability: 'note.add',
      action: 'note.add',
      input: { title: m[1], body: m[2], sensitivity: 'private' },
    };
  }

  m = /^(?:save\s+|write\s+)?(?:a\s+)?note\s+(?:titled|called)\s+(.+?)\s*:\s*([\s\S]+)$/i.exec(r);
  if (m) {
    return { kind: 'action', capability: 'note.add', action: 'note.add', input: { title: m[1], body: m[2] } };
  }

  if (/^(?:list|show)\s+(?:my\s+)?notes$/i.test(r)) {
    return { kind: 'action', capability: 'note.list', action: 'note.list', input: {} };
  }

  m = /^(?:show|open|read|display)\s+(?:the\s+)?private\s+note\s+([A-Za-z0-9-]{1,64})$/i.exec(r);
  if (m) {
    return { kind: 'action', capability: 'note.show', action: 'note.show', input: { target: m[1], includePrivate: true } };
  }

  m = /^(?:show|open|read|display)\s+(?:the\s+)?note\s+([A-Za-z0-9-]{1,64})$/i.exec(r);
  if (m) {
    return { kind: 'action', capability: 'note.show', action: 'note.show', input: { target: m[1] } };
  }

  m = /^(?:search|find)\s+(?:my\s+)?notes\s+(?:for|about)\s+([\s\S]+)$/i.exec(r);
  if (m) {
    return { kind: 'action', capability: 'note.search', action: 'note.search', input: { query: m[1].trim() } };
  }

  m = /^(?:note\s+history|history\s+of\s+(?:the\s+)?note)\s*:?\s*([A-Za-z0-9-]{1,64})$/i.exec(r);
  if (m) {
    return { kind: 'action', capability: 'note.history', action: 'note.history', input: { target: m[1] } };
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
  m = /^(?:ls|list|dir)\s+(?:the\s+)?(?:files?\s+)?(?:contents?\s+of\s+)?(?:(?:in|under)\s+)?(.+)$/i.exec(r);
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

  // Workspace discovery and analysis. Each pattern names what the user asked for in the
  // words they would use; a target that is not path-shaped keeps the request on the model
  // path, so "summarize my week" is not turned into a file read. A name or extension
  // criterion is a plain substring, and the action re-validates every path it receives.
  m = /^(?:find|search\s+for|look\s+for)\s+(?:files?\s+)?(?:named|called)\s+(.+?)(?:\s+(?:under|in)\s+(.+))?$/i.exec(r);
  if (m) {
    const name = m[1].trim();
    const under = m[2] === undefined ? '.' : workspacePath(m[2]);
    if (name.length > 0 && name.length <= 200 && under !== null) {
      return {
        kind: 'action',
        capability: 'filesystem.find',
        action: 'filesystem.find',
        input: under === '.' ? { name } : { path: under, name },
      };
    }
  }

  m = /^(?:find|search\s+for|look\s+for)\s+(?:files?|directories|entries)\s+with\s+(?:the\s+)?extension\s+\.?([A-Za-z0-9_+-]{1,16})(?:\s+(?:under|in)\s+(.+))?$/i.exec(r);
  if (m) {
    const under = m[2] === undefined ? '.' : workspacePath(m[2]);
    if (under !== null) {
      return {
        kind: 'action',
        capability: 'filesystem.find',
        action: 'filesystem.find',
        input: under === '.' ? { extension: m[1] } : { path: under, extension: m[1] },
      };
    }
  }

  // Document text extraction. Only a path-shaped target is routed, so "extract text from my
  // notes" stays a normal request; the action bounds the read and never executes anything the
  // document contains.
  m = /^(?:extract|pull)\s+(?:the\s+)?(?:text|content|contents)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:file\s+)?(.+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'filesystem.extract', action: 'filesystem.extract', input: { path } };
    }
  }

  m = /^(?:summari[sz]e|summary\s+of|give\s+(?:me\s+)?a\s+summary\s+of)\s+(?:the\s+)?(?:file\s+)?(.+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'filesystem.summarize', action: 'filesystem.summarize', input: { path } };
    }
  }

  m = /^compare\s+(?:the\s+)?(?:files?\s+)?(.+?)\s+(?:with|and|to)\s+(.+)$/i.exec(r);
  if (m) {
    const a = workspacePath(m[1]);
    const b = workspacePath(m[2]);
    if (a !== null && b !== null) {
      return { kind: 'action', capability: 'filesystem.compare', action: 'filesystem.compare', input: { a, b } };
    }
  }

  if (/^(?:workspace\s+report|workspace\s+overview)\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'filesystem.report', action: 'filesystem.report', input: {} };
  }

  m = /^(?:workspace\s+report|report\s+on)\s+(.+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'filesystem.report', action: 'filesystem.report', input: { path } };
    }
  }

  // A create-file request is routed only when the user states the content explicitly with a
  // colon. The action can create but never silently overwrite, so a target that already exists
  // is refused; the router is not authorization and the action re-validates the path and bytes.
  m = /^(?:create|write)\s+(?:the\s+)?(?:new\s+)?(?:text\s+)?file\s+(.+?)\s+(?:with|containing)\s+(?:the\s+)?(?:content|text)\s*:\s*([\s\S]+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    const content = m[2].trim();
    if (path !== null && content.length > 0) {
      return { kind: 'action', capability: 'filesystem.write', action: 'filesystem.write', input: { path, content } };
    }
  }

  // Workspace lifecycle. These are writes, but a request typed by the user is the user origin,
  // and the actions re-validate every path, never overwrite, and put a delete into a reversible
  // quarantine. A request that does not name a plausible path stays on the model path.
  m = /^(?:create|make)\s+(?:a\s+)?(?:new\s+)?(?:directory|folder|dir)\s+(.+)$/i.exec(r) || /^mkdir\s+(.+)$/i.exec(r);
  if (m) {
    const path = directoryNameToken(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'filesystem.mkdir', action: 'filesystem.mkdir', input: { path } };
    }
  }

  m = /^(?:move|rename)\s+(?:the\s+)?(?:file\s+|directory\s+|folder\s+)?(.+?)\s+(?:to|into)\s+(.+)$/i.exec(r);
  if (m) {
    const from = workspacePath(m[1]);
    const to = workspacePath(m[2]);
    if (from !== null && to !== null) {
      return { kind: 'action', capability: 'filesystem.move', action: 'filesystem.move', input: { path: from, to } };
    }
  }

  if (/^(?:workspace\s+trash|list\s+(?:the\s+)?(?:workspace\s+)?trash|show\s+(?:the\s+)?(?:workspace\s+)?quarantine)\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'filesystem.trash', action: 'filesystem.trash', input: {} };
  }

  m = /^(?:restore|undelete)\s+(?:the\s+)?(?:quarantined\s+)?(?:entry\s+)?(.+)$/i.exec(r);
  if (m) {
    const id = m[1].trim().replace(/^["']|["']$/g, '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { kind: 'action', capability: 'filesystem.restore', action: 'filesystem.restore', input: { id } };
    }
  }

  m = /^(?:delete|remove)\s+(?:the\s+)?(?:file\s+|directory\s+|folder\s+)?(.+)$/i.exec(r);
  if (m) {
    const path = workspacePath(m[1]);
    if (path !== null) {
      return { kind: 'action', capability: 'filesystem.delete', action: 'filesystem.delete', input: { path } };
    }
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
