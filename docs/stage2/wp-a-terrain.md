# WP-A: terrain in the engine

Read `docs/stage2/README.md` first (rules, tools, terrain interface), then
`docs/THEORY.md` for why the ecology is stable. The stability is hard-won, so
treat any change to it as a scientific change that needs evidence.

## Goal

Give the world mountains, lakes and fertile valleys that **change the ecology**:
water and cliffs block movement, high ground grows less grass, and the land
shapes where herds, predators and tribes live. Ecology theory says spatial
heterogeneity and refuges usually *help* persistence (Huffaker's mites). Find
out what it does here, and keep the world stable.

## Files you own

`src/terrain.js` (new), `src/world.js`, `src/humans.js`, `src/grass.js`,
`src/config.js` (a new `terrain` section, plus any retune), `src/render.js`
(only so the 2D view shows the terrain), `headless/check.mjs` (optional terrain
stats), `docs/THEORY.md` (one short section, in the existing voice).

Do not touch `src/main.js`, `src/ui.js`, `index.html` or `src/view3d/` (WP-B owns those).

## Requirements

1. **Heightmap.** Seeded from the world's rng, generated at construction. It
   must be **seamless on the torus**: periodic value noise (lattice wrapped
   modulo the period) or similar, with a few octaves. Expose exactly the
   interface in the README, documented in the header of `src/terrain.js`.
   Suggested scale for a 1600 × 1000 world: node spacing ~20, mountains up to
   ~120 units, ~10–15% of the area under water, a few ranges and lakes rather
   than noise everywhere. Make the knobs config values.
2. **Grass.** Patches on water hold no grass and never regrow. Regrowth is
   scaled by a fertility that falls with altitude (bare peaks, lush lowlands).
   Keep it supply-driven (`g += r·f·(1 − g)` or similar).
3. **Movement.** Herbivores, carnivores and people never end a step inside a
   `blocked` position. When a move would, they turn and try other headings
   (e.g. ±45°, ±90°, then back) rather than freeze. Fleeing and chasing must
   still work sensibly near shores and cliffs. Keep it cheap: this is the hot
   loop, and steps/s must not drop by more than ~15%.
4. **Spawning.** Initial animals, newborns, tribe camps and tribe splits only
   land on non-blocked ground. Camps prefer flat, fertile land near (not in)
   water.
5. **Off switch.** `params.terrain.enabled = false` gives `world.terrain = null`
   and the engine must behave **exactly** as today:
   `make fingerprint ARGS="--set terrain.enabled=false"` must print
   `all: 7364f6de983a0376`.
6. **2D view.** In `src/render.js`, show water (a muted dark blue) and gentle
   hill shading under the grass so the terrain can be checked with
   `make shot ARGS="--query '?seed=7&2d'"`. (`?2d` will select the 2D renderer
   once WP-B lands; until then the 2D renderer is the only one.)

## Verification (put the numbers in your report)

- Fingerprint with terrain off, as above.
- `make check ARGS="--seeds 1-20 --steps 150000"` with terrain on (the default):
  all 20 ecosystems persist, and people survive in at least 18/20. Report the
  minimum herbivores, carnivores and people.
- `--aspect 0.46` and `--aspect 2.4`, 8 seeds × 100k: all persist.
- steps/s before and after.
- If stability suffers, **find the mechanism** before tuning (less usable area?
  herds trapped? tribes on islands?) and say what you changed and why. Prefer
  compensating lost area (e.g. grass regrowth) over new rules.
- Screenshots of the 2D view showing terrain.
