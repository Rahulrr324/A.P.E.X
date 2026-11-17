// Bounded document extraction. PDF, DOCX, XLSX and CSV are read without executing
// anything they contain: a PDF is parsed for text operators, an OOXML file is parsed as
// bytes through a minimal ZIP reader, and a CSV is parsed as text with quoted fields.
//
// Every parser is bounded and says what it could not read. A scanned PDF (no text
// operators), an object-stream PDF, a workbook that is not the first sheet, or a
// document truncated at the extraction cap is reported as a limitation, never as a
// complete understanding of the file. Embedded content is never run, no external
// program is invoked, and no model is consulted.
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { ExecutionError } from '../errors.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const TEXT_EXTENSIONS = Object.freeze([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sql', '.sh',
  '.ps1', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
]);
export const MAX_EXTRACTED_CHARS = 200_000;
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_PDF_STREAMS = 500;
const MAX_PDF_EXAMINED_STREAMS = 2_000;
const MAX_PDF_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_PDF_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_CSV_ROWS = 2_000;
const MAX_CSV_COLUMNS = 50;

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

function damaged(message) {
  return new ExecutionError('DAMAGED_DOCUMENT', message);
}

function tooComplex(message) {
  return new ExecutionError('DOCUMENT_TOO_COMPLEX', message);
}

export function decodeXmlText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return match;
  });
}

// Text decoding is deliberately explicit. A BOM selects UTF-16LE/BE or UTF-8; otherwise UTF-8
// with fatal errors is required. No transcoding guess is made, because a mojibake ingest would be
// worse than an honest encoding error.
export function decodeTextBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(3));
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

function normaliseWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- ZIP -------------------------------------------------------------------

function readZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw damaged('not a readable ZIP container (no central directory)');
  const entries = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ZIP_ENTRIES) throw tooComplex(`the archive holds ${entries} entries; the limit is ${MAX_ZIP_ENTRIES}`);
  if (directorySize > MAX_ZIP_DIRECTORY_BYTES) throw tooComplex('the central directory is larger than the supported bound');
  if (directoryOffset + directorySize > buf.length) throw damaged('the central directory points outside the file');

  const byName = new Map();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw damaged('the central directory is damaged');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const expectedCrc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > buf.length) throw damaged('an entry name points outside the file');
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (flags & 1) throw new ExecutionError('ENCRYPTED_DOCUMENT', 'the archive is encrypted; APEX does not decrypt documents');
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw tooComplex(`entry "${name}" declares ${uncompressedSize} bytes; the limit is ${MAX_ZIP_ENTRY_BYTES}`);
    if (method !== 0 && method !== 8) throw new ExecutionError('UNSUPPORTED_FORMAT', `entry "${name}" uses compression method ${method}`);
    total += uncompressedSize;
    if (total > MAX_ZIP_TOTAL_BYTES) throw tooComplex('the archive expands beyond the supported bound');
    byName.set(name, {
      name, method, expectedCrc, compressedSize, uncompressedSize, localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    names: [...byName.keys()],
    has(name) { return byName.has(name); },
    read(name) {
      const entry = byName.get(name);
      if (!entry) return null;
      const local = entry.localOffset;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
        throw damaged(`entry "${name}" has no readable local header`);
      }
      const localNameLength = buf.readUInt16LE(local + 26);
      const localExtraLength = buf.readUInt16LE(local + 28);
      const start = local + 30 + localNameLength + localExtraLength;
      const end = start + entry.compressedSize;
      if (end > buf.length) throw damaged(`entry "${name}" points outside the file`);
      const raw = buf.subarray(start, end);
      let output;
      try {
        output = entry.method === 0
          ? Buffer.from(raw)
          : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      } catch {
        throw damaged(`entry "${name}" could not be decompressed`);
      }
      if (output.length !== entry.uncompressedSize) {
        throw damaged(`entry "${name}" does not match its declared size`);
      }
      if (crc32(output) !== entry.expectedCrc) {
        throw damaged(`entry "${name}" fails its stored checksum`);
      }
      return output;
    },
  };
}

// ---- DOCX ------------------------------------------------------------------

function docxText(zip) {
  const xml = zip.read('word/document.xml');
  if (xml === null) throw damaged('the DOCX has no word/document.xml');
  const source = xml.toString('utf8');
  let out = '';
  let inText = false;
  let inInstruction = false;
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('<')) {
      const nameMatch = /^<\s*\/?\s*([A-Za-z0-9:._-]+)/.exec(token);
      const name = nameMatch ? nameMatch[1].toLowerCase() : '';
      const closing = /^<\s*\//.test(token);
      const selfClosing = /\/>\s*$/.test(token);
      if (name === 'w:t' && !selfClosing) inText = !closing;
      else if (name === 'w:instrtext' && !selfClosing) inInstruction = !closing;
      else if (!closing && (name === 'w:tab')) out += '\t';
      else if (!closing && (name === 'w:br' || name === 'w:cr')) out += '\n';
      else if (closing && (name === 'w:p' || name === 'w:tr')) out += '\n';
      else if (closing && name === 'w:tc') out += '\t';
      continue;
    }
    if (inText && !inInstruction) out += decodeXmlText(token);
  }
  return normaliseWhitespace(out);
}

// ---- XLSX ------------------------------------------------------------------

function collectTextElements(xml) {
  const parts = [];
  for (const match of xml.matchAll(/<(?:w:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:)?t>/g)) {
    parts.push(decodeXmlText(match[1]));
  }
  return parts.join('');
}

function sharedStrings(xml) {
  const values = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    values.push(collectTextElements(match[1]));
  }
  return values;
}

function columnIndex(reference) {
  const letters = /^[A-Za-z]+/.exec(reference ?? '');
  if (!letters) return null;
  let index = 0;
  for (const ch of letters[0].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function xlsxText(zip) {
  if (!zip.has('xl/workbook.xml')) throw damaged('the XLSX has no xl/workbook.xml');
  const sharedXml = zip.has('xl/sharedStrings.xml') ? zip.read('xl/sharedStrings.xml').toString('utf8') : '';
  const strings = sharedStrings(sharedXml);
  const sheetName = zip.names.find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw damaged('the XLSX has no worksheet');
  const sheet = zip.read(sheetName).toString('utf8');
  const rows = [];
  let truncated = false;
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_CSV_ROWS) {
      truncated = true;
      break;
    }
    const cells = [];
    let sequential = 0;
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const reference = /\br="([A-Za-z]+)\d+"/.exec(attrs)?.[1] ?? null;
      const column = columnIndex(reference);
      const position = column === null ? sequential : column;
      sequential = position + 1;
      if (position >= MAX_CSV_COLUMNS) {
        truncated = true;
        continue;
      }
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? null;
      const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? null;
      let text = '';
      if (type === 's' && value !== null) text = strings[Number.parseInt(value, 10)] ?? '';
      else if (type === 'inlineStr' && inline !== null) text = collectTextElements(inline);
      else if (value !== null) text = decodeXmlText(value);
      cells[position] = text;
    }
    rows.push(cells.map((cell) => cell ?? '').join('\t'));
  }
  return { text: normaliseWhitespace(rows.join('\n')), rows: rows.length, truncated };
}

// ---- PDF -------------------------------------------------------------------

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (next === '\n') out += '\n';
    else if (next === '\r') {
      if (raw[i + 1] === '\n') i += 1;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let k = 0; k < 2 && /[0-7]/.test(raw[i + 1] ?? ''); k += 1) {
        i += 1;
        octal += raw[i];
      }
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
    } else out += next;
  }
  return out;
}

function decodePdfHex(raw) {
  const clean = raw.replace(/\s+/g, '');
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) return '';
  let out = '';
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function textFromPdfStream(stream) {
  let out = '';
  // Text-showing operators only. Positioning operators separate runs so words from
  // different lines are not glued together.
  const block = /BT([\s\S]*?)ET/g;
  for (const match of stream.matchAll(block)) {
    const body = match[1];
    const pieces = [];
    const literal = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g;
    const arrays = /\[((?:\\.|[^\]\\])*)\]\s*TJ/g;
    for (const m of body.matchAll(literal)) pieces.push(decodePdfString(m[1]));
    for (const m of body.matchAll(arrays)) {
      for (const s of m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)) pieces.push(decodePdfString(s[1]));
    }
    for (const m of body.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) pieces.push(decodePdfHex(m[1]));
    if (pieces.length > 0) out += `${pieces.join(' ')}\n`;
    if (/\b(?:Td|TD|T\*)\b/.test(body) && pieces.length === 0) out += '\n';
  }
  return out;
}

function pdfText(buf) {
  const header = buf.subarray(0, 8).toString('latin1');
  if (!header.startsWith('%PDF-')) throw damaged('the file does not start with a PDF header');
  const latin = buf.toString('latin1');
  if (/\/Encrypt\b/.test(latin)) {
    throw new ExecutionError('ENCRYPTED_DOCUMENT', 'the PDF is encrypted; APEX does not decrypt documents');
  }
  const pages = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
  const limitations = [];
  if (/\/ObjStm\b/.test(latin)) {
    limitations.push('the PDF uses compressed object streams; text held only there could not be read');
  }
  let out = '';
  let streams = 0;
  let skipped = 0;
  let examined = 0;
  let index = 0;
  while (streams < MAX_PDF_STREAMS && examined < MAX_PDF_EXAMINED_STREAMS) {
    const marker = latin.indexOf('stream', index);
    if (marker < 0) break;
    examined += 1;
    const start = marker + 6;
    const eol = latin[start] === '\r' && latin[start + 1] === '\n' ? 2 : latin[start] === '\n' || latin[start] === '\r' ? 1 : 0;
    const end = latin.indexOf('endstream', start + eol);
    if (end < 0) {
      limitations.push('a stream has no end marker; the rest of the file was not read');
      break;
    }
    const dataStart = start + eol;
    const dataEnd = end;
    const dictionary = latin.slice(Math.max(0, marker - 2000), marker);
    const compressed = /\/FlateDecode\b/.test(dictionary);
    if (compressed && dataEnd - dataStart > MAX_PDF_STREAM_BYTES) {
      skipped += 1;
      index = end + 9;
      continue;
    }
    const raw = buf.subarray(dataStart, dataEnd);
    let decoded;
    if (compressed) {
      try {
        decoded = zlib.inflateSync(raw, { maxOutputLength: MAX_PDF_INFLATED_BYTES });
      } catch {
        skipped += 1;
        index = end + 9;
        continue;
      }
    } else {
      decoded = raw;
    }
    streams += 1;
    const text = textFromPdfStream(decoded.toString('latin1'));
    if (text.length > 0) out += text;
    index = end + 9;
  }
  if (skipped > 0) limitations.push(`${skipped} stream(s) could not be inflated within the bounds and were skipped`);
  if (examined >= MAX_PDF_EXAMINED_STREAMS) limitations.push(`only the first ${MAX_PDF_EXAMINED_STREAMS} stream markers were examined`);
  if (index < latin.length && streams >= MAX_PDF_STREAMS) limitations.push(`only the first ${MAX_PDF_STREAMS} streams were read`);
  const text = normaliseWhitespace(out);
  if (text.length === 0) limitations.push('no text-showing operators were found; a scanned PDF or an unsupported encoding may hold no extractable text');
  return { text, pages, limitations };
}

// ---- CSV -------------------------------------------------------------------

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;
  let truncated = false;
  while (index < text.length) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      index += ch === '\r' && text[index + 1] === '\n' ? 2 : 1;
      if (rows.length >= MAX_CSV_ROWS) {
        truncated = true;
        break;
      }
      continue;
    }
    field += ch;
    index += 1;
  }
  if (quoted) throw damaged('the CSV ends inside a quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  const columns = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
  if (columns > MAX_CSV_COLUMNS) {
    for (const cells of rows) cells.length = Math.min(cells.length, MAX_CSV_COLUMNS);
  }
  return {
    text: rows.map((cells) => cells.slice(0, MAX_CSV_COLUMNS).join('\t')).join('\n'),
    rows: rows.length,
    columns: Math.min(columns, MAX_CSV_COLUMNS),
    truncated: truncated || columns > MAX_CSV_COLUMNS,
  };
}

// The delimiter is chosen once from the first non-empty line (a tab-separated file
// otherwise named .csv still parses), and the same delimiter is used for every row.
export function csvDelimiter(text, name = '') {
  if (path.extname(String(name)).toLowerCase() === '.tsv') return '\t';
  const firstLine = text.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0) ?? '';
  const counts = {
    ',': (firstLine.match(/,/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
  };
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

// ---- format dispatch -------------------------------------------------------

export function detectFormat(name, buf) {
  const extension = path.extname(String(name ?? '')).toLowerCase();
  const pdfMagic = buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const zipMagic = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (pdfMagic) return 'pdf';
  if (zipMagic) {
    const zip = readZip(buf);
    if (zip.has('word/document.xml')) return 'docx';
    if (zip.has('xl/workbook.xml')) return 'xlsx';
    throw new ExecutionError('UNSUPPORTED_FORMAT', 'the ZIP container is neither a DOCX nor an XLSX document');
  }
  if (extension === '.pdf') throw damaged('the file has a .pdf name but no PDF header');
  if (extension === '.docx') throw damaged('the file has a .docx name but is not a ZIP container');
  if (extension === '.xlsx') throw damaged('the file has a .xlsx name but is not a ZIP container');
  if (extension === '.csv' || extension === '.tsv') return 'csv';
  return 'text';
}

// Extract one document. `format` is the detected format; a text or CSV document is
// returned as decoded text. The returned text is bounded by MAX_EXTRACTED_CHARS and
// `truncated` says whether the bound cut it.
export function extractDocument(name, buf, { format = null } = {}) {
  const detected = format ?? detectFormat(name, buf);
  let text = '';
  let limitations = [];
  let details = {};
  if (detected === 'pdf') {
    const result = pdfText(buf);
    text = result.text;
    limitations = result.limitations;
    details = { pages: result.pages };
  } else if (detected === 'docx') {
    const zip = readZip(buf);
    text = docxText(zip);
    if (!zip.has('word/styles.xml')) limitations.push('no word/styles.xml; heading levels were not extracted');
    details = {};
  } else if (detected === 'xlsx') {
    const zip = readZip(buf);
    const result = xlsxText(zip);
    text = result.text;
    if (result.truncated) limitations.push(`only the first ${MAX_CSV_ROWS} rows and ${MAX_CSV_COLUMNS} columns of the first worksheet were read`);
    details = { rows: result.rows };
  } else if (detected === 'csv') {
    let decoded;
    try {
      decoded = decodeTextBuffer(buf);
    } catch {
      throw new ExecutionError('FILE_NOT_TEXT', 'the CSV is not valid UTF-8 text (a BOM-marked UTF-16 file is accepted)');
    }
    // UTF-16 text decodes as valid UTF-8 with NUL bytes between characters, so the
    // control-character check is what keeps a mis-encoded CSV from being parsed as noise.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) {
      throw new ExecutionError('FILE_NOT_TEXT', 'the CSV is not UTF-8 text (it may be UTF-16 encoded)');
    }
    const result = parseCsv(decoded.replace(/^\uFEFF/, ''), csvDelimiter(decoded, name));
    text = result.text;
    if (result.truncated) limitations.push(`only the first ${MAX_CSV_ROWS} rows and ${MAX_CSV_COLUMNS} columns were read`);
    details = { rows: result.rows, columns: result.columns };
  } else {
    let decoded;
    try {
      decoded = decodeTextBuffer(buf);
    } catch {
      throw new ExecutionError('UNSUPPORTED_FORMAT', 'the file is not a PDF, DOCX, XLSX or CSV document, and it is not UTF-8 text (a BOM-marked UTF-16 file is accepted)');
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) {
      throw new ExecutionError('UNSUPPORTED_FORMAT', 'the file is not a PDF, DOCX, XLSX or CSV document, and it is not text');
    }
    text = normaliseWhitespace(decoded);
    details = {};
  }
  let truncated = false;
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS);
    truncated = true;
  }
  const words = text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
  return {
    format: detected,
    text,
    textSha256: sha256(Buffer.from(text, 'utf8')),
    chars: text.length,
    words,
    lines: text.length === 0 ? 0 : text.split('\n').length,
    truncated,
    limitations,
    ...details,
  };
}

export function documentFormats() {
  return ['pdf', 'docx', 'xlsx', 'csv'];
}
