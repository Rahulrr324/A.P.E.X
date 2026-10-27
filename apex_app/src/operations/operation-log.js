// Audit log: one JSON line per Cognitive Controller operation. Append-only.
import { JsonlStore } from '../memory/jsonl-store.js';
import { OPERATION_SCHEMA, OUTCOME_VALUES } from '../outcomes.js';

function validateOperation(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'not an object';
  if (op.schema !== OPERATION_SCHEMA) return 'unsupported schema';
  if (typeof op.id !== 'string' || op.id.length === 0) return 'missing id';
  if (!OUTCOME_VALUES.has(op.status)) return 'unknown status';
  return null;
}

export class OperationLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.store = new JsonlStore(filePath, { validateRecord: validateOperation });
  }

  async append(operation) {
    await this.store.append(operation);
  }

  async list({ limit = 10 } = {}) {
    const { records, corrupt } = await this.store.load();
    return { records: records.slice(-Math.max(1, limit)).reverse(), corrupt: corrupt.length };
  }

  async status() {
    const { records, corrupt } = await this.store.load();
    return { records: records.length, corrupt: corrupt.length };
  }
}
