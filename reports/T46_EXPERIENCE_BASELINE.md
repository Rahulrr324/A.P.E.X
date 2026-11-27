# T-46 STEP 0 — Baseline and gates (2026-11-19)

Baseline is measured **in CI**, in a real Chromium build, on the shipped page at the shipped
commit. The development sandbox has no browser binary and no way to download one, so no number in
the *Measured* column below was produced here. What this file records is: the gates as code, the
harness that produces the numbers, and the honest statement of what has and has not run.

- Branch: `arena/c4691a2f-a-p-e-x`, from `5a1fd56` (T-45 close-out). `main` stays `fb09e73`.
- Spec: `apex_app/tests/e2e/t46-experience.spec.mjs`
  (the brief names `t46-experience.spec.js`; every suite in this tree is `.spec.mjs`, so the file
  follows the tree's convention — a deviation from the brief's filename, not from its intent).
- Wiring: `apex_app/playwright.config.mjs` `testMatch` (the brief calls it `playwright.config.js`),
  `apex_app/tests/real-browser-harness.test.js` (the brief calls it `t31-browser-suite-wiring.test.js`),
  `.github/workflows/apex-app-tests.yml` (the brief calls it `ci.yml`).
- Fixture: `apex_app/tests/e2e/t46-fixtures.mjs`.
- Summary written by the run: `apex_app/reports/t46-experience.json`.
- Screenshots: `apex_app/artifacts/t46/` (uploaded as a workflow artifact).

## The gates, as code

`T46_GATES` in `tests/e2e/t46-fixtures.mjs` is the single definition; the spec, the baseline report
and the CI annotation all quote it.

| Gate | Value | Measured on |
| --- | --- | --- |
| Header height, desktop | ≤ 64 px, one row | 1600×900, 1280×720 |
| Core centre horizontally | within 5 % of viewport centre | 1600×900, 1280×720 |
| Core is the largest element | widest painted element in the deck | 1600×900, 1280×720 |
| Document scroll height | ≤ `innerHeight` | 1600×900, 1280×720 |
| Deck height | ≤ 100 vh | 1600×900, 1280×720 |
| Command bar | visible without scrolling, docked bottom | 1600×900, 1280×720 |
| Panels scroll internally | every panel's overflow is inside the panel | both desktop viewports |
| Mobile | Core top, cards stacked, bottom bar, no horizontal scroll | 390×844 |
| Contrast | ≥ 4.5 : 1 | every viewport |
| Boot sequence | ≤ 4000 ms, ≤ 3 Hz flash, real sources, skippable | 1280×720 |
| Mode pairs | differ in ≥ 3 of 5 properties, and ≥ 2 % of pixels | 1280×720 |
| Overlay tags | 0 with no records, N with N records, every id resolves | 1280×720 |
| Workshop | accept/reject, select, pan/zoom, path escape refused | 1280×720 |

## Measured

The run that measures these has **not** happened at the time this file was written. The table is
filled by `t46-experience.spec.mjs` on the hosted runner, and the CI annotation
`t46-experience-pass` prints the same numbers. Until that annotation exists, no row below may be
quoted as a measurement.

| Measurement | 1600×900 | 1280×720 | 390×844 |
| --- | --- | --- | --- |
| Header height (px) | — | — | — |
| Core centre (x, y) | — | — | — |
| Core is largest | — | — | — |
| `documentElement.scrollHeight` | — | — | — |
| `innerHeight` | — | — | — |
| Deck height (px) | — | — | — |
| Command bar visible without scrolling | — | — | — |
| `scrollWidth === clientWidth` | — | — | — |
| Contrast, worst sample | — | — | — |

## The defects this milestone is answering

Read from the shipped CSS at `5a1fd56`, not guessed. Each is a cause of a review finding, and each
has a gate above that fails until it is fixed.

1. **The header is a grid, not a row.** `.topbar{display:grid;grid-template-columns:auto 1fr auto}` with
   `padding:.85rem 1.25rem`. The middle column holds `.topbar-meta` — nine badges that `flex-wrap` —
   and the third holds `.topbar-actions` — eleven controls that also wrap. At 1600 px the middle column
   carries a nine-badge run and the action column an eleven-control run, so the header is several rows
   tall. There is no height gate on it at all today; nothing in the tree has ever measured it.
2. **The Core is not centred and is not large.** `.deck{grid-template-columns:minmax(18rem,1fr) minmax(22rem,1.35fr) minmax(18rem,1fr)}`
   and `.core{width:min(260px,70vw)}`. The Core sits in the middle column of a three-column grid at a
   fixed 260 px, so it is neither the widest thing on the deck nor necessarily at the viewport's centre.
3. **The document scrolls.** `.deck` carries `padding: 1rem 1.25rem 6rem` and stacks panels in three
   columns whose natural heights sum well past 900 px, and the command bar sits *after* the deck in
   document order — so the bar an owner types into is at the bottom of a ~2 000 px document rather
   than docked. Reaching it means scrolling past every panel.
4. **The phone layout is the desktop layout, narrower.** The only answer to a 390 px viewport today is
   `@media (max-width: 720px)` adjustments; the deck keeps its three-column intent, the rails keep
   their order, and the command bar is still wherever the document puts it.

## Honesty statement

- No screenshot in this milestone has been looked at by the agent. The sandbox cannot launch a
  Chromium build (`playwright install` and every download host are unreachable; no system browser
  exists), so every pixel-level claim in the T-46 report comes from the CI run's measurements and
  artifact list, and the report says which ones were viewed by eye — none.
- Nothing has been run on the owner's Windows machine.
