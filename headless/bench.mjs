// Performance benchmark + correctness fingerprint for the engine.
//
// Two jobs:
//   1. TIMING  — how many sim-steps/second at a representative population, and
//      at a stress population (bigger world), best-of-N to fight measurement noise.
//   2. FINGERPRINT — exact final counts per seed at a fixed horizon. This is the
//      byte-identical check: a behaviour-preserving optimization must NOT change
//      these numbers. (Methodology from docs/HANDOFF.md §5.)
//
// Usage:
//   node headless/bench.mjs                 # fingerprint (seeds 1-3 @ 6000) + timing
//   node headless/bench.mjs --frames 6000 --seed 1 --reps 3
//   node headless/bench.mjs --stress        # add a big-world high-N timing run
//   node headless/bench.mjs --fingerprint   # only the correctness fingerprint (fast, load-independent)
import { config } from '../config.js';
import { setAnimals, populate, speciesCounts, animals } from '../Animal.js';
import { step } from '../Engine.js';
import { DayNightCycle } from '../DayNightCycle.js';
import { seedRandom } from './rng.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const BASE_CONFIG = structuredClone(config);

// Run `frames` steps with a fixed seed and world, no early stop. Returns final
// counts + elapsed ms. Deterministic given (seed, world, config).
function runFixed(seed, frames, world) {
    seedRandom(seed);
    // reset config to defaults each run (shared singleton)
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, structuredClone(BASE_CONFIG));
    config.run = true;
    config.world.width = world.width;
    config.world.height = world.height;
    config.world.areaScale = (world.width * world.height) /
        (config.world.referenceWidth * config.world.referenceHeight);
    config.visuals.procreationAnimations.enabled = false;

    setAnimals([]);
    populate('tree', config.trees.initialPopulation);
    populate('herbivore', config.herbivores.initialPopulation);
    populate('carnivore', config.carnivores.initialPopulation);

    const dnc = new DayNightCycle();
    const startPop = animals.length;

    const t0 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) {
        dnc.update();
        step(dnc);
    }
    const t1 = process.hrtime.bigint();

    const ms = Number(t1 - t0) / 1e6;
    return {
        ms,
        startPop,
        counts: { tree: speciesCounts.tree, herbivore: speciesCounts.herbivore, carnivore: speciesCounts.carnivore },
        total: animals.length,
    };
}

const frames = parseInt(flag('frames', '6000'), 10);
const reps = parseInt(flag('reps', '3'), 10);
const ref = { width: 1920, height: 1080 };

// --- Correctness fingerprint (seeds 1-3) ---------------------------------
console.log(`\n=== FINGERPRINT (byte-identical check) — ${frames} frames @ ${ref.width}x${ref.height} ===`);
const seeds = [1, 2, 3];
for (const s of seeds) {
    const r = runFixed(s, frames, ref);
    console.log(`  seed ${s}: ${r.counts.tree}/${r.counts.herbivore}/${r.counts.carnivore}  (trees/herb/carn, total ${r.total})`);
}

if (has('fingerprint')) process.exit(0);

// --- Timing (best-of-reps to fight noise from a competing search) --------
function timeScenario(label, seed, frames, world) {
    let best = Infinity, counts = null, startPop = 0;
    for (let i = 0; i < reps; i++) {
        const r = runFixed(seed, frames, world);
        if (r.ms < best) { best = r.ms; counts = r.counts; startPop = r.startPop; }
    }
    const stepsPerSec = (frames / best) * 1000;
    // avg population over the run isn't tracked; report start + end as a proxy
    console.log(`  ${label.padEnd(22)} ${best.toFixed(0).padStart(6)} ms   ${stepsPerSec.toFixed(0).padStart(6)} steps/s   (start ${startPop} → end ${counts.tree + counts.herbivore + counts.carnivore} entities)`);
    return { best, stepsPerSec };
}

console.log(`\n=== TIMING (best of ${reps}) ===`);
timeScenario('reference 1920x1080', 1, frames, ref);

if (has('stress')) {
    // 4x area → ~4x populations (area-scaled). Stresses the spatial index + hot path.
    const big = { width: 3840, height: 2160 };
    timeScenario('stress 3840x2160', 1, frames, big);
}
console.log('');
