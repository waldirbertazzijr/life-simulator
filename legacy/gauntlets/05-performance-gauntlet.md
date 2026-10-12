Run a gauntlet loop to double this simulation's throughput at 1,000+ entities — headless
step rate and browser frame rate — without changing behavior by a single byte.

THE BAR, judged by a fresh-context critic every round:
1. Correctness first: byte-identical fingerprints on `node headless/run.mjs --frames 6000
   --seed N` for five critic-chosen seeds, before vs after. Fast-but-wrong loses
   automatically — this check runs before any benchmark is even looked at.
2. Speed second: headless/bench.mjs, median of five runs, critic-executed on a quiet
   machine. The builder's own numbers are hypotheses, not evidence.
3. Browser: FPS meter screenshot at 1,000 animals and 5× speed, versus the pre-round
   baseline captured by the critic.

Each round the builder profiles first (headless/prof.mjs), names the top hotspot with
numbers, makes ONE coherent optimization, and hands it to the critic. Fair game: the
SpatialGrid vs Quadtree swap (SPATIAL_INDEX env — but only after
`node headless/validate-index.mjs` passes), batching canvas state changes, gating
expensive decorations (target lines, vision cones, per-animal text) above an animal-count
threshold per docs/HANDOFF.md §7, allocation reduction in the hot loop. Not fair game:
anything that alters simulation results, timestep semantics, or the pause/speed behavior
fixed in HANDOFF §3.3.

Boundaries: no new dependencies, no workers in the browser path without my approval, no
edits to the harness or scoring. Keep a progress file: hotspot → change → fingerprint
evidence → bench delta, including failed attempts. Stop when cumulative headless gain
reaches 2×, or when two consecutive rounds each gain under 5% — then report where the
remaining time goes. Every shell needs: export PATH="/opt/homebrew/bin:$PATH".
