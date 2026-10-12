Run a gauntlet loop to make this ecosystem honestly, robustly persistent. Read
docs/HANDOFF.md fully first — especially §3 (the model was reward-hacked once already)
and §7 (pending actions). config.js currently holds a STALE config tuned against a buggy
model; do not trust it.

OBJECTIVE: a config where trees, herbivores, and carnivores all persist for 60,000 frames
— not by luck, and not by fraud. Start from headless/best-config.json if the finished
search produced one (apply its overrides into config.js per HANDOFF §7.1); otherwise run
`node headless/search.mjs` yourself to produce a candidate.

THE CRITIC (fresh context, every round): takes the candidate config and judges it on TEN
seeds of its own choosing that the builder has never seen, at 60,000 frames, using
scoreRun from headless/harness.mjs. Pass requires ALL of:
- every seed survives the full horizon with all three species present;
- back-half populations healthy (scoreRun's minimum-population and trend terms — no
  slow collapse, no predator pinned near its floor);
- the evolved-genetics printout from run.mjs looks DIVERSE on every seed: no single
  mutation swept the population, no gene pinned at an extreme. A sweep = automatic fail
  and a suspected model exploit — the builder must find the mechanism, fix the MODEL,
  and re-search. Never tune around an exploit (HANDOFF §6: fix model → verify →
  re-search, in that order);
- a shock test: re-run two seeds with a mid-run cull of half the herbivores (do it via
  a harness option the CRITIC controls). The web must recover, not unravel.
- the real browser check: headless Chromium screenshot (HANDOFF §5) at a non-1920
  window; populations holding, "100% of tuned" displayed, zero console errors.

If a round fails, the critic names the single biggest gap (which seed, which species,
what pattern — oscillation amplitude? predator overshoot? enrichment paradox?) and only
that goes back to the builder. HANDOFF §8 lists the theory-backed levers, including the
Holling Type III refuge option — allowed, but it is a model change and triggers a
re-search.

Also settle §3.6 while you are here: instrument the sleep branch with a counter and
measure whether it EVER fires. Then either fix the thresholds so it works or remove the
feature. Either way is a model change: re-verify before final scoring.

FINISH by filling docs/ECOSYSTEM_BALANCE.md §7 "Results" with the honest numbers:
before/after trajectories, final knob values, and what each change did — written for a
curious hobbyist who enjoys the why, not a formal paper.

Boundaries: builders never touch scoreRun, harness.mjs, or the critic's seed list. Keep a
progress file with every config tried, its held-out score, and failed approaches. Stop
when the critic passes a candidate twice in a row with different seed sets, or report the
best surviving candidate with evidence if 60k-frame persistence proves unreachable. Every
shell needs: export PATH="/opt/homebrew/bin:$PATH".
