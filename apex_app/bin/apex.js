#!/usr/bin/env node
// APEX Local Alpha entry point. Run from the apex_app directory:
//   node bin/apex.js status
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fatal: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  },
);
