import fs from 'node:fs';
const p = new URL('./src/council/index.js', import.meta.url);
let c = fs.readFileSync(p, 'utf8');
const lines = c.split('\n');
const out = lines.map((line) => {
  if (line.includes('\\\\u0000') || line.includes('\\\\u0008')) {
    return line.replace(/\\\\u/g, '\\u');
  }
  return line;
});
fs.writeFileSync(p, out.join('\n'));
console.log('done', out.join('\n').includes('\\\\u'));
