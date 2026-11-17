#!/usr/bin/env node
// T-15 evaluation runner.
//
//   node eval/run.js                 run every scenario once
//   node eval/run.js --category NAME run one category
//   node eval/run.js --id rq-02      run scenarios whose id matches (exact or prefix)
//   node eval/run.js --repeat 2      re-run each scenario in a fresh fixture and compare signatures
//   node eval/run.js --json          print the full machine-readable report
//   node eval/run.js --list          list declared scenarios and exit
//
// A nonzero exit means at least one scenario failed or the harness refused its input. A scenario
// that merely returns without throwing does not count as a pass; that rule lives in the framework.
//
// No inference system is launched, contacted, downloaded, or recommended. The only gateway is the
// no-backend stub or an in-process scripted fixture that returns fixed text.
import { runEvaluation, renderReport } from './framework.js';
import { SCENARIOS, CATEGORIES, makeContext, selectScenarios } from './index.js';

const USAGE = `Usage: node eval/run.js [--category NAME] [--id ID]... [--repeat N] [--json] [--list]

  --category NAME  run only scenarios in one category (${CATEGORIES.join(', ')})
  --id ID          run a scenario by exact id or id prefix; repeatable
  --repeat N       run each scenario N times in fresh fixtures and compare signatures
  --json           print a JSON report instead of the text report
  --list           list declared scenarios and exit
`;

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function value(argv, index, flag) {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) fail(`${flag} needs a value`);
  return next;
}

function parse(argv) {
  const options = { category: null, ids: [], repeat: 1, json: false, list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--category') options.category = value(argv, index++, '--category');
    else if (arg === '--id') options.ids.push(value(argv, index++, '--id'));
    else if (arg === '--repeat') {
      const raw = value(argv, index++, '--repeat');
      const repeat = Number(raw);
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) fail('--repeat must be an integer between 1 and 10');
      options.repeat = repeat;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`unknown option: ${arg}`);
  }
  if (options.category && !CATEGORIES.includes(options.category)) fail(`unknown category: ${options.category}`);
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.list) {
    for (const scenario of SCENARIOS) {
      process.stdout.write(`${scenario.id.padEnd(8)} ${scenario.category.padEnd(22)} ${scenario.title}${scenario.blind ? ' [blind]' : ''}\n`);
    }
    return;
  }

  const selected = selectScenarios({ category: options.category, ids: options.ids });
  if (selected.length === 0) fail('no scenario matched the selected category or id');

  const report = await runEvaluation({
    scenarios: selected,
    makeContext,
    repeat: options.repeat,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`evaluation failed: ${err?.stack ?? err}\n`);
  process.exit(2);
});
