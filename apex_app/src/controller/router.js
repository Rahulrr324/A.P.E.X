// Deterministic capability routing for the first version. Requests that match a
// known action pattern are routed to that action. Everything else goes to the
// model path, which is itself subject to the same authorization policy.
// This is a small, explicit table, not a substitute for the controller's
// retrieval, verification, and audit steps.

export function route(request) {
  const r = String(request).trim();
  let m;

  // \"remember privately\" must be tested first: it is never sent to a model.
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

  m = /^what\s+is\s+([0-9+\-*/()\s]*\d[0-9+\-*/()\s]*?)\s*\??$/i.exec(r);
  if (m) return { kind: 'action', capability: 'calc.evaluate', action: 'calc.evaluate', input: { expression: m[1] } };

  // Read-only filesystem inspection. These forms name the authorised root through the
  // configured APEX_FILESYSTEM_ROOT, never through model output. The actions themselves enforce
  // the boundary; the router just extracts the relative path the user named.
  //
  // Ordering matters: the memory forms above are matched first, so \"list memory\", \"show memory\",
  // \"read memory\", and similar never leak into the filesystem actions.

  m = /^(?:list|show)\s+(?:the\s+)?contents?\s+of\s+(?:the\s+)?([\s\S]+?)(?:\s*|\?\s*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'filesystem.list', action: 'filesystem.list', input: { path: m[1].trim() } };

  m = /^(?:list|show)\s+([\s\S]+?)(?:\s*|\?\s*)$/i.exec(r);
  if (m) {
    const pathToken = m[1].trim();
    if (pathToken && !/^(?:memory|memories)$/i.test(pathToken)) {
      return { kind: 'action', capability: 'filesystem.list', action: 'filesystem.list', input: { path: pathToken } };
    }
  }

  // filesystem.read: the generic read/show/print/peek/display/cat verbs would otherwise match
  // \"read memory\" and similar, so only route here when the token is unambiguously a path (contains
  // a dot, or is a simple alphanumeric segment) and not one of the other supported actions.
  m = /^(?:read|show|print|peek|display|cat)\s+(?:the\s+)?(?:file\s+)?([\s\S]+?)(?:\s*|\?\s*)$/i.exec(r);
  if (m) {
    const pathToken = m[1].trim();
    if (pathToken && !/^(?:memory|memories)$/i.test(pathToken) && !/^what\b/i.test(pathToken) && !/^(?:recall|search|remember|list|show|calc|calculate|compute|contents?\s+of)$/i.test(pathToken) && (pathToken.includes('.') || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pathToken))) {
      return { kind: 'action', capability: 'filesystem.read', action: 'filesystem.read', input: { path: pathToken } };
    }
  }

  return { kind: 'model', capability: 'model.answer', action: null, input: null };
}
