# WP-D: grass you can see, and a blue sky

Read `docs/stage2/README.md` first (rules, tools, architecture). The 3D view is
in `src/view3d/`; read `scene.js`, `terrain-mesh.js` and `creatures.js` before
changing anything.

## Goal

Make the 3D world feel alive and bright, while staying sober:

1. **Grass tufts where the grass is dense.** Today the ground is a colour. Add
   low-poly grass tufts (a few thin triangles each) standing on the ground.
   - **Density follows the grass field** (`world.grass.g`, 0..1 per 10-unit
     patch): lush patches are thick with tufts, grazed patches go bare. As
     herds graze, you should *see* the grass disappear, and see it come back.
   - **Placement is stable:** each patch's tufts come from a hash of its index,
     so they don't jump around between updates. Only their count and height
     change with the grass.
   - **Near the camera only:** a radius that suits each view (dense around you
     in first person and follow; sparse or none from the high map view).
     Refresh when the camera moves or every few frames, not every frame.
   - **Looks:** colour from the existing grass palette (darker at the root,
     lighter at the tip), a slight random lean and a gentle wind sway done in
     the vertex shader (e.g. `onBeforeCompile`), not in JavaScript.
   - **No tufts** on water, rock or steep ground when `world.terrain` exists
     (use its `heightAt` / `isWater`; terrain is arriving from another
     package). Flat ground: tufts everywhere grass is.
2. **A blue sky.** A daytime sky: a soft gradient from a pale, slightly hazy
   horizon to a muted blue overhead. Match the fog colour to the horizon so
   distance fades into it. Re-check the lighting so the scene is bright but
   not garish. Desaturated is fine; gloomy is not.

## Files you own

`src/view3d/*` (a new `grass.js` or similar; `scene.js` for the sky and
lights). Nothing else, unless you must (say why in your report). Don't
change the simulation: `make fingerprint` must print `all: 7364f6de983a0376`.

## Budget

- JavaScript cost of the tufts: refresh ≤ ~2 ms when it happens, and near-zero
  on frames without a refresh. Report the numbers (`performance.now()`).
- Instance count ≤ ~40k. One draw call for all tufts if possible.
- Check the high map view doesn't drown in tufts or slow down.

## Verification (put it in your report)

- `make fingerprint` → `all: 7364f6de983a0376`.
- `make shot` with 0 console errors:
  - first person and follow on a grazer in a lush area, and on a grazer in a
    grazed-down area (the difference should be visible);
  - the map view at 1440×900 and 390×844 (`--dpr 2 --mobile`);
  - a before/after pair of the sky.
- The measured JavaScript cost.
