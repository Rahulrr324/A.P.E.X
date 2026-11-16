// Single-instance runtime lease. The lease is a small file created with an exclusive flag, so two
// processes cannot both claim the same data directory. A lease left by a process that no longer
// exists is taken over deliberately and reported; a live holder always wins. The runtime also keeps
// an in-process set, so a second start in the same process is refused even before the file is read.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class RuntimeLease {
  constructor(dataDir, { now = () => new Date(), ttlMs = 30_000 } = {}) {
    this.filePath = path.join(dataDir, 'runtime.lock');
    this.now = now;
    this.ttlMs = ttlMs;
  }

  inspect() {
    try {
      const body = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const alive = processAlive(body.pid);
      const ageMs = this.now().getTime() - Date.parse(body.at ?? 0);
      return { held: alive, pid: body.pid ?? null, runtimeId: body.runtimeId ?? null, at: body.at ?? null, ageMs, stale: !alive || ageMs > this.ttlMs * 4, raw: null };
    } catch (err) {
      if (err?.code === 'ENOENT') return { held: false, pid: null, runtimeId: null, at: null, ageMs: null, stale: false, raw: null };
      return { held: false, pid: null, runtimeId: null, at: null, ageMs: null, stale: true, raw: 'unreadable' };
    }
  }

  acquire({ runtimeId }) {
    const nonce = randomUUID();
    const body = JSON.stringify({ pid: process.pid, runtimeId, nonce, at: this.now().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(this.filePath, `${body}\n`, { encoding: 'utf8', flag: 'wx' });
        return { acquired: true, nonce, previous: attempt > 0 ? 'stale-taken-over' : null };
      } catch (err) {
        if (err?.code !== 'EEXIST') throw new ValidationError(`the runtime lease could not be written: ${err?.message ?? String(err)}`);
        const held = this.inspect();
        if (held.held && held.pid !== process.pid) {
          return { acquired: false, nonce: null, holder: held, reason: `runtime process ${held.pid} already holds the lease${held.runtimeId ? ` (${held.runtimeId})` : ''}` };
        }
        if (held.held && held.pid === process.pid) {
          // A different runtime object in this same process already owns it. The in-process guard
          // normally refuses earlier; this is the file-level backstop.
          return { acquired: false, nonce: null, holder: held, reason: 'this process already holds the runtime lease' };
        }
        try {
          fs.rmSync(this.filePath, { force: true });
        } catch (rmErr) {
          return { acquired: false, nonce: null, holder: held, reason: `the stale runtime lease could not be replaced: ${rmErr?.message ?? String(rmErr)}` };
        }
      }
    }
    return { acquired: false, nonce: null, holder: this.inspect(), reason: 'the runtime lease could not be acquired' };
  }

  heartbeat(nonce) {
    try {
      const body = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (body.nonce !== nonce) return { ok: false, reason: 'the lease is held by another runtime' };
      fs.writeFileSync(this.filePath, `${JSON.stringify({ ...body, at: this.now().toISOString() })}\n`, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }

  release(nonce) {
    try {
      const body = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (body.nonce !== nonce) return { released: false, reason: 'the lease is not ours' };
      fs.rmSync(this.filePath, { force: true });
      return { released: true };
    } catch (err) {
      if (err?.code === 'ENOENT') return { released: true, reason: 'the lease was already gone' };
      return { released: false, reason: err?.message ?? String(err) };
    }
  }
}
