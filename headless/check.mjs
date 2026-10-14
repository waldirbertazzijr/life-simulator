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
import { STATE, STATE_LABEL } from '../src/population.js';
import { SEASONS, WINTERS, winterOf } from '../src/calendar.js';

const KINDS = ['herbivore', 'carnivore', 'human'];

// ---- the actual run (worker side) ------------------------------------------

// The seasons, one by one (stage 4's calendar): each species' mean, lowest
// and last count, its births and deaths by cause, the tribes, and the
// winter's severity. Births are what the counts cannot otherwise explain.
function seasonBook(world) {
    const c = world.p.calendar;
    const length = c.day * c.seasonDays;
    const pops = { herbivore: world.herbivores, carnivore: world.carnivores, human: world.humans };
    const out = [];
    let cur = null;
    const open = (k) => {
        cur = { k, year: Math.floor(k / 4) + 1, season: k % 4, winter: winterOf(c, world.seed, Math.floor(k / 4) + 1), sum: {}, min: {}, end: {}, fat: {}, grass: 0, under: 0, low: 0, samples: 0, born: {}, died: {}, start: {}, deaths: {}, tribes: 0,
            store: 0, storeMax: 0, perMember: 0, carcasses: 0, carcassMax: 0, lying: 0 };
        for (const kind of KINDS) {
            cur.start[kind] = pops[kind].n;
            cur.deaths[kind] = { ...world.deaths[kind] };
            cur.sum[kind] = 0;
            cur.fat[kind] = 0;
            cur.min[kind] = Infinity;
        }
    };
    const close = () => {
        for (const kind of KINDS) {
            const died = {};
            let total = 0;
            for (const [cause, v] of Object.entries(world.deaths[kind])) {
                const d = v - (cur.deaths[kind][cause] ?? 0);
                if (d) died[cause] = d;
                total += d;
            }
            cur.died[kind] = died;
            cur.born[kind] = total + pops[kind].n - cur.start[kind];
            cur.end[kind] = pops[kind].n;
        }
        cur.tribes = world.tribes.length;
        delete cur.deaths;
        delete cur.start;
        out.push(cur);
    };
    open(0);
    return {
        // After each step.
        step() {
            const k = Math.floor(world.time / length);
            if (k !== cur.k) {
                close();
                open(k);
            }
        },
        sample() {
            cur.samples++;
            cur.grass += world.grass.mean();
            const h = world.herbivores;
            let under = 0;
            for (let i = 0; i < h.n; i++) under += world.grass.g[world.grass.index(h.x[i], h.y[i])];
            cur.under += h.n ? under / h.n : 0;
            // How high the grazers stand (0 the shore, 1 the summits): lower in winter.
            if (world.lowland) {
                let low = 0;
                for (let i = 0; i < h.n; i++) low += world.lowland[world.grass.index(h.x[i], h.y[i])];
                cur.low += h.n ? low / h.n : 0;
            }
            // The tribes' stores (mean a tribe, the largest, a member), and
            // the carcasses lying (how many, the most, their meat).
            let store = 0;
            let members = 0;
            for (const t of world.tribes) {
                store += t.store;
                members += t.members;
                if (t.store > cur.storeMax) cur.storeMax = t.store;
            }
            cur.store += world.tribes.length ? store / world.tribes.length : 0;
            cur.perMember += members ? store / members : 0;
            const n = world.carcasses.size;
            cur.carcasses += n;
            if (n > cur.carcassMax) cur.carcassMax = n;
            for (const cc of world.carcasses.values()) cur.lying += cc.meat;
            for (const kind of KINDS) {
                const pop = pops[kind];
                const v = pop.n;
                cur.sum[kind] += v;
                if (v < cur.min[kind]) cur.min[kind] = v;
                let fat = 0;
                if (pop.fat) for (let i = 0; i < v; i++) fat += pop.fat[i]; // (no fat before stage 4)
                cur.fat[kind] += v ? fat / v : 0;
            }
        },
        // The book, the season under way closed as it stands.
        done() {
            close();
            for (const s of out) {
                s.grass = s.samples ? s.grass / s.samples : 0;
                s.under = s.samples ? s.under / s.samples : 0;
                s.low = s.samples ? s.low / s.samples : 0;
                for (const key of ['store', 'perMember', 'carcasses', 'lying']) s[key] = s.samples ? s[key] / s.samples : 0;
                s.mean = {};
                for (const kind of KINDS) {
                    s.mean[kind] = s.samples ? s.sum[kind] / s.samples : s.end[kind];
                    s.fat[kind] = s.samples ? s.fat[kind] / s.samples : 0;
                }
            }
            return out.map(({ sum, ...s }) => s);
        },
    };
}

function runSeed({ params, seed, steps, sample, shock, aspect }) {
    const world = new World(params, { seed, aspect });
    const book = seasonBook(world);
    const series = { herbivore: [], carnivore: [], grass: [], human: [], tribes: [], carcasses: [] };
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
    const ends = { butchered: 0, used: 0, spoiled: 0 };
    // How lively a day is: adults' states by daylight (step by step), throws,
    // fights with strangers (a person taking one up), predators' chases; and
    // tribe-steps and predator-steps to make them rates.
    const lively = { states: new Array(STATE_LABEL.length).fill(0), throws: 0, fights: 0, chases: 0, tribeSteps: 0, predatorSteps: 0,
        into: { meat: 0, plant: 0, other: 0 }, killsFull: 0, killsShort: 0 };
    const carried = new Map(); // (a person's id → what it carries, by where it came from)
    const wrap = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
    let fighting = new Set();
    let fightingNow = new Set();
    let chasing = new Set();
    let chasingNow = new Set();
    const humanIds = new Set();
    const t0 = performance.now();

    for (let t = 1; t <= steps; t++) {
        if (shock && t === shock.at) {
            const h = world.herbivores;
            for (let i = 0; i < h.n; i++) if (world.rng.next() < shock.fraction) h.energy[i] = 0;
            h.compact();
        }
        world.step();
        book.step();
        // How carcasses end: cut up, or eaten to the bone ('used').
        for (const e of world.events) {
            if (e.type in ends) ends[e.type]++;
            else if (e.type === 'throw' || e.type === 'swing') lively.throws++;
        }
        lively.tribeSteps += world.tribes.length;
        lively.predatorSteps += world.carnivores.n;
        {
            const c = world.carnivores;
            chasingNow.clear();
            for (let i = 0; i < c.n; i++) {
                if (c.state[i] !== STATE.CHASING) continue;
                chasingNow.add(c.id[i]);
                if (!chasing.has(c.id[i])) lively.chases++;
            }
            [chasing, chasingNow] = [chasingNow, chasing];
        }
        if (hadHumans) {
            const pop = world.humans;
            const adult = world.p.human.maturity;
            const day = !world.night && !world.dusk;
            fightingNow.clear();
            let any = false;
            for (let i = 0; i < pop.n; i++) {
                if (day && pop.age[i] >= adult) lively.states[pop.state[i]]++;
                if (pop.state[i] === STATE.FIGHTING) any = true;
            }
            if (any) {
                humanIds.clear();
                for (let i = 0; i < pop.n; i++) humanIds.add(pop.id[i]);
                for (let i = 0; i < pop.n; i++) {
                    if (pop.state[i] !== STATE.FIGHTING || !humanIds.has(pop.focus[i])) continue;
                    fightingNow.add(pop.id[i]);
                    if (!fighting.has(pop.id[i])) lively.fights++;
                }
            }
            [fighting, fightingNow] = [fightingNow, fighting];
            // Food into the stores, by where it came from: what each person
            // carries is tallied by what it was doing as it grew (cutting a
            // kill: meat; gathering: plants; else: robbed, looted, taken),
            // and counted in as it is put down at its own camp. And the
            // grazers people killed with their store full, or not.
            const R = world.p.human.campRadius;
            for (let i = 0; i < pop.n; i++) {
                let f = carried.get(pop.id[i]);
                if (f === undefined) carried.set(pop.id[i], (f = { c: pop.carry[i], meat: 0, plant: 0, other: 0 }));
                const dc = pop.carry[i] - f.c;
                if (dc > 0) {
                    const s = pop.state[i];
                    if (s === STATE.BUTCHERING) f.meat += dc;
                    else if (s === STATE.GATHERING) f.plant += dc;
                    else f.other += dc;
                } else if (dc < 0 && f.c > 0) {
                    const k = -dc / f.c;
                    const t = world.tribeById.get(pop.tribe[i]);
                    if (t && Math.hypot(wrap(t.camp.x - pop.x[i], world.width), wrap(t.camp.y - pop.y[i], world.height)) < R) {
                        lively.into.meat += f.meat * k;
                        lively.into.plant += f.plant * k;
                        lively.into.other += f.other * k;
                    }
                    f.meat -= f.meat * k;
                    f.plant -= f.plant * k;
                    f.other -= f.other * k;
                }
                f.c = pop.carry[i];
            }
            for (const e of world.events) {
                if (e.type !== 'death' || e.cause !== 'hunted' || !e.by) continue;
                const found = world.find(e.by);
                const t = found && found.kind === 'human' ? world.tribeById.get(found.pop.tribe[found.i]) : null;
                if (t) lively[t.store >= world.p.human.storeTarget * t.members ? 'killsFull' : 'killsShort']++;
            }
        }
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
            book.sample();
            series.herbivore.push(world.herbivores.n);
            series.carnivore.push(world.carnivores.n);
            series.grass.push(+world.grass.mean().toFixed(3));
            series.human.push(world.humans.n);
            series.tribes.push(world.tribes.length);
            series.carcasses.push(world.carcasses.size);
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
        pace: { ...paceSummary(world, start, raids), ends, lively },
        seasons: book.done(),
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
        else if (a === '--merge') opts.merge = next();
        else if (a === '--workers') opts.workers = +next();
        else if (a === '--trace') opts.trace = true;
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
    const out = { seed: r.seed, steps: r.steps, extinct: r.extinct, stepsPerSec: r.stepsPerSec, genes: r.genes, terrain: r.terrain, biomes: r.biomes, items: r.items, pace: r.pace, seasons: r.seasons };
    for (const s of ['herbivore', 'carnivore', 'grass', 'human', 'tribes', 'carcasses']) {
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

// The seasons over all the seeds: each species' mean count by season (and
// the lowest of any season), summer against winter, births by season, deaths
// by cause a year and in each kind of winter, and the tribes year by year.
// Full seasons only (the last, if cut short, is left out), and the first
// year apart from the rest (it starts from the warm start).
function seasonReport(sums, f) {
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    // Full seasons only: as many samples as the most any season has.
    const most = Math.max(...sums.flatMap((s) => (s.seasons ?? []).map((x) => x.samples)));
    const book = sums.map((s) => ({ seed: s.seed, seasons: (s.seasons ?? []).filter((x) => x.samples >= most) }));
    const all = book.flatMap((b) => b.seasons);
    if (!all.length) return;
    const later = all.filter((x) => x.year > 1);
    const pick = later.length ? later : all;
    const kinds = KINDS.filter((k) => all.some((x) => x.mean[k] > 0));
    const short = { herbivore: 'herbivores', carnivore: 'carnivores', human: 'people' };
    const years = Math.max(...all.map((x) => x.year));
    console.log(`\nseasons (means over ${pick === later ? 'years 2+' : 'all years'}; ${sums.length} seeds, ${years} years, full seasons only):`);
    for (const k of kinds) {
        const means = SEASONS.map((_, s) => avg(pick.filter((x) => x.season === s).map((x) => x.mean[k])));
        const lows = SEASONS.map((_, s) => Math.min(...all.filter((x) => x.season === s).map((x) => x.min[k])));
        // Winter against the summer before it, seed by seed.
        const ratios = [];
        for (const b of book) {
            for (const su of b.seasons.filter((x) => x.season === 1 && x.year > 1)) {
                const wi = b.seasons.find((x) => x.year === su.year && x.season === 3);
                if (wi && su.mean[k] > 0) ratios.push(wi.mean[k] / su.mean[k]);
            }
        }
        console.log(`  ${short[k].padEnd(10)} mean ${SEASONS.map((n, s) => `${n} ${f(means[s])}`).join(' · ')} · winter/summer ${f(avg(ratios), 2)}` +
            ` (lowest ${f(ratios.length ? Math.min(...ratios) : 0, 2)}) · lowest count ${SEASONS.map((n, s) => `${n.slice(0, 3)} ${lows[s] === Infinity ? '—' : lows[s]}`).join(' ')}`);
        const births = SEASONS.map((_, s) => avg(pick.filter((x) => x.season === s).map((x) => x.born[k])));
        console.log(`             births a season ${SEASONS.map((n, s) => `${n} ${f(births[s], 1)}`).join(' · ')}`);
        const causes = {};
        for (const x of all) for (const [c, v] of Object.entries(x.died[k])) causes[c] = (causes[c] ?? 0) + v;
        const seedYears = all.length / 4 || 1;
        console.log(`             deaths a year ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${f(v / seedYears, 1)}`).join(', ') || 'none'}`);
        const winters = WINTERS.map((name, w) => {
            const xs = all.filter((x) => x.season === 3 && x.winter === w);
            if (!xs.length) return null;
            const by = {};
            for (const x of xs) for (const [c, v] of Object.entries(x.died[k])) by[c] = (by[c] ?? 0) + v / xs.length;
            const kept = avg(xs.map((x) => (x.mean[k] > 0 ? x.end[k] / x.mean[k] : 1)));
            return `${name} ×${xs.length}: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${f(v, 1)}`).join(', ') || 'none'} (end/mean ${f(kept, 2)})`;
        }).filter(Boolean);
        console.log(`             deaths a winter ${winters.join(' · ')}`);
    }
    if (pick.some((x) => x.low > 0)) {
        const at = (key) => SEASONS.map((n, s) => `${n} ${f(avg(pick.filter((x) => x.season === s).map((x) => x[key])), key === "low" ? 3 : 2)}`).join(" · ");
        console.log(`  grazers stand at a height (0 the shore, 1 the summits) of ${at("low")}; the land's grass ${at("grass")}`);
    }
    if (kinds.includes('human')) {
        const line = [];
        for (let y = 1; y <= years; y++) {
            const ends = book.map((b) => b.seasons.filter((x) => x.year === y).at(-1)).filter((x) => x && x.season === 3);
            if (ends.length) line.push(`y${y} ${f(avg(ends.map((x) => x.tribes)), 1)} (${Math.min(...ends.map((x) => x.tribes))}) ${f(avg(ends.map((x) => x.end.human)))}p`);
        }
        console.log(`  tribes at each year's end, mean (lowest), and people: ${line.join(' · ')}`);
        // Year by year, over the seeds: people born, the stores (mean a
        // tribe; the largest any tribe held), and the carcasses lying (mean;
        // the most at any sample; the meat in them, mean).
        const yearly = [];
        for (let y = 1; y <= years; y++) {
            const xs = all.filter((x) => x.year === y);
            if (xs.length < 4 * book.length) continue;
            const born = xs.reduce((s, x) => s + (x.born.human ?? 0), 0) / book.length;
            yearly.push(`y${y} born ${f(born)} · store ${f(avg(xs.map((x) => x.store)))} (max ${f(Math.max(...xs.map((x) => x.storeMax)))}, ${f(avg(xs.map((x) => x.perMember)))}/member)` +
                ` · carcasses ${f(avg(xs.map((x) => x.carcasses)), 1)} (max ${Math.max(...xs.map((x) => x.carcassMax))}, meat ${f(avg(xs.map((x) => x.lying)))})`);
        }
        if (yearly.length) console.log(`  year by year, a seed:\n    ${yearly.join('\n    ')}`);
    }
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
    if (opts.merge) return merged(opts);
    const params = applySets(structuredClone(defaults), opts.sets);
    const workers = Math.min(opts.workers || availableParallelism(), opts.seeds.length);

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
    report(opts, sums, results);
}

// Runs saved with --json (e.g. a few containers at once, each on some of
// the seeds), reported together: --merge a.json,b.json.
async function merged(opts) {
    const { readFileSync } = await import('node:fs');
    const sums = [];
    let first = null;
    for (const file of opts.merge.split(',')) {
        const run = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)); // (the last line: make echoes its command first)
        first ??= run.opts;
        sums.push(...run.summaries);
    }
    sums.sort((a, b) => a.seed - b.seed);
    report({ ...first, seeds: sums.map((s) => s.seed), spark: false, trace: opts.trace }, sums, []);
}

function report(opts, sums, results) {
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
        if (opts.trace && s.seasons) {
            // Season by season: each species' mean count (lowest), mean fat,
            // births, and deaths by cause.
            const deaths = (d) => Object.entries(d).map(([c, v]) => `${c.slice(0, 5)} ${v}`).join(' ');
            for (const x of s.seasons) {
                const part = (k) => `${f(x.mean[k])} (${x.min[k] === Infinity ? '—' : x.min[k]}) fat ${f(x.fat[k])} +${x.born[k]} −[${deaths(x.died[k])}]`;
                console.log(`        y${x.year} ${SEASONS[x.season].slice(0, 3)}${x.season === 3 ? `(${WINTERS[x.winter]})` : ''}  g ${f(x.grass, 2)}/${f(x.under, 2)} hgt ${f(x.low, 3)}  h ${part('herbivore')} | c ${part('carnivore')}` +
                    (s.humans ? ` | p ${part('human')} t${x.tribes}` : ''));
            }
        }
    }
    if (sums.some((s) => s.seasons?.length)) seasonReport(sums, f);
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
        const lively = paced.filter((s) => s.pace.lively);
        if (lively.length && withPeople.length) {
            // A lively day? Adults' daylight steps by state; people's hunts
            // (grazers killed) and throws a tribe a day; raids set off,
            // fights with strangers taken up and people killed, a year;
            // predators' kills a day (all of them, and each) and chases each.
            const DAY = defaults.calendar.day;
            const YEAR = DAY * defaults.calendar.seasonDays * 4;
            const mm = (get) => mean(lively.map(get));
            const states = new Array(STATE_LABEL.length).fill(0);
            for (const s of lively) {
                const tot = s.pace.lively.states.reduce((a, b) => a + b, 0) || 1;
                s.pace.lively.states.forEach((v, k) => { states[k] += v / tot / lively.length; });
            }
            const shares = states.map((v, k) => [STATE_LABEL[k], v]).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
            console.log(`lively: adults by daylight ${shares.map(([k, v]) => `${k} ${f(100 * v)}%`).join(', ')}`);
            const tribeDays = (s) => s.pace.lively.tribeSteps / DAY || 1;
            const years = (s) => s.pace.steps / YEAR;
            const eaten = (s) => (s.pace.herbivore.died.eaten ?? 0) + (s.pace.human.died.eaten ?? 0);
            console.log(`        a tribe a day: hunts (grazers killed) ${f(mm((s) => (s.pace.herbivore.died.hunted ?? 0) / tribeDays(s)), 2)} · throws ${f(mm((s) => s.pace.lively.throws / tribeDays(s)), 1)}` +
                ` · a year: raids ${f(mm((s) => s.pace.raids / years(s)), 1)} · fights taken up ${f(mm((s) => s.pace.lively.fights / years(s)), 1)} · people killed ${f(mm((s) => (s.pace.human.died.killed ?? 0) / years(s)), 1)}` +
                ` (a tribe a year: raids ${f(mm((s) => s.pace.raids / (tribeDays(s) * DAY / YEAR)), 1)}, fights ${f(mm((s) => s.pace.lively.fights / (tribeDays(s) * DAY / YEAR)), 1)})`);
            const into = (k) => f(mm((s) => (s.pace.lively.into?.[k] ?? 0) / tribeDays(s)));
            const full = mm((s) => s.pace.lively.killsFull ?? 0);
            const short = mm((s) => s.pace.lively.killsShort ?? 0);
            console.log(`        into the store a tribe a day: meat ${into('meat')} · plants ${into('plant')} · robbed, looted, taken ${into('other')}` +
                ` · grazers killed with the store full ${f((100 * full) / (full + short || 1))}%`);
            console.log(`        predators: kills a day ${f(mm((s) => eaten(s) / (s.pace.steps / DAY)), 1)} (each ${f(mm((s) => eaten(s) / (s.pace.lively.predatorSteps / DAY || 1)), 3)})` +
                ` · chases each a day ${f(mm((s) => s.pace.lively.chases / (s.pace.lively.predatorSteps / DAY || 1)), 2)}`);
        }
        if (paced.some((s) => s.pace.ends)) {
            const end = (k) => f(m((s) => per(s, s.pace.ends?.[k] ?? 0)), 1);
            console.log(`        carcasses ended: cut up ${end('butchered')} · eaten to the bone ${end('used')} · spoiled ${end('spoiled')}` +
                ` · lying ${f(m((s) => s.carcasses?.mean ?? 0), 1)} (2nd half; most ${Math.max(...paced.map((s) => s.carcasses?.max ?? 0))})`);
        }
    }
    console.log(`\n${ok}/${sums.length} ecosystems persisted${withPeople.length ? ` · people survived in ${peopleOk}/${withPeople.length}` : ''} · median ${f(sums.map((s) => s.stepsPerSec).sort((a, b) => a - b)[Math.floor(sums.length / 2)])} steps/s per core\n`);
}
