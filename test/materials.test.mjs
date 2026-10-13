// Wood and flint by hand (player.js, items.js handWork): E in forest chops
// wood, on rock (a little on tundra) knaps flint, elsewhere gathers food; a
// load carried to the rack; the page's prompt deciding with the same test
// on its Mirror; and the orders Gather wood and Gather flint (orders.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { Sim, setParam } from '../src/sim.js';
import { Mirror } from '../src/mirror.js';
import { takeControl, applyInput, applyAct, playerSnapshot } from '../src/player.js';
import { issueOrder, heeded, setAside, ORDER_KINDS } from '../src/orders.js';
import { TASK, KIND, handWork, yieldAt, richness, flatSpot, newItem, hold, unhold, heldLike } from '../src/items.js';
import { BIOME } from '../src/terrain.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// No predators: nothing bites while a test stands still.
const CALM = { 'carnivore.initial': 0 };
// Flat, one tribe, no animals.
const EMPTY = { 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 };

const wrap = (v, size) => ((v % size) + size) % size;
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const dist = (w, ax, ay, bx, by) => Math.hypot(wrapDelta(ax - bx, w.width), wrapDelta(ay - by, w.height));
const at = (w, id) => w.humans.id.subarray(0, w.humans.n).indexOf(id);
const happened = (w, type) => w.events.filter((e) => e.type === type);

let seq = 0;
const input = (w, x, y) => applyInput(w, { seq: ++seq, x, y, heading: 0, speed: 0, crouch: false });
const act = (w, action, more = {}) => applyAct(w, { seq: ++seq, action, ...more });

// An adult of the first tribe with its life ahead of it, fed, taken over. Its id.
function control(w) {
    const pop = w.humans;
    let i = 0;
    while (pop.tribe[i] !== w.tribes[0].id || pop.age[i] < w.p.human.maturity) i++;
    pop.age[i] = w.p.human.maturity;
    pop.lifespan[i] = w.p.human.lifespan;
    pop.energy[i] = 140;
    pop.carry[i] = 0;
    assert.ok(takeControl(w, pop.id[i], 'god'));
    return pop.id[i];
}

// Put person `id` at (x, y).
function put(w, id, x, y) {
    const i = at(w, id);
    w.humans.x[i] = x;
    w.humans.y[i] = y;
}

// The middle of a grass cell of `biome`, on open ground and well away from
// every camp: {x, y}, or null.
function cellOf(w, biome, away = 40) {
    const g = w.grass;
    const T = w.terrain;
    for (let k = 0; k < T.biomeGrid.length; k++) {
        if (T.biomeGrid[k] !== biome) continue;
        const x = ((k % g.cols) + 0.5) * g.cellW;
        const y = (Math.floor(k / g.cols) + 0.5) * g.cellH;
        if (T.blocked(x, y) || w.tribes.some((t) => dist(w, t.camp.x, t.camp.y, x, y) < away)) continue;
        return { x, y };
    }
    return null;
}

// A new item of `kind` in person i's hand, in place of what it held there.
function give(w, i, kind) {
    const held = heldLike(w, i, kind);
    if (held) {
        unhold(w, i, held);
        w.items.delete(held.id);
    }
    hold(w, i, newItem(w, kind, 0, '', 0, w.humans.tribe[i]));
}

// ---- By hand -------------------------------------------------------------------------------

test('chopping in forest gives wood at the rate of the errands, with chips', () => {
    const w = world(CALM);
    const I = w.p.items;
    const id = control(w);
    const tribe = w.tribes[0];
    // Where its tribe's woodcutters go (a forest spot), and someone on an errand there.
    const spot = tribe.woodSpot;
    assert.ok(spot && spot.rich, 'the tribe has a forest to go to');
    put(w, id, spot.x, spot.y);
    const pop = w.humans;
    const j = pop.id.subarray(0, pop.n).findIndex((pid, k) => pid !== id && pop.tribe[k] === tribe.id && pop.age[k] >= w.p.human.maturity);
    pop.x[j] = spot.x;
    pop.y[j] = spot.y;
    pop.task[j] = TASK.WOOD;
    pop.work[j] = 1;
    pop.load[j] = 0;
    pop.energy[j] = 140;
    assert.equal(handWork(w, spot.x, spot.y, tribe), TASK.WOOD);
    act(w, 'gather', { on: true });
    w.step();
    const pl = w.player;
    assert.equal(pl.wood, I.wood, 'items.wood a step, in forest');
    assert.equal(pl.wood, pop.load[j], 'as much as the woodcutter beside it');
    assert.equal(pl.wood, yieldAt(w, spot.x, spot.y, TASK.WOOD));
    assert.equal(pl.flint, 0);
    assert.equal(pop.state[at(w, id)], STATE.CHOPPING);
    const snap = playerSnapshot(w);
    assert.equal(snap.gathering, 'wood');
    assert.equal(snap.wood, I.wood);
    assert.equal(snap.loadMax, I.load);
    assert.equal(pop.carry[at(w, id)], 0, 'no food');
    let chops = happened(w, 'chop').filter((e) => e.id === id).length;
    for (let k = 1; k < 60; k++) {
        w.step();
        chops += happened(w, 'chop').filter((e) => e.id === id).length;
    }
    assert.ok(Math.abs(pl.wood - 60 * I.wood) < 1e-9, `60 steps: ${pl.wood}`);
    assert.equal(chops, Math.ceil(60 / w.p.materials.chopEvery), 'a stroke (chips) every materials.chopEvery steps');
});

test('knapping on rock gives flint, a little on tundra, faster with a knife', () => {
    const w = world(CALM);
    const I = w.p.items;
    const id = control(w);
    const rock = cellOf(w, BIOME.ROCK);
    const tundra = cellOf(w, BIOME.TUNDRA);
    assert.ok(rock && tundra);
    const pl = w.player;
    const gain = (spot) => {
        put(w, id, spot.x, spot.y);
        const before = pl.flint;
        act(w, 'gather', { on: true });
        w.step();
        assert.equal(playerSnapshot(w).gathering, 'flint');
        assert.equal(w.humans.state[at(w, id)], STATE.QUARRYING);
        return pl.flint - before;
    };
    assert.equal(gain(rock), I.flint, 'items.flint a step on rock');
    assert.ok(happened(w, 'knap').some((e) => e.id === id), 'sparks');
    assert.ok(Math.abs(gain(tundra) - I.flint * I.poor) < 1e-12, 'items.poor of it on tundra');
    give(w, at(w, id), KIND.KNIFE);
    assert.ok(Math.abs(gain(rock) - I.flint * w.p.materials.knifeKnap) < 1e-12, 'a knife knaps ×1.5');
    assert.equal(pl.wood, 0);
});

test('elsewhere, E gathers food as before', () => {
    const w = world(CALM);
    const P = w.p.human;
    const id = control(w);
    const meadow = cellOf(w, BIOME.MEADOW);
    put(w, id, meadow.x, meadow.y);
    assert.equal(handWork(w, meadow.x, meadow.y, w.tribes[0]), TASK.NONE);
    w.grass.g[w.grass.index(meadow.x, meadow.y)] = 0.5;
    act(w, 'gather', { on: true });
    w.step();
    assert.ok(Math.abs(w.humans.carry[at(w, id)] - P.gatherRate * P.plantEnergy) < 1e-12);
    assert.equal(playerSnapshot(w).gathering, 'food');
    assert.equal(w.humans.state[at(w, id)], STATE.GATHERING);
    assert.deepEqual([w.player.wood, w.player.flint], [0, 0]);
});

test('without items, E gathers food in forest too', () => {
    const w = world({ ...CALM, 'items.enabled': false });
    const id = control(w);
    const forest = cellOf(w, BIOME.FOREST);
    put(w, id, forest.x, forest.y);
    assert.equal(handWork(w, forest.x, forest.y, w.tribes[0]), TASK.NONE);
    w.grass.g[w.grass.index(forest.x, forest.y)] = 0.5;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, 'food');
    assert.equal(w.player.wood, 0);
    assert.ok(w.humans.carry[at(w, id)] > 0);
});

test('it stops on a move, when let go, and when the load is full (more with a basket)', () => {
    const w = world(CALM);
    const I = w.p.items;
    const id = control(w);
    const forest = cellOf(w, BIOME.FOREST);
    put(w, id, forest.x, forest.y);
    const pl = w.player;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, 'wood');
    input(w, forest.x + 1, forest.y);
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'a move stops it');
    const after = pl.wood;
    act(w, 'gather', { on: true });
    w.step();
    act(w, 'gather', { on: false });
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'let go');
    assert.ok(Math.abs(pl.wood - after - I.wood) < 1e-12, 'one step more');

    pl.wood = I.load - 0.01;
    act(w, 'gather', { on: true });
    w.step();
    assert.ok(Math.abs(pl.wood - I.load) < 1e-9, 'filled up, no more');
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'full');
    assert.ok(Math.abs(pl.wood - I.load) < 1e-9);
    pl.wood = 4;
    pl.flint = 4;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(pl.wood, 4, 'wood and flint share the load');
    assert.equal(playerSnapshot(w).gathering, false);

    give(w, at(w, id), KIND.BASKET);
    assert.equal(playerSnapshot(w).loadMax, I.load * I.basket, 'a basket carries more');
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, 'wood');
    assert.ok(Math.abs(pl.wood - 4 - I.wood) < 1e-12);
});

// The player alone in its tribe, `d` from the camp's centre: the store
// changes only by what it does.
function alone(w, d) {
    const id = control(w);
    const pop = w.humans;
    for (let k = 0; k < pop.n; k++) if (pop.id[k] !== id && pop.tribe[k] === w.tribes[0].id) w.die(pop, k, 'old age');
    w.step();
    const camp = w.tribes[0].camp;
    put(w, id, wrap(camp.x + d, w.width), camp.y);
    pop.energy[at(w, id)] = 140;
    return { id, tribe: w.tribes[0] };
}

test('E at the rack stores wood and flint with the food', () => {
    const w = world(EMPTY);
    const { id, tribe } = alone(w, 12);
    const pl = w.player;
    pl.wood = 3.5;
    pl.flint = 1.25;
    w.humans.carry[at(w, id)] = 20;
    const before = { wood: tribe.wood, flint: tribe.flint };
    act(w, 'store');
    w.step();
    assert.equal(happened(w, 'store').length, 0, 'not at the rack');
    put(w, id, wrap(tribe.camp.x + 5, w.width), tribe.camp.y);
    act(w, 'store');
    w.step();
    const [e] = happened(w, 'store');
    assert.deepEqual([e.amount, e.wood, e.flint], [20, 3.5, 1.25]);
    assert.deepEqual([tribe.wood - before.wood, tribe.flint - before.flint], [3.5, 1.25], 'into the store');
    assert.deepEqual([pl.wood, pl.flint], [0, 0]);
    // Wood alone is worth a trip to the rack too.
    pl.flint = 2;
    act(w, 'store');
    w.step();
    const [f] = happened(w, 'store');
    assert.deepEqual([f.amount, f.flint, f.wood], [0, 2, undefined]);
    assert.equal(tribe.flint - before.flint, 3.25);
});

test('the load: an errand taken over is yours, a body left takes it home, a death loses it', () => {
    const w = world(EMPTY);
    const pop = w.humans;
    const tribe = w.tribes[0];
    // A woodcutter on its way home with 5.
    let j = 0;
    while (pop.age[j] < w.p.human.maturity) j++;
    pop.task[j] = TASK.WOOD;
    pop.load[j] = 5;
    pop.work[j] = 100;
    const id = pop.id[j];
    takeControl(w, id, 'god');
    assert.equal(w.player.wood, 5, 'taken over: its load is yours');
    assert.equal(pop.task[j], TASK.NONE);
    w.player.flint = 2;
    // Another body: this one goes home with the wood (the bigger) for the AI.
    let k = 0;
    while (k === j || pop.age[k] < w.p.human.maturity) k++;
    takeControl(w, pop.id[k], 'god');
    assert.deepEqual([pop.task[j], pop.load[j], pop.work[j]], [TASK.WOOD, 5, w.p.items.errand]);
    assert.deepEqual([w.player.wood, w.player.flint], [0, 0], 'the new body carries nothing');
    // Home, the AI puts it in the store (campItems: the errand is over).
    const before = tribe.wood;
    pop.x[j] = tribe.camp.x;
    pop.y[j] = tribe.camp.y;
    pop.energy[j] = 140;
    w.step();
    assert.equal(pop.load[at(w, id)], 0, 'unloaded');
    assert.notEqual(pop.task[at(w, id)], TASK.WOOD, 'the errand is done');
    // (Unless it set to making something with it at once.)
    assert.ok(pop.task[at(w, id)] === TASK.CRAFT || tribe.wood >= before + 5 - 1e-9, 'into the store');
    // A death: the load is gone with the body.
    const dead = w.player.id;
    w.player.wood = 3;
    w.die(pop, at(w, dead), 'killed');
    w.step();
    assert.notEqual(w.player.id, dead, 'an heir');
    assert.deepEqual([w.player.wood, w.player.flint], [0, 0]);
});

// ---- The page decides as the simulation does --------------------------------------

// A Mirror of the world `seed` makes with `set` (no simulation behind it:
// the land is built on the page, as in the browser).
function mirrorOf(set, seed) {
    const host = { local: true, onmessage: null, send() {} };
    const m = new Mirror(host);
    m.reset(config(set), seed, 1.6);
    return m;
}

test("the page's ground test agrees with the simulation's, anywhere", () => {
    for (const [set, seed] of [[CALM, 1], [CALM, 4], [EMPTY, 2]]) {
        const w = world(set, seed);
        const m = mirrorOf(set, seed);
        const id = control(w);
        const pl = w.player;
        const tribe = w.tribes[0];
        const shown = m.tribeById.get(tribe.id);
        assert.deepEqual(shown.camp, tribe.camp);
        let rng = 12345;
        const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
        const seen = new Set();
        for (let n = 0; n < 400; n++) {
            // Random points, and (on a flat world) points about the tribe's spots.
            let x = rand() * w.width;
            let y = rand() * w.height;
            if (w.terrain === null && n % 2) {
                const s = flatSpot(w, tribe, n % 4 === 1 ? TASK.WOOD : TASK.FLINT);
                x = wrap(s.x + (rand() - 0.5) * 30, w.width);
                y = wrap(s.y + (rand() - 0.5) * 30, w.height);
            }
            const page = handWork(m, x, y, shown);
            assert.equal(page, handWork(w, x, y, tribe), `at (${x}, ${y})`);
            seen.add(page);
            // And what the hands actually do there (off blocked ground and out of camp).
            if (n % 8 || (w.terrain && w.terrain.blocked(x, y)) || dist(w, x, y, tribe.camp.x, tribe.camp.y) < w.p.human.campRadius + 1) continue;
            put(w, id, x, y);
            act(w, 'gather', { on: true });
            w.step();
            if (w.player === null || w.player.id !== id) break; // (it died, on some world)
            assert.equal(pl.work, page, `the hands at (${x}, ${y})`);
            act(w, 'gather', { on: false });
        }
        assert.deepEqual([...seen].sort(), [TASK.NONE, TASK.WOOD, TASK.FLINT], 'all three seen');
    }
});

// ---- Orders: Gather wood, Gather flint ------------------------------------------------

const adultsOf = (w, tribe) => {
    const pop = w.humans;
    const out = [];
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === tribe.id && pop.age[i] >= w.p.human.maturity) out.push(i);
    return out;
};

test('Gather wood and Gather flint send idle adults for them, to the spot; a hungry camp sets them aside', () => {
    for (const kind of ['wood', 'flint']) {
        const w = world(CALM, 2);
        const tribe = w.tribes[0];
        const task = kind === 'wood' ? TASK.WOOD : TASK.FLINT;
        const spot = kind === 'wood' ? tribe.woodSpot : tribe.flintSpot;
        w.step();
        const busy = () => adultsOf(w, tribe).filter((i) => w.humans.task[i] === task).length;
        // Fed, no order: few or none go at once (only what the tribe needs).
        let without = 0;
        for (let k = 0; k < 300; k++) {
            tribe.store = 5000;
            w.step();
            without = Math.max(without, busy());
        }
        assert.equal(issueOrder(w, tribe, { kind, x: 0, y: 0 }), true);
        assert.deepEqual([tribe.order.kind, tribe.order.x, tribe.order.y], [kind, spot.x, spot.y], 'the order stands at the spot');
        assert.equal(w.events.at(-1).type, 'call');
        let most = 0;
        for (let k = 0; k < 300; k++) {
            tribe.store = 5000; // (fed: resting at camp, idle)
            w.step();
            most = Math.max(most, busy());
        }
        const cap = 1 + Math.round(w.p.materials.ordered * tribe.adults);
        assert.ok(most > without, `${kind}: ${most} at once under the order, ${without} without`);
        assert.equal(most, cap, `${kind}: its share of ${tribe.adults} adults at once, no more`);
        // Hungry: set aside, nobody more is sent.
        tribe.store = 0;
        assert.equal(setAside(w.p, tribe), true);
        assert.equal(heeded(w.p, tribe), null);
        for (const i of adultsOf(w, tribe)) w.humans.task[i] = TASK.NONE;
        let sent = 0;
        for (let k = 0; k < 200; k++) {
            tribe.store = 0;
            w.step();
            sent = Math.max(sent, busy());
        }
        assert.ok(sent <= 2, `hungry, ${sent} went (the tribe's own needs only)`);
    }
});

test('Gather wood and flint are refused without items or a spot', () => {
    const off = world({ ...CALM, 'items.enabled': false });
    assert.equal(issueOrder(off, off.tribes[0], { kind: 'wood', x: 0, y: 0 }), false);
    assert.deepEqual([off.events.at(-1).type, off.events.at(-1).reason], ['refused', 'nowhere']);
    const w = world(CALM);
    const tribe = w.tribes[0];
    tribe.flintSpot = null;
    assert.equal(issueOrder(w, tribe, { kind: 'flint', x: 0, y: 0 }), false);
    assert.equal(w.events.at(-1).reason, 'nowhere');
    assert.equal(tribe.order, null);
});

test('the snapshot round trip: the load, what the hands gather, the order', async () => {
    const host = { local: true, onmessage: null, send: (msg) => sim.handle(msg) };
    const sim = new Sim((msg) => host.onmessage(msg));
    const mirror = new Mirror(host);
    mirror.reset(config(CALM), 1, 1.6);
    let now = performance.now();
    const frame = async (n = 1) => {
        await mirror.run(n);
        for (let k = 0; k < 2; k++) {
            now += 1000;
            mirror.update(now, 16);
        }
    };
    await frame();
    const w = sim.world;
    const id = control(w);
    const tribe = w.tribes[0];
    put(w, id, tribe.woodSpot.x, tribe.woodSpot.y);
    sim.handle({ type: 'act', seq: 1, action: 'gather', on: true });
    await frame(10);
    const p = mirror.player;
    assert.equal(p.gathering, 'wood');
    assert.ok(Math.abs(p.wood - 10 * w.p.items.wood) < 1e-9, `${p.wood}`);
    assert.deepEqual([p.flint, p.loadMax], [0, w.p.items.load]);
    // The page's test, on the Mirror's land, says the same.
    assert.equal(handWork(mirror, p.x, p.y, mirror.tribeById.get(tribe.id)), TASK.WOOD);

    for (const kind of ['wood', 'flint']) {
        tribe.store = 5000;
        issueOrder(w, tribe, { kind, x: 0, y: 0 });
        await frame();
        const spot = kind === 'wood' ? tribe.woodSpot : tribe.flintSpot;
        assert.deepEqual(mirror.tribeById.get(tribe.id).order, { kind, x: spot.x, y: spot.y });
    }
    assert.deepEqual(ORDER_KINDS.slice(5), ['wood', 'flint'], 'codes 5 and 6');
});

test('richness: what the ground gives, as handWork reads it', () => {
    const w = world(CALM);
    const forest = cellOf(w, BIOME.FOREST);
    const meadow = cellOf(w, BIOME.MEADOW);
    assert.equal(richness(w, forest.x, forest.y, TASK.WOOD), 1);
    assert.equal(richness(w, meadow.x, meadow.y, TASK.WOOD), w.p.items.poor, 'a little wood in a meadow...');
    assert.equal(handWork(w, meadow.x, meadow.y, w.tribes[0]), TASK.NONE, '...but E gathers food there');
});
