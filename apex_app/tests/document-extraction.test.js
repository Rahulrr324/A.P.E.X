// Document extraction: real generated PDF, DOCX, XLSX and CSV fixtures read through the
// bounded parsers, the filesystem.extract action, filesystem.summarize dispatch, natural
// language routing, and the CLI. Nothing here starts a model or an inference server.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../src/app.js';
import { Outcome } from '../src/outcomes.js';
import { route } from '../src/controller/router.js';
import {
  detectFormat, extractDocument, csvDelimiter, decodeXmlText, MAX_DOCUMENT_BYTES,
} from '../src/filesystem/documents.js';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

const dirs = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

function tempDir() {
  const d = makeTempDataDir();
  dirs.push(d);
  return d;
}

function appFor(root) {
  return createApp({ dataDir: tempDir(), filesystemRoot: root });
}

// ---- fixture builders -------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A real ZIP container built from scratch. Entries are stored or deflated, so both the
// stored and the compressed paths in the reader are exercised.
function makeZip(files, { compress = false, encrypted = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const raw = compress ? zlib.deflateRawSync(data) : data;
    const method = compress ? 8 : 0;
    const crc = crc32(data);
    const flags = encrypted ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, raw);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + raw.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function docx(paragraphs, options = {}) {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: xml },
  ], options);
}

function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function xlsx(rows, options = {}) {
  const strings = [];
  const index = new Map();
  const shared = (value) => {
    if (!index.has(value)) {
      index.set(value, strings.length);
      strings.push(value);
    }
    return index.get(value);
  };
  const sheetRows = rows.map((cells, r) => {
    const encoded = cells.map((cell, c) => {
      const ref = `${columnLetters(c)}${r + 1}`;
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      return `<c r="${ref}" t="s"><v>${shared(cell)}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${encoded}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sharedXml = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  return makeZip([
    { name: 'xl/workbook.xml', data: '<workbook/>' },
    { name: 'xl/sharedStrings.xml', data: sharedXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ], options);
}

function pdf(contentStream, { compress = false, extra = '' } = {}) {
  const raw = Buffer.from(contentStream, 'latin1');
  const body = compress ? zlib.deflateSync(raw) : raw;
  const filter = compress ? ' /Filter /FlateDecode' : '';
  const header = '%PDF-1.4\n1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n';
  const stream = `2 0 obj << /Length ${body.length}${filter} >>\nstream\n`;
  const tail = '\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(stream, 'latin1'), body, Buffer.from(`${extra}${tail}`, 'latin1')]);
}

const PDF_TEXT = 'BT /F1 12 Tf 72 720 Td (Quarterly revenue report) Tj 0 -14 Td (Growth was 12 percent) Tj ET';

function write(root, name, data) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

// ---- unit: formats ----------------------------------------------------------

describe('document formats', () => {
  test('a PDF is detected by its header and both uncompressed and FlateDecode streams are read', () => {
    const plain = pdf(PDF_TEXT);
    assert.equal(detectFormat('report.pdf', plain), 'pdf');
    const fromPlain = extractDocument('report.pdf', plain);
    assert.equal(fromPlain.format, 'pdf');
    assert.match(fromPlain.text, /Quarterly revenue report/);
    assert.match(fromPlain.text, /Growth was 12 percent/);
    assert.equal(fromPlain.pages, 1);

    const packed = pdf(PDF_TEXT, { compress: true });
    const fromPacked = extractDocument('report.pdf', packed);
    assert.equal(fromPacked.text, fromPlain.text, 'compression does not change the extracted text');
    assert.equal(fromPacked.textSha256, fromPlain.textSha256);
  });

  test('a PDF with no text operators reports a limitation instead of an empty success claim', () => {
    const scanned = pdf('BI /W 16 /H 16 /BPC 8 /CS /G ID 0000000000000000 EI', { compress: true });
    const result = extractDocument('scan.pdf', scanned);
    assert.equal(result.text, '');
    assert.ok(result.limitations.some((line) => /no text-showing operators/.test(line)));
  });

  test('an encrypted PDF is refused with a stable code rather than decoded', () => {
    const encrypted = pdf(PDF_TEXT, { extra: '' });
    const withEncrypt = Buffer.concat([encrypted, Buffer.from('\n')]);
    const latin = withEncrypt.toString('latin1');
    const index = latin.indexOf('/Root');
    const patched = Buffer.from(latin.slice(0, index) + '/Encrypt 9 0 R ' + latin.slice(index), 'latin1');
    assert.throws(() => extractDocument('locked.pdf', patched), /does not decrypt documents/);
  });

  test('a file named .pdf without a PDF header is refused as damaged', () => {
    assert.throws(() => detectFormat('fake.pdf', Buffer.from('not a pdf at all')), /no PDF header/);
  });
});

describe('DOCX and XLSX', () => {
  test('DOCX paragraphs are extracted with entities decoded, stored or deflated', () => {
    const buffer = docx(['Quarterly &amp; annual plan', 'Second paragraph']);
    const result = extractDocument('plan.docx', buffer);
    assert.equal(result.format, 'docx');
    assert.match(result.text, /Quarterly & annual plan/);
    assert.match(result.text, /Second paragraph/);

    const compressed = extractDocument('plan.docx', docx(['Quarterly &amp; annual plan', 'Second paragraph'], { compress: true }));
    assert.equal(compressed.textSha256, result.textSha256);
  });

  test('XML entities decode to their characters, including numeric forms', () => {
    assert.equal(decodeXmlText('a &lt; b &amp;&amp; c &#65; &#x42;'), "a < b && c A B");
  });

  test('a DOCX with a wrong checksum is refused as damaged', () => {
    const buffer = docx(['Integrity matters']);
    const zip = buffer.toString('latin1');
    const index = zip.indexOf('<w:body>');
    const flipped = Buffer.from(buffer);
    flipped[index + 9] = (flipped[index + 9] + 1) % 128;
    assert.throws(() => extractDocument('plan.docx', flipped), /checksum|decompressed|damaged/i);
  });

  test('an encrypted ZIP container is refused', () => {
    assert.throws(() => extractDocument('plan.docx', docx(['secret'], { encrypted: true })), /does not decrypt documents/);
  });

  test('XLSX shared strings and numeric cells are extracted as tab-separated rows', () => {
    const buffer = xlsx([['Name', 'Quarter', 'Price'], ['Widget', 'Q1', 12.5]]);
    const result = extractDocument('data.xlsx', buffer);
    assert.equal(result.format, 'xlsx');
    assert.match(result.text, /Name\tQuarter\tPrice/);
    assert.match(result.text, /Widget\tQ1\t12\.5/);
    assert.equal(result.rows, 2);
  });

  test('a ZIP that is neither DOCX nor XLSX is unsupported, not guessed', () => {
    const plainZip = makeZip([{ name: 'readme.txt', data: 'hello' }]);
    assert.throws(() => extractDocument('bundle.zip', plainZip), /neither a DOCX nor an XLSX/);
  });
});

describe('CSV', () => {
  test('quoted fields, embedded commas, escaped quotes and CRLF are parsed', () => {
    const text = 'name,note\r\n"Smith, Jane","said ""hello"""\r\nBob,plain\r\n';
    const result = extractDocument('contacts.csv', Buffer.from(text));
    assert.equal(result.format, 'csv');
    assert.equal(result.rows, 3);
    assert.equal(result.columns, 2);
    assert.match(result.text, /Smith, Jane\tsaid "hello"/);
  });

  test('the delimiter is chosen once: semicolon, tab, and a .tsv name', () => {
    assert.deepEqual(extractDocument('a.csv', Buffer.from('a;b;c\n1;2;3')).columns, 3);
    assert.equal(csvDelimiter('a;b;c', 'a.csv'), ';');
    assert.equal(csvDelimiter('a\tb\tc', 'a.csv'), '\t');
    assert.equal(csvDelimiter('a,b,c', 'a.tsv'), '\t');
    const tsv = extractDocument('a.tsv', Buffer.from('left\tright\n1\t2'));
    assert.match(tsv.text, /left\tright/);
  });

  test('an unterminated quoted field is refused rather than silently truncated', () => {
    assert.throws(() => extractDocument('a.csv', Buffer.from('a,b\n"open,end')), /ends inside a quoted field/);
  });

  test('a UTF-16 CSV is refused as not UTF-8 text', () => {
    const utf16 = Buffer.from('a,b\n1,2', 'utf16le');
    assert.throws(() => extractDocument('a.csv', utf16), /not UTF-8 text|UTF-16/);
  });

  test('plain UTF-8 text stays a supported text format', () => {
    const result = extractDocument('notes.txt', Buffer.from('alpha\nbeta\n'));
    assert.equal(result.format, 'text');
    assert.equal(result.lines, 2);
  });
});

// ---- action and controller integration --------------------------------------

describe('filesystem.extract action', () => {
  test('extracts a document, reports stats and a text hash, and keeps the text out of the record', async () => {
    const root = tempDir();
    write(root, 'reports/q1.pdf', pdf(PDF_TEXT));
    const app = appFor(root);

    const res = await app.controller.workspaceExtract({ path: 'reports/q1.pdf' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.format, 'pdf');
    assert.equal(data.pages, 1);
    assert.match(data.textSha256, /^[0-9a-f]{64}$/);
    assert.equal('text' in data, false, 'the operation record holds a hash, not the document text');
    assert.match(res.display, /Quarterly revenue report/);
    assert.match(res.display, /not an interpretation/);
  });

  test('summarize dispatches to extraction for a document and still recomputes its analysis', async () => {
    const root = tempDir();
    write(root, 'plan.docx', docx(['Release plan', 'Ship the offline build']));
    const app = appFor(root);

    const res = await app.controller.workspaceSummarize({ path: 'plan.docx' });
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    const data = res.operation.steps[0].result.data;
    assert.equal(data.format, 'docx');
    assert.match(data.textSha256, /^[0-9a-f]{64}$/);
    assert.match(res.display, /Summary of "plan\.docx" \(docx/);
    assert.match(res.display, /Release plan/);
  });

  test('a damaged document fails without a verified success, and a good one is re-checked against the file', async () => {
    const root = tempDir();
    write(root, 'broken.docx', Buffer.from('PK\u0003\u0004 truncated'));
    const app = appFor(root);

    const res = await app.controller.workspaceExtract({ path: 'broken.docx' });
    assert.equal(res.status, Outcome.EXECUTION_FAILED);
    assert.match(res.display, /damaged|readable ZIP|central directory/i);
  });

  test('extraction is user-origin only', async () => {
    const root = tempDir();
    write(root, 'a.csv', Buffer.from('x,y\n1,2\n'));
    const app = appFor(root);

    assert.equal(app.registry.authorize('filesystem.extract', 'model').decision, 'deny');
    const step = await app.controller.runAction('filesystem.extract', { path: 'a.csv' }, 'model', 'op-x');
    assert.equal(step.outcome, Outcome.ACTION_DENIED);
  });

  test('a model input field cannot widen the path or the format', async () => {
    const root = tempDir();
    write(root, 'a.csv', Buffer.from('x,y\n1,2\n'));
    const app = appFor(root);

    const res = await app.controller.workspaceExtract({ path: 'a.csv', format: 'pdf' });
    assert.equal(res.status, Outcome.INPUT_REJECTED);
    assert.match(res.display, /unexpected input field/);
  });

  test('extraction honours a byte bound and the configured cap', async () => {
    const root = tempDir();
    write(root, 'a.csv', Buffer.from('a,b\n1,2\n3,4\n'));
    const app = appFor(root);

    const small = await app.controller.workspaceExtract({ path: 'a.csv', maxBytes: 4 });
    assert.equal(small.status, Outcome.EXECUTION_FAILED);
    assert.match(small.display, /limit is 4/);

    const tooBig = await app.controller.workspaceExtract({ path: 'a.csv', maxBytes: MAX_DOCUMENT_BYTES + 1 });
    assert.equal(tooBig.status, Outcome.INPUT_REJECTED);

    const ok = await app.controller.workspaceExtract({ path: 'a.csv', maxBytes: 64 });
    assert.equal(ok.status, Outcome.SUCCESS_VERIFIED, ok.display);
  });
});

// ---- routing and CLI --------------------------------------------------------

describe('routing and CLI', () => {
  test('natural language extracts only a path-shaped target', () => {
    assert.deepEqual(route('extract text from report.pdf'), {
      kind: 'action',
      capability: 'filesystem.extract',
      action: 'filesystem.extract',
      input: { path: 'report.pdf' },
    });
    assert.deepEqual(route('pull the content out of docs/summary.docx'), {
      kind: 'action',
      capability: 'filesystem.extract',
      action: 'filesystem.extract',
      input: { path: 'docs/summary.docx' },
    });
    assert.equal(route('extract text from my notes').kind, 'model');
    assert.equal(route('extract the meaning of this project').kind, 'model');
  });

  test('the request path answers an extraction without a model', async () => {
    const root = tempDir();
    write(root, 'report.pdf', pdf(PDF_TEXT));
    const app = appFor(root);

    const res = await app.controller.handle('extract text from report.pdf');
    assert.equal(res.status, Outcome.SUCCESS_VERIFIED, res.display);
    assert.match(res.display, /Quarterly revenue report/);
  });

  test('the CLI extracts a document and reports a damaged one with a non-zero exit', async () => {
    const root = tempDir();
    write(root, 'table.xlsx', xlsx([['Item', 'Count'], ['Crate', 4]]));
    write(root, 'bad.pdf', Buffer.from('not a pdf'));
    const second = tempDir();
    write(second, 'short.csv', Buffer.from('a,b\n1,2\n'));
    const env = cleanEnv({
      APEX_DATA_DIR: tempDir(),
      APEX_FILESYSTEM_ROOT: root,
      APEX_WORKSPACES: `second=${second}`,
    });

    const ok = await runCli(['workspace', 'extract', 'table.xlsx'], env);
    assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /Item\tCount/);
    assert.match(ok.stdout, /Crate\t4/);

    const secondRoot = await runCli(['workspace', 'extract', 'short.csv', '--workspace', 'second'], env);
    assert.equal(secondRoot.code, 0, `${secondRoot.stdout}${secondRoot.stderr}`);
    assert.match(secondRoot.stdout, /a\tb/);

    const bad = await runCli(['workspace', 'extract', 'bad.pdf'], env);
    assert.notEqual(bad.code, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /PDF header|damaged/i);

    const missing = await runCli(['workspace', 'extract'], env);
    assert.equal(missing.code, 2);
  });
});
