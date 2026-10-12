// Headless stability check: runs the real engine (src/world.js) on many seeds
// in parallel and reports whether every species persisted, how much the
// populations swing, how low they dipped, what evolved, and how fast it ran.
//
//   make check                                   # 8 seeds × 100k steps
//   make check ARGS="--seeds 1-20 --steps 200000"
//   make check ARGS="--set carnivore.efficiency=0.6 --set grass.regrowth=0.001"
//   make check ARGS="--shock 0.6@50000"         # cull 60% of herbivores at step 50k
//   make check ARGS="--aspect 0.46"             # a phone-shaped world (same area)
//   make check ARGS="--set terrain.enabled=false"  # a flat world, no mountains or lakes
//   make check ARGS="--spark"                   # print population sparklines
//   make check ARGS="--json"                    # machine-readable output
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';

// ---- the actual run (worker side) ------------------------------------------
function runSeed({ params, seed, steps, sample, shock, aspect }) {
    const world = new World(params, { seed, aspect });
    const series = { herbivore: [], carnivore: [], grass: [], human: [], tribes: [] };
    let extinct = null;
    let humansGone = null;
    const hadHumans = world.humans.n > 0;
    const t0 = performance.now();

    for (let t = 1; t <= steps; t++) {
        if (shock && t === shock.at) {
            const h = world.herbivores;
            for (let i = 0; i < h.n; i++) if (world.rng.next() < shock.fraction) h.energy[i] = 0;
            h.compact();
        }
        world.step();
        if (t % sample === 0) {
            series.herbivore.push(world.herbivores.n);
            series.carnivore.push(world.carnivores.n);
            series.grass.push(+world.grass.mean().toFixed(3));
            series.human.push(world.humans.n);
            series.tribes.push(world.tribes.length);
        }
        if (hadHumans && humansGone === null && world.humans.n === 0) humansGone = t;
        if (world.herbivores.n === 0 || world.carnivores.n === 0) {
            extinct = { species: world.herbivores.n === 0 ? 'herbivore' : 'carnivore', at: t };
            break;
        }
    }

    // Culture of the surviving tribes, weighted by their size.
    let people = 0;
    let aggression = 0;
    let sociality = 0;
    for (const tribe of world.tribes) {
        people += tribe.members;
        aggression += tribe.aggression * tribe.members;
        sociality += tribe.sociality * tribe.members;
    }

    const ms = performance.now() - t0;
    return {
        seed,
        steps: world.time,
        extinct,
        stepsPerSec: world.time / (ms / 1000),
        series,
        genes: {
            herbivore: world.meanGenes(world.herbivores),
            carnivore: world.meanGenes(world.carnivores),
        },
        terrain: world.terrain ? { ...world.terrain.coverage(), boost: world.grass.boost } : null,
        humans: hadHumans ? {
            gone: humansGone,
            founded: world.nextTribeId - 1,
            tribes: world.tribes.length,
            culture: people ? { aggression: aggression / people, sociality: sociality / people } : null,
        } : null,
    };
}

if (!isMainThread) {
    parentPort.postMessage(runSeed(workerData));
} else {
    main();
}

// ---- reporting (main thread) ---------------------------------------------------
function parseArgs(argv) {
    const opts = { seeds: [1, 2, 3, 4, 5, 6, 7, 8], steps: 100000, sample: 100, aspect: 1.6, sets: [], shock: null, spark: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--seeds') {
            const v = next();
            const m = v.match(/^(\d+)-(\d+)$/);
            opts.seeds = m
                ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, k) => +m[1] + k)
                : v.split(',').map(Number);
        } else if (a === '--steps') opts.steps = +next();
        else if (a === '--sample') opts.sample = +next();
        else if (a === '--aspect') opts.aspect = +next();
        else if (a === '--set') opts.sets.push(next());
        else if (a === '--shock') {
            const [fraction, at] = next().split('@').map(Number);
            opts.shock = { fraction, at };
        } else if (a === '--spark') opts.spark = true;
        else if (a === '--json') opts.json = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

// "--set carnivore.efficiency=0.6" → params.carnivore.efficiency = 0.6
function applySets(params, sets) {
    for (const s of sets) {
        const [path, raw] = s.split('=');
        const keys = path.split('.');
        let o = params;
        for (const k of keys.slice(0, -1)) o = o[k];
        const last = keys[keys.length - 1];
        if (!(last in o)) throw new Error(`unknown parameter: ${path}`);
        o[last] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    }
    return params;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

// Dominant cycle length from the first autocorrelation peak of the series.
function period(a, sample) {
    const m = mean(a);
    const d = a.map((x) => x - m);
    const ac = (lag) => {
        let s = 0;
        for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag];
        return s;
    };
    const a0 = ac(0) || 1;
    let wentNegative = false;
    let best = null;
    for (let lag = 1; lag < d.length / 2; lag++) {
        const r = ac(lag) / a0;
        if (r < 0) wentNegative = true;
        else if (wentNegative && (best === null || r > best.r)) best = { lag, r };
        if (best && r < best.r - 0.05) break;
    }
    return best && best.r > 0.2 ? best.lag * sample : null;
}

function summarise(r) {
    const out = { seed: r.seed, steps: r.steps, extinct: r.extinct, stepsPerSec: r.stepsPerSec, genes: r.genes, terrain: r.terrain };
    for (const s of ['herbivore', 'carnivore', 'grass']) {
        const ser = r.series[s];
        const back = ser.slice(Math.floor(ser.length / 2));
        const m = mean(back);
        // mean and CV describe the second half (after any start-up wobble);
        // min is over the WHOLE run, opening included.
        out[s] = { mean: m, cv: m ? sd(back) / m : 0, min: ser.length ? Math.min(...ser) : 0, max: Math.max(...back, 0) };
    }
    out.period = period(r.series.carnivore.slice(Math.floor(r.series.carnivore.length / 4)), r.sample ?? 100);
    if (r.humans) {
        const ser = r.series.human;
        const back = ser.slice(Math.floor(ser.length / 2));
        out.humans = { ...r.humans, mean: mean(back), min: ser.length ? Math.min(...ser) : 0, max: Math.max(...ser, 0) };
    }
    return out;
}

function spark(a, width = 72) {
    const chars = ' ▁▂▃▄▅▆▇█';
    const stride = Math.max(1, Math.floor(a.length / width));
    const pts = a.filter((_, i) => i % stride === 0);
    const max = Math.max(1, ...pts);
    return pts.map((v) => chars[Math.round((v / max) * (chars.length - 1))]).join('');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const params = applySets(structuredClone(defaults), opts.sets);
    const workers = Math.min(availableParallelism(), opts.seeds.length);

    const queue = [...opts.seeds];
    const results = [];
    await Promise.all(Array.from({ length: workers }, async () => {
        while (queue.length) {
            const seed = queue.shift();
            const r = await new Promise((resolve, reject) => {
                const w = new Worker(new URL(import.meta.url), {
                    workerData: { params, seed, steps: opts.steps, sample: opts.sample, shock: opts.shock, aspect: opts.aspect },
                });
                w.once('message', resolve);
                w.once('error', reject);
            });
            r.sample = opts.sample;
            results.push(r);
        }
    }));
    results.sort((a, b) => a.seed - b.seed);
    const sums = results.map(summarise);

    if (opts.json) {
        console.log(JSON.stringify({ opts, summaries: sums }));
        return;
    }

    const f = (x, d = 0) => x.toFixed(d);
    console.log(`\n${opts.seeds.length} seeds × ${opts.steps} steps · aspect ${opts.aspect}${opts.sets.length ? '  ' + opts.sets.join(' ') : ''}${opts.shock ? `  shock ${opts.shock.fraction}@${opts.shock.at}` : ''}\n`);
    console.log('seed  result          herbivores (mean cv min)   carnivores (mean cv min)   grass   cycle   genes h(spd/sns) c(spd/sns)   steps/s');
    for (const s of sums) {
        const res = s.extinct ? `✗ ${s.extinct.species[0]}@${s.extinct.at}` : '✓ persisted';
        const g = s.genes;
        console.log(
            `${String(s.seed).padStart(4)}  ${res.padEnd(15)} ` +
            `${f(s.herbivore.mean).padStart(6)} ${f(s.herbivore.cv, 2)} ${String(s.herbivore.min).padStart(5)}        ` +
            `${f(s.carnivore.mean).padStart(6)} ${f(s.carnivore.cv, 2)} ${String(s.carnivore.min).padStart(5)}        ` +
            `${f(s.grass.mean, 2)}   ${(s.period ? f(s.period) : '—').padStart(5)}   ` +
            `${f(g.herbivore.speed, 2)}/${f(g.herbivore.sense, 2)} ${f(g.carnivore.speed, 2)}/${f(g.carnivore.sense, 2)}      ` +
            `${f(s.stepsPerSec)}`,
        );
        if (s.humans) {
            const h = s.humans;
            const culture = h.culture ? `culture: aggression ${f(h.culture.aggression, 2)}, sociality ${f(h.culture.sociality, 2)}` : '';
            console.log(h.gone
                ? `        people died out at step ${h.gone} (peak ${h.max}, ${h.founded} tribes founded)`
                : `        people ${f(h.mean).padStart(4)} (min ${h.min}, peak ${h.max}) · ${h.tribes} tribes alive of ${h.founded} founded · ${culture}`);
        }
        if (s.terrain) {
            const t = s.terrain;
            console.log(`        terrain: water ${f(100 * t.water)}% · cliffs ${f(100 * t.cliff)}% · regrowth ×${f(t.boost, 2)} on the land left`);
        }
        if (opts.spark) {
            const r = results.find((x) => x.seed === s.seed);
            console.log(`        h ${spark(r.series.herbivore)}`);
            console.log(`        c ${spark(r.series.carnivore)}`);
            if (s.humans) console.log(`        p ${spark(r.series.human)}`);
        }
    }
    const ok = sums.filter((s) => !s.extinct).length;
    const withPeople = sums.filter((s) => s.humans);
    const peopleOk = withPeople.filter((s) => !s.humans.gone).length;
    console.log(`\n${ok}/${sums.length} ecosystems persisted${withPeople.length ? ` · people survived in ${peopleOk}/${withPeople.length}` : ''} · median ${f(sums.map((s) => s.stepsPerSec).sort((a, b) => a - b)[Math.floor(sums.length / 2)])} steps/s per core\n`);
}
