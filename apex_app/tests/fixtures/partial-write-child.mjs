// TEST FIXTURE for Batch F / 066: a real process that writes the bytes a crash would
// leave behind - a record prefix with no terminating newline - then exits abruptly with a
// non-zero status. It does not simulate a kill inside a syscall; it reproduces the durable
// state such a kill leaves, which is what the next process has to recover from.
import fs from 'node:fs';

const [file, text, exitCode] = process.argv.slice(2);
fs.appendFileSync(file, text);
const fd = fs.openSync(file, 'r+');
fs.fsyncSync(fd);
fs.closeSync(fd);
process.exit(Number(exitCode || 9));
