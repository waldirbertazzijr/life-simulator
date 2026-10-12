Run a gauntlet loop to take this ecosystem sim from colored shapes on a canvas to a
living world worth watching — the kind of thing you leave running in a tab like an
aquarium. The reference bar: The Bibites and Equilinox, real ecosystem games with real
art direction. You decide what to improve — creature rendering, motion feel, vegetation,
lighting, the day/night palette, ambient detail, UI polish — and split it into the
smallest pieces a critic can judge separately.

THE JUDGMENT, every round:
1. The critic (fresh context) gathers reference screenshots of The Bibites and Equilinox.
2. It takes our screenshots with headless Chromium (exact command in docs/HANDOFF.md §5)
   at three window sizes and at day, dusk, and night.
3. Labels stripped, it runs a blind A/B: which frame looks like a living world made with
   intent? While ours loses, the critic names the SINGLE biggest visual gap — "the trees
   read as flat circles," "night is a gray overlay, not darkness" — and only that gap
   goes back to the builder. One gap per round.

THE HARD GATE, every round, before any A/B counts: rendering must never leak into
simulation. A second critic runs `node headless/run.mjs --frames 6000 --seed N` on three
seeds it chose before the round started — fingerprints must be byte-identical to its
baseline. Any drift = the round fails regardless of how good it looks. Also required:
zero console errors, and FPS at 1,000 animals no worse than the pre-round baseline
(screenshot the on-screen FPS meter as the receipt).

Boundaries: touch only Renderer.js, DayNightCycle drawing, UI.js, index.html/CSS, and
drawing code (if drawing still lives inside Animal.js, you may move it out — under the
same fingerprint gate). No frameworks; plain canvas. Procedural art preferred over image
assets; any asset added must be generated, not downloaded from a licensed source. No
network calls at runtime.

Keep a live progress page with before/after screenshots per round — this loop is the fun
one to watch. Loop until the blind A/B is a coin flip or better against the references,
or until two consecutive rounds produce gaps too small to matter. Every shell needs:
export PATH="/opt/homebrew/bin:$PATH".
