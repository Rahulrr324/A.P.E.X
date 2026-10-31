// Explicit recovery for the takeover tokens a dead process leaves behind. A stale
// claim on its own is not a problem: the next task run or queue update elects a taker
// and removes it exactly as it does for any dead holder. What blocks that protocol is
// the case the election was designed around: a bounded list of epochs, all occupied by
// tokens whose holders exited. This recovery removes those dead tokens and nothing else.
//
// It deliberately does not remove the lock claim. Deleting the claim would need a
// compare-and-delete step, and without a native dependency the check and the unlink are
// two operations: a taker can replace the dead claim with its own between them, and
// removing that would admit a second owner. Leaving the claim makes the race harmless -
// the ordinary election remains the only path that ever removes a lock.
//
// Two properties bound what this may do:
//  - a live holder or a live takeover is never displaced; recovery refuses and
//    changes nothing;
//  - concurrent recovery attempts are serialised by a create-once guard, so at most
//    one process removes tokens. A recovery process that exits mid-way leaves the
//    guard; later attempts refuse with the guard path rather than guessing.
//
// "Live" here is a liveness check of the recorded number, not a proof that the
// original holder still runs. A number the operating system has recycled belongs to some
// live process, so the claim is refused: recovery cannot tell the original holder from a
// stranger, and removing the claim would risk admitting a second owner. This is a
// fail-closed state an operator resolves by hand after verifying the pid, not something
// APEX guesses about. No portable start-identity check exists without a native dependency.
//
// Deleting a token is safe because every token for the current claim is read and
// checked just before removal, and a taker never creates a token at an occupied epoch:
// a path holding a dead token cannot become a live taker's token while it still exists.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from '../errors.js';

// Bounded so a directory littered with abandoned takeover tokens is reported instead of
// retried forever. Each epoch requires a process that exited during a takeover.
export const TAKEOVER_EPOCHS = 16;

// Liveness of a process number, not identity: see the note at the top of this file.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, but belongs to another user
  }
}

function claimKey(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

async function writeExclusive(file, text) {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function tokenPattern(lockPath) {
  const base = path.basename(lockPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${base}\\.takeover\\.([0-9a-f]{16})\\.(\\d+)$`);
}

function readPid(body) {
  try {
    const pid = Number(JSON.parse(body)?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Read-only view used by diagnostics. It never creates, removes, or waits.
export async function inspectLock(lockPath) {
  const report = {
    present: false,
    pid: null,
    alive: false,
    error: null,
    tokens: { total: 0, live: 0, dead: 0, unknown: 0, current: 0 },
    guard: { present: false, pid: null, alive: null, error: null },
  };
  let raw = null;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      report.present = true;
      report.error = err?.code || 'unreadable';
    }
  }
  let key = null;
  if (raw !== null) {
    report.present = true;
    key = claimKey(raw);
    const pid = readPid(raw);
    if (pid === null) {
      report.alive = null;
    } else {
      report.pid = pid;
      report.alive = processAlive(pid);
    }
  }

  let names = [];
  try {
    names = await fs.readdir(path.dirname(lockPath));
  } catch {
    names = [];
  }
  const pattern = tokenPattern(lockPath);
  const guardName = `${path.basename(lockPath)}.recover`;
  for (const name of names) {
    if (name === guardName) {
      report.guard.present = true;
      let body = null;
      try {
        body = await fs.readFile(path.join(path.dirname(lockPath), name), 'utf8');
      } catch (err) {
        report.guard.error = err?.code || 'unreadable';
      }
      if (body !== null) {
        const pid = readPid(body);
        if (pid === null) report.guard.alive = null;
        else {
          report.guard.pid = pid;
          report.guard.alive = processAlive(pid);
        }
      }
      continue;
    }
    const match = name.match(pattern);
    if (!match) continue;
    report.tokens.total += 1;
    if (key !== null && match[1] !== key) continue;
    report.tokens.current += 1;
    let body = null;
    try {
      body = await fs.readFile(path.join(path.dirname(lockPath), name), 'utf8');
    } catch {
      body = null;
    }
    const pid = body === null ? null : readPid(body);
    if (pid === null) report.tokens.unknown += 1;
    else if (processAlive(pid)) report.tokens.live += 1;
    else report.tokens.dead += 1;
  }
  return report;
}

// Removes the dead takeover tokens for the lock's current claim. Returns
// { recovered, reason, removedTokens, claimRetained }. Throws StoreError('LOCKED')
// when a live holder, a live takeover, an unidentified holder, or another recovery
// attempt makes removal unsafe. The claim itself is never removed: the next normal
// operation takes over a dead claim through the ordinary election.
export async function recoverLock(lockPath, label) {
  let raw;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { recovered: false, reason: 'no-lock', removedTokens: 0, claimRetained: false };
    throw new StoreError(`cannot read the ${label} lock: ${err?.code || err?.message}`, 'LOCKED');
  }
  const holderPid = readPid(raw);
  if (holderPid === null) {
    throw new StoreError(`the ${label} lock holder cannot be identified; refusing recovery`, 'LOCKED');
  }
  if (processAlive(holderPid)) {
    throw new StoreError(`the ${label} lock is held by live process ${holderPid}; refusing recovery`, 'LOCKED');
  }

  const guardPath = `${lockPath}.recover`;
  const guardBody = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: new Date().toISOString() });
  try {
    await writeExclusive(guardPath, guardBody);
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw new StoreError(`cannot start ${label} lock recovery: ${err?.code || err?.message}`, 'LOCKED');
    }
    let blocked = null;
    try {
      blocked = readPid(await fs.readFile(guardPath, 'utf8'));
    } catch {
      blocked = null;
    }
    if (blocked !== null && processAlive(blocked)) {
      throw new StoreError(`${label} lock recovery is already in progress by process ${blocked}`, 'LOCKED');
    }
    throw new StoreError(
      `${label} lock recovery is blocked by an unfinished recovery claim at ${guardPath}; inspect it and remove it only if no recovery or task run is active`,
      'LOCKED',
    );
  }

  try {
    // Re-read under the guard. A claim that changed or vanished is somebody else's
    // work, not a stale claim this recovery may act on.
    const current = await fs.readFile(lockPath, 'utf8').catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw new StoreError(`cannot read the ${label} lock: ${err?.code || err?.message}`, 'LOCKED');
    });
    if (current === null) return { recovered: false, reason: 'no-lock', removedTokens: 0, claimRetained: false };
    if (current !== raw) {
      throw new StoreError(`the ${label} lock changed during recovery; nothing was removed`, 'LOCKED');
    }
    const stillDead = readPid(current);
    if (stillDead === null || processAlive(stillDead)) {
      throw new StoreError(`the ${label} lock holder is no longer provably dead; nothing was removed`, 'LOCKED');
    }

    const key = claimKey(raw);
    const dir = path.dirname(lockPath);
    const pattern = tokenPattern(lockPath);
    const tokens = [];
    for (const name of await fs.readdir(dir)) {
      const match = name.match(pattern);
      if (!match || match[1] !== key) continue;
      const tokenPath = path.join(dir, name);
      const body = await fs.readFile(tokenPath, 'utf8').catch(() => null);
      if (body === null) continue; // released between listing and read
      const pid = readPid(body);
      if (pid === null) {
        throw new StoreError(`takeover token ${name} has no readable holder; refusing recovery`, 'LOCKED');
      }
      if (processAlive(pid)) {
        throw new StoreError(`a ${label} lock takeover is in progress by process ${pid}; refusing recovery`, 'LOCKED');
      }
      tokens.push({ path: tokenPath, body, pid });
    }

    let removedTokens = 0;
    for (const token of tokens) {
      const now = await fs.readFile(token.path, 'utf8').catch(() => null);
      if (now !== token.body) continue;
      if (processAlive(token.pid)) {
        throw new StoreError(`a ${label} lock takeover started during recovery; the tokens removed so far stay removed`, 'LOCKED');
      }
      await fs.rm(token.path, { force: true });
      removedTokens += 1;
    }

    return {
      recovered: removedTokens > 0,
      reason: removedTokens > 0 ? 'tokens-removed' : 'no-abandoned-tokens',
      removedTokens,
      claimRetained: true,
    };
  } finally {
    const mine = await fs.readFile(guardPath, 'utf8').catch(() => null);
    if (mine === guardBody) await fs.rm(guardPath, { force: true }).catch(() => {});
  }
}
