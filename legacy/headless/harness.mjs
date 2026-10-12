// Headless simulation harness: run the REAL simulation with no rendering,
// measure the population dynamics, and score how "healthy" the ecosystem is.
import { config } from '../config.js';
import { animals, setAnimals, populate, speciesCounts, setSoilNutrients } from '../Animal.js';
import { step } from '../Engine.js';
import { DayNightCycle } from '../DayNightCycle.js';
import { seedRandom } from './rng.mjs';

// A pristine copy of the default config, captured once. Every run resets to
// this before applying its candidate overrides, so runs never contaminate
// each other through the shared config singleton.
const BASE_CONFIG = structuredClone(config);

const SPECIES = ['tree', 'herbivore', 'carnivore'];

// ---- small stats helpers ------------------------------------------------
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Deep-merge candidate overrides into the live config object (mutating fields,
// not replacing sub-objects, so cached references stay valid).
function applyOverrides(target, overrides) {
    for (const [k, v] of Object.entries(overrides)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            applyOverrides(target[k], v);
        } else {
            target[k] = v;
        }
    }
}

/**
 * Run one simulation.
 * @param {object} overrides  partial config (e.g. { trees: { procreatingChance: 0.001 } })
 * @param {object} opts       { seed, frames, sample, world }
 * @returns rich metrics object
 */
export function runOnce(overrides = {}, opts = {}) {
    const {
        seed = 1,
        frames = 20000,
        sample = 100,
        world = { width: 1920, height: 1080 },
        shock = null, // { frame, species, fraction } — a disturbance to test resilience
    } = opts;

    // 1. Deterministic RNG for this run.
    seedRandom(seed);

    // 2. Reset config to defaults, then apply this candidate's overrides.
    applyOverrides(config, structuredClone(BASE_CONFIG));
    applyOverrides(config, overrides);
    config.run = true;
    config.world.width = world.width;
    config.world.height = world.height;
    // Match the browser's density scaling (=1 at the 1920x1080 reference).
    config.world.areaScale = (config.world.width * config.world.height) /
        (config.world.referenceWidth * config.world.referenceHeight);
    config.visuals.procreationAnimations.enabled = false; // render-only, skip it

    // 3. Fresh world.
    setAnimals([]);
    setSoilNutrients(0);
    populate('tree', config.trees.initialPopulation);
    populate('herbivore', config.herbivores.initialPopulation);
    populate('carnivore', config.carnivores.initialPopulation);

    const dnc = new DayNightCycle();
    const series = { tree: [], herbivore: [], carnivore: [] };

    let completed = true;
    let collapseFrame = frames;
    let collapseCause = null;

    for (let f = 0; f < frames; f++) {
        // Resilience shock: wipe out a fraction of a species and see if the
        // ecosystem recovers (a real system does; a fake/fragile one cascades).
        if (shock && f === shock.frame) {
            setAnimals(animals.filter((a) => !(a.kind === shock.species && Math.random() < shock.fraction)));
        }

        dnc.update();
        step(dnc); // step() refreshes speciesCounts at the start of each frame

        if (f % sample === 0) {
            series.tree.push(speciesCounts.tree);
            series.herbivore.push(speciesCounts.herbivore);
            series.carnivore.push(speciesCounts.carnivore);
        }

        // Nothing can return from zero in this model, so the first extinction of
        // ANY species seals the ecosystem's fate — stop and save the work.
        if (speciesCounts.tree === 0 || speciesCounts.herbivore === 0 || speciesCounts.carnivore === 0) {
            completed = false;
            collapseFrame = f;
            collapseCause =
                speciesCounts.herbivore === 0 ? 'herbivore'
                : speciesCounts.carnivore === 0 ? 'carnivore'
                : 'tree';
            break;
        }
    }

    // Final snapshot.
    const finalCounts = { tree: speciesCounts.tree, herbivore: speciesCounts.herbivore, carnivore: speciesCounts.carnivore };

    // Back-half (post-transient) summary for each species.
    const summary = {};
    for (const s of SPECIES) {
        const seg = series[s].slice(Math.floor(series[s].length / 2));
        const m = mean(seg);
        summary[s] = {
            mean: m,
            std: std(seg),
            min: seg.length ? Math.min(...seg) : 0,
            max: seg.length ? Math.max(...seg) : 0,
            cv: m > 0 ? std(seg) / m : 1,
        };
    }

    // Resilience: did the shocked species recover toward its pre-shock level?
    let recovery = null;
    if (shock) {
        const ser = series[shock.species];
        const shockIdx = Math.floor(shock.frame / sample);
        const preMean = mean(ser.slice(Math.max(0, shockIdx - 10), shockIdx));
        const postMean = mean(ser.slice(Math.floor(ser.length * 0.85)));
        recovery = preMean > 0 ? postMean / preMean : 0;
    }

    return { completed, collapseFrame, collapseCause, frames, finalCounts, summary, series, shock, recovery };
}

/**
 * Turn a run's metrics into a single "health" score — the RESILIENCE definition
 * of balance (nature persists through disturbance; it isn't a flat line).
 *
 *  - Collapsed (any extinction before the horizon, incl. after the shock) → 0..10,
 *    proportional to how long the whole web lasted (a gradient the search can climb).
 *  - Survived the full horizon THROUGH a mid-run shock → 20..48, rewarding:
 *      • a healthy MINIMUM population (bounded-below buffer against stochastic dips —
 *        NOT low variance, so natural predator-prey oscillation is fine), and
 *      • SHOCK RECOVERY: after 40% of the herbivores are culled mid-run, did the
 *        system bounce back toward its pre-shock level? This is the exploit-resistant
 *        term — a fake/idle "balance" can't recover; a real one does.
 */
export function scoreRun(r) {
    if (!r.completed) {
        return 10 * (r.collapseFrame / r.frames);
    }

    let score = 20; // reached the horizon with all three species alive, through the shock

    // Resilience buffer: a healthy minimum keeps a random dip from hitting zero.
    for (const s of ['herbivore', 'carnivore']) {
        const seg = r.series[s].slice(Math.floor(r.series[s].length / 2));
        const mn = seg.length ? Math.min(...seg) : 0;
        const floor = s === 'carnivore' ? 12 : 30;
        score += 7 * clamp(mn / floor, 0, 1);
    }

    // Shock recovery — bounce back toward the pre-shock level (1.0 = full recovery).
    if (r.shock && r.recovery != null) {
        score += 14 * clamp(r.recovery, 0, 1);
    }

    return score;
}

/**
 * Evaluate a candidate config across several seeds and average the score
 * (so we reward configs that are robustly stable, not just lucky once).
 */
export function evaluate(overrides, { seeds = [1, 2, 3], frames = 20000, sample = 100, shock } = {}) {
    // Default resilience shock: cull 40% of the herbivores ~55% through the run.
    const theShock = shock === undefined
        ? { frame: Math.floor(frames * 0.55), species: 'herbivore', fraction: 0.4 }
        : shock;
    const runs = seeds.map((seed) => runOnce(overrides, { seed, frames, sample, shock: theShock }));
    const scores = runs.map(scoreRun);
    const avg = mean(scores);
    const completedCount = runs.filter((r) => r.completed).length;
    // Representative run = the median-scoring one, for reporting.
    const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
    const rep = runs[order[Math.floor(order.length / 2)][1]];
    return { score: avg, scores, completedCount, seeds: seeds.length, rep };
}
