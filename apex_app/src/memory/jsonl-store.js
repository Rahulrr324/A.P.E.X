// Append-only JSON Lines store. Design rules:
//  - records are only ever appended; existing bytes are never rewritten;
//  - each append is fsynced before it is reported as written;
//  - malformed lines are reported as corrupt and skipped, never deleted;
//  - a missing file is an empty store; an unreadable path is a StoreError.
import fs from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from '../errors.js';

export class JsonlStore {
  constructor(filePath, { validateRecord = () => null } = {}) {
    this.filePath = filePath;
    this.label = path.basename(filePath);
    this.validateRecord = validateRecord;
  }

  async load() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(this.filePath);
        try {
          const parentStat = await fs.stat(parent);
          if (!parentStat.isDirectory()) {
            throw Object.assign(new Error('parent path is not a directory'), { code: 'ENOTDIR' });
          }
        } catch (statErr) {
          if (statErr && statErr.code === 'ENOENT') return { records: [], corrupt: [] };
          throw new StoreError(`cannot read ${this.label}: ${statErr?.code || statErr?.message}`);
        }
        return { records: [], corrupt: [] };
      }
      throw new StoreError(`cannot read ${this.label}: ${err?.code || err?.message}`);
    }
    const records = [];
    const corrupt = [];
    const lines = text.split('\n');
    // A file ending with a newline has an empty final element. The last line that
    // carries content is what an interrupted append leaves unterminated.
    const endsWithNewline = text.endsWith('\n');
    let lastContent = lines.length - 1;
    while (lastContent >= 0 && lines[lastContent] === '') lastContent -= 1;
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        // Invalid JSON on an unterminated final line is what a crash during an
        // append leaves. It is still damage and still blocks the stores that
        // require a complete log; the flag only lets diagnostics tell that
        // recoverable residue apart from damage in the middle of the file.
        const truncatedTail = index === lastContent && !endsWithNewline;
        corrupt.push({ line: index + 1, reason: 'invalid JSON', ...(truncatedTail ? { truncatedTail: true } : {}) });
        return;
      }
      const problem = this.validateRecord(obj);
      if (problem) {
        corrupt.push({ line: index + 1, reason: problem });
        return;
      }
      records.push(obj);
    });
    return { records, corrupt };
  }

  async append(record) {
    const line = `${JSON.stringify(record)}\n`;
    let handle;
    let written = 0;
    let total = 0;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      handle = await fs.open(this.filePath, 'a+');
      const { size } = await handle.stat();
      let prefix = '';
      if (size > 0) {
        // If a previous crash left a partial last line, start on a fresh line so
        // the new record is not merged into it.
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      // A single write can complete partially. The remainder is appended in follow-up
      // writes until the whole record is on disk; reporting success after a partial
      // write would lose the record while its caller believed it was recorded. A write
      // that accepts no bytes is a failure, not a completed append.
      const data = Buffer.from(prefix + line, 'utf8');
      total = data.length;
      while (written < total) {
        const { bytesWritten } = await handle.write(data, written, total - written);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
          throw new Error(`write accepted ${written} of ${total} bytes`);
        }
        written += bytesWritten;
      }
      await handle.sync();
    } catch (err) {
      // A failure is not proof that nothing was written. The bytes are visible to readers
      // as soon as the write returns; only durability is unknown until the fsync returns.
      // Say which state the caller is in instead of implying the store is unchanged.
      const note = written === 0
        ? ''
        : written < total
          ? `; ${written} byte(s) may remain as a partial line`
          : '; the record was written but its durability could not be confirmed, so it may be present';
      throw new StoreError(`cannot write ${this.label}: ${err?.code || err?.message}${note}`);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
}
