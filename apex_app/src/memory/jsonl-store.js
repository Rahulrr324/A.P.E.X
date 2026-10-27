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
      if (err && err.code === 'ENOENT') return { records: [], corrupt: [] };
      throw new StoreError(`cannot read ${this.label}: ${err?.code || err?.message}`);
    }
    const records = [];
    const corrupt = [];
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        corrupt.push({ line: index + 1, reason: 'invalid JSON' });
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
      await handle.write(prefix + line);
      await handle.sync();
    } catch (err) {
      throw new StoreError(`cannot write ${this.label}: ${err?.code || err?.message}`);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
}
