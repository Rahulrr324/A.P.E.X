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

  return { kind: 'model', capability: 'model.answer', action: null, input: null };
}
