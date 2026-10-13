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
//   make check ARGS="--set biomes.cover=true"   # forest hides grazers from hunters
//   make check ARGS="--spark"                   # print population sparklines
//   make check ARGS="--json"                    # machine-readable output
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { ITEM_KINDS } from '../src/items.js';

// ---- the actual run (worker side) ------------------------------------------
function runSeed({ params, seed, steps, sample, shock, aspect }) {
    const world = new World(params, { seed, aspect });
    const series = { herbivore: [], carnivore: [], grass: [], human: [], tribes: [] };
    // With biomes: where the herds graze, summed over the samples.
    const biomeOf = world.terrain ? world.terrain.biomeGrid : null;
    const herds = biomeOf ? new Array(world.terrain.biomes.length).fill(0) : null;
    let extinct = null;
    let humansGone = null;
    const hadHumans = world.humans.n > 0;
    // For the pace: how many each species started with, and raids set off
    // (a person taking up a raid goal: the ids on a raid, step to step).
    const start = { herbivore: world.herbivores.n, carnivore: world.carnivores.n, human: world.humans.n };
    let raids = 0;
    let raiding = new Set();
    let raidingNow = new Set();
    const t0 = performance.now();

    for (let t = 1; t <= steps; t++) {
        if (shock && t === shock.at) {
            const h = world.herbivores;
            for (let i = 0; i < h.n; i++) if (world.rng.next() < shock.fraction) h.energy[i] = 0;
            h.compact();
        }
        world.step();
        if (hadHumans) {
            const pop = world.humans;
            raidingNow.clear();
            for (let i = 0; i < pop.n; i++) {
                if (pop.goal[i] === 0) continue;
                raidingNow.add(pop.id[i]);
                if (!raiding.has(pop.id[i])) raids++;
            }
            [raiding, raidingNow] = [raidingNow, raiding];
        }
        if (t % sample === 0) {
            series.herbivore.push(world.herbivores.n);
            series.carnivore.push(world.carnivores.n);
            series.grass.push(+world.grass.mean().toFixed(3));
            series.human.push(world.humans.n);
            series.tribes.push(world.tribes.length);
            if (herds) {
                const h = world.herbivores;
                for (let i = 0; i < h.n; i++) herds[biomeOf[world.grass.index(h.x[i], h.y[i])]]++;
            }
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
        biomes: herds ? biomeSummary(world.terrain, herds) : null,
        humans: hadHumans ? {
            gone: humansGone,
            founded: world.nextTribeId - 1,
            tribes: world.tribes.length,
            culture: people ? { aggression: aggression / people, sociality: sociality / people } : null,
            died: world.deaths.human,
            hunted: world.deaths.herbivore.hunted ?? 0,
        } : null,
        items: world.itemsOn ? itemSummary(world) : null,
        pace: paceSummary(world, start, raids),
    };
}

// The pace of life over the run: births and deaths (by cause) of each
// species, tribes split, raids set off, items made and errands run. Births
// are what the counts cannot otherwise explain: died + alive now − at start.
function paceSummary(world, start, raids) {
    const out = { steps: world.time };
    for (const [kind, pop] of [['herbivore', world.herbivores], ['carnivore', world.carnivores], ['human', world.humans]]) {
        const died = world.deaths[kind];
        const deaths = Object.values(died).reduce((a, b) => a + b, 0);
        out[kind] = { births: deaths + pop.n - start[kind], deaths, died: { ...died } };
    }
    out.splits = world.nextTribeId - 1 - (world.p.human.enabled ? world.p.human.tribes : 0);
    out.raids = raids;
    if (world.itemsOn) {
        const s = world.itemStats;
        out.crafted = s.crafted.reduce((a, b) => a + b, 0);
        out.errands = s.errands.wood + s.errands.flint;
        out.butchered = s.butchered;
    }
    return out;
}

// With items (src/items.js): what was made, broken and lost; the legends and
// their deeds; what is in hand now, by kind and rarity, and by the culture
// of the tribes that hold it; and people's deaths with a kill to butcher.
function itemSummary(world) {
    const s = world.itemStats;
    const now = {}; // kind → [normal, rare, legendary]
    const byCulture = { aggressive: {}, social: {} }; // kinds held by the people of tribes more aggressive than social, and the rest
    const pop = world.humans;
    let adults = 0;
    let armed = 0;
    let tooled = 0;
    for (const item of world.items.values()) {
        const k = ITEM_KINDS[item.kind];
        (now[k] ??= [0, 0, 0])[item.rarity]++;
    }
    for (let i = 0; i < pop.n; i++) {
        if (pop.age[i] < world.p.human.maturity) continue;
        adults++;
        const t = world.tribeById.get(pop.tribe[i]);
        for (const id of [pop.weapon[i], pop.tool[i]]) {
            if (!id) continue;
            const k = ITEM_KINDS[world.items.get(id).kind];
            const c = t.aggression > t.sociality ? byCulture.aggressive : byCulture.social;
            c[k] = (c[k] ?? 0) + 1;
        }
        if (pop.weapon[i]) armed++;
        if (pop.tool[i]) tooled++;
    }
    const legends = [...world.items.values()].filter((it) => it.legend).map((it) => ({ name: it.legend.name, kind: ITEM_KINDS[it.kind], deed: it.legend.deed }));
    return {
        crafted: Object.fromEntries(ITEM_KINDS.slice(1).map((k, j) => [k, s.crafted[j + 1]])),
        broke: s.broke.reduce((a, b) => a + b, 0),
        rare: s.rare, vanished: s.vanished, picked: s.picked, inherited: s.inherited, raided: s.raided,
        butchered: s.butchered, butcherDeaths: s.butcherDeaths, errands: s.errands,
        deeds: s.legends, legends, now, byCulture,
        armed: adults ? armed / adults : 0, tooled: adults ? tooled / adults : 0,
    };
}

// Each biome's share of the world, and of the herbivores counted in it.
function biomeSummary(terrain, herds) {
    const shares = terrain.biomeShares();
    const total = herds.reduce((s, v) => s + v, 0) || 1;
    return terrain.biomes.map((b, k) => ({ name: b.name, share: shares[k], herds: herds[k] / total }));
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
    const out = { seed: r.seed, steps: r.steps, extinct: r.extinct, stepsPerSec: r.stepsPerSec, genes: r.genes, terrain: r.terrain, biomes: r.biomes, items: r.items, pace: r.pace };
    for (const s of ['herbivore', 'carnivore', 'grass', 'human', 'tribes']) {
        const ser = r.series[s];
        const back = ser.slice(Math.floor(ser.length / 2));
        const m = mean(back);
        // mean and CV describe the second half (after any start-up wobble);
        // min is over the WHOLE run, opening included; `all` is the mean of
        // the whole run (for births and deaths a head).
        out[s] = { mean: m, cv: m ? sd(back) / m : 0, min: ser.length ? Math.min(...ser) : 0, max: Math.max(...back, 0), all: mean(ser) };
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
        if (s.items) {
            const it = s.items;
            const kinds = Object.entries(it.now).map(([k, [n, r, l]]) => `${k} ${n}/${r}/${l}`).join(' · ');
            const deeds = Object.entries(it.deeds).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
            const died = Object.entries(it.butcherDeaths).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
            console.log(`        items now (normal/rare/legendary): ${kinds} · adults armed ${f(100 * it.armed)}%, with a tool ${f(100 * it.tooled)}%`);
            console.log(`        made ${Object.values(it.crafted).reduce((a, b) => a + b, 0)} (${it.rare} rare), broke ${it.broke}, lost ${it.vanished} · legends: ${deeds} · deaths with a kill to butcher: ${died} (eaten in all: ${s.humans?.died?.eaten ?? 0})`);
        }
        if (s.pace) {
            const p = s.pace;
            const per = (v) => f((v * 10000) / p.steps, 1);
            console.log(`        pace /10k steps: herbivores born ${per(p.herbivore.births)} · carnivores born ${per(p.carnivore.births)}` +
                (s.humans ? ` · people born ${per(p.human.births)}, died ${per(p.human.deaths)} · tribes ${f(s.tribes.mean, 1)} (2nd half) · ` +
                    `splits ${per(p.splits)}, raids ${per(p.raids)}${p.crafted !== undefined ? `, crafted ${per(p.crafted)}, errands ${per(p.errands)}` : ''}` : ''));
        }
        if (s.terrain) {
            const t = s.terrain;
            console.log(`        terrain: water ${f(100 * t.water)}% · cliffs ${f(100 * t.cliff)}% · regrowth ×${f(t.boost, 2)} on the land left`);
        }
        if (s.biomes) {
            // Share of the world's patches, and (in brackets) of the herbivores found there.
            const land = s.biomes.filter((b) => b.name !== 'water');
            console.log(`        biomes: ${land.map((b) => `${b.name} ${f(100 * b.share)}% (${f(100 * b.herds)}%)`).join(' · ')}`);
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
    // Means and lows over the seeds, for comparing runs.
    const avg = (get) => mean(sums.map(get));
    const low = (get) => Math.min(...sums.map(get));
    console.log(`\nmeans over seeds: herbivores ${f(avg((s) => s.herbivore.mean))} (lowest ${low((s) => s.herbivore.min)}) · ` +
        `carnivores ${f(avg((s) => s.carnivore.mean))} (lowest ${low((s) => s.carnivore.min)})` +
        (withPeople.length ? ` · people ${f(avg((s) => s.humans?.mean ?? 0))} (lowest ${low((s) => s.humans?.min ?? 0)}) · ` +
            `grazers hunted ${f(avg((s) => s.humans?.hunted ?? 0))} · people eaten ${f(avg((s) => s.humans?.died?.eaten ?? 0))}` : ''));
    const withItems = sums.filter((s) => s.items);
    if (withItems.length) {
        const deeds = {};
        const kinds = {};
        const culture = { aggressive: {}, social: {} };
        let atKills = 0;
        for (const s of withItems) {
            for (const [k, v] of Object.entries(s.items.deeds)) deeds[k] = (deeds[k] ?? 0) + v;
            for (const [k, v] of Object.entries(s.items.now)) kinds[k] = (kinds[k] ?? [0, 0, 0]).map((x, j) => x + v[j]);
            for (const c of ['aggressive', 'social']) for (const [k, v] of Object.entries(s.items.byCulture[c])) culture[c][k] = (culture[c][k] ?? 0) + v;
            atKills += s.items.butcherDeaths.eaten ?? 0;
        }
        const per = (v) => f(v / withItems.length, 1);
        const share = (o) => {
            const tot = Object.values(o).reduce((a, b) => a + b, 0) || 1;
            return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f(100 * v / tot)}%`).join(', ');
        };
        console.log(`items, a seed on average: legends ${per(Object.values(deeds).reduce((a, b) => a + b, 0))} ` +
            `(${Object.entries(deeds).map(([k, v]) => `${k} ${per(v)}`).join(', ')}) · in the world at the end (normal/rare/legendary): ` +
            Object.entries(kinds).map(([k, v]) => `${k} ${v.map(per).join('/')}`).join(' · '));
        console.log(`        held in aggressive tribes: ${share(culture.aggressive)} · in social tribes: ${share(culture.social)} · ` +
            `eaten with a kill to butcher ${per(atKills)} a seed · adults armed ${f(100 * avg((s) => s.items.armed))}%`);
    }
    // The pace of life, per 10k steps, as means over the seeds: births and
    // deaths by cause, and the same a head (÷ the whole run's mean count).
    const paced = sums.filter((s) => s.pace);
    if (paced.length) {
        const per = (s, v) => (v * 10000) / s.pace.steps;
        const m = (get) => mean(paced.map(get));
        const line = (kind, series) => {
            const causes = {};
            for (const s of paced) for (const [c, v] of Object.entries(s.pace[kind].died)) causes[c] = (causes[c] ?? 0) + per(s, v) / paced.length;
            const head = (get) => m((s) => (s[series].all ? per(s, get(s)) / s[series].all : 0));
            return `born ${f(m((s) => per(s, s.pace[kind].births)), 1)} (${f(head((s) => s.pace[kind].births), 3)} a head), ` +
                `died ${f(m((s) => per(s, s.pace[kind].deaths)), 1)} (${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${f(v, 1)}`).join(', ')})`;
        };
        console.log(`pace, per 10k steps: herbivores ${line('herbivore', 'herbivore')}`);
        console.log(`        carnivores ${line('carnivore', 'carnivore')}`);
        if (withPeople.length) {
            console.log(`        people ${line('human', 'human')}`);
            console.log(`        tribes ${f(m((s) => s.tribes.mean), 1)} (2nd half; lowest seed ${f(Math.min(...paced.map((s) => s.tribes.mean)), 1)}, at the end ${f(m((s) => s.humans.tribes), 1)}) · ` +
                `splits ${f(m((s) => per(s, s.pace.splits)), 2)} · raids ${f(m((s) => per(s, s.pace.raids)), 1)}` +
                (withItems.length ? ` · crafted ${f(m((s) => per(s, s.pace.crafted ?? 0)), 1)} · errands ${f(m((s) => per(s, s.pace.errands ?? 0)), 1)} · butchered ${f(m((s) => per(s, s.pace.butchered ?? 0)), 1)}` : ''));
        }
    }
    console.log(`\n${ok}/${sums.length} ecosystems persisted${withPeople.length ? ` · people survived in ${peopleOk}/${withPeople.length}` : ''} · median ${f(sums.map((s) => s.stepsPerSec).sort((a, b) => a - b)[Math.floor(sums.length / 2)])} steps/s per core\n`);
}
