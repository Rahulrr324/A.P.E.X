// Backup actions: export the APEX data directory, inspect an archive, and restore one.
//
// All three are user-origin only and unplannable: a model may not archive the stores (which hold
// private notes, conversations, and the audit log) and may not replace them. The archive format,
// bounds, confirmation rule, and pre-restore archive are implemented in ../backup/archive.js; these
// actions validate the request, run the file work, and verify what was written by reading it back.
import { ValidationError } from '../errors.js';
import { textInput } from './inputs.js';
import { ORIGIN_USER } from './origins.js';
import {
  CONFIRMATION_MIN_CHARS, exportArchive, inspectArchive, restoreArchive, verifyRestored,
} from '../backup/archive.js';

export const BACKUP_EXPORT_DESCRIPTION = 'Write one versioned archive of the APEX data files, with a digest per file. User origin only.';
export const BACKUP_INSPECT_DESCRIPTION = 'Read and check an APEX backup archive without restoring anything. User origin only.';
export const BACKUP_RESTORE_DESCRIPTION = 'Replace APEX data files from a validated, confirmed archive after writing a pre-restore archive. User origin only.';

function pathInput(value) {
  return textInput(value, 'path', { max: 500 });
}

function confirmInput(value) {
  return textInput(value, 'confirmation', { max: 64 });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fileLine(file) {
  const records = file.lines === null ? 'file' : `${file.lines} line(s)${file.unparsed > 0 ? `, ${file.unparsed} unparseable` : ''}`;
  return `  ${file.name.padEnd(24)} ${formatBytes(file.bytes).padStart(9)}  ${records}`;
}

export function backupActions({ dataDir, appVersion }) {
  return [
    {
      name: 'backup.export',
      description: BACKUP_EXPORT_DESCRIPTION,
      inputHint: '{"path": "destination archive path outside the data directory"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        for (const key of Object.keys(input)) {
          if (key !== 'path') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { path: pathInput(input.path) };
      },
      async execute(ctx, input) {
        const result = await exportArchive({ dataDir, destination: input.path, now: ctx.now, appVersion });
        const lines = [
          `Exported ${result.files.length} of ${result.files.length + result.missing.length} APEX data files to "${result.path}".`,
          `  archive sha256: ${result.archiveSha256}`,
          `  archive size:   ${formatBytes(result.size)}`,
          ...result.files.map(fileLine),
        ];
        if (result.missing.length > 0) lines.push(`  not present:    ${result.missing.join(', ')}`);
        lines.push('The archive holds the APEX stores as they are written, including notes, conversations, and the audit log. It is not encrypted; protect it like the data directory.');
        if (result.files.some((file) => file.unparsed > 0)) lines.push('At least one store already held unparseable lines; they are preserved as they are, not repaired.');
        lines.push('Each file is read at one moment; this is not a transaction across files, and the export is refused if APEX data changed while it was read.');
        const display = lines.join('\n');
        const summary = `exported ${result.files.length} data file(s) to "${result.path}" (sha256 ${result.archiveSha256.slice(0, 12)})`;
        return { summary, data: result, display };
      },
      async verify(ctx, input, result) {
        const written = result.data;
        const checked = await inspectArchive({ source: written.path });
        if (checked.archiveSha256 !== written.archiveSha256) {
          return { ok: false, detail: 'the written archive re-reads with a different manifest digest' };
        }
        if (!checked.ok) return { ok: false, detail: `the written archive does not validate: ${checked.problems[0]}` };
        for (const file of written.files) {
          const found = checked.files.find((entry) => entry.name === file.name);
          if (!found || found.sha256 !== file.sha256 || found.bytes !== file.bytes) {
            return { ok: false, detail: `${file.name} does not re-read with the recorded digest and length` };
          }
        }
        return { ok: true, detail: `re-read "${written.path}" and every file digest matched` };
      },
    },
    {
      name: 'backup.inspect',
      description: BACKUP_INSPECT_DESCRIPTION,
      inputHint: '{"path": "archive path"}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        for (const key of Object.keys(input)) {
          if (key !== 'path') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { path: pathInput(input.path) };
      },
      async execute(ctx, input) {
        const result = await inspectArchive({ source: input.path });
        // The inspector keeps each file's stored text so other callers can use it; the operation
        // record must not. This is a read, and copying every store's contents into the audit log
        // would duplicate the notes and conversations the archive holds on every inspection.
        const data = {
          ...result,
          files: result.files.map(({ name, bytes, sha256: digest, lines, unparsed }) => ({ name, bytes, sha256: digest, lines, unparsed })),
        };
        const lines = [
          result.ok
            ? `Archive "${result.path}" is valid and can be restored.`
            : `Archive "${result.path}" is NOT restorable: ${result.problems.join('; ')}.`,
          `  format:         ${result.ok ? 'APEX backup, version 1' : 'unconfirmed'}`,
          `  created:        ${result.archive.createdAt ?? 'unknown'} by APEX ${result.archive.appVersion ?? 'unknown'}`,
          `  sha256:         ${result.archiveSha256}`,
          `  archive size:   ${formatBytes(result.size)}`,
          ...result.files.map(fileLine),
        ];
        if (result.problems.length > 0) {
          lines.push(`  problems:       ${result.problems.length}`);
          for (const problem of result.problems.slice(0, 10)) lines.push(`    - ${problem}`);
        }
        lines.push(`To restore it: backup restore "${result.path}" --confirm ${result.archiveSha256.slice(0, 12)}`);
        const display = lines.join('\n');
        const summary = result.ok
          ? `archive "${result.path}" is valid (sha256 ${result.archiveSha256.slice(0, 12)})`
          : `archive "${result.path}" is not restorable (${result.problems.length} problem(s))`;
        return { summary, data, display };
      },
      async verify(ctx, input, result) {
        const read = result.data;
        const again = await inspectArchive({ source: read.path });
        if (again.archiveSha256 !== read.archiveSha256 || again.ok !== read.ok || again.problems.length !== read.problems.length) {
          return { ok: false, detail: 'the archive does not re-inspect to the same digest and findings' };
        }
        return { ok: true, detail: 're-inspected the archive and the digest and findings matched' };
      },
    },
    {
      name: 'backup.restore',
      description: BACKUP_RESTORE_DESCRIPTION,
      inputHint: `{"path": "archive path", "confirm": "archive digest prefix (at least ${CONFIRMATION_MIN_CHARS} characters)", "replaceExisting": false}`,
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        for (const key of Object.keys(input)) {
          if (!['path', 'confirm', 'replaceExisting'].includes(key)) {
            throw new ValidationError(`unexpected input field "${key}"`);
          }
        }
        if (typeof input.replaceExisting !== 'boolean' && input.replaceExisting !== undefined) {
          throw new ValidationError('replaceExisting must be true or false');
        }
        return {
          path: pathInput(input.path),
          confirm: confirmInput(input.confirm),
          replaceExisting: input.replaceExisting === true,
        };
      },
      async execute(ctx, input) {
        const result = await restoreArchive({
          dataDir,
          source: input.path,
          confirm: input.confirm,
          replaceExisting: input.replaceExisting,
          now: ctx.now,
          operationId: ctx.operationId,
          appVersion,
        });
        const lines = [
          `Restored ${result.files.length} APEX data file(s) from "${result.source}".`,
          `  archive sha256: ${result.archiveSha256}`,
          ...(result.safetyPath === null
            ? ['  pre-restore:    no existing file was replaced, so none was written']
            : [`  pre-restore:    ${result.safetyPath}`]),
          `  created:        ${result.created.length === 0 ? 'none (every file was already present)' : result.created.join(', ')}`,
          `  replaced:       ${result.replaced.length === 0 ? 'none' : result.replaced.join(', ')}`,
        ];
        if (result.unchanged.length > 0) lines.push(`  already equal:  ${result.unchanged.join(', ')}`);
        if (result.leftInPlace.length > 0) {
          lines.push(`  left in place:  ${result.leftInPlace.join(', ')} (recorded now but absent from the archive; restore does not delete records)`);
        }
        lines.push('The restore itself is appended to the restored audit log after this step, so the replacement is recorded rather than hidden.');
        const display = lines.join('\n');
        const summary = `restored ${result.files.length} data file(s) from archive ${result.archiveSha256.slice(0, 12)}`;
        return { summary, data: result, display };
      },
      async verify(ctx, input, result) {
        const checked = await verifyRestored({ dataDir, files: result.data.files });
        if (!checked.ok) return { ok: false, detail: checked.problems[0] };
        return { ok: true, detail: `re-read ${result.data.files.length} restored file(s) and every digest matched` };
      },
    },
  ];
}
