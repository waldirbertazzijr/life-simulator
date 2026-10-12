# WP-E: biomes

Read `docs/stage2/README.md` (rules, tools, baselines), `docs/THEORY.md`
(especially §3 on supply-driven grass and §12 on terrain), and
`src/terrain.js`. The terrain author left notes on where biomes plug in:

- `fractal(...)` is the exported noise helper;
- `makeHeights()` builds the heightmap;
- `fertility(x, y)` is the one place fertility is decided, looked up per grass
  patch by `fertilityGrid()`;
- the queue loop in `pathField()` can measure "distance to water" if seeded
  from every water cell;
- the regrowth compensation (`terrain.compensate`) automatically keeps total
  food constant, whatever fertility the biomes produce.

## Goal

The land gets **biomes**: regions that differ in climate, and therefore in how
much grass they grow and how they look. Biomes should come from two fields
rather than being painted at random:

- **moisture**: high near water, falling with distance, plus broad noise;
- **temperature**: falling with altitude (a lapse rate), plus broad noise.

| biome | where | grass |
|---|---|---|
| wetland / marsh | wet lowland next to water | lush |
| meadow | temperate and moist | full |
| forest | moist mid-slopes | moderate |
| steppe | dry | sparse |
| tundra / alpine | cold, high | thin |
| snow / bare rock | the highest peaks | none |

The table is a starting point: tune the names and classes until the map reads well.

**Forest as cover (optional, a model change).** Animals in a forest are harder
to see: a predator's sense range against prey standing in forest is reduced.
That's a habitat refuge, which ecology predicts is stabilising. Implement it
behind a config switch, measure it on and off, and report what it does.

## Files you own

`src/terrain.js` (the biome fields, `biome(x, y)`, the fertility rules),
`src/grass.js`, `src/world.js` and `src/humans.js` (only if cover or camp
siting needs them), `src/config.js` (a `biomes` section), `src/render.js` (the
2D view shows biomes), `headless/check.mjs` (optional biome shares),
`docs/THEORY.md` (a short subsection in §12, in the existing voice).

Do **not** touch `src/view3d/`, `src/main.js`, `src/ui.js` or `index.html`.
Another agent is editing the 3D view, and 3D biome visuals are a later package.

## Interface for renderers (add to `world.terrain`, and document it)

```js
world.terrain.biome(x, y)   // biome index at a world position
world.terrain.biomes        // [{ name, color: [r, g, b], fertility }, ...] in index order
world.terrain.biomeGrid     // Uint8Array, one biome index per grass patch (same layout as world.grass.g)
```

`color` is the biome's *bare-ground* colour (what shows when the grass is grazed
down). Keep the palette muted and in the same family as the existing greens,
rock grey and water blue.

## Verification (put the numbers in your report)

- `make fingerprint ARGS="--set terrain.enabled=false"` → `all: 7364f6de983a0376`
  (the flat world is untouched).
- With biomes on: `make check ARGS="--seeds 1-20 --steps 150000"` → all 20
  ecosystems persist and people survive in ≥ 18/20. Report the minimum
  herbivores, carnivores and people, and compare with the terrain-only baseline
  (herbivores ≥ ~580, carnivores ≥ ~37, people ≥ ~20).
- `--aspect 0.46` and `--aspect 2.4`, 8 seeds × 100k: all persist.
- If you build forest cover: the same check with it on and off, and what changed.
- steps/s: no worse than ~10% below terrain-only.
- 2D screenshots (`make shot ARGS="--query '?seed=7&2d'"`, plus a couple of
  seeds) showing readable biomes, and the share of each biome per seed.
