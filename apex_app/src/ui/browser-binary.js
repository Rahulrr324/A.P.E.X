// T-31 Step 1 (2026-11-19): one browser-binary resolver, shared by the thin desktop shell and
// the real-browser verification suite.
//
// Why this module exists: Playwright's own bundled Chromium has to be downloaded from
// `cdn.playwright.dev`, which is unreachable in the development sandbox, so a suite that only
// asks Playwright for "chromium" cannot run anywhere that download is blocked — even where a
// perfectly good Chromium-family browser is already installed. The GitHub-hosted runner has
// `/usr/bin/microsoft-edge`; a developer machine usually has Edge, Chrome or Chromium on PATH.
// Resolving the binary explicitly means the same suite runs in real Edge, in real Chrome, or in
// real Chromium, and says which one it used.
//
// Precedence, highest first:
//   1. `APEX_BROWSER_BIN` (the T-31 name), then the older `APEX_DESKTOP_BROWSER_BIN`;
//   2. Playwright's own downloaded browser, when the caller passes its path and it exists;
//   3. the platform's discovery order — Edge first, then Chrome, then Chromium — by bare name
//      on PATH and by the absolute path the platform installs it at.
//
// This module is zero-dependency: it imports nothing but Node's own `fs` and `path`, and it never
// launches anything. The desktop shell uses it to build a launcher command; the verification
// suite hands the result to `chromium.launch({ executablePath })`. Resolution is a read of the
// filesystem, not a capability, and it authorizes nothing.
import fs from 'node:fs';
import path from 'node:path';

export const BROWSER_BINARY_SCHEMA = 'apex.browser-binary/1';

// The absolute paths each platform installs Edge, Chrome and Chromium at. They are tried after
// the bare names, so a browser that is on PATH is preferred and a browser installed somewhere
// PATH does not cover is still found.
const LINUX_ABSOLUTE = [
  ['msedge', '/usr/bin/microsoft-edge'],
  ['msedge-stable', '/usr/bin/microsoft-edge-stable'],
  ['chrome', '/usr/bin/google-chrome'],
  ['chrome-stable', '/usr/bin/google-chrome-stable'],
  ['chromium', '/usr/bin/chromium'],
  ['chromium-browser', '/usr/bin/chromium-browser'],
  ['chromium-snap', '/snap/bin/chromium'],
];

const MAC_ABSOLUTE = [
  ['msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['chrome-beta', '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
  ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
];

function winRoots(env) {
  return [
    env['PROGRAMFILES(X86)'], env['ProgramFiles(x86)'], env.PROGRAMFILES, env.ProgramFiles,
    env.LOCALAPPDATA, env.LocalAppData,
  ].filter((root) => typeof root === 'string' && root.length > 0);
}

function winCandidates(env) {
  const roots = winRoots(env);
  const relative = [
    ['msedge', path.win32.join('Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['chrome', path.win32.join('Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chromium', path.win32.join('Chromium', 'Application', 'chrome.exe')],
  ];
  const list = [];
  for (const [id, suffix] of relative) {
    for (const root of roots) {
      list.push({ id, label: path.win32.basename(suffix), command: path.win32.join(root, suffix) });
    }
    // A bare name is also tried, so an executable on PATH is found without knowing where it lives.
    list.push({ id, label: path.win32.basename(suffix), command: path.win32.basename(suffix) });
  }
  return list;
}

function macCandidates() {
  return MAC_ABSOLUTE.map(([id, command]) => ({
    id,
    label: id === 'msedge' ? 'Microsoft Edge' : id.startsWith('chrome') ? 'Google Chrome' : 'Chromium',
    command,
  }));
}

function linuxCandidates() {
  const bare = [
    ['msedge', 'microsoft-edge'],
    ['msedge-stable', 'microsoft-edge-stable'],
    ['chrome', 'google-chrome'],
    ['chrome-stable', 'google-chrome-stable'],
    ['chromium', 'chromium'],
    ['chromium-browser', 'chromium-browser'],
  ];
  return [
    ...bare.map(([id, command]) => ({ id, label: command, command })),
    // The absolute paths come last and are separate entries: when PATH is deliberately restricted
    // (a test, a service unit, a locked-down shell) the bare name cannot resolve, but the browser
    // is still installed where the distribution puts it.
    ...LINUX_ABSOLUTE
      .filter(([, command]) => !bare.some(([, bareCommand]) => bareCommand === command))
      .map(([id, command]) => ({ id: `${id}-path`, label: command, command, absolutePath: true })),
  ];
}

function platformCandidates({ platform, env }) {
  if (platform === 'win32') return winCandidates(env);
  if (platform === 'darwin') return macCandidates();
  return linuxCandidates();
}

function explicitOverride(env) {
  const candidates = [
    ['APEX_BROWSER_BIN', env.APEX_BROWSER_BIN],
    ['APEX_DESKTOP_BROWSER_BIN', env.APEX_DESKTOP_BROWSER_BIN],
  ];
  for (const [label, value] of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return { id: 'env', label, command: value.trim() };
  }
  return null;
}

// The ordered candidate list. `playwrightPath` is optional and is only used when the file it names
// exists: Playwright reports the path it *would* download to whether or not it did, so an unchecked
// value would produce a launch attempt against a missing file.
export function browserCandidates({ platform = process.platform, env = process.env, playwrightPath = null, exists = null } = {}) {
  const list = [];
  const override = explicitOverride(env);
  if (override) list.push(override);
  if (typeof playwrightPath === 'string' && playwrightPath.length > 0) {
    const present = typeof exists === 'function' ? exists(playwrightPath) : fileExists(playwrightPath, { platform, env });
    if (present) list.push({ id: 'playwright', label: 'Playwright bundled Chromium', command: playwrightPath });
  }
  list.push(...platformCandidates({ platform, env }));
  return list;
}

// Deterministic resolution: a path is tested directly; a bare name is searched on PATH. It
// returns the absolute file so the printed command names a real executable rather than a name
// that happens to resolve in this shell's environment.
export function findExecutable(command, { platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const hasSeparator = command.includes('/') || (platform === 'win32' && command.includes('\\'));
  const test = (candidate) => {
    try {
      fsImpl.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return fsImpl.statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  };
  if (hasSeparator) return test(command);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const directories = String(env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${platform === 'win32' && !command.toLowerCase().endsWith(extension.toLowerCase()) ? extension : ''}`);
      const found = test(candidate);
      if (found) return found;
    }
  }
  return null;
}

export function isExecutable(command, options = {}) {
  return findExecutable(command, options) !== null;
}

function fileExists(candidate, options = {}) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return isExecutable(candidate, options) !== null;
  }
}

// Resolves the first candidate that actually exists. `tried` is the whole plan, in order, so a
// failure can report exactly what was attempted rather than "no browser found".
export function resolveBrowser({ platform = process.platform, env = process.env, candidates = null, executable = findExecutable, playwrightPath = null } = {}) {
  const plan = candidates ?? browserCandidates({ platform, env, playwrightPath });
  for (const candidate of plan) {
    const found = executable(candidate.command, { platform, env });
    if (found) {
      return {
        schema: BROWSER_BINARY_SCHEMA,
        browser: candidate,
        executable: typeof found === 'string' ? found : candidate.command,
        source: candidate.id === 'env' || candidate.id === 'playwright' ? candidate.id : 'system',
        tried: plan.map((entry) => entry.command),
      };
    }
  }
  return {
    schema: BROWSER_BINARY_SCHEMA, browser: null, executable: null, source: null, tried: plan.map((entry) => entry.command),
  };
}

// What a suite should print when there is no browser anywhere: a diagnostic, never a pass.
export function noBrowserDiagnostic(resolution) {
  const tried = resolution?.tried?.length ? resolution.tried.join(', ') : '(no candidates on this platform)';
  return `no Chromium-family browser is installed on this host, so no real-browser check ran; tried: ${tried}`;
}
