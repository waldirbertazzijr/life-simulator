// Parallel parameter search for a STABLE ecosystem.
//
// Strategy:
//   Phase 1 — random search over the ecological knobs (broad exploration).
//   Phase 2 — local refinement (Gaussian perturbation of the elites).
//   Final   — re-validate the winner on more seeds and a longer horizon.
//
// Runs across a worker pool (one simulation per worker). Each candidate is
// scored on multiple seeds and averaged, so we reward robust stability rather
// than a single lucky run.
import { Worker } from 'worker_threads';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mulberry32 } from './rng.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- CLI ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const N1 = parseInt(flag('n1', '700'), 10);        // random candidates in phase 1
const ELITES = parseInt(flag('elites', '6'), 10);   // elites carried into refinement
const ROUNDS = parseInt(flag('rounds', '6'), 10);   // refinement rounds
const NEIGH = parseInt(flag('neighbors', '10'), 10);// neighbors per elite per round
const FRAMES = parseInt(flag('frames', '25000'), 10);
const SAMPLE = parseInt(flag('sample', '100'), 10);
const WORKERS = parseInt(flag('workers', '11'), 10);
const SEARCH_SEED = parseInt(flag('searchSeed', '42'), 10);
const SEARCH_SEEDS = [1, 2, 3];               // seeds per candidate during search
const FINAL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]; // seeds for final validation (robustness)
const FINAL_FRAMES = parseInt(flag('finalFrames', '60000'), 10);

// ---- search space -------------------------------------------------------
// Each knob has an ecological meaning; ranges are deliberately wide.
const SPACE = [
    { path: ['trees', 'procreatingChance'], min: 0.0005, max: 0.005, log: true },   // forest regrowth rate r
    { path: ['trees', 'carryingCapacity'], min: 400, max: 900, int: true },         // forest cap K
    { path: ['trees', 'energyGain'], min: 0.05, max: 0.8 },                         // PHOTOSYNTHESIS = enrichment level (paradox of enrichment!)
    { path: ['herbivores', 'procreatingChance'], min: 0.0005, max: 0.008, log: true },
    { path: ['herbivores', 'energyGain'], min: -0.20, max: -0.04 },                 // metabolic drain
    { path: ['herbivores', 'maxAge'], min: 3000, max: 8000, int: true },
    { path: ['herbivores', 'carryingCapacity'], min: 150, max: 500, int: true },
    { path: ['carnivores', 'procreatingChance'], min: 0.0005, max: 0.01, log: true },
    { path: ['carnivores', 'energyGain'], min: -0.10, max: -0.01 },
    { path: ['carnivores', 'maxAge'], min: 3000, max: 8000, int: true },
    { path: ['carnivores', 'carryingCapacity'], min: 20, max: 150, int: true },
    // Ecological-realism knobs: honest assimilation fraction + Type III refuge strength.
    { path: ['ecology', 'energyTransferEfficiency'], min: 0.4, max: 0.9 },
    { path: ['ecology', 'typeIIIRefuge'], min: 1, max: 8 },
];

const rng = mulberry32(SEARCH_SEED);
const uniform = (a, b) => a + (b - a) * rng();
const gauss = () => { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function sampleVector() {
    return SPACE.map((d) => {
        let v = d.log ? Math.exp(uniform(Math.log(d.min), Math.log(d.max))) : uniform(d.min, d.max);
        if (d.int) v = Math.round(v);
        return v;
    });
}

// Perturb a vector: Gaussian step in each dimension (in log-space for rates),
// scaled by `sigma` (fraction of the range), then clamped to bounds.
function perturb(vec, sigma) {
    return vec.map((val, i) => {
        const d = SPACE[i];
        let v;
        if (d.log) {
            const lo = Math.log(d.min), hi = Math.log(d.max);
            v = Math.exp(clamp(Math.log(val) + gauss() * sigma * (hi - lo), lo, hi));
        } else {
            v = clamp(val + gauss() * sigma * (d.max - d.min), d.min, d.max);
        }
        if (d.int) v = Math.round(v);
        return v;
    });
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function toOverrides(vec) {
    const o = {};
    vec.forEach((val, i) => {
        const [a, b] = SPACE[i].path;
        (o[a] ??= {})[b] = val;
    });
    return o;
}

function fmtVec(vec) {
    return SPACE.map((d, i) => {
        const name = d.path.join('.');
        const v = vec[i];
        return `${name}=${d.log ? v.toExponential(2) : d.int ? v : v.toFixed(3)}`;
    }).join('  ');
}

// ---- worker pool --------------------------------------------------------
// Each task is { vec, opts }. Tasks are handed to workers as slots free up.
function runPool(tasks, onProgress) {
    return new Promise((resolve) => {
        const results = new Array(tasks.length);
        let next = 0, done = 0;
        const workers = [];
        const nw = Math.max(1, Math.min(WORKERS, tasks.length));

        const finishIfDone = () => {
            if (done === tasks.length) {
                workers.forEach((w) => w.terminate());
                resolve(results);
            }
        };
        const dispatch = (w) => {
            if (next >= tasks.length) return;
            const id = next++;
            w.postMessage({ id, overrides: toOverrides(tasks[id].vec), opts: tasks[id].opts });
        };

        for (let i = 0; i < nw; i++) {
            const w = new Worker(join(__dirname, 'searchWorker.mjs'));
            w.on('message', (res) => {
                results[res.id] = res;
                done++;
                if (onProgress) onProgress(done, tasks.length, res, tasks[res.id].vec);
                dispatch(w);
                finishIfDone();
            });
            w.on('error', (e) => { console.error('worker error:', e); done++; finishIfDone(); });
            workers.push(w);
            dispatch(w);
        }
    });
}

const searchTasks = (vectors) => vectors.map((vec) => ({ vec, opts: { seeds: SEARCH_SEEDS, frames: FRAMES, sample: SAMPLE } }));

// ---- driver + live progress feed ----------------------------------------
const t0 = Date.now();
const OVERALL_TOTAL = N1 + ROUNDS * ELITES * NEIGH;
const PROGRESS_PATH = join(__dirname, 'progress.json');
let overallDone = 0;
let currentPhase = 'starting';
let best = { score: -Infinity };
let finalStats = null;
const scoreHistory = [];
let lastWrite = 0;

function writeProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastWrite < 400) return; // throttle disk writes
    lastWrite = now;
    const data = {
        updatedAt: now,
        elapsedSeconds: Math.round((now - t0) / 1000),
        phase: currentPhase,
        done: overallDone,
        total: OVERALL_TOTAL,
        workers: WORKERS,
        searchSeeds: SEARCH_SEEDS.length,
        frames: FRAMES,
        bestScore: best.score > -Infinity ? best.score : null,
        bestOverrides: best.overrides || null,
        bestSummary: best.summary || null,
        bestFinalCounts: best.finalCounts || null,
        bestCompleted: best.completed || false,
        bestSpark: best.spark || null,
        scoreHistory,
        finalStats,
    };
    try { writeFileSync(PROGRESS_PATH, JSON.stringify(data)); } catch { /* ignore */ }
}

function setPhase(label) { currentPhase = label; writeProgress(true); }

function progress(done, total, res, vec) {
    overallDone++;
    if (res && typeof res.score === 'number' && res.score > best.score) {
        best = {
            score: res.score,
            overrides: toOverrides(vec),
            summary: res.rep.summary,
            finalCounts: res.rep.finalCounts,
            completed: res.rep.completed,
            spark: res.rep.spark,
        };
    }
    if (best.score > -Infinity && overallDone % 4 === 0) scoreHistory.push({ n: overallDone, best: Number(best.score.toFixed(2)) });
    writeProgress();
    if (overallDone % 25 === 0 || done === total) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        process.stdout.write(`\r  ${overallDone}/${OVERALL_TOTAL} evaluated | best ${best.score.toFixed(1)} | ${secs}s   `);
    }
}

function attachScores(vectors, results) {
    return vectors.map((vec, i) => ({ vec, ...results[i] })).filter((x) => typeof x.score === 'number');
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

async function main() {
    console.log(`\n🔎 Parameter search — ${SPACE.length} knobs, ${WORKERS} workers`);
    console.log(`   Phase 1: ${N1} random candidates × ${SEARCH_SEEDS.length} seeds × ${FRAMES} frames`);

    // Phase 1 — random search
    setPhase('Phase 1 — random exploration');
    let vectors = Array.from({ length: N1 }, sampleVector);
    let results = await runPool(searchTasks(vectors), progress);
    let scored = attachScores(vectors, results).sort((a, b) => b.score - a.score);
    console.log(`\n   Phase 1 best: ${scored[0].score.toFixed(1)} (${scored[0].completedCount}/${scored[0].seeds} seeds survived)`);

    // Phase 2 — local refinement around the elites
    let elites = scored.slice(0, ELITES);
    for (let round = 0; round < ROUNDS; round++) {
        const sigma = 0.25 * (1 - round / ROUNDS) + 0.05; // anneal step size
        const neighbors = [];
        for (const e of elites) {
            for (let k = 0; k < NEIGH; k++) neighbors.push(perturb(e.vec, sigma));
        }
        console.log(`\n   Phase 2 round ${round + 1}/${ROUNDS} — ${neighbors.length} neighbors (σ=${sigma.toFixed(2)})`);
        setPhase(`Phase 2 — refinement ${round + 1}/${ROUNDS}`);
        const nres = await runPool(searchTasks(neighbors), progress);
        const nscored = attachScores(neighbors, nres);
        const pool = [...elites, ...nscored].sort((a, b) => b.score - a.score);
        elites = pool.slice(0, ELITES);
        console.log(`\n   round ${round + 1} best: ${elites[0].score.toFixed(1)}`);
    }

    const winner = elites[0];

    // Final validation — more seeds, longer horizon, one seed per worker so it
    // parallelizes instead of running serially.
    console.log(`\n\n🧪 Final validation of winner — ${FINAL_SEEDS.length} seeds × ${FINAL_FRAMES} frames`);
    setPhase(`Final validation — ${FINAL_SEEDS.length} seeds × ${FINAL_FRAMES} frames`);
    const finalTasks = FINAL_SEEDS.map((s) => ({ vec: winner.vec, opts: { seeds: [s], frames: FINAL_FRAMES, sample: SAMPLE } }));
    const finalRes = await runPool(finalTasks, () => {});
    const finScore = mean(finalRes.map((r) => r.score));
    const finCompleted = finalRes.reduce((a, r) => a + r.completedCount, 0);
    // Representative = a surviving run if any (for reporting final populations).
    const repRes = finalRes.find((r) => r.rep.completed) || finalRes.sort((a, b) => b.score - a.score)[0];

    const overrides = toOverrides(winner.vec);
    const out = {
        searchSeed: SEARCH_SEED,
        elapsedSeconds: ((Date.now() - t0) / 1000).toFixed(0),
        searchScore: winner.score,
        searchFrames: FRAMES,
        searchSeeds: SEARCH_SEEDS.length,
        finalScore: finScore,
        finalFrames: FINAL_FRAMES,
        finalCompleted: `${finCompleted}/${FINAL_SEEDS.length}`,
        perSeedFinalScores: finalRes.map((r) => Number(r.score.toFixed(1))),
        overrides,
        winnerSummary: repRes.rep,
        elites: elites.map((e) => ({ score: e.score, overrides: toOverrides(e.vec) })),
    };
    const outPath = join(__dirname, 'best-config.json');
    writeFileSync(outPath, JSON.stringify(out, null, 2));

    // Push the validated winner (long-horizon trajectory + final score) to the dashboard.
    finalStats = {
        finalScore: Number(finScore.toFixed(1)),
        finalCompleted: `${finCompleted}/${FINAL_SEEDS.length}`,
        finalFrames: FINAL_FRAMES,
        perSeed: out.perSeedFinalScores,
    };
    best = {
        score: winner.score,
        overrides,
        summary: repRes.rep.summary,
        finalCounts: repRes.rep.finalCounts,
        completed: repRes.rep.completed,
        spark: repRes.rep.spark,
    };
    currentPhase = 'done ✅';
    writeProgress(true);

    console.log(`\n================ WINNER ================`);
    console.log(fmtVec(winner.vec));
    console.log(`\nsearch score: ${winner.score.toFixed(1)}   final(${FINAL_FRAMES}f, ${FINAL_SEEDS.length} seeds): ${finScore.toFixed(1)}   survived ${finCompleted}/${FINAL_SEEDS.length} seeds`);
    console.log('per-seed final scores:', JSON.stringify(out.perSeedFinalScores));
    console.log('final populations (representative run):', JSON.stringify(repRes.rep.finalCounts));
    console.log('\noverrides:\n', JSON.stringify(overrides, null, 2));
    console.log(`\n💾 saved → ${outPath}`);
    console.log(`⏱  total ${out.elapsedSeconds}s`);
}

main();
