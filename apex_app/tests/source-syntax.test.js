// T-30 (2026-11-19): guard the source and the extracted browser client against unexecuted syntax edits.
// This deliberately uses Node's parser for every source file and parses UI_CLIENT as its own program;
// parsing assets.js alone cannot catch malformed JavaScript hidden inside the served string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { UI_CLIENT } from '../src/ui/assets.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(APP_ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function sourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(file);
    }
  };
  visit(root);
  return files.sort();
}

test('every source file passes node --check and the served UI client parses independently', () => {
  const files = sourceFiles(SOURCE_ROOT);
  assert.ok(files.length > 0, 'the source tree contains JavaScript files');
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const detail = String(error.stderr ?? error.message).trim();
      assert.fail(`node --check failed for ${path.relative(APP_ROOT, file)}:\n${detail}`);
    }
  }
  assert.doesNotThrow(
    () => new vm.Script(UI_CLIENT, { filename: 'apex-ui-client.js' }),
    'the extracted browser client is a syntactically valid program',
  );
});
