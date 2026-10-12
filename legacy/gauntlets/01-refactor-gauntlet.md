Run a gauntlet loop to split Animal.js — a ~1,270-line monolith mixing simulation logic
(energy, behavior, genetics, procreation) with canvas drawing — into focused ES modules,
with simulation fully separated from rendering. You choose the module layout; propose it
first on the progress page, then move code in small coherent steps.

The bar is binary and non-negotiable. This sim is deterministic under a seeded RNG, so:

1. Before anything changes, a fresh-context critic picks FIVE seeds the builder never
   sees, runs `node headless/run.mjs --frames 6000 --seed N` for each, and records the
   final counts as the baseline fingerprint. (Note: current known-goods for seeds 1–3 are
   661/25/58, 662/134/51, 661/128/54 — but capture your own baseline; it is
   config-dependent.)
2. After every builder step, the critic re-runs the same five seeds. If any digit
   differs, the round FAILS, with the diff as evidence. No explanations accepted — a
   refactor that changes a fingerprint changed behavior, period.
3. Each round must also pass: `node headless/validate-index.mjs`, and a headless Chromium
   screenshot (exact command in docs/HANDOFF.md §5) proving the browser app still runs
   with populations alive and zero console errors.

Boundaries: zero behavior change; no edits to config.js, the harness, or scoring; no new
dependencies; Engine.step() remains the only step path for both browser and headless.
Read docs/HANDOFF.md §4 and §6 first — the shared-neighbor invalidation guard
(`nearby = null` when a baby follows its parent) and the config-singleton rules are the
traps most likely to bite you.

Keep a compact progress file: module map, steps done, fingerprint evidence per round,
anything that failed and why. Loop until the split is complete and every check is green.
Stop and report if the same fingerprint mismatch survives three different fix attempts.
Every shell needs: export PATH="/opt/homebrew/bin:$PATH".
