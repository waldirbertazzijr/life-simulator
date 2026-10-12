# Stage 2: the 3D world — plan and rules

The same simulation, seen in 3D with three.js, on a world with mountains and
lakes. The work is split into packages, each built by one agent in its own git
worktree and reviewed before it is merged.

| package | what | depends on |
|---|---|---|
| [WP-A](wp-a-terrain.md) ✅ | terrain in the engine: mountains, lakes, fertility, movement | — |
| [WP-B](wp-b-3d.md) ✅ | the three.js renderer: terrain mesh, creatures, camps, three cameras, picking | the terrain interface below (not WP-A's code) |
| WP-C | simulation in a Web Worker, interpolated drawing | A and B merged |
| [WP-D](wp-d-look.md) | grass tufts where the grass is dense; a blue sky | B |
| WP-E | biomes on the terrain: meadow, steppe, forest, snowy peaks | A |

A and B run in parallel. They meet only through the **terrain interface** below.

---

## Rules for every package

1. **Never run code on the host machine.** No `node`, `npx`, `npm`, `python`
   or `pip` on the host, not even `--version`. Everything runs in containers
   through the Makefile or `docker run` (colima is the Docker runtime). Reading
   and editing files, and `git`, on the host are fine. For a scratch script, pipe
   it in over stdin:
   `docker run --rm -i -v "$PWD":/app:ro -w /app node:22-alpine node --input-type=module < script.mjs`
   (the scratch file itself can live anywhere; only the repo is mounted).
2. **Tools:**
   - `make check ARGS="..."`: multi-seed ecology check (persistence, CV, minima,
     genes, people, tribes, steps/s). See `headless/check.mjs` for options.
   - `make fingerprint ARGS="..."`: hash of the simulation's behaviour. A change
     that claims not to alter the simulation must leave it identical.
     Baselines (since terrain landed): defaults `all: 4d5825d6ba1dfcee`;
     `--set terrain.enabled=false` (the flat world) `all: 7364f6de983a0376`;
     `--set terrain.enabled=false --set human.enabled=false` `all: 4ace304bd98f76c7`.
   - `make shot ARGS="..."`: headless Chromium (software WebGL) in a container.
     It loads the app, runs optional JS (`--eval`), prints a panel readout and
     console errors, and saves PNGs to `.shots/`. Read the PNGs to check
     your work. **Its fps is software-rendered and meaningless as a performance
     number**; measure JavaScript time per frame instead.
   - Do **not** run `make serve` (port 8000 is in use).
3. **Stay in scope.** Each brief lists the files you own. If you must touch
   another file, keep it minimal and say why in your report.
4. **Commits:** on your worktree branch, short one-line messages
   (e.g. `Add terrain heightmap`). No co-author or session trailers. Do not
   push, and do not merge into other branches.
5. **Style:** match the existing code. Plain ES modules, no frameworks, no new
   dependencies (three.js is vendored at `vendor/three/three.module.min.js`).
   Comments explain *why* for a curious hobbyist, like the rest of the code.
   Use the Edit tool for edits. Do not use `perl`/`sed` substitutions with `|`
   as delimiter on text containing `|`: it has silently corrupted files here.
6. **Look:** sober. Muted palette consistent with the 2D view (grass from
   `#1b1d19` to `#3e6840`, herbivores `#ece6d6`, carnivores `#e4664f`, people in
   their tribe colour), flat-shaded low-poly, no clutter.
7. **Report back** (your final message is your report): what you built; files
   changed; evidence (command output excerpts, `.shots/` paths); what you are
   unsure about; anything left undone. Be honest about failures. A clear
   "this doesn't work yet" is worth more than a vague success.

---

## Architecture

- **The engine stays the single source of truth** (`src/world.js` and
  friends): positions are 2D `(x, y)` on a torus (the world wraps at its
  edges). Terrain adds a height field that changes the ecology and gives
  renderers a `z`.
- **Renderers only read the world.** The 2D canvas renderer (`src/render.js`)
  stays as a fallback (`?2d` in the URL). The 3D renderer lives in `src/view3d/`.
- **Coordinates in 3D:** world `x` → three.js `X`, world `y` → three.js `Z`,
  height → `Y`. 1 world unit = 1 three.js unit.
- **The torus in 3D uses a floating origin:** everything is positioned relative
  to the camera using the shortest wrapped difference (see `wrapDelta` in
  `src/render.js`), and the terrain is drawn as up to 3×3 copies around the
  camera. The edge of the world is never visible.

### Terrain interface (the contract between WP-A and WP-B)

```js
world.terrain        // null when params.terrain.enabled is false (flat world)
  .cols, .rows       // grid NODES; node (i, j) sits at world (i * cellW, j * cellH).
                     // The grid wraps: node (cols, j) is node (0, j).
  .cellW, .cellH     // node spacing in world units
  .height            // Float32Array(cols * rows), index i + j * cols, world units (≥ 0)
  .seaLevel          // nodes/points below this height are water
  .heightAt(x, y)    // bilinear height at any world position (wraps)
  .isWater(x, y)     // heightAt(x, y) < seaLevel
  .blocked(x, y)     // true where land creatures and people cannot go (water, cliffs)
```

The grass field (`world.grass`, cell size 10) is finer than the terrain grid.
Renderers colour the ground from it (water and rock come from the terrain).
