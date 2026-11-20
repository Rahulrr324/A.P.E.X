# ADR: desktop shell for APEX (T-30 Package 5)

- **Status:** proposed, not implemented. No shell code exists in this repository.
- **Date:** 2026-11-19
- **Decision owner:** the project owner. The master document (Part 7) leaves the platform
  decision open; this record gives the build agent's recommendation and the evidence behind it.
- **Applies to:** how the owner reaches APEX on their own machines. It does not change the
  authorization model: the ECP (`src/executive/control-plane.js`) stays the sole authority, and
  a UI token is never owner identity.

## Context

APEX today is a zero-runtime-dependency Node application (`apex_app/`) serving a loopback web
UI at `127.0.0.1`. The owner's intended end state is a persistent personal desktop assistant,
not a browser tab (master document §1.5). Three candidate paths are on the table:

- **(A) Loopback browser + thin shell** — keep the existing UI as the only renderer and wrap it
  in a minimal native window.
- **(B) Tauri** — Rust host, system webview, small binary.
- **(C) Electron** — Chromium + Node bundled.

Constraints that shape the decision:

1. `apex_app` stays zero-runtime-dependency; the browser UI must remain a supported fallback.
2. No model inference is authorized, so the shell is not on the critical path for capability.
3. The authorization boundary is server-side. A shell that talks to stores directly would
   create a second authority and is unacceptable.
4. Whatever is chosen must be reviewable by the owner without a toolchain they do not have.
5. Nothing may be added that the build agent cannot verify in this environment.

## Decision matrix

| Criterion | (A) Thin shell around loopback UI | (B) Tauri | (C) Electron |
| --- | --- | --- | --- |
| **IPC security** | No new IPC. The shell loads one URL; all authority stays in the HTTP API behind the existing token + `x-apex-ui` checks. | Needs a reviewed command surface; every exposed command is a new privilege boundary to threat-model. | Same need plus a Node-enabled renderer unless `contextIsolation` is used; larger attack surface. |
| **Application lifecycle** | Shell process supervises the existing `bin/apex.js` server; no lifecycle logic in the UI. | Host process owns lifecycle; must reimplement supervision, restart and single-instance behaviour. | Same as Tauri, with more moving parts. |
| **Authentication** | Unchanged: loopback token, cookie, ECP step-up for high-risk scopes. | Tempting to add OS-keychain or biometric auth at the shell layer — a second identity path that would contradict "UI token ≠ owner identity". | Same risk, plus auto-update credentials. |
| **Window management** | Minimal: one window, size/position persistence, always-on-top toggle. | Full native window control (frameless, multi-window, tray) with modest code. | Equivalent but heavier. |
| **Startup / shutdown** | Shell starts server, waits for readiness, loads URL; on quit, stops the server and lets it drain. Crash of either side is observable and reportable. | Startup sequencing must be written in Rust and kept in sync with server changes. | As Tauri, in Node. |
| **Local data access** | None from the shell. Data stays behind the HTTP API; the shell never reads `dataDir`. | Must be deliberately denied; easy to add "convenient" direct file access that bypasses the ECP. | Same, with `fs` available by default in the main process. |
| **Packaging / updates** | Wraps the existing Node requirement; distribution is a script plus Node. No auto-update to secure. | Single signed binary; auto-update must be designed and secured. | Large installer; auto-update is a supply-chain dependency. |
| **Crash recovery** | Server already persists state and recovers on restart (T-30 packages 0–4 evidence). Shell restarts it and reloads the URL. | Shell crash and server crash are separate recovery paths to design and test. | Same. |
| **Resource usage** | One webview + Node process. | Lowest: system webview, small binary. | Highest: full Chromium + Node, ~150–250 MB installed before any APEX data. |
| **Security boundary** | One boundary: HTTP + ECP. No shell privileges to escalate into. | Two boundaries (shell commands, HTTP). | Two boundaries plus a bundled runtime that must be patched (Chromium CVEs) on the owner's schedule. |
| **Verifiability here** | Fully testable today (already tested: real server + shipped client in `tests/ui-live-stream.test.js`). | Requires a Rust toolchain and a GUI environment, neither present. | Requires a Chromium runtime, which cannot be installed in this environment. |

## Decision

**Adopt (A) as the near-term path; keep (B) as the planned destination if a native shell becomes
necessary; reject (C).**

Rationale:

- Every criterion that matters for a personal, single-owner system — one authorization
  boundary, no new privilege surface, unchanged authentication, crash recovery that already
  exists — is best served by **not adding a second runtime**.
- (A) is the only option the build agent can implement and verify under the standing rules
  (zero runtime dependencies, no fabricated verification).
- (B) is the right long-term answer *if* the owner wants a signed single binary, tray
  integration, a frameless HUD or native notifications — but it doubles the boundary count and
  requires a Rust review process that does not exist yet.
- (C) is rejected on footprint, patch cadence and attack surface; nothing in the requirements
  needs a bundled Chromium.

## Consequences

- The desktop experience is a shell, not a rewrite: the UI, tokens and workspaces stay the
  same code that is tested here.
- Voice, global hotkeys, tray and OS notifications remain unimplemented; they are separate
  work with their own ADRs.
- The shell must **not**: read `dataDir`, hold the ECP token in a place the renderer can read,
  expose `file://` to arbitrary paths, or auto-start work. It starts the server, shows the URL,
  and stops the server.
- If the owner later chooses (B), the HTTP API stays the contract and the shell becomes a
  second client — the browser fallback must keep passing the same tests.

## Revisit triggers

1. The owner requires signed distribution or auto-update.
2. A native surface is required that a webview cannot provide (tray, global hotkey, overlay).
3. Multi-device Presence Mesh work begins (T-31+), which changes the trust model.
4. Any of the above must be re-evaluated against the ECP, not around it.

## What this record does not claim

No shell was built or run. Nothing here was verified on Windows or macOS. The recommendation is
an engineering judgement based on the constraints in this repository, and the platform decision
remains the owner's.
