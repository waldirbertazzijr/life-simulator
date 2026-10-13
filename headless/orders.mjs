// The orders check (spec §11, package 4): does the ecosystem stand up to a
// leader's orders? Every tribe gets a random standing order every 1500–4500
// steps, each on its own schedule, through orders.js's issueOrder, as the
// player would give them (but here to every tribe, all the time):
//
//   hunt     Hunt here, at a random spot on the land within --reach of its camp
//   gather   Gather food
//   defend   Defend camp
//   move     Move camp, to a random valid site within --reach (refused when
//            none is found, or while the camp's last move is too recent)
//   wood     Gather wood    (only with --kinds: the default is the four above)
//   flint    Gather flint
//
// (--reach is 300 by default, about as far as a daughter tribe settles.)
// Gather food, wood and flint and Defend camp are set aside while a tribe is
// hungry (orders.js): the table says how often orders were heeded.
//
// The orders' random numbers are the check's own, never the world's. Each
// seed is also run without orders, the same world, for comparison. It fails
// (exit code 1) if anything died out with orders: grazers, predators, or
// the people.
//
//   make orders                                    # seeds 1-20 × 150k steps
//   make orders ARGS="--seeds 73-92 --steps 300000 --reach 800"
//   make orders ARGS="--set orders.huntRange=60"
//   make orders ARGS="--kinds defend,gather"     # only some kinds of order
//   make orders ARGS="--kinds hunt,gather,defend,move,wood,flint"   # all of them
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { setParam } from '../src/sim.js';
import { campSite } from '../src/humans.js';
import { issueOrder, hungry, setAside } from '../src/orders.js';
import { createRng } from '../src/rng.js';

const KINDS = ['hunt', 'gather', 'defend', 'move'];
const EVERY = [1500, 4500]; // steps between a tribe's orders
const TRIES = 40;           // random spots tried for a hunt or a new camp
const FULL = [5, 10, 15, 20, 30]; // store a member: how often a tribe holds at least this much

const wrapPos = (v, size) => ((v % size) + size) % size;

// A random spot within `reach` of the tribe's camp that passes `ok`, or the
// last one tried.
function spotNear(world, tribe, reach, rng, ok) {
    let spot = null;
    for (let k = 0; k < TRIES; k++) {
        const r = reach * Math.sqrt(rng.next());
        const a = rng.next() * Math.PI * 2;
        spot = { x: wrapPos(tribe.camp.x + Math.cos(a) * r, world.width), y: wrapPos(tribe.camp.y + Math.sin(a) * r, world.height) };
        if (ok(spot)) break;
    }
    return spot;
}

// ---- one run (worker side) -----------------------------------------------------------

function runSeed({ params, seed, steps, sample, orders, reach, kinds }) {
    const world = new World(params, { seed, aspect: 1.6 });
    const T = world.terrain;
    const rng = createRng(seed * 7919 + 101); // the check's own
    const next = new Map();                   // tribe id → when its next order comes
    const given = { hunt: 0, gather: 0, defend: 0, move: 0, wood: 0, flint: 0 };
    const refused = {};
    const series = { herbivore: [], carnivore: [], human: [] };
    let extinct = null;
    let humansGone = null;
    let births = 0;
    const born = new Map(); // tribe id → its births counted so far
    let tribeSteps = 0;
    let fedSteps = 0;
    let orderedSteps = 0;
    let heededSteps = 0;
    const full = FULL.map(() => 0);
    const t0 = performance.now();
    const land = ({ x, y }) => T === null || T.spawnable(x, y);
    const site = ({ x, y }) => T === null || campSite(world, x, y) > -Infinity;

    for (let t = 1; t <= steps; t++) {
        if (orders) {
            for (const tribe of world.tribes) {
                let due = next.get(tribe.id);
                if (due === undefined) next.set(tribe.id, (due = world.time + rng.next() * EVERY[1]));
                if (world.time < due) continue;
                next.set(tribe.id, world.time + EVERY[0] + rng.next() * (EVERY[1] - EVERY[0]));
                const kind = kinds[Math.floor(rng.next() * kinds.length)];
                const spot = kind === 'hunt' ? spotNear(world, tribe, reach, rng, land)
                    : kind === 'move' ? spotNear(world, tribe, reach, rng, site)
                    : tribe.camp;
                if (issueOrder(world, tribe, { kind, x: spot.x, y: spot.y })) given[kind]++;
                else {
                    const why = world.events.at(-1).reason;
                    refused[why] = (refused[why] ?? 0) + 1;
                }
            }
        }
        world.step();
        for (const tribe of world.tribes) {
            births += tribe.births - (born.get(tribe.id) ?? 0);
            born.set(tribe.id, tribe.births);
            // How often a tribe is fed enough to heed an order (orders.js),
            // and how full its store is, a member, at the lines in FULL.
            const each = tribe.store / Math.max(1, tribe.members);
            const fed = !hungry(params, tribe);
            tribeSteps++;
            if (fed) fedSteps++;
            if (tribe.order !== null) {
                orderedSteps++;
                if (!setAside(params, tribe)) heededSteps++;
            }
            for (let k = 0; k < FULL.length; k++) if (each >= FULL[k]) full[k]++;
        }
        if (t % sample === 0) {
            series.herbivore.push(world.herbivores.n);
            series.carnivore.push(world.carnivores.n);
            series.human.push(world.humans.n);
        }
        if (humansGone === null && world.humans.n === 0) humansGone = t;
        if (world.herbivores.n === 0 || world.carnivores.n === 0) {
            extinct = { species: world.herbivores.n === 0 ? 'herbivore' : 'carnivore', at: t };
            break;
        }
    }
    return {
        seed,
        orders,
        steps: world.time,
        extinct,
        humansGone,
        series,
        founded: world.nextTribeId - 1,
        alive: world.tribes.length,
        starved: world.deaths.human.starvation ?? 0,
        births,
        died: world.deaths.human,
        hunted: world.deaths.herbivore.hunted ?? 0,
        given,
        refused,
        fed: fedSteps / (tribeSteps || 1),        // share of the time a tribe could heed an order
        heeded: heededSteps / (orderedSteps || 1), // share of the time under an order that it did
        full: full.map((v) => v / (tribeSteps || 1)),
        stepsPerSec: world.time / ((performance.now() - t0) / 1000),
    };
}

// ---- reporting (main thread) -------------------------------------------------------

function parseArgs(argv) {
    const opts = { seeds: Array.from({ length: 20 }, (_, k) => k + 1), steps: 150000, sample: 100, reach: 300, kinds: KINDS, sets: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--seeds') {
            const v = next();
            const m = v.match(/^(\d+)-(\d+)$/);
            opts.seeds = m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, k) => +m[1] + k) : v.split(',').map(Number);
        } else if (a === '--steps') opts.steps = +next();
        else if (a === '--sample') opts.sample = +next();
        else if (a === '--reach') opts.reach = +next();
        else if (a === '--kinds') opts.kinds = next().split(',');
        else if (a === '--set') opts.sets.push(next());
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

// Mean and CV over the second half (after the opening), lowest over the whole run.
function stats(ser) {
    const back = ser.slice(Math.floor(ser.length / 2));
    const m = mean(back);
    return { mean: m, cv: m ? sd(back) / m : 0, min: ser.length ? Math.min(...ser) : 0 };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const params = structuredClone(defaults);
    for (const s of opts.sets) {
        const [path, raw] = s.split('=');
        setParam(params, path, raw === 'true' ? true : raw === 'false' ? false : Number(raw));
    }
    const jobs = opts.seeds.flatMap((seed) => [true, false].map((orders) => ({ seed, orders })));
    const workers = Math.min(availableParallelism(), jobs.length);
    const results = [];
    await Promise.all(Array.from({ length: workers }, async () => {
        while (jobs.length) {
            const { seed, orders } = jobs.shift();
            results.push(await new Promise((resolve, reject) => {
                const w = new Worker(new URL(import.meta.url), {
                    workerData: { params, seed, steps: opts.steps, sample: opts.sample, orders, reach: opts.reach, kinds: opts.kinds },
                });
                w.once('message', resolve);
                w.once('error', reject);
            }));
        }
    }));

    const f = (x, d = 0) => x.toFixed(d);
    const pad = (s, n) => String(s).padStart(n);
    console.log(`\n${opts.seeds.length} seeds × ${opts.steps} steps · each tribe a random order (${opts.kinds.join(', ')}) every ${EVERY[0]}–${EVERY[1]} steps, within ${opts.reach} of its camp${opts.sets.length ? '  ' + opts.sets.join(' ') : ''}\n`);
    console.log('seed  run     result         herbivores          carnivores        people        tribes    people   grazers   orders given                       refused');
    console.log('                             mean   cv   min     mean  cv   min    mean   min    alive/all starved  hunted    hunt gath defd move wood flnt');
    const rows = { true: [], false: [] };
    for (const seed of opts.seeds) {
        for (const orders of [true, false]) {
            const r = results.find((x) => x.seed === seed && x.orders === orders);
            const h = stats(r.series.herbivore);
            const c = stats(r.series.carnivore);
            const p = stats(r.series.human);
            rows[orders].push({ r, h, c, p });
            const res = r.extinct ? `✗ ${r.extinct.species}s @${r.extinct.at}` : r.humansGone ? `✗ people @${r.humansGone}` : '✓';
            const g = r.given;
            const why = Object.entries(r.refused).map(([k, v]) => `${v} ${k}`).join(', ');
            console.log(
                `${orders ? pad(seed, 4) : '    '}  ${(orders ? 'orders' : 'none').padEnd(6)}  ${res.padEnd(13)} ` +
                `${pad(f(h.mean), 5)} ${f(h.cv, 2)} ${pad(h.min, 5)}    ${pad(f(c.mean), 4)} ${f(c.cv, 2)} ${pad(c.min, 4)}    ` +
                `${pad(f(p.mean), 4)} ${pad(p.min, 5)}    ${pad(r.alive, 3)}/${String(r.founded).padEnd(3)}   ${pad(r.starved, 5)}  ${pad(r.hunted, 6)}    ` +
                (orders ? `${pad(g.hunt, 4)} ${pad(g.gather, 4)} ${pad(g.defend, 4)} ${pad(g.move, 4)} ${pad(g.wood, 4)} ${pad(g.flint, 4)}   ${why}` : ''),
            );
        }
    }
    console.log('');
    for (const orders of [true, false]) {
        const all = rows[orders];
        const ok = all.filter(({ r }) => !r.extinct).length;
        const people = all.filter(({ r }) => !r.extinct && !r.humansGone).length;
        const low = (k) => Math.min(...all.map((x) => x[k].min));
        const avg = (k) => mean(all.map((x) => x[k].mean));
        const cv = (k) => mean(all.map((x) => x[k].cv));
        console.log(
            `${(orders ? 'with orders:' : 'without:').padEnd(13)} ${ok}/${all.length} ecosystems persisted · people survived in ${people}/${all.length} · ` +
            `herbivores ${f(avg('h'))} (cv ${f(cv('h'), 3)}, lowest ${low('h')}) · carnivores ${f(avg('c'))} (cv ${f(cv('c'), 3)}, lowest ${low('c')}) · ` +
            `people ${f(avg('p'))} (lowest ${low('p')}) · ${f(mean(all.map(({ r }) => r.stepsPerSec)))} steps/s`,
        );
        // People's lives, a run on average: born, and what they died of.
        const died = {};
        for (const { r } of all) for (const [k, v] of Object.entries(r.died)) died[k] = (died[k] ?? 0) + v / all.length;
        const causes = Object.entries(died).map(([k, v]) => `${k} ${f(v)}`).join(', ');
        console.log(`${''.padEnd(13)} people a run: ${f(mean(all.map(({ r }) => r.births)))} born; died of ${causes}`);
        const pc = (v) => `${f(100 * v)}%`;
        const shares = FULL.map((v, k) => `≥ ${v} ${pc(mean(all.map(({ r }) => r.full[k])))}`).join(', ');
        console.log(`${''.padEnd(13)} store a member, share of the time: ${shares} · store could pay for a birth ${pc(mean(all.map(({ r }) => r.fed)))}` +
            (orders ? ` · orders heeded ${pc(mean(all.map(({ r }) => r.heeded)))} of the time they stood` : ''));
    }
    const failed = rows.true.some(({ r }) => r.extinct || r.humansGone);
    console.log('');
    process.exit(failed ? 1 : 0);
}

if (!isMainThread) {
    parentPort.postMessage(runSeed(workerData));
} else {
    await main();
}
