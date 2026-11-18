import fs from 'node:fs';
const p = new URL('./src/council/index.js', import.meta.url);
let c = fs.readFileSync(p, 'utf8');
c = c.replace(/`\\$\\{dependents\\} dependent steps'/g, '`${dependents} dependent steps`');
fs.writeFileSync(p, c);
console.log('done', !c.includes("steps'"));
