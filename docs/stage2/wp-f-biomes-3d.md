# WP-F: biomes in the 3D view

Read `docs/stage2/README.md` first (rules, tools, baselines, the terrain and
biome interface). Then read `src/view3d/` (especially `terrain-mesh.js` and
`tufts.js`) and the biome section of `src/terrain.js`. For how the 2D view
already colours biomes, see `groundLayer()` and the grass loop in `src/render.js`.

## Goal

The 3D land shows its biomes, so a player can tell at a glance where the
meadows, forests, steppes and snowy peaks are, and the world feels varied but
still sober.

1. **Ground colour per biome.** Each patch blends from its biome's bare-ground
   colour (`terrain.biomes[i].color`) towards green as its grass grows, as the
   2D view does. Soften the class edges (e.g. a small blur of the biome colours
   over land) so they don't follow the grid. This also fixes the current
   problem that grazed ground looks almost black: bare ground must read as
   earth, sand or tundra, not as a hole.
2. **Forests.** Low-poly trees as instanced meshes, placed by a stable hash in
   forest patches: dense in forest, a few scattered at forest edges and in
   wetland. Mostly conifers on cold or high ground, rounder broadleaf trees
   lower down. Trees are scenery: static, built once per world, part of the
   wrapped 3×3 copies. They must read from the map view, where they define the
   forest.
3. **Snow and rock.** Snow biome patches are white with a slight cool tint;
   rock is the existing rock colour. Peaks should look capped.
4. **Grass tufts per biome.** Tuft colour follows the biome: yellowish on
   steppe, brownish on tundra, deep green in meadow and wetland. Fewer tufts
   under forest canopy. Optional: reeds (taller, darker tufts) along wetland
   shores.
5. **With biomes off** (`world.terrain.biomes` is null) or no terrain, the view
   looks exactly as it does today.

## Files you own

`src/view3d/*` only. Do not change the engine (`src/world.js`, `terrain.js`,
`humans.js`, `grass.js`, `config.js`) or `src/main.js`, `src/ui.js`,
`index.html`: another agent (WP-C) is moving the simulation into a Web Worker
in parallel and owns `main.js`. WP-C will hand the renderers a "world mirror"
with the same fields they read today, so keep reading the world the way the
view does now (`world.terrain`, `world.grass.g`, the populations).

## Budget

- Trees: one or two instanced draw calls. Up to ~20k trees, culled to the view.
- No per-frame JavaScript for trees; ground colour refresh stays as cheap as today.
- `make fingerprint` → `all: 9d4e5263c001546d` (default, forest cover on) and
  `all: 3dd61589825d2616` with `--set biomes.cover=false`.

## Verification (put it in your report)

- Fingerprints as above.
- `make shot` screenshots, with 0 console errors, of:
  - the map view (1440×900 and phone 390×844 `--dpr 2 --mobile`) on two seeds;
  - first person and follow in a meadow, a forest, a steppe and near a snowy
    peak (use `sim.world.terrain.biome(x, y)` in `--eval` to find creatures in
    each);
  - a grazed-down patch (bare ground must read as earth, not black).
- JavaScript cost: tree build time per world, and per-frame cost before and after.
