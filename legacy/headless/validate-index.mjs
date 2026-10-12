// Statistical-equivalence check: quadtree vs. grid spatial index.
//
// An index swap returns the SAME neighbour set in a different ORDER. In a chaotic
// sim that diverges the exact per-seed trajectory, so a byte-identical fingerprint
// is the wrong test. The RIGHT test is: does the swap change the ECOLOGY? We answer
// it the way you'd validate any stochastic model change — run many seeds under each
// index and compare the DISTRIBUTIONS of the outcome (back-half mean population per
// species, its minimum, and the survival rate). If those overlap, the two indices
// are the same dynamical system with different microscopic noise.
//
// Usage: node headless/validate-index.mjs [--seeds 20] [--frames 20000]
import { config } from '../config.js';
import { setAnimals, populate, speciesCounts, animals } from '../Animal.js';
import { step, setSpatialIndex } from '../Engine.js';
import { DayNightCycle } from '../DayNightCycle.js';
import { seedRandom } from './rng.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const SEEDS = parseInt(flag('seeds', '20'), 10);
const FRAMES = parseInt(flag('frames', '20000'), 10);
const REF = { width: 1920, height: 1080 };

const BASE_CONFIG = structuredClone(config);

// One deterministic run. Records the back-half mean and min for each species
// (the same signal scoreRun cares about: healthy average + resilient minimum).
function runFixed(seed) {
    seedRandom(seed);
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, structuredClone(BASE_CONFIG));
    config.run = true;
    config.world.width = REF.width;
    config.world.height = REF.height;
    config.world.areaScale = 1;
    config.visuals.procreationAnimations.enabled = false;

    setAnimals([]);
    populate('tree', config.trees.initialPopulation);
    populate('herbivore', config.herbivores.initialPopulation);
    populate('carnivore', config.carnivores.initialPopulation);

    const dnc = new DayNightCycle();
    const halfStart = Math.floor(FRAMES / 2);
    const acc = { tree: 0, herbivore: 0, carnivore: 0 };
    const min = { tree: Infinity, herbivore: Infinity, carnivore: Infinity };
    let n = 0;
    let collapsedAt = -1;

    for (let f = 0; f < FRAMES; f++) {
        dnc.update();
        step(dnc);
        if (collapsedAt < 0 && (speciesCounts.herbivore === 0 || speciesCounts.carnivore === 0)) {
            collapsedAt = f;
        }
        if (f >= halfStart) {
            for (const kind of ['tree', 'herbivore', 'carnivore']) {
                acc[kind] += speciesCounts[kind];
                if (speciesCounts[kind] < min[kind]) min[kind] = speciesCounts[kind];
            }
            n++;
        }
    }
    return {
        mean: { tree: acc.tree / n, herbivore: acc.herbivore / n, carnivore: acc.carnivore / n },
        min,
        survived: speciesCounts.herbivore > 0 && speciesCounts.carnivore > 0,
    };
}

function batch(indexKind) {
    setSpatialIndex(indexKind);
    const rows = [];
    for (let s = 1; s <= SEEDS; s++) rows.push(runFixed(s));
    return rows;
}

// summary stats over the per-seed rows
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

function summarize(label, rows) {
    const survived = rows.filter((r) => r.survived).length;
    const out = { label, survived: `${survived}/${rows.length}` };
    for (const kind of ['tree', 'herbivore', 'carnivore']) {
        const means = rows.map((r) => r.mean[kind]);
        const mins = rows.map((r) => r.min[kind]);
        out[kind] = { mean: mean(means), sd: sd(means), minMean: mean(mins) };
    }
    return out;
}

console.log(`\nStatistical equivalence — ${SEEDS} seeds × ${FRAMES} frames @ ${REF.width}x${REF.height}`);
console.log('(back-half mean population per species, averaged across seeds ± seed-to-seed SD)\n');

const q = summarize('quadtree', batch('quadtree'));
const g = summarize('grid', batch('grid'));

const pad = (s, w) => String(s).padStart(w);
const fmt = (x) => x.toFixed(1);
console.log(`  ${'index'.padEnd(10)} ${pad('survival', 9)} ${pad('trees(mean±sd)', 18)} ${pad('herb(mean±sd)', 18)} ${pad('carn(mean±sd)', 18)}`);
for (const r of [q, g]) {
    console.log(`  ${r.label.padEnd(10)} ${pad(r.survived, 9)} ` +
        `${pad(`${fmt(r.tree.mean)}±${fmt(r.tree.sd)}`, 18)} ` +
        `${pad(`${fmt(r.herbivore.mean)}±${fmt(r.herbivore.sd)}`, 18)} ` +
        `${pad(`${fmt(r.carnivore.mean)}±${fmt(r.carnivore.sd)}`, 18)}`);
}

// A simple overlap verdict: are the two means within 1 pooled SD of each other?
console.log('\n  Δ(grid − quadtree) in units of pooled seed-to-seed SD:');
for (const kind of ['tree', 'herbivore', 'carnivore']) {
    const dm = g[kind].mean - q[kind].mean;
    const pooledSd = Math.sqrt((q[kind].sd ** 2 + g[kind].sd ** 2) / 2) || 1e-9;
    const z = dm / pooledSd;
    const verdict = Math.abs(z) < 1 ? 'equivalent' : Math.abs(z) < 2 ? 'close' : 'DIFFERENT';
    console.log(`    ${kind.padEnd(11)} Δmean=${pad(fmt(dm), 7)}   ${pad((z >= 0 ? '+' : '') + z.toFixed(2), 7)} SD   → ${verdict}`);
}
console.log('');
