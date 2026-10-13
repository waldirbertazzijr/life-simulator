// The player's hands (package 2): spears thrown and in flight (src/spears.js),
// jabs and ambushes, carcasses and butchering, gathering, eating and the
// store (src/player.js); and everyone else's throws, told to the page as
// events (src/humans.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { Sim, setParam } from '../src/sim.js';
import { takeControl, applyInput, applyAct, playerSnapshot } from '../src/player.js';
import { stepSpears } from '../src/spears.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};

// A world for one test; `set` changes parameters, e.g. {'terrain.enabled': false}.
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// Flat, one tribe, and no animals but those a test puts there.
const EMPTY = { 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 };

const wrap = (v, size) => ((v % size) + size) % size;
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
// Are two positions within `eps` of each other, across the world's edges?
const near = (w, ax, ay, bx, by, eps = 1e-9) => Math.hypot(wrapDelta(ax - bx, w.width), wrapDelta(ay - by, w.height)) <= eps;
const indexIn = (pop, id) => pop.id.subarray(0, pop.n).indexOf(id);
const at = (w, id) => indexIn(w.humans, id);
const happened = (w, type) => w.events.filter((e) => e.type === type);

let seq = 0;
const input = (w, x, y, more = {}) => applyInput(w, { seq: ++seq, x, y, heading: 0, speed: 0, crouch: false, ...more });
const act = (w, action, more = {}) => applyAct(w, { seq: ++seq, action, ...more });
const attack = (w, more = {}) => act(w, 'attack', { heavy: false, dx: 1, dy: 0, power: 0, target: 0, ...more });

// An adult of the first tribe with its life ahead of it, taken over. Its id.
function control(w, mode = 'god') {
    const pop = w.humans;
    let i = 0;
    while (pop.age[i] < w.p.human.maturity) i++;
    pop.age[i] = w.p.human.maturity;
    pop.lifespan[i] = w.p.human.lifespan;
    pop.energy[i] = 140;
    pop.carry[i] = 0;
    assert.ok(takeControl(w, pop.id[i], mode));
    return pop.id[i];
}

// Stand the person `id` on the spot farthest from every camp (on the grass
// grid's corners, so tests can place things around it). Returns the spot.
function stand(w, id) {
    let best = null;
    for (let y = 0; y < w.height; y += 20) {
        for (let x = 0; x < w.width; x += 20) {
            let d = Infinity;
            for (const t of w.tribes) d = Math.min(d, Math.hypot(wrapDelta(t.camp.x - x, w.width), wrapDelta(t.camp.y - y, w.height)));
            if (!best || d > best.d) best = { x, y, d };
        }
    }
    const i = at(w, id);
    w.humans.x[i] = best.x;
    w.humans.y[i] = best.y;
    return best;
}

// A grazer at (x, y) facing `heading`, on good grass (it stays put unless
// something frightens it). sense: its sense gene (×20 units).
function grazer(w, x, y, { heading = 0, sense = 0.3, energy = 60 } = {}) {
    const pop = w.herbivores;
    const i = w.spawn(pop, w.p.herbivore, wrap(x, w.width), wrap(y, w.height), energy, 1.3, sense, 1000);
    pop.heading[i] = heading;
    w.grass.g[w.grass.index(pop.x[i], pop.y[i])] = 1;
    return pop.id[i];
}

// A predator at (x, y), catching its breath for a long while (it stays put).
function predatorAt(w, x, y) {
    const pop = w.carnivores;
    const i = w.spawn(pop, w.p.carnivore, wrap(x, w.width), wrap(y, w.height), 60, 1.5, 0.8, 1000);
    pop.timer[i] = 1000;
    pop.state[i] = STATE.RESTING;
    return pop.id[i];
}

// Step until no spear flies (at most `limit` steps); the events of every step.
function flyOut(w, limit = 20) {
    const all = [];
    for (let k = 0; k < limit && (k === 0 || w.spears.n); k++) {
        w.step();
        all.push(...w.events);
    }
    return all;
}

// ---- Others' throws ----------------------------------------------------------

test("hunters' and fighters' throws are events", () => {
    const w = world();
    const throws = [];
    let hits = 0;
    for (let k = 0; k < 6000 && (hits < 5 || throws.length === hits); k++) {
        w.step();
        for (const e of w.events) {
            if (e.type !== 'throw') continue;
            throws.push(e);
            for (const f of ['id', 'x', 'y', 'tx', 'ty', 'time']) assert.equal(typeof e[f], 'number', `${f}`);
            assert.equal(typeof e.hit, 'boolean');
            assert.equal(e.time, w.time - 1);
            if (!e.hit) continue;
            // A hit kills, in the same step: the death is the thrower's, where it aimed.
            const death = w.events.find((d) => d.type === 'death' && d.by === e.id && d.x === e.tx && d.y === e.ty);
            assert.ok(death, 'a throw that hits kills');
            assert.ok(['hunted', 'killed'].includes(death.cause));
            hits++;
        }
    }
    assert.ok(hits >= 5, `${hits} hits in ${throws.length} throws`);
    assert.ok(throws.length > hits, `and some miss: ${hits} hits in ${throws.length} throws`);
});

test('a throw at a predator is an event too', () => {
    const w = world({ 'terrain.enabled': false, 'carnivore.initial': 1, 'human.tribes': 1 });
    const P = w.p.human;
    const pop = w.humans;
    const tribe = w.tribes[0];
    tribe.aggression = 1;
    // Two adults side by side, a predator 10 away.
    const adults = [];
    for (let i = 0; i < pop.n && adults.length < 2; i++) if (pop.age[i] >= P.maturity) adults.push(i);
    for (const i of adults) {
        pop.x[i] = 400 + adults.indexOf(i);
        pop.y[i] = 300;
        pop.timer[i] = 0;
    }
    const c = w.carnivores;
    c.x[0] = 410;
    c.y[0] = 300;
    c.energy[0] = c.energy[0] || 50;
    w.step();
    const throws = w.events.filter((e) => e.type === 'throw');
    assert.ok(throws.length >= 1, 'they stand and throw');
    const e = throws[0];
    assert.ok(adults.map((i) => pop.id[i]).includes(e.id));
    assert.ok(Math.hypot(e.tx - 410, e.ty - 300) < 2, 'at the predator');
});

// ---- The player's spear: thrown -----------------------------------------------

test('a light throw flies 3 a step and comes down 20 away', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    attack(w);
    w.step();
    const [t] = happened(w, 'throw');
    assert.ok(t, 'a throw event');
    assert.equal(t.id, id);
    assert.ok(near(w, t.x, t.y, x, y));
    assert.ok(near(w, t.tx, t.ty, x + 20, y), 'aimed 20 ahead');
    assert.equal(t.hit, undefined, 'a real spear: how it ends is still to come');
    const S = w.spears;
    for (let k = 1; k <= 6; k++) {
        if (k > 1) w.step();
        assert.equal(S.n, 1);
        assert.ok(near(w, S.x[0], S.y[0], x + 3 * k, y), `step ${k}: ${S.x[0]}`);
    }
    w.step();
    assert.equal(S.n, 0, 'down after 20');
    const [m] = happened(w, 'miss');
    assert.ok(m, 'a miss event');
    assert.ok(near(w, m.x, m.y, x + 20, y));
    assert.equal(m.by, id);
});

test('a heavy throw flies farther and faster with its power', () => {
    for (const [power, speed, range] of [[1, 4.5, 34], [0.5, 3.75, 27]]) {
        const w = world(EMPTY);
        const id = control(w);
        const { x, y } = stand(w, id);
        attack(w, { heavy: true, power, dx: 0, dy: 2 }); // (any length: it is a direction)
        w.step();
        assert.ok(near(w, w.spears.x[0], w.spears.y[0], x, y + speed), `power ${power}: ${speed} a step`);
        const events = flyOut(w);
        const m = events.find((e) => e.type === 'miss');
        assert.ok(m && near(w, m.x, m.y, x, y + range, 1e-6), `power ${power}: down ${range} away`);
    }
});

test('a spear kills the first grazer it passes, for a carcass', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    const first = grazer(w, x + 12, y);
    const second = grazer(w, x + 17, y);
    const aside = grazer(w, x + 9, y + 3); // 3 off the line: missed
    const kills = w.humans.kills[at(w, id)];
    attack(w);
    const events = flyOut(w);
    assert.equal(indexIn(w.herbivores, first), -1, 'the first one dies');
    assert.ok(indexIn(w.herbivores, second) >= 0, 'the one behind it lives');
    assert.ok(indexIn(w.herbivores, aside) >= 0, 'the one aside lives');
    const death = events.find((e) => e.type === 'death' && e.id === first);
    assert.equal(death.cause, 'hunted');
    assert.equal(death.by, id);
    const hit = events.find((e) => e.type === 'hit');
    assert.equal(hit.id, first);
    assert.equal(hit.by, id);
    assert.equal(hit.kind, 'herbivore');
    assert.ok(Math.abs(hit.dx - 1) < 1e-9 && Math.abs(hit.dy) < 1e-9, 'the blow’s direction');
    assert.ok(!events.some((e) => e.type === 'miss'));
    assert.equal(w.humans.kills[at(w, id)], kills + 1);
    // Its meat waits in a carcass where it fell.
    const c = w.carcasses.get(first);
    assert.ok(c, 'a carcass');
    assert.equal(c.kind, 'herbivore');
    assert.ok(near(w, c.x, c.y, death.x, death.y));
    const H = w.p.herbivore;
    assert.ok(c.meat > 0 && c.meat <= (H.maxEnergy + H.fatMax + H.meat) * w.p.human.efficiency, "what it was worth: World.meatOf");
    assert.equal(c.meat, c.total);
    assert.equal(c.cut, 0);
});

test('a predator is hit from farther, and dies killed', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    const g = grazer(w, x + 9, y + 2.3);
    const c = predatorAt(w, x + 17, y + 2.3);
    attack(w);
    const events = flyOut(w);
    assert.ok(indexIn(w.herbivores, g) >= 0, '2.3 off the line, a grazer is missed');
    assert.equal(indexIn(w.carnivores, c), -1, 'but a predator is bigger');
    const death = events.find((e) => e.type === 'death' && e.id === c);
    assert.equal(death.cause, 'killed');
    assert.equal(death.by, id);
    assert.equal(w.carcasses.get(c).kind, 'carnivore');
});

test('a stranger hit loses 60; tribe-mates are passed through', () => {
    const w = world({ ...EMPTY, 'human.tribes': 2 });
    const id = control(w);
    const { x, y } = stand(w, id);
    const pop = w.humans;
    const me = pop.tribe[at(w, id)];
    const mate = pop.id[pop.tribe.subarray(0, pop.n).findIndex((t, k) => t === me && pop.id[k] !== id)];
    const stranger = pop.id[pop.tribe.subarray(0, pop.n).findIndex((t) => t !== me)];
    const put = (pid, px, e) => {
        const k = at(w, pid);
        pop.x[k] = wrap(px, w.width);
        pop.y[k] = y;
        pop.energy[k] = e;
    };
    put(mate, x + 5, 100);
    put(stranger, x + 12, 100);
    // (Spears stepped on their own, so nobody walks out of the way.)
    const kills = pop.kills[at(w, id)];
    w.spears.add(x, y, 3, 0, 20, id, me);
    for (let k = 0; k < 7; k++) stepSpears(w);
    assert.equal(pop.energy[at(w, mate)], 100, 'no friendly fire');
    assert.equal(pop.energy[at(w, stranger)], 40);
    assert.equal(happened(w, 'hit').length, 1);
    assert.equal(happened(w, 'hit')[0].kind, 'human');
    assert.equal(happened(w, 'death').length, 0);
    w.spears.add(x, y, 3, 0, 20, id, me);
    for (let k = 0; k < 7; k++) stepSpears(w);
    const death = happened(w, 'death')[0];
    assert.ok(death && death.id === stranger, 'a second one kills');
    assert.equal(death.cause, 'killed');
    assert.equal(death.by, id);
    assert.equal(pop.kills[at(w, id)], kills + 1);
    assert.equal(w.carcasses.size, 0, 'no meat from people');
});

test("a spear flies across the world's edge and still hits", () => {
    const w = world(EMPTY);
    const id = control(w);
    const y = 300;
    const g = grazer(w, 5, y);
    w.spears.add(w.width - 5, y, 3, 0, 20, id, w.humans.tribe[at(w, id)]);
    for (let k = 0; k < 7 && w.spears.n; k++) stepSpears(w);
    assert.equal(w.herbivores.energy[indexIn(w.herbivores, g)], 0, 'struck 10 away, over the edge');
    assert.equal(w.spears.n, 0);
});

// ---- The jab, and the ambush ----------------------------------------------------

test('a jab within reach in front; from behind, unnoticed, it always kills', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    input(w, x, y, { crouch: true });
    // A tribe-mate right in front is not jabbed: that is a throw (through it).
    const pop = w.humans;
    const mate = pop.id[pop.tribe.subarray(0, pop.n).findIndex((t, k) => t === pop.tribe[at(w, id)] && pop.id[k] !== id)];
    pop.x[at(w, mate)] = x + 2;
    pop.y[at(w, mate)] = y;
    attack(w);
    w.step();
    assert.equal(happened(w, 'jab').length, 0);
    assert.equal(happened(w, 'throw').length, 1);
    assert.equal(pop.energy[at(w, mate)] > 0, true);
    pop.x[at(w, mate)] = x - 200;
    for (let k = 0; k < 20; k++) {
        pop.timer[at(w, id)] = 0; // (the reload, waived)
        const g = grazer(w, x + 4, y + 0.5, { heading: 0.2 }); // 4 ahead, facing away: we are behind it
        attack(w);
        w.step();
        assert.equal(w.herbivores.state[indexIn(w.herbivores, g)] ?? STATE.GRAZING, STATE.GRAZING);
        const [jab] = happened(w, 'jab');
        assert.ok(jab, 'a jab, not a throw');
        assert.equal(happened(w, 'throw').length, 0);
        assert.equal(jab.id, id);
        assert.ok(near(w, jab.tx, jab.ty, x + 4, y + 0.5));
        const death = happened(w, 'death').find((e) => e.id === g);
        assert.ok(death, `ambush ${k} kills`);
        assert.equal(death.cause, 'hunted');
        assert.ok(w.carcasses.has(g));
    }
});

test('a jab from the front kills about half the time', () => {
    const w = world({ ...EMPTY, 'items.enabled': false }); // (a plain spear that never wears out: 200 jabs)
    const id = control(w);
    const { x, y } = stand(w, id);
    input(w, x, y, { crouch: true });
    let kills = 0;
    const trials = 200;
    for (let k = 0; k < trials; k++) {
        w.humans.timer[at(w, id)] = 0;
        const g = grazer(w, x + 4, y, { heading: Math.PI }); // facing us
        attack(w);
        w.step();
        assert.equal(happened(w, 'jab').length, 1);
        if (happened(w, 'death').some((e) => e.id === g)) kills++;
        else w.herbivores.x[indexIn(w.herbivores, g)] = wrap(x + 300, w.width); // out of the way
    }
    assert.ok(kills > trials * 0.35 && kills < trials * 0.65, `${kills} of ${trials}`);
});

test('the reload, and children, hold the spear back', () => {
    const w = world(EMPTY);
    const id = control(w);
    stand(w, id);
    attack(w);
    w.step();
    assert.equal(happened(w, 'throw').length, 1);
    assert.equal(playerSnapshot(w).reload, w.p.human.reload);
    for (let k = 1; k < w.p.human.reload; k++) {
        attack(w);
        w.step();
        assert.equal(happened(w, 'throw').length, 0, `step ${k} of the reload`);
    }
    attack(w);
    w.step();
    assert.equal(happened(w, 'throw').length, 1, 'ready again');

    const v = world(EMPTY);
    const child = control(v);
    stand(v, child);
    v.humans.age[at(v, child)] = v.p.human.maturity - 10;
    attack(v);
    v.step();
    assert.equal(happened(v, 'throw').length + happened(v, 'jab').length, 0, 'children do not attack');
    assert.equal(v.spears.n, 0);
});

test('the lock-on target is led', () => {
    // A grazer flees from a predator, across the line of the throw.
    const setup = () => {
        const w = world(EMPTY);
        const id = control(w);
        const { x, y } = stand(w, id);
        const g = grazer(w, x + 15, y, { sense: 2 });
        predatorAt(w, x + 15, y - 10);
        w.step();
        assert.equal(w.herbivores.state[indexIn(w.herbivores, g)], STATE.FLEEING);
        return { w, g };
    };
    let { w, g } = setup();
    attack(w);
    flyOut(w);
    assert.ok(indexIn(w.herbivores, g) >= 0, 'thrown where it was, the spear misses');
    ({ w, g } = setup());
    attack(w, { target: g, lock: false });
    flyOut(w);
    assert.ok(indexIn(w.herbivores, g) >= 0, 'told what it goes for, but not locked on: not led');
    assert.equal(w.player.lastTarget, g, '(followers are told: orders.js)');
    ({ w, g } = setup());
    attack(w, { target: g });
    const events = flyOut(w);
    assert.equal(indexIn(w.herbivores, g), -1, 'locked on, led, it hits');
    assert.ok(events.some((e) => e.type === 'hit' && e.id === g));
});

test('an attack between steps kills inside the next step, once', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    input(w, x, y, { crouch: true });
    const g = grazer(w, x + 4, y, { heading: 0 });
    w.step();
    attack(w);
    assert.ok(w.herbivores.energy[indexIn(w.herbivores, g)] > 0, 'nothing happens between steps');
    assert.equal(w.carcasses.size, 0);
    const hunted = w.deaths.herbivore.hunted || 0;
    w.step();
    assert.equal(happened(w, 'death').filter((e) => e.id === g).length, 1, 'one death, in the step');
    assert.equal(w.deaths.herbivore.hunted, hunted + 1);
    assert.equal(indexIn(w.herbivores, g), -1);
    w.step();
    assert.equal(happened(w, 'death').length, 0, 'and never again');
});

test("a spear in flight outlives its thrower's control", () => {
    const w = world(EMPTY);
    const id = control(w);
    const { x, y } = stand(w, id);
    const g = grazer(w, x + 14, y);
    const kills = w.humans.kills[at(w, id)];
    attack(w);
    w.step();
    takeControl(w, 0);
    assert.equal(w.spears.n, 1);
    const events = flyOut(w);
    const death = events.find((e) => e.type === 'death' && e.id === g);
    assert.ok(death, 'it still kills');
    assert.equal(death.by, id);
    assert.equal(w.humans.kills[at(w, id)], kills + 1, 'for the one who threw it');
});

test('snapshot.spears and the reload reach the page', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 1, aspect: 1.6, params: config(EMPTY) });
    const snapshot = () => {
        sim.handle({ type: 'want' });
        return posted.filter((m) => m.type === 'snapshot').at(-1);
    };
    assert.deepEqual(snapshot().spears, []);
    const w = sim.world;
    const id = control(w);
    const { x, y } = stand(w, id);
    sim.handle({ type: 'act', seq: 1, action: 'attack', heavy: false, dx: 0, dy: -1, power: 0, target: 0 });
    sim.step();
    let snap = snapshot();
    assert.equal(snap.spears.length, 6);
    const [sx, sy, vx, vy, progress, kind] = snap.spears;
    assert.equal(kind, 1, 'a spear (an ITEM_KINDS code)');
    assert.ok(near(w, sx, sy, x, y - 3));
    assert.deepEqual([vx, vy], [0, -3]);
    assert.ok(Math.abs(progress - 3 / 20) < 1e-9);
    assert.equal(snap.player.reload, w.p.human.reload);
    sim.step();
    snap = snapshot();
    assert.equal(snap.player.reload, w.p.human.reload - 1);
    assert.ok(Math.abs(snap.spears[4] - 6 / 20) < 1e-9);
});

// ---- Carcasses and butchering ---------------------------------------------------

// The player (at a spot far from camps) creeps up behind a grazer 4 ahead
// and jabs it: a sure kill, and a carcass within reach. Returns the
// carcass's id and where the player stands.
function kill(w, id) {
    const { x, y } = stand(w, id);
    input(w, x, y, { crouch: true });
    const g = grazer(w, x + 4, y, { heading: 0 });
    attack(w);
    w.step();
    assert.ok(w.carcasses.has(g), 'killed');
    input(w, x, y, { crouch: false });
    return { carcass: g, x, y };
}

test('a carcass spoils after play.spoil steps untouched', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { carcass } = kill(w, id);
    for (let k = 1; k < w.p.play.spoil; k++) w.step();
    assert.ok(w.carcasses.has(carcass), 'still there a step before');
    w.step();
    assert.equal(w.carcasses.has(carcass), false, 'gone');
    const [e] = happened(w, 'spoiled');
    assert.ok(e && e.carcass === carcass);
});

test('butchering takes 60 steps, strikes every 10, and fills the pouch (a kill that fits in it)', () => {
    const w = world({ ...EMPTY, 'herbivore.meat': 0 }); // (a grazer's stomach alone: less than a pouch)
    const id = control(w);
    const { carcass } = kill(w, id);
    const total = w.carcasses.get(carcass).total;
    const Q = w.p.play;
    act(w, 'butcher', { on: true, id: carcass });
    let strokes = 0;
    for (let k = 1; k < Q.butcherSteps; k++) {
        w.step();
        strokes += happened(w, 'butcher').length;
        if (k === 1) {
            const [first] = happened(w, 'butcher');
            assert.ok(first, 'the first stroke at once');
            assert.equal(first.id, id);
            assert.equal(first.carcass, carcass);
            assert.ok(Number.isFinite(first.x) && Number.isFinite(first.y));
        }
        const c = w.carcasses.get(carcass);
        assert.ok(c, `step ${k}: still being cut`);
        assert.ok(Math.abs(c.cut - k / Q.butcherSteps) < 1e-9);
        assert.ok(Math.abs(w.humans.carry[at(w, id)] - (total * k) / Q.butcherSteps) < 1e-9, 'into the pouch as it is cut');
        assert.equal(w.humans.state[at(w, id)], STATE.BUTCHERING);
        assert.equal(playerSnapshot(w).butchering, carcass);
    }
    w.step();
    strokes += happened(w, 'butcher').length;
    assert.equal(strokes, Q.butcherSteps / Q.butcherEvery, 'a stroke every 10 steps');
    assert.equal(w.carcasses.has(carcass), false, 'cut up');
    const [done] = happened(w, 'butchered');
    assert.ok(done && done.carcass === carcass && done.id === id);
    assert.ok(Math.abs(w.humans.carry[at(w, id)] - total) < 1e-9, 'all of it in the pouch');
    assert.equal(playerSnapshot(w).butchering, 0);
});

test('a big kill fills the pouch; the rest waits in the carcass for another load', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { carcass } = kill(w, id);
    const c = w.carcasses.get(carcass);
    const max = w.p.human.carryMax;
    assert.ok(c.total > max, `a grazer's body is more than a pouch: ${c.total.toFixed(0)}`);
    act(w, 'butcher', { on: true, id: carcass });
    for (let k = 0; k < w.p.play.butcherSteps && playerSnapshot(w).butchering; k++) w.step();
    const i = at(w, id);
    assert.ok(Math.abs(w.humans.carry[i] - max) < 1e-9, 'the pouch is full');
    assert.equal(playerSnapshot(w).butchering, 0, 'and the hands stop');
    assert.ok(w.carcasses.has(carcass), 'the carcass is still there...');
    assert.ok(Math.abs(c.meat - (c.total - max)) < 1e-9, '...with the rest of its meat');
    assert.ok(Math.abs(c.cut - max / c.total) < 1e-9);
    // Emptied (into the store), the hands cut the next load.
    w.humans.carry[i] = 0;
    act(w, 'butcher', { on: true, id: carcass });
    w.step();
    assert.ok(w.humans.carry[i] > 0 && c.meat < c.total - max, 'and go on where they left off');
});

test('butchering needs the carcass within reach and stops on a move', () => {
    const w = world(EMPTY);
    const id = control(w);
    const { carcass, x, y } = kill(w, id);
    const Q = w.p.play;
    // From 4.5 away: nothing.
    input(w, x - 0.5, y);
    w.step();
    act(w, 'butcher', { on: true, id: carcass });
    w.step();
    assert.equal(w.carcasses.get(carcass).cut, 0);
    assert.equal(playerSnapshot(w).butchering, 0, 'out of reach: it stops');
    // Within reach, a few strokes; then a step aside stops it.
    input(w, x + 0.5, y);
    w.step();
    act(w, 'butcher', { on: true, id: carcass });
    for (let k = 0; k < 5; k++) w.step();
    const cut = w.carcasses.get(carcass).cut;
    assert.ok(Math.abs(cut - 5 / Q.butcherSteps) < 1e-9);
    input(w, x + 1.5, y);
    w.step();
    assert.equal(playerSnapshot(w).butchering, 0, 'a move stops it');
    assert.equal(w.carcasses.get(carcass).cut, cut, 'what was cut stays cut');
    // Started again, it carries on where it was; off, it stops.
    act(w, 'butcher', { on: true, id: carcass });
    w.step();
    assert.ok(w.carcasses.get(carcass).cut > cut);
    act(w, 'butcher', { on: false });
    w.step();
    assert.equal(playerSnapshot(w).butchering, 0);
    // Nothing by that id: nothing happens.
    act(w, 'butcher', { on: true, id: 999999 });
    w.step();
    assert.equal(playerSnapshot(w).butchering, 0);
});

test('snapshot.carcasses lists what is left', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 1, aspect: 1.6, params: config(EMPTY) });
    const snapshot = () => {
        sim.handle({ type: 'want' });
        return posted.filter((m) => m.type === 'snapshot').at(-1);
    };
    assert.deepEqual(snapshot().carcasses, []);
    const w = sim.world;
    const id = control(w);
    const { carcass } = kill(w, id);
    let [c] = snapshot().carcasses;
    assert.deepEqual(Object.keys(c).sort(), ['by', 'cut', 'id', 'kind', 'meat', 'x', 'y']);
    assert.equal(c.id, carcass);
    assert.equal(c.kind, 'herbivore');
    assert.equal(c.cut, 0);
    const meat = c.meat;
    sim.handle({ type: 'act', seq: 99, action: 'butcher', on: true, id: carcass });
    for (let k = 0; k < 6; k++) sim.step();
    [c] = snapshot().carcasses;
    assert.ok(c.cut > 0 && c.meat < meat);
    assert.equal(snapshot().player.butchering, carcass);
});

// ---- Gathering, eating, the store ------------------------------------------------

test('gathering takes from the patch underfoot as the AI does', () => {
    const w = world(EMPTY);
    const P = w.p.human;
    const id = control(w);
    const { x, y } = stand(w, id);
    const gi = w.grass.index(x, y);
    w.grass.g[gi] = 0.5;
    act(w, 'gather', { on: true });
    w.step();
    const i = at(w, id);
    assert.ok(Math.abs(w.humans.carry[i] - P.gatherRate * P.plantEnergy) < 1e-12, 'gatherRate × plantEnergy a step');
    const regrown = 0.5 - P.gatherRate + w.regrowth * (1 - (0.5 - P.gatherRate)); // (the season's rate: World.clock)
    assert.ok(Math.abs(w.grass.g[gi] - regrown) < 1e-12, 'taken from the patch');
    assert.equal(w.humans.state[i], STATE.GATHERING);
    assert.equal(playerSnapshot(w).gathering, 'food');
    for (let k = 0; k < 9; k++) w.step();
    assert.ok(Math.abs(w.humans.carry[at(w, id)] - 10 * P.gatherRate * P.plantEnergy) < 1e-9);

    // Not in camp (E rests there).
    const camp = w.tribes[0].camp;
    input(w, camp.x, camp.y); // (a jump: turned down, so the body is put there)
    const k = at(w, id);
    w.humans.x[k] = camp.x;
    w.humans.y[k] = camp.y;
    w.grass.g[w.grass.index(camp.x, camp.y)] = 0.5;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'not in camp');
});

test('gathering stops on a thin patch, a move, or off', () => {
    const w = world(EMPTY);
    const P = w.p.human;
    const id = control(w);
    const { x, y } = stand(w, id);
    const g = w.grass.g;
    g[w.grass.index(x, y)] = P.gatherMin - 0.01;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'too thin to bother');
    assert.equal(w.humans.carry[at(w, id)], 0);

    g[w.grass.index(x, y)] = 0.6;
    g[w.grass.index(x + 1, y)] = 0.6;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, 'food');
    input(w, x + 1, y);
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'a move stops it');

    act(w, 'gather', { on: true });
    w.step();
    assert.equal(playerSnapshot(w).gathering, 'food');
    act(w, 'gather', { on: false });
    w.step();
    assert.equal(playerSnapshot(w).gathering, false, 'off');

    w.humans.carry[at(w, id)] = P.carryMax - 0.01;
    act(w, 'gather', { on: true });
    w.step();
    assert.equal(w.humans.carry[at(w, id)], P.carryMax, 'hands full');
    w.step();
    assert.equal(playerSnapshot(w).gathering, false);
});

test('R eats up to 40, never past full', () => {
    const w = world(EMPTY);
    const P = w.p.human;
    const id = control(w);
    stand(w, id);
    const i = () => at(w, id);
    const cost = () => P.baseCost * w.humans.upkeep[i()];
    const eats = (energy, carry) => {
        w.humans.energy[i()] = energy;
        w.humans.carry[i()] = carry;
        act(w, 'eat');
        w.step();
        const [e] = happened(w, 'eat');
        return { amount: e ? e.amount : 0, energy: w.humans.energy[i()] + cost(), carry: w.humans.carry[i()] };
    };
    let r = eats(60, 100);
    assert.equal(r.amount, 40);
    assert.ok(Math.abs(r.energy - 100) < 1e-9);
    assert.equal(r.carry, 60);
    r = eats(140, 60);
    assert.equal(r.amount, P.maxEnergy - 140, 'only up to full');
    assert.ok(Math.abs(r.energy - P.maxEnergy) < 1e-9);
    assert.equal(r.carry, 50);
    r = eats(80, 5);
    assert.equal(r.amount, 5);
    assert.equal(r.carry, 0);
    r = eats(80, 0);
    assert.equal(r.amount, 0, 'nothing to eat: nothing happens');
    assert.equal(happened(w, 'eat').length, 0);
});

// The player alone in its tribe, standing `d` from its camp's centre with
// `carry` in hand: so the store changes only by what it does (and spoils).
function alone(w, d, carry) {
    const id = control(w);
    const pop = w.humans;
    for (let k = 0; k < pop.n; k++) if (pop.id[k] !== id) w.die(pop, k, 'old age');
    w.step();
    const camp = w.tribes[0].camp;
    const i = at(w, id);
    pop.x[i] = wrap(camp.x + d, w.width);
    pop.y[i] = camp.y;
    pop.carry[i] = carry;
    pop.energy[i] = 140; // (not hungry: the store does not feed it)
    return { id, tribe: w.tribes[0] };
}

test('the player keeps what it carries at camp; E stores it at the rack', () => {
    const w = world(EMPTY);
    const spoil = 1 - w.p.human.spoil;
    const { id, tribe } = alone(w, 12, 50);
    let store = tribe.store;
    w.step();
    assert.equal(w.humans.carry[at(w, id)], 50, 'in camp, it is not dropped off');
    assert.ok(Math.abs(tribe.store - store * spoil) < 1e-9);
    store = tribe.store;
    act(w, 'store');
    w.step();
    assert.equal(happened(w, 'store').length, 0, '12 from the centre: not at the rack');
    assert.equal(w.humans.carry[at(w, id)], 50);
    store = tribe.store;
    const i = at(w, id);
    w.humans.x[i] = wrap(tribe.camp.x + 6, w.width);
    act(w, 'store');
    w.step();
    const [e] = happened(w, 'store');
    assert.ok(e, 'at the rack');
    assert.equal(e.amount, 50);
    assert.equal(e.id, id);
    assert.equal(w.humans.carry[at(w, id)], 0);
    assert.ok(Math.abs(tribe.store - (store + 50) * spoil) < 1e-9, 'all of it in the store');
});

test('with empty hands, take up to 40 from the store', () => {
    const w = world(EMPTY);
    const spoil = 1 - w.p.human.spoil;
    const { id, tribe } = alone(w, 3, 0);
    tribe.store = 100;
    act(w, 'take');
    w.step();
    const [e] = happened(w, 'take');
    assert.ok(e);
    assert.equal(e.amount, 40);
    assert.equal(w.humans.carry[at(w, id)], 40);
    assert.ok(Math.abs(tribe.store - 60 * spoil) < 1e-9);
    act(w, 'take');
    w.step();
    assert.equal(happened(w, 'take').length, 0, 'hands not empty');
    w.humans.carry[at(w, id)] = 0;
    tribe.store = 25;
    act(w, 'take');
    w.step();
    assert.equal(happened(w, 'take')[0].amount, 25, 'what there is');
    assert.equal(tribe.store, 0);
});

test('everyone else still drops food off', () => {
    const w = world(EMPTY);
    const id = control(w);
    stand(w, id);
    const pop = w.humans;
    const camp = w.tribes[0].camp;
    const k = pop.id.subarray(0, pop.n).findIndex((pid, j) => pid !== id && pop.age[j] >= w.p.human.maturity);
    const other = pop.id[k];
    pop.x[k] = camp.x;
    pop.y[k] = camp.y;
    pop.carry[k] = 30;
    w.step();
    assert.equal(pop.carry[at(w, other)], 0);
});
