# HANDOFF — Ecosystem balance & optimization work

*Written for another engineer/model to continue. Pairs with `docs/ECOSYSTEM_BALANCE.md` (the theory, written for the human owner). This file is the technical state-of-the-world.*

---

## 0. TL;DR — where things stand right now

- **Goal:** make the 3-tier ecosystem (trees → herbivores → carnivores) *persist* instead of collapsing, by (a) fixing structural/model bugs and (b) tuning the numbers with a headless parameter search.
- **Model is now "honest"** (a reward-hacking exploit was removed — see §3.4). The genetics/energy model, performance, and browser game-loop are all fixed.
- **A parameter search is RUNNING** on the corrected model (background `node` process). Live dashboard: **http://localhost:8099**. It writes the winner to `headless/best-config.json` when done.
- **`config.js` currently holds an INVALID config** — it was tuned against the *buggy* model, so on the corrected model it collapses (carnivores over-hunt herbivores). **Do not trust it.** Replace it with the search winner (see §7, "Next actions").
- Background processes you'll find running: the **search** (`headless/search.mjs`), the **dashboard** (`headless/dashboard.mjs`, port 8099), and a **static file server** for the browser app (`python3 -m http.server 8000`, open http://localhost:8000).

---

## 1. The app (architecture)

A browser ES-module ecosystem sim on an HTML5 canvas. Entities: **trees** (static producers), **herbivores** (eat trees), **carnivores** (eat herbivores + weaker carnivores). Each entity has **genetics** (⚡speed 📏size 💪maxEnergy 👁️vision 😠aggression 🧠intelligence), can gain rare **mutations**, ages through **life stages**, and lives under a **day/night cycle**. A **quadtree** does spatial queries.

**File map:**

| File | Role |
|---|---|
| `main.js` | entry — `new Simulation().start()` |
| `Simulation.js` | the **game loop** (`animate()`), canvas sizing, wires up UI/stats |
| `Engine.js` | **`step(dayNightCycle, createProcreationAnimation)`** — one pure simulation tick (no rendering). **NEW file, the linchpin.** |
| `Renderer.js` | **`renderScene(ctx, dayNightCycle)`** — paints current state only (no stepping) |
| `Animal.js` | `Animal` class + subclasses (Tree/Herbivore/Carnivore), `AnimalFactory`, `populate`, shared `animals` array, energy/behaviour logic |
| `Quadtree.js` | `Quadtree`, `Rectangle`, `Circle` spatial index |
| `config.js` | **all tunable knobs** (the search only touches a subset) |
| `DayNightCycle.js` | time-of-day, activity multipliers, overlay colour (pure except `draw()`) |
| `StatsDashboard.js` / `EvolutionTracker.js` | on-screen population + genetics panels (browser-only, DOM) |
| `UI.js` | tooltip + toolbar (mouse handling) |
| `utils.js` | `randomInt`, `randomHexColor`, `getRandomName` |
| `index.html` | markup + inline CSS; loads `stats.js` (FPS meter) + `main.js` |

**The key architectural decision:** `Engine.step()` is the single source of truth for advancing the world, imported by **both** the browser (`Renderer`/`Simulation`) **and** the headless harness. That's why a config tuned headlessly transfers 1:1 to the on-screen sim. **Never fork the step logic.**

`Renderer.js` and `Simulation.js` were refactored so that **stepping and rendering are decoupled** (see §3.3). `Simulation.animate()` steps N times (driven by real elapsed time) then paints once.

---

## 2. The headless harness (`headless/`) — how the tuning works

Runs the **real** `Engine.step()` in Node with no canvas/DOM. Node is installed but **not on the default PATH** — prefix commands with `export PATH="/opt/homebrew/bin:$PATH"`.

| File | Role |
|---|---|
| `rng.mjs` | `mulberry32(seed)` + `seedRandom(seed)` — overrides global `Math.random` so a run is **deterministic**. The whole sim uses `Math.random()`, so seeding it makes runs reproducible with zero changes to sim code. |
| `harness.mjs` | `runOnce(overrides, opts)` (reset config from a captured `BASE_CONFIG`, seed RNG, populate, loop `step()`, early-stop on first extinction), `scoreRun(r)` (the fitness function), `evaluate(overrides, {seeds})` (avg score across seeds). |
| `run.mjs` | single-run CLI (see commands below). Prints survival, final counts, back-half stats, sparklines, **and evolved genetics + mutation counts**. |
| `search.mjs` | parallel search: **Phase 1** random exploration → **Phase 2** Gaussian refinement of the elites → **final validation** (more seeds, longer horizon). Writes `best-config.json` and live `progress.json`. Worker pool = `min(workers, cpus)`. |
| `searchWorker.mjs` | worker thread: runs `evaluate`, returns compact result (+ downsampled trajectory for the dashboard). |
| `dashboard.mjs` | tiny HTTP server (port 8099) serving a self-contained page that polls `progress.json`: progress bar, convergence chart, best-ecosystem trajectory, tuned-knob table. |

**Commands (run from repo root, with the PATH export):**
```bash
node headless/run.mjs                          # current config.js, seed 1, 20k frames
node headless/run.mjs --frames 40000 --seed 4  # longer, different seed
node headless/run.mjs --world 1440x840         # test a specific window size (density)
node headless/run.mjs --baseline               # reproduce the ORIGINAL bug (non-renewable trees)
node headless/run.mjs '{"carnivores":{"energyGain":-0.06}}'  # ad-hoc overrides (bare JSON arg)
node headless/search.mjs --n1 700 --rounds 6 --frames 18000 --finalFrames 60000 --workers 11
node headless/dashboard.mjs                     # then open http://localhost:8099
```

**The scoring function** (`scoreRun` in `harness.mjs`) — deliberately shaped by hard-won lessons (§3.5):
- Collapsed run → `10 * (collapseFrame / frames)` (a smooth "how long did the whole web last" gradient).
- Survived the full horizon → base 20, plus per herbivore & carnivore over the back half: `8 * min(minPop/floor, 1)` (**healthy minimum** — resilience), `4 * (1 - CV)` (**low variability**), `4 * trend` (**not declining** — catches slow collapse). Floors: carnivore 15, herbivore 40.
- `evaluate` averages the score over seeds `[1,2,3]` so we reward configs that are *robustly* stable, not lucky once.

---

## 3. Findings (root causes, in the order discovered)

### 3.1 STRUCTURAL — trees couldn't regenerate (the big one)
`config.trees.procreatingChance` was **`0`**, but trees die of old age (`maxAge`). So the forest was a **non-renewable resource** — it could only drain. Once trees ran out, herbivores starved, then carnivores. **Collapse was guaranteed regardless of every other knob.** In ecology terms: no primary production, no `+r·x` growth term at the base of the food web. *No amount of tuning can fix a food web whose base can't regrow.* → Fixed: trees reproduce, with a **carrying capacity** cap `K` (logistic growth). Reproduce this bug with `node headless/run.mjs --baseline`.

### 3.2 WORLD SIZE / DENSITY — why the browser didn't match headless
The headless search tunes at a fixed **1920×1080** world. The browser originally used the *window* size. Populations are really **densities**, and density depends on area — a smaller window packs the same animals denser → more predation, less spatial refuge → collapse. Scaling populations by area alone wasn't enough because **vision/speed/search radii are absolute pixels** (a smaller world = predators effectively see farther and mix faster — Huffaker's spatial-refuge result). → Fixed by simulating in a world with the **tuned AREA shaped to the window's aspect ratio**, then CSS-scaling the canvas to fill the screen (§4, `Simulation.fixCanvasSize`). Verified across aspect ratios headlessly with `--world WxH`.

### 3.3 BROWSER GAME-LOOP BUGS (user-reported, confirmed)
Old `animate()` ran the *step + full render* `Math.floor(simulationSpeed)` times per frame:
- **Pause didn't stop the clock** — `dayNightCycle.update()` ran unconditionally; `config.run` only gated the animals.
- **5× janked** (5 full re-renders/frame) and **0.5× did nothing** (`Math.floor(0.5)=0`→clamped to 1).
- **Speed was tied to frame rate** — at 1000 animals FPS drops, so "1×" ran slower in wall-clock while "5×" felt closer to real-time.
→ Fixed by **decoupling step from render** and using a **delta-time fixed-timestep** loop (§4, `Simulation.animate`): advance by real elapsed time (so a given speed is FPS-independent), catch-up steps capped by `config.maxStepsPerFrame` to avoid a spiral of death, render once per frame.

### 3.4 REWARD-HACKING EXPLOIT — "eternal hibernation" carnivores (the subtle one)
The search drove carnivore `energyGain` down to ~**-0.03**. But the genetic/mutation energy modifiers were **flat constants** sized for the old big metabolism (e.g. dwarfism = `+0.10` "less drain", speed penalty `-0.05`, …). When the base drain is tiny, a flat *benefit* like **dwarfism** flips resting metabolism **net-positive** (`-0.03 + 0.10 = +0.07`) → the animal **gains energy while idle**, never gets hungry, **never hunts**. Selection then favours these freeloaders (the Evolution Tracker showed **dwarfism sweeping to 65+/pop** and carnivore Size/Energy genes collapsing to the dwarf phenotype ~0.36×). Net effect: carnivores drop out of the food web and the "stable" balance is really a **fake trees↔herbivores** wave. **The search reward-hacked a model bug.**
→ Fixed by making the trade-off modifiers **MULTIPLICATIVE** (`Animal.js` `walk()`), so they scale with the base metabolism and can never flip the sign. After the fix: dwarfism drops to 3–5, carnivores evolve normal size, mutations are diverse. **Detection tell for the future: watch the Evolution Tracker — a single mutation sweeping the population, or a gene pinned at an extreme, is a red flag for an exploit.**

### 3.5 SCORING PITFALLS (baked into `scoreRun`)
- **Short-horizon overfit:** a config stable at 10k frames collapses by 30k. → search at long horizons + a **downward-trend penalty**.
- **Perverse low-variance incentive:** rewarding only low CV drives predators to near-zero (tiny pops have low absolute variance but are one dip from extinction). → also reward a **healthy minimum population**.

### 3.6 SUSPECTED DEAD FEATURE (not yet fixed) — sleep
The sleep code triggers only when `energy/maxEnergy < sleepEnergyThreshold (0.3)` **and** the animal isn't actively hunting. But hunger thresholds (herbivore 0.5, carnivore 0.85) are **above** 0.3, so an animal below 0.3 is always `seekFood` (isActivelyHunting) → the sleep branch appears **unreachable**. This is *reasoned, not measured* — worth confirming with a counter and then either fixing the thresholds or removing the feature. The user has referred to carnivores "sleeping" — that was really them *idling/relaxing* via the §3.4 exploit, not the sleep state.

---

## 4. What I changed (file by file)

> Note: at session start, the modular files (`Animal.js`, `config.js`, `Engine.js`, …) were **untracked** in git — the owner had just split a monolith. So most files show as new (`??`). `main.js`/`index.html`/`README.md` are tracked+modified.

- **`config.js`** — trees: `procreatingChance` 0→(tuned), added `carryingCapacity`. Added `carryingCapacity` to herbivores/carnivores. Added `world.referenceWidth/Height` + `areaScale`, and `targetStepsPerSecond` + `maxStepsPerFrame`. **⚠ the tree/herb/carn tuned numbers here are stale (buggy-model) — replace from `best-config.json`.**
- **`Engine.js`** — **NEW.** `step()` (refresh counts → build quadtree → `live()` all → `removeDead`).
- **`Animal.js`** —
  - Guarded image loading (`loadImage`, works headlessly where `Image` is undefined).
  - `speciesCounts` + `refreshCounts()` (cheap per-frame population counts).
  - **Carrying-capacity gate** in `procriate()` (× `world.areaScale`).
  - **Area-scaling** in `populate()` (starting pops × areaScale).
  - **Tree-feed skip:** `feed()` early-returns when `consumes.length === 0` (perf; byte-identical).
  - **Shared neighbour query:** `live()` does one `quadtree.query(SENSE_RADIUS=200)` and passes it to `analyze`/`seekFood`/`flee`/`moveTowardHerd`, each filtering to its own radius (perf; byte-identical). **Guard:** if `analyze()` moved the animal (a baby following its parent), the shared list is invalidated (`nearby = null`) so `walk()` re-queries.
  - **Multiplicative energy trade-offs** in `walk()` (the §3.4 fix).
- **`Renderer.js`** — split: `renderScene()` paints only; stepping removed (moved to `Engine`/`Simulation`).
- **`Simulation.js`** — delta-time fixed-timestep `animate()` (pause + speed fixes); `fixCanvasSize()` does area-matching + canvas CSS scaling; live `world: W×H · N% of tuned` display.
- **`UI.js`** — tooltip + click map screen px → world coords (canvas buffer ≠ display size now).
- **`index.html`** — added `#world-size-display`.
- **`package.json`** — **NEW** (`"type":"module"` so Node treats `.js` as ESM; the browser ignores it) + `sim`/`search`/`dashboard` scripts.
- **`headless/**`** — **NEW** (the whole harness, §2).
- **`docs/ECOSYSTEM_BALANCE.md`** — **NEW** theory report for the owner (Verhulst → Lotka-Volterra → Rosenzweig-MacArthur → paradox of enrichment → NetLogo Wolf-Sheep). **§7 "Results" is a placeholder — fill it after the search finishes.**

---

## 5. Verification methodology (please keep using this)

- **Behavior-preserving changes (perf) → prove byte-identical.** Run `node headless/run.mjs --frames 6000 --seed N` for seeds 1–3 before and after; final counts must match exactly. Current known-good baseline for the *honest* model: seed1 `661/25/58`, seed2 `662/134/51`, seed3 `661/128/54` (trees/herb/carn @ 6000 frames). **⚠ this baseline is only valid until you change `config.js` — it's config-dependent.**
- **Model-changing fixes → confirm the intended behavioral change** (e.g. after the metabolism fix, the old config collapses and dwarfism stops sweeping).
- **Exploit detection → read the evolved genetics** (`run.mjs` prints them). A mutation sweeping the population or a gene pinned at an extreme = investigate.
- **Browser verification → headless Chromium screenshot** (no install needed): `/Applications/Chromium.app/Contents/MacOS/Chromium --headless=new --disable-gpu --no-sandbox --window-size=1440,900 --virtual-time-budget=60000 --screenshot=/tmp/sim.png http://localhost:8000` then read the PNG. Check populations hold, `world: … · 100% of tuned`, no console errors in stderr.

---

## 6. Gotchas for the next model

- **Node isn't on the default PATH:** `export PATH="/opt/homebrew/bin:$PATH"`.
- **`macOS has no `timeout`.** Chromium `--virtual-time-budget` self-exits; run headless browser jobs in the background.
- **Any model/dynamics change invalidates a tuned config.** Order: fix the model → optimize (verify identical) → *then* search. Never search first.
- **Distances (vision 150 via `config.genetics.baselineVisionRange`, speed 0.5, search radii 200/150, feed 10, herd 100) are absolute pixels and are NOT area-scaled.** That's why the browser needs area-*matching* (§3.2), not just population scaling.
- **`config` is a shared singleton;** the harness captures `BASE_CONFIG` at load and resets from it each run — mutate config *fields*, don't replace sub-objects.
- **Determinism depends on `Math.random` only.** `Date.now()` is used for memory timestamps but never read for decisions, so it doesn't affect dynamics.
- **This is a personal for-fun project.** The owner is a curious hobbyist who enjoys the *why* (theory, the "clever jumps" in papers) and finding bugs together — explain reasoning, keep it readable, don't over-formalize.

---

## 7. Next actions (in order)

1. **When the search finishes:** read `headless/best-config.json`. Apply its `overrides` (10 fields: trees `procreatingChance`/`carryingCapacity`; herbivores `procreatingChance`/`energyGain`/`maxAge`/`carryingCapacity`; carnivores same 4) into `config.js`, replacing the stale values.
2. **Inspect the winner for NEW exploits:** `node headless/run.mjs --frames 60000 --seed <several>` — confirm all three persist, evolved genetics look sane, and no single mutation sweeps. If an exploit appears, fix the model and **re-search** (don't just accept the number).
3. **Verify in the real browser** (§5 screenshot) at a non-1920 window — populations should hold and read `100% of tuned`.
4. **Fill `docs/ECOSYSTEM_BALANCE.md` §7 "Results"** with the honest before/after trajectories and the final knobs.
5. **Optional polish** the owner is interested in:
   - *Baseline correction / warm-start:* if traits reliably converge **across multiple honest runs**, shift the starting genetics baseline toward that attractor. Only for genuinely convergent traits (not drift, not exploit).
   - *Rendering perf:* gate expensive decorations (target lines / vision cones / per-animal text) above some animal count; batch canvas state. Browser-only, verify via FPS.
   - *Sleep feature:* decide (§3.6) — fix thresholds so it can fire, or remove it.

---

## 8. If the honest model turns out hard to balance

Real predator-prey is inherently oscillatory (neutral stability in Lotka-Volterra; the paradox of enrichment). If the search can't find configs where all three persist robustly:
- Lower carnivore `carryingCapacity` range further and/or bias toward smaller carnivore `procreatingChance` (fewer predators).
- Consider giving prey a stronger low-density refuge (a Holling **Type III** functional response is *stabilizing*) — e.g. carnivores give up hunting when herbivore density is very low. This is a *model* change → re-search after.
- Widen the search (more `--n1`, more `--rounds`) and/or lengthen `--frames` if slow collapses are slipping through.

Good luck — the model is honest now, which is the hard part. The rest is tuning.
