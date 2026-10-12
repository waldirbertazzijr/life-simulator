# WP-C: the simulation in a Web Worker

Read `docs/stage2/README.md` first (rules, tools, baselines). Then read
`src/main.js` (the frame loop, speed and pause, following, `window.sim`),
`src/ui.js` (what the panel reads from the world) and skim how `src/view3d/`
and `src/render.js` read the world.

## Goal

Run the simulation in a **Web Worker** so drawing never competes with stepping.
That keeps 64× smooth and frees the main thread for the 3D view. Also make
motion **smooth at any speed** by drawing positions interpolated between the
two most recent simulation states.

## Design (follow it, or explain why not)

1. **The worker owns the real `World`.** It steps at `60 × speed` steps per
   second with the same fixed-timestep logic `main.js` uses today, and
   handles pause, speed, reset(seed), follow(id) (for `world.watch` and
   `world.fate`), and the descendant lookup.
2. **The main thread keeps a "world mirror"** with the *same shape* the
   renderers and the panel read today: `herbivores`, `carnivores` and `humans`
   with `n`, `x`, `y`, `heading`, `energy`, `age`, `lifespan`, genes, `state`,
   `focus`, `tribe` and so on; `grass.g`; `tribes`, `tribeById`, `fallen`;
   `time`, `seed`, `fate`, `watch`; `width`, `height`, `p`; plus the methods
   they call (`find`, `meanGenes`, `descendant`, `kindOf`, ...). The renderers
   (`src/view3d/`, `src/render.js`) should need **no changes**, or only tiny ones.
   - **Static data:** the terrain, biomes and grid sizes are a pure function of
     the seed and params. The main thread can build its own `World` for the same
     seed and never step it, then overwrite the dynamic arrays from snapshots.
     Check that this really gives identical static data.
   - **Snapshots:** typed arrays posted at display rate (not every step), with
     transferable buffers, carrying only the columns that are drawn or shown.
3. **Interpolation.** Keep the previous and current snapshot and draw
   positions and headings blended by elapsed time. Handle the world's wrap
   (blend across an edge, never streak across the map), and newborns and the
   dead (no ghosts or pops). Interpolation is display-only.
4. **Fallback:** `?noworker` (or no Worker support) runs the simulation on the
   main thread as today. Both paths must behave the same, so a given seed
   produces the same world.
5. **Keep everything working:** panel numbers and sparklines, the follow card
   and fates, descendants, the tribes list, picking, speeds, pause, `R`,
   `?seed=`, `?2d`, the console handle `window.sim` (document what changed).

## Files you own

`src/main.js`, new files (e.g. `src/sim-worker.js`, `src/mirror.js`),
`src/ui.js` (only if needed), small read-only adaptations in `src/view3d/` or
`src/render.js` if unavoidable (say why). **Do not change the engine**
(`src/world.js`, `terrain.js`, `humans.js`, `grass.js`, `population.js`,
`spatial.js`, `config.js`): `make fingerprint` must stay at the default
baseline. Another agent (WP-F) is changing `src/view3d/` in parallel for
biomes, so keep your edits there minimal.

## Verification (put it in your report)

- `make fingerprint` unchanged.
- **Same world both ways:** the same seed run N steps in the worker and with
  `?noworker` gives identical populations (compare `sim.world` counts or a
  hash after a fixed number of steps; the worker can expose a test hook).
- **Main-thread JavaScript time per frame** at 1× and 64×, before and after
  (`performance.now()`). The point is that 64× no longer eats the frame.
- `make shot` screenshots, with 0 console errors, in map, follow and first
  person, plus `?2d` and `?noworker`.
- Interpolation: describe how you checked there's no jitter, streaking at the
  wrap, or popping.
