# WP-B: the three.js 3D view

Read `docs/stage2/README.md` first (rules, tools, architecture, terrain
interface). Then read `src/render.js`, `src/main.js` and `src/ui.js`, because
the 3D view replaces the 2D canvas while keeping everything else working.

## Goal

The world in 3D, sober and readable, with three cameras:

- **map**: a god view over the land;
- **follow**: a third-person camera behind the followed creature;
- **first person**: an eye-level view from the creature's own head, looking where it goes.

## Files you own

`src/view3d/*` (new: suggested `scene.js`, `terrain-mesh.js`, `creatures.js`,
`camps.js`, `camera.js`), `src/main.js`, `index.html`, `src/ui.js` (only if
needed), `src/flag.js` (new: move `drawFlag` out of `render.js` so 2D, 3D and
the panel share it; leave a re-export or update imports), `README.md`
(controls section).

Do not change the simulation (`src/world.js`, `humans.js`, `population.js`,
`spatial.js`, `grass.js`, `config.js`). WP-A is changing some of them in
parallel. `make fingerprint` must still print `all: 7364f6de983a0376`.

## Requirements

1. **three.js** via an import map in `index.html`:
   `"three": "./vendor/three/three.module.min.js"` (r170, already in the repo).
   No addons; write the camera controls yourself.
2. **Renderer selection.** 3D by default; `?2d` uses the existing 2D renderer.
   Both expose the same small interface to `main.js`. Today that is
   `attach / resize / updateCamera / draw / mode`, plus picking. Replace the
   click-picking in `main.js` with a `pick(world, px, py) → id | 0` method on
   each renderer: the 3D one projects creatures to the screen and takes the
   nearest within ~16 px.
3. **Terrain.** If `world.terrain` exists (see the interface), build the ground
   from its heights, plus a water surface at `seaLevel`. Otherwise use a flat
   ground. Colour the ground from the grass field: a `DataTexture` updated every
   few frames works well, because the grass grid is finer than the height grid.
   Add muted rock on steep or high ground. Draw up to 3×3 copies around the
   camera (floating origin) so the torus edge never shows. Test both flat and
   with a terrain: a temporary stub of the interface in your own code is fine,
   but don't commit engine changes.
4. **Creatures** as `InstancedMesh`es (one per species; people coloured per
   tribe with instance colours). Build low-poly, flat-shaded shapes in code:
   - a herbivore as a small rounded grazer body;
   - a carnivore as a sleek wedge with a clear front;
   - a person upright and taller, with children smaller.

   Each is oriented by its heading and sits on the terrain. Sizes should be
   consistent with the 2D world (herbivore radius ~2.3, carnivore ~7 long, a
   person ~5 tall). In the map view, creatures may be scaled up with distance
   so they stay visible.
5. **Camps:** pole + flag (a `CanvasTexture` painted with `drawFlag`), and a
   small dark ground disc. Flags should read from the map view.
6. **Cameras.** The panel's map / follow / first person buttons and the `V` key
   switch between them; transitions are smoothed.
   - map: start framing the whole world at an angle. Mouse drag pans, wheel
     zooms, right-drag (or ctrl-drag) rotates and tilts. One-finger pan and
     pinch-zoom on touch.
   - follow: behind and above the creature.
   - first person: at head height, ~70° FOV, looking along the heading,
     smoothed so it doesn't jitter.

   With nobody followed, the map camera is free.
7. **The followed creature:** a subtle ring on the ground, a faint sense-radius
   circle in follow and first-person views, and a thin line to what it is
   reacting to (focus), coloured like the 2D view.
8. **Light and atmosphere:** hemisphere + directional light, soft distance fog
   matching a muted sky. Sober. (Day/night is a nice-to-have, visual only:
   do it last, if at all.)
9. **Performance:** few draw calls (terrain tiles + 3 instanced meshes + camps).
   JavaScript time spent in your per-frame update must stay under ~4 ms with
   ~1,200 creatures. Measure it with `performance.now()` and report it. Expose
   it, e.g. `sim.frameMs`. Pause still renders; resize works; devicePixelRatio
   is capped at 2.
10. **Everything else keeps working:** panel, follow card, tribes list, speeds,
    pause, new world (`R`), descendants, `?seed=`, phones.

## Verification (put it in your report)

- `make fingerprint` → `all: 7364f6de983a0376`.
- `make shot` screenshots, with 0 console errors, of:
  - the map view at 1440×900 and 390×844 (`--dpr 2 --mobile`);
  - follow and first person on a herbivore, a carnivore and a person (use
    `--eval "sim.follow(...)"` and click `[data-view=first]`);
  - `?2d` still working.
- The JavaScript frame time.
- Which parts were tested with a stub terrain and which with a flat world.
