// The controlled person (src/player.js): taking control, the body the page
// moves, the rules that apply to the player alone, heirs, and the way it all
// reaches the page through the Sim (sim.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { Sim, setParam } from '../src/sim.js';
import { takeControl, applyInput, applyAct, playerSnapshot } from '../src/player.js';

// Every field the page reads from snapshot.player.
const FIELDS = ['id', 'mode', 'tribe', 'energy', 'carry', 'spirit', 'crouch', 'resting', 'dodging', 'snap', 'heir', 'over', 'x', 'y', 'heading', 'seq', 'auto'];

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};

// A world for one test; `set` changes parameters, e.g. {'terrain.enabled': false}.
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// A world where nothing can happen to the player by chance: flat, no
// predators, one tribe (so no strangers to fight).
const QUIET = { 'terrain.enabled': false, 'carnivore.initial': 0, 'human.tribes': 1 };

// The index of the person with this id, or -1 once it is gone.
const at = (w, id) => w.humans.id.subarray(0, w.humans.n).indexOf(id);

// An adult of the world's first tribe with its whole life ahead of it, taken
// over in `mode`. Returns its id.
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

// Put a person somewhere (between steps), and say where the page has it.
function place(w, id, x, y) {
    const i = at(w, id);
    w.humans.x[i] = x;
    w.humans.y[i] = y;
}
let seq = 0;
const input = (w, x, y, more = {}) => applyInput(w, { seq: ++seq, x, y, heading: 0, speed: 0, crouch: false, ...more });

// Where the person is, relative to its camp (wrapped onto the torus).
const wrap = (v, size) => ((v % size) + size) % size;
const campOf = (w, id) => w.tribeById.get(w.humans.tribe[at(w, id)]).camp;

// Hash a world's state the way tools/fingerprint.mjs does.
function digest(w, steps) {
    const h = createHash('sha256');
    for (let t = 1; t <= steps; t++) {
        w.step();
        if (t % 100 === 0) h.update(`${w.herbivores.n},${w.carnivores.n},${w.humans.n},${w.tribes.length};`);
    }
    for (const pop of [w.herbivores, w.carnivores, w.humans]) {
        for (const f of ['x', 'y', 'energy']) h.update(Buffer.from(pop[f].buffer, 0, pop.n * 8));
    }
    return h.digest('hex').slice(0, 16);
}

// A Sim as the worker runs it, and a way to ask it for the next snapshot.
function startSim(set = {}, seed = 1) {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed, aspect: 1.6, params: config(set) });
    const snapshot = () => {
        sim.handle({ type: 'want' });
        return posted.filter((m) => m.type === 'snapshot').at(-1);
    };
    return { sim, snapshot };
}

// ---- taking control ----------------------------------------------------------

test('control takes over a living person and follows it', () => {
    const w = world();
    const id = w.humans.id[3];
    assert.equal(takeControl(w, id, 'god'), true);
    assert.equal(w.player.id, id);
    assert.equal(w.player.mode, 'god');
    assert.equal(w.player.tribe, w.humans.tribe[3]);
    assert.equal(w.watch, id);
});

test('control 0 lets go', () => {
    const w = world();
    takeControl(w, w.humans.id[0], 'god');
    assert.equal(takeControl(w, 0, 'god'), true);
    assert.equal(w.player, null);
});

test('control of a dead id is refused', () => {
    const w = world();
    const id = w.humans.id[0];
    w.die(w.humans, 0, 'killed');
    assert.equal(takeControl(w, id, 'god'), false, 'dead, not yet removed');
    w.step();
    assert.equal(takeControl(w, id, 'god'), false, 'dead and gone');
    assert.equal(takeControl(w, 999999, 'play'), false, 'never lived');
    assert.equal(takeControl(w, w.herbivores.id[0], 'god'), false, 'not a person');
    assert.equal(w.player, null);
    assert.equal(playerSnapshot(w), null);

    // A refusal leaves whoever is controlled in control.
    const other = w.humans.id[0];
    takeControl(w, other, 'god');
    assert.equal(takeControl(w, id, 'god'), false);
    assert.equal(w.player.id, other);

    // And through the Sim, nothing throws and the snapshot stays empty.
    const { sim, snapshot } = startSim();
    const gone = sim.world.humans.id[0];
    sim.world.die(sim.world.humans, 0, 'killed');
    sim.step();
    sim.handle({ type: 'control', id: gone, mode: 'god' });
    assert.equal(snapshot().player, null);
});

test('the Sim reports the player', () => {
    const { sim, snapshot } = startSim();
    const id = sim.world.humans.id[2];
    sim.handle({ type: 'control', id, mode: 'play' });
    const p = snapshot().player;
    for (const f of FIELDS) assert.ok(f in p, `has ${f}`);
    assert.equal(p.id, id);
    assert.equal(p.mode, 'play');
    assert.equal(p.tribe, sim.world.humans.tribe[2]);
    assert.equal(p.energy, sim.world.humans.energy[2]);
    assert.equal(p.x, sim.world.humans.x[2]);
    assert.equal(p.y, sim.world.humans.y[2]);
    assert.equal(p.spirit, defaults.play.spiritMax);
    assert.equal(p.snap, false);
    assert.equal(p.heir, 0);
    assert.equal(p.over, false);
    assert.equal(p.seq, 0);
});

test('nobody controlled → snapshot.player is null', () => {
    const { sim, snapshot } = startSim();
    assert.equal(snapshot().player, null);
    sim.step();
    assert.equal(snapshot().player, null);
    sim.handle({ type: 'control', id: sim.world.humans.id[0], mode: 'god' });
    sim.handle({ type: 'control', id: 0, mode: 'god' });
    sim.step();
    assert.equal(snapshot().player, null);
});

test('a new world forgets the player', () => {
    const { sim, snapshot } = startSim();
    sim.handle({ type: 'control', id: sim.world.humans.id[0], mode: 'god' });
    assert.ok(snapshot().player);
    sim.handle({ type: 'start', gen: 2, seed: 2, aspect: 1.6, params: config() });
    assert.equal(sim.world.player, null);
    const snap = snapshot();
    assert.equal(snap.gen, 2);
    assert.equal(snap.player, null);
});

// ---- the body follows the page -----------------------------------------------

test('an allowed move is applied', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    const x0 = w.humans.x[i];
    const y0 = w.humans.y[i];
    input(w, x0 + 0.3, y0 - 0.2, { heading: 2.5, speed: 0.36 });
    w.step();
    const j = at(w, id);
    assert.ok(Math.abs(w.humans.x[j] - wrap(x0 + 0.3, w.width)) < 1e-9);
    assert.ok(Math.abs(w.humans.y[j] - wrap(y0 - 0.2, w.height)) < 1e-9);
    assert.equal(w.humans.heading[j], 2.5);
    const p = playerSnapshot(w);
    assert.equal(p.seq, seq);
    assert.equal(p.snap, false);
});

test('a teleport is rejected and snaps back', () => {
    const w = world(QUIET);
    const id = control(w);
    const { x: cx, y: cy } = campOf(w, id);
    place(w, id, cx, cy);
    const accepted = playerSnapshot(w).seq;
    input(w, cx + 50, cy);
    w.step();
    let p = playerSnapshot(w);
    assert.equal(p.x, cx, 'stays where it was');
    assert.equal(p.y, cy);
    assert.equal(p.snap, true, 'and the page is told to jump back');
    assert.equal(p.seq, accepted, 'the rejected input is not counted');
    assert.equal(playerSnapshot(w).snap, false, 'snap is reported once');
    w.step();
    assert.equal(playerSnapshot(w).snap, false, 'a rejected input is not tried again');

    // After a long gap (a pause, a hidden page) the allowance grows, but only
    // up to maxCatchUp steps' worth.
    const Q = w.p.play;
    const top = w.p.human.speed * w.humans.speedGene[at(w, id)];
    const most = top * Q.maxCatchUp + Q.slack;
    for (let k = 0; k < 100; k++) w.step();
    input(w, cx + most + 0.5, cy);
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.x, cx);
    assert.equal(p.snap, true);
    input(w, cx + most - 0.5, cy);
    w.step();
    p = playerSnapshot(w);
    assert.ok(Math.abs(p.x - (cx + most - 0.5)) < 1e-9, 'a long but possible move is accepted');
    assert.equal(p.snap, false);
    input(w, cx + most - 0.5 + top + Q.slack + 0.1, cy);
    w.step();
    assert.equal(playerSnapshot(w).snap, true, 'one step later, more than one step (plus slack) is too far again');

    // Nonsense is rejected too, and breaks nothing.
    input(w, NaN, cy);
    w.step();
    assert.equal(playerSnapshot(w).snap, true);
    input(w, 'east', undefined);
    w.step();
    p = playerSnapshot(w);
    assert.ok(p.energy > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('input onto water is rejected', () => {
    const w = world({ 'carnivore.initial': 0 });
    const T = w.terrain;
    // A dry spot with water just east of it, and dry ground just west.
    let spot = null;
    for (let y = 5; y < w.height && !spot; y += 7) {
        for (let x = 5; x < w.width && !spot; x += 0.5) {
            if (!T.blocked(x, y) && !T.blocked(x - 1, y) && T.isWater(x + 1, y) && T.blocked(x + 1, y)) spot = { x, y };
        }
    }
    assert.ok(spot, 'the world has a shore');
    const id = control(w);
    place(w, id, spot.x, spot.y);
    input(w, spot.x + 1, spot.y);
    w.step();
    let p = playerSnapshot(w);
    assert.equal(p.x, spot.x);
    assert.equal(p.snap, true);
    input(w, spot.x - 1, spot.y);
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.x, spot.x - 1, 'dry ground is fine');
    assert.equal(p.snap, false);
});

test('input across the wrap is accepted', () => {
    const w = world(QUIET);
    const id = control(w);
    const W = w.width;
    const y = w.humans.y[at(w, id)];
    place(w, id, W - 0.2, y);
    input(w, 0.2, y); // the page wrapped it
    w.step();
    let p = playerSnapshot(w);
    assert.equal(p.snap, false);
    assert.equal(p.x, 0.2);
    input(w, -0.3, y); // and back, unwrapped
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.snap, false);
    assert.ok(Math.abs(p.x - (W - 0.3)) < 1e-9);
    place(w, id, W - 0.2, y);
    input(w, W + 0.4, y); // forward, unwrapped
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.snap, false);
    assert.ok(Math.abs(p.x - 0.4) < 1e-9);
    // Across the top and bottom edges as well.
    const x = p.x;
    place(w, id, x, 0.1);
    input(w, x, w.height - 0.4);
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.snap, false);
    assert.ok(Math.abs(p.y - (w.height - 0.4)) < 1e-9);
});

test('moving costs energy, standing costs less', () => {
    const steps = 200;
    const v = 0.4;
    const drop = (moving) => {
        const w = world(QUIET);
        const id = control(w);
        const i = at(w, id);
        const x0 = w.humans.x[i];
        const y0 = w.humans.y[i];
        const e0 = w.humans.energy[i];
        for (let k = 1; k <= steps; k++) {
            input(w, moving ? x0 + v * k : x0, y0, { speed: moving ? v : 0 });
            w.step();
        }
        const p = playerSnapshot(w);
        assert.equal(p.snap, false);
        assert.ok(Math.abs(p.x - wrap(moving ? x0 + v * steps : x0, w.width)) < 1e-6, 'it went where it was sent');
        return e0 - p.energy;
    };
    const extra = drop(true) - drop(false);
    const expected = defaults.human.moveCost * v * v * steps;
    assert.ok(Math.abs(extra - expected) < expected * 0.01, `moving cost ${extra} more; expected ${expected}`);
});

test('the controlled person ages and eats at camp like anyone', () => {
    const w = world(QUIET);
    const P = w.p.human;
    const id = control(w);
    const camp = campOf(w, id);
    let i = at(w, id);
    place(w, id, camp.x, camp.y);
    w.humans.energy[i] = 50;
    w.humans.carry[i] = 20;
    const age = w.humans.age[i];
    const cost = P.baseCost * w.humans.upkeep[i];
    w.step();
    i = at(w, id);
    assert.equal(w.humans.age[i], age + 1);
    assert.equal(w.humans.carry[i], 20, 'keeps its food at camp: E stores it (package 2)');
    assert.ok(Math.abs(w.humans.energy[i] - (0.9 * P.maxEnergy - cost)) < 1e-9, 'eats from the store when hungry');
    assert.equal(w.humans.state[i], STATE.AT_CAMP);

    // Away from camp and starving, it eats what it carries.
    place(w, id, wrap(camp.x + 100, w.width), camp.y);
    w.humans.energy[i] = 30;
    w.humans.carry[i] = 50;
    w.step();
    i = at(w, id);
    assert.ok(Math.abs(w.humans.energy[i] - (0.5 * P.maxEnergy - cost)) < 1e-9);
    assert.ok(Math.abs(w.humans.carry[i] - 5) < 1e-9);

    // And it dies of old age.
    w.humans.age[i] = w.humans.lifespan[i];
    w.step();
    assert.equal(at(w, id), -1);
    const death = w.events.find((e) => e.type === 'death' && e.id === id);
    assert.equal(death.cause, 'old age');
});

test('the posture shows in the state', () => {
    const w = world(QUIET);
    const P = w.p.human;
    const id = control(w);
    const camp = campOf(w, id);
    place(w, id, wrap(camp.x + 100, w.width), camp.y);
    const top = P.speed * w.humans.speedGene[at(w, id)];
    const state = (more) => {
        const p = playerSnapshot(w);
        input(w, p.x + (more.speed ?? 0), p.y, more);
        w.step();
        return w.humans.state[at(w, id)];
    };
    assert.equal(state({ speed: top }), STATE.RUNNING);
    assert.equal(state({ speed: top * P.cruise }), STATE.WALKING);
    assert.equal(state({ speed: top * w.p.play.crouchSpeed, crouch: true }), STATE.CREEPING);
    assert.equal(state({ speed: 0 }), STATE.WALKING, 'standing, away from camp');
    place(w, id, camp.x, camp.y);
    assert.equal(state({ speed: 0 }), STATE.AT_CAMP, 'standing at camp');
});

test('an uncontrolled world is unchanged', () => {
    const a = world();
    const b = world();
    assert.ok(takeControl(b, b.humans.id[0], 'god'));
    takeControl(b, 0, 'god');
    assert.equal(digest(a, 3000), digest(b, 3000));
});

// ---- rules for the player alone: bites, rolls, crouching, resting ------------

// Far from its camp (and so from its tribe-mates, who could drive a predator
// off): the point of the world farthest from every camp.
function faraway(w, id) {
    let best = null;
    for (let y = 0; y < w.height; y += 20) {
        for (let x = 0; x < w.width; x += 20) {
            let near = Infinity;
            for (const t of w.tribes) {
                const dx = Math.abs(t.camp.x - x);
                const dy = Math.abs(t.camp.y - y);
                near = Math.min(near, Math.hypot(Math.min(dx, w.width - dx), Math.min(dy, w.height - dy)));
            }
            if (!best || near > best.near) best = { x, y, near };
        }
    }
    place(w, id, best.x, best.y);
    return best;
}

// A hungry, rested predator `dx` east of the person `id`: it catches it this step.
function predatorBeside(w, id, dx = 1) {
    const i = at(w, id);
    const c = w.carnivores;
    c.x[0] = wrap(w.humans.x[i] + dx, w.width);
    c.y[0] = w.humans.y[i];
    c.energy[0] = 50;
    c.timer[0] = 0;
    c.age[0] = 1000;
    c.lifespan[0] = w.p.carnivore.lifespan;
    return c.id[0];
}
const predator = (w, id) => w.carnivores.id.subarray(0, w.carnivores.n).indexOf(id);
const happened = (w, type, id) => w.events.filter((e) => e.type === type && (e.id === id || e.from === id));

// Flat, one tribe: the only danger is the predator a test puts there.
const WILD = { 'terrain.enabled': false, 'human.tribes': 1 };

test('a predator bites the player instead of killing', () => {
    const w = world(WILD);
    const id = control(w);
    faraway(w, id);
    const c = predatorBeside(w, id);
    const i = at(w, id);
    const e0 = w.humans.energy[i];
    const cost = w.p.human.baseCost * w.humans.upkeep[i];
    w.step();
    const j = at(w, id);
    assert.ok(j >= 0, 'still alive');
    assert.ok(Math.abs(e0 - cost - w.humans.energy[j] - 60) < 1e-9, 'down 60');
    const [bite] = happened(w, 'bite', id);
    assert.ok(bite, 'a bite event');
    assert.equal(bite.by, c);
    assert.equal(bite.damage, 60);
    assert.equal(bite.time, w.time - 1);
    assert.ok(Number.isFinite(bite.x) && Number.isFinite(bite.y));
    assert.equal(happened(w, 'death', id).length, 0);
    const k = predator(w, c);
    assert.equal(w.carnivores.state[k], STATE.RESTING, 'the predator backs off');
    assert.equal(w.carnivores.timer[k], w.p.carnivore.rest);
});

test('a roll makes the bite miss', () => {
    const w = world(WILD);
    const id = control(w);
    faraway(w, id);
    const c = predatorBeside(w, id);
    const e0 = w.humans.energy[at(w, id)];
    applyAct(w, { seq: ++seq, action: 'roll' });
    assert.equal(playerSnapshot(w).dodging, true);
    w.step();
    assert.equal(happened(w, 'bite', id).length, 0);
    const [dodge] = happened(w, 'dodge', id);
    assert.ok(dodge, 'a dodge event');
    assert.equal(dodge.by, c);
    assert.equal(dodge.time, w.time - 1);
    assert.equal(w.carnivores.state[predator(w, c)], STATE.CHASING, 'the chase goes on');
    assert.ok(e0 - w.humans.energy[at(w, id)] < 1, 'only the cost of living');
    assert.equal(w.humans.state[at(w, id)], STATE.ROLLING);

    // The roll lasts rollSteps steps; then the predator, still on its heels, bites.
    let dodges = 1;
    for (let k = 1; k < w.p.play.rollSteps; k++) {
        w.step();
        dodges += happened(w, 'dodge', id).length;
    }
    assert.equal(dodges, w.p.play.rollSteps);
    assert.equal(playerSnapshot(w).dodging, false);
    w.step();
    assert.equal(happened(w, 'bite', id).length, 1);
});

test('a second bite at low energy kills', () => {
    const w = world(WILD);
    const id = control(w);
    faraway(w, id);
    w.humans.energy[at(w, id)] = 100;
    const c = predatorBeside(w, id);
    w.step();
    assert.ok(at(w, id) >= 0);
    assert.ok(w.humans.energy[at(w, id)] < 40);
    predatorBeside(w, id); // hungry and rested again
    w.step();
    assert.equal(at(w, id), -1, 'dead');
    assert.equal(happened(w, 'bite', id).length, 1);
    const deaths = happened(w, 'death', id);
    assert.equal(deaths.length, 1);
    assert.equal(deaths[0].cause, 'eaten');
    assert.equal(deaths[0].by, c);
    const k = predator(w, c);
    assert.equal(w.carnivores.state[k], STATE.EATING, 'and it eats');
    assert.equal(w.carnivores.kills[k], 1);
});

test('a crouched player is not noticed from afar', () => {
    const w = world(QUIET);
    const H = w.p.herbivore;
    const id = control(w);
    const spot = faraway(w, id);
    const grazer = (d) => {
        const h = w.herbivores;
        h.x[0] = spot.x + d * H.sense * h.senseGene[0];
        h.y[0] = spot.y;
        h.energy[0] = 50;
        h.age[0] = 100;
        w.grass.g[w.grass.index(h.x[0], h.y[0])] = 1; // good grass: no reason to move but fear
        return h.id[0];
    };
    const stateOf = (hid) => w.herbivores.state[w.herbivores.id.subarray(0, w.herbivores.n).indexOf(hid)];
    input(w, spot.x, spot.y, { crouch: true });
    assert.equal(playerSnapshot(w).crouch, true);
    const far = grazer(0.7);
    w.step();
    assert.equal(stateOf(far), STATE.GRAZING, 'unnoticed at 0.7 of its range');
    assert.equal(w.humans.state[at(w, id)], STATE.CREEPING);
    w.step();
    assert.equal(stateOf(far), STATE.GRAZING, 'still');
    input(w, spot.x, spot.y, { crouch: false });
    w.step();
    assert.equal(stateOf(far), STATE.FLEEING, 'standing up gives it away');

    // Within crouchSense of its range it notices even a crouching player.
    const near = grazer(0.4);
    input(w, spot.x, spot.y, { crouch: true });
    w.step();
    assert.equal(stateOf(near), STATE.FLEEING);
});

test('resting at camp refills spirit and feeds the hungry', () => {
    const w = world({ ...WILD, 'human.defend': 0 });
    const P = w.p.human;
    const Q = w.p.play;
    const id = control(w);
    const camp = campOf(w, id);
    const cost = P.baseCost * w.humans.upkeep[at(w, id)];

    // Not away from camp.
    place(w, id, wrap(camp.x + 100, w.width), camp.y);
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    assert.equal(playerSnapshot(w).resting, false);

    place(w, id, camp.x, camp.y);
    w.humans.energy[at(w, id)] = 50;
    w.player.spirit = 10;
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    assert.equal(playerSnapshot(w).resting, true);
    for (let k = 0; k < 10; k++) w.step();
    let p = playerSnapshot(w);
    assert.equal(p.resting, true);
    assert.ok(Math.abs(p.spirit - (10 + 10 * (Q.spiritRegen + Q.spiritRest))) < 1e-9);
    assert.ok(Math.abs(p.energy - (0.9 * P.maxEnergy - 10 * cost)) < 1e-9, 'fed from the store');
    assert.equal(w.humans.state[at(w, id)], STATE.AT_CAMP);
    w.player.spirit = Q.spiritMax - 0.5;
    w.step();
    assert.equal(playerSnapshot(w).spirit, Q.spiritMax, 'up to spiritMax');

    // The page stands it up.
    applyAct(w, { seq: ++seq, action: 'rest', on: false });
    w.player.spirit = 10;
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.resting, false);
    assert.ok(Math.abs(p.spirit - (10 + Q.spiritRegen)) < 1e-9, 'slowly when not resting');

    // A bite stands it up too.
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    predatorBeside(w, id);
    w.step();
    assert.equal(happened(w, 'bite', id).length, 1);
    assert.equal(playerSnapshot(w).resting, false);

    // And so does walking out of camp.
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    assert.equal(playerSnapshot(w).resting, true);
    place(w, id, wrap(camp.x + P.campRadius + 1, w.width), camp.y);
    w.step();
    assert.equal(playerSnapshot(w).resting, false);

    applyAct(w, { seq: ++seq, action: 'dance' }); // unknown actions are ignored
    assert.equal(playerSnapshot(w).resting, false);
});

test('bite and fight in one step leave a consistent person', () => {
    // The player is caught by a predator and, in the same step, attacked by a
    // hawkish stranger who cannot see the predator (it sees only 5 units).
    const outcome = (energy) => {
        const w = world({ 'terrain.enabled': false, 'human.tribes': 2, 'human.defend': 0 });
        const pop = w.humans;
        const id = control(w);
        const spot = faraway(w, id);
        pop.energy[at(w, id)] = energy;
        const mine = pop.tribe[at(w, id)];
        let s = 0;
        while (pop.tribe[s] === mine || pop.age[s] < w.p.human.maturity) s++;
        const stranger = pop.id[s];
        w.tribeById.get(pop.tribe[s]).aggression = 1; // always a hawk
        pop.senseGene[s] = 5 / w.p.human.sense;
        pop.energy[s] = 140;
        place(w, stranger, spot.x - 6, spot.y);
        predatorBeside(w, id, 3);
        w.step();
        for (let k = 0; k < pop.n; k++) assert.ok(pop.energy[k] > 0, 'nobody alive with no energy');
        return { w, id, stranger, deaths: happened(w, 'death', id), bites: happened(w, 'bite', id) };
    };

    // Bitten, then beaten to death by the stranger.
    let r = outcome(80);
    assert.equal(r.bites.length, 1);
    assert.equal(r.deaths.length, 1, 'one death, not two');
    assert.equal(r.deaths[0].cause, 'killed');
    assert.equal(r.deaths[0].by, r.stranger);
    assert.equal(at(r.w, r.id), -1);

    // Killed by the bite: the stranger finds nobody to rob.
    r = outcome(50);
    assert.equal(r.deaths.length, 1);
    assert.equal(r.deaths[0].cause, 'eaten');
    assert.equal(at(r.w, r.id), -1);

    // Survives both.
    r = outcome(140);
    assert.equal(r.bites.length, 1);
    assert.equal(r.deaths.length, 0);
    const e = r.w.humans.energy[at(r.w, r.id)];
    assert.ok(e > 0 && e < 140 - 60 - r.w.p.human.fightDamage + 1, `bitten and beaten: ${e}`);
});

// ---- heirs ---------------------------------------------------------------------

// The person `id` dies of old age in the next step.
const doom = (w, id) => {
    const i = at(w, id);
    w.humans.age[i] = w.humans.lifespan[i];
};

// The eldest living person matching `keep`, or 0.
function eldest(w, keep) {
    const pop = w.humans;
    let best = -1;
    for (let k = 0; k < pop.n; k++) if (keep(k) && (best < 0 || pop.age[k] > pop.age[best])) best = k;
    return best < 0 ? 0 : pop.id[best];
}

// Some living adult with a living child, after the world has had time for births.
function parentWithChild(w) {
    for (let t = 0; t < 3000; t++) {
        w.step();
        const pop = w.humans;
        for (let k = 0; k < pop.n; k++) {
            if (pop.age[k] < w.p.human.maturity || pop.age[k] > pop.lifespan[k] - 100) continue;
            if (eldest(w, (c) => pop.parent[c] === pop.id[k])) return pop.id[k];
        }
    }
    assert.fail('no births in 3000 steps');
}

test('death passes control to a child', () => {
    for (const mode of ['god', 'play']) {
        const w = world();
        const pop = w.humans;
        const id = parentWithChild(w);
        assert.ok(takeControl(w, id, mode));
        // In Play, the line goes on even in another tribe (after a split), and
        // then that is the tribe you lead.
        const child = eldest(w, (c) => pop.parent[c] === id);
        const other = w.tribes.find((t) => t.id !== pop.tribe[at(w, id)]);
        if (mode === 'play') pop.tribe[at(w, child)] = other.id;
        doom(w, id);
        w.step();
        assert.equal(at(w, id), -1);
        assert.ok(at(w, child) >= 0, 'the child lives');
        assert.equal(w.player.id, child, mode);
        assert.equal(w.watch, child, 'and is followed');
        assert.equal(w.player.mode, mode);
        if (mode === 'play') assert.equal(w.player.tribe, other.id);
        const [heir] = happened(w, 'heir', id);
        assert.deepEqual(heir, { type: 'heir', from: id, to: child, parent: id, time: w.time - 1 });
        const p = playerSnapshot(w);
        assert.equal(p.id, child);
        assert.equal(p.heir, child);
        assert.equal(p.snap, true, 'the page must jump to the new body');
        assert.equal(p.x, pop.x[at(w, child)]);
    }
});

test('a grandchild carries on when there are no children', () => {
    const w = world();
    const pop = w.humans;
    const id = parentWithChild(w);
    assert.ok(takeControl(w, id, 'god'));
    // Make its children grandchildren instead (their parent: some child of
    // its, long gone). They are still tagged as its line (World.follow).
    for (let k = 0; k < pop.n; k++) if (pop.parent[k] === id) pop.parent[k] = 999999;
    const expected = w.descendant(id);
    assert.ok(expected);
    doom(w, id);
    w.step();
    assert.equal(w.player.id, expected, 'still of its line (World.descendant)');
});

test('without descendants, the eldest adult tribe-mate takes over', () => {
    const w = world();
    const pop = w.humans;
    const id = control(w);
    const tribe = pop.tribe[at(w, id)];
    doom(w, id);
    w.step();
    const expected = eldest(w, (k) => pop.tribe[k] === tribe);
    assert.ok(pop.age[at(w, expected)] >= w.p.human.maturity, 'an adult');
    assert.equal(w.player.id, expected);
    assert.equal(w.player.tribe, tribe);
    assert.equal(happened(w, 'heir', id).length, 1);

    // With no adults left, the eldest child.
    const adult = w.player.id;
    for (let k = 0; k < pop.n; k++) if (pop.tribe[k] === tribe && pop.id[k] !== adult && pop.age[k] >= w.p.human.maturity) w.die(pop, k, 'killed');
    doom(w, adult);
    w.step();
    const child = eldest(w, (k) => pop.tribe[k] === tribe);
    assert.ok(child, 'children are left');
    assert.equal(w.player.id, child);
});

// Everyone in the controlled person's tribe dies, and it dies in the next step.
function endLine(w, id) {
    const pop = w.humans;
    const tribe = pop.tribe[at(w, id)];
    for (let k = 0; k < pop.n; k++) if (pop.tribe[k] === tribe && pop.id[k] !== id) w.die(pop, k, 'killed');
    doom(w, id);
}

test('God mode with nobody left releases', () => {
    const w = world({ 'human.tribes': 2 });
    const id = control(w, 'god');
    endLine(w, id);
    w.step();
    assert.equal(w.player, null);
    assert.equal(playerSnapshot(w), null);
    const released = w.events.filter((e) => e.type === 'released');
    assert.deepEqual(released, [{ type: 'released', reason: 'no heir', time: w.time - 1 }]);
    w.step();
});

test('Play mode with nobody left is over', () => {
    const w = world({ 'human.tribes': 2 });
    const id = control(w, 'play');
    const i = at(w, id);
    const where = { x: w.humans.x[i], y: w.humans.y[i] };
    input(w, where.x, where.y, { crouch: true });
    endLine(w, id);
    w.step();
    assert.ok(w.player, 'still a player...');
    assert.equal(w.player.over, true, '...whose game is over');
    assert.equal(w.player.id, 0);
    const over = w.events.filter((e) => e.type === 'over');
    assert.deepEqual(over, [{ type: 'over', time: w.time - 1 }]);
    let p = playerSnapshot(w);
    for (const f of FIELDS) assert.ok(f in p, `has ${f}`);
    assert.equal(p.id, 0);
    assert.equal(p.over, true);
    assert.equal(p.mode, 'play');
    assert.equal(p.crouch, false, 'no body, no posture');
    assert.ok(Math.abs(p.x - where.x) < 2 && Math.abs(p.y - where.y) < 2, 'where the line ended');

    // It stays over, whatever the page sends...
    input(w, p.x, p.y);
    applyAct(w, { seq: ++seq, action: 'roll' });
    for (let k = 0; k < 10; k++) w.step();
    assert.equal(w.events.filter((e) => e.type === 'over').length, 0, 'reported once');
    p = playerSnapshot(w);
    assert.equal(p.over, true);
    assert.equal(p.id, 0);
    assert.equal(p.dodging, false);

    // ...until a new game.
    const next = w.humans.id[0];
    assert.ok(takeControl(w, next, 'play'));
    assert.equal(w.player.over, false);
    assert.equal(playerSnapshot(w).id, next);
});

test('heir is reported for one snapshot', () => {
    const { sim, snapshot } = startSim();
    const w = sim.world;
    const id = control(w);
    sim.handle({ type: 'control', id, mode: 'god' });
    const before = snapshot().player;
    sim.handle({ type: 'input', seq: 100, x: before.x, y: before.y, heading: 0, speed: 0, crouch: false });
    sim.step();
    assert.equal(snapshot().player.seq, 100);
    doom(w, id);
    sim.step();
    const snap = snapshot();
    const heir = w.player.id;
    assert.notEqual(heir, id);
    assert.equal(snap.player.id, heir);
    assert.equal(snap.player.heir, heir);
    assert.equal(snap.player.snap, true);
    assert.ok(snap.events.some((e) => e.type === 'heir' && e.from === id && e.to === heir));
    assert.ok(snap.events.some((e) => e.type === 'death' && e.id === id));
    sim.step();
    const later = snapshot();
    assert.notEqual(later, snap);
    assert.equal(later.player.id, heir);
    assert.equal(later.player.heir, 0);
    assert.equal(later.player.snap, false);

    // The page may number the new body's inputs from scratch.
    assert.equal(later.player.seq, 0);
    sim.handle({ type: 'input', seq: 1, x: later.player.x + 0.2, y: later.player.y, heading: 0, speed: 0.2, crouch: false });
    sim.step();
    const moved = snapshot().player;
    assert.equal(moved.seq, 1);
    assert.equal(moved.snap, false);
    assert.ok(Math.abs(moved.x - wrap(later.player.x + 0.2, w.width)) < 1e-9);
});

// ---- autopilot: the map view, where the person carries on under the AI ---------

const auto = (w, on) => applyAct(w, { seq: ++seq, action: 'auto', on });

test('autopilot runs the AI and keeps the heir rules', () => {
    // On autopilot the controlled person lives exactly as if nobody
    // controlled it, whatever the page sends, through deaths and heirs.
    const a = world();
    const b = world();
    const id = b.humans.id[0];
    assert.ok(takeControl(b, id, 'god'));
    assert.equal(playerSnapshot(b).auto, false, 'control starts by hand');
    auto(b, true);
    assert.equal(playerSnapshot(b).auto, true);
    const steer = () => {
        const p = playerSnapshot(b);
        if (p === null) return;
        applyInput(b, { seq: ++seq, x: p.x + 1, y: p.y, heading: 1, speed: 0.7, crouch: true });
        applyAct(b, { seq: ++seq, action: 'roll' });
        applyAct(b, { seq: ++seq, action: 'rest', on: true });
    };
    const ha = createHash('sha256');
    const hb = createHash('sha256');
    for (let t = 1; t <= 3000; t++) {
        steer();
        a.step();
        b.step();
        for (const [w, h] of [[a, ha], [b, hb]]) {
            h.update(`${w.herbivores.n},${w.carnivores.n},${w.humans.n},${w.tribes.length};`);
            for (const pop of [w.herbivores, w.carnivores, w.humans]) {
                for (const f of ['x', 'y', 'energy', 'state']) h.update(Buffer.from(pop[f].buffer, 0, pop.n * pop[f].BYTES_PER_ELEMENT));
            }
        }
    }
    assert.equal(ha.digest('hex'), hb.digest('hex'), 'the same world, step by step');
    const p = playerSnapshot(b);
    assert.ok(p, 'still controlled (an heir, or the same person)');
    assert.equal(p.auto, true);
    assert.equal(p.seq, 0, 'no input was taken');
    assert.equal(p.crouch, false);
    assert.equal(p.dodging, false);
    assert.equal(p.resting, false);

    // Heirs while on autopilot, and they stay on it.
    const w = world();
    const first = control(w);
    auto(w, true);
    doom(w, first);
    w.step();
    assert.equal(happened(w, 'heir', first).length, 1);
    assert.notEqual(w.player.id, first);
    assert.equal(playerSnapshot(w).auto, true);

    // A Play game can end while you watch the map.
    const v = world({ 'human.tribes': 2 });
    const mine = control(v, 'play');
    auto(v, true);
    endLine(v, mine);
    v.step();
    assert.equal(v.events.filter((e) => e.type === 'over').length, 1);
    assert.equal(playerSnapshot(v).over, true);

    // And God mode lets go.
    const g = world({ 'human.tribes': 2 });
    const one = control(g, 'god');
    auto(g, true);
    endLine(g, one);
    g.step();
    assert.equal(g.player, null);
    assert.equal(g.events.filter((e) => e.type === 'released').length, 1);
});

test('autopilot off snaps the page to the body', () => {
    const { sim, snapshot } = startSim(QUIET);
    const w = sim.world;
    const id = control(w);
    sim.handle({ type: 'control', id, mode: 'god' });
    const start = snapshot().player;
    sim.handle({ type: 'input', seq: 50, x: start.x, y: start.y, heading: 0, speed: 0, crouch: false });
    sim.step();
    assert.equal(snapshot().player.seq, 50);
    sim.handle({ type: 'act', seq: 51, action: 'auto', on: true });
    for (let k = 0; k < 300; k++) sim.step();
    const away = snapshot().player;
    assert.equal(away.auto, true);
    assert.equal(away.snap, false);
    assert.ok(Math.hypot(away.x - start.x, away.y - start.y) > 1, 'the AI walked it somewhere');
    assert.equal(w.humans.state[at(w, id)] < STATE.WALKING, true, 'in a state of the AI');

    sim.handle({ type: 'act', seq: 52, action: 'auto', on: false });
    const back = snapshot().player;
    assert.equal(back.auto, false);
    assert.equal(back.snap, true, 'the page must jump to where the AI left it');
    assert.equal(back.seq, 0, 'inputs numbered afresh');
    assert.equal(back.x, w.humans.x[at(w, id)]);
    assert.equal(back.y, w.humans.y[at(w, id)]);

    // Then the page steers it again from there.
    sim.handle({ type: 'input', seq: 1, x: back.x + 0.3, y: back.y, heading: 0, speed: 0.3, crouch: false });
    sim.step();
    const moved = snapshot().player;
    assert.equal(moved.snap, false);
    assert.equal(moved.seq, 1);
    assert.ok(Math.abs(moved.x - wrap(back.x + 0.3, w.width)) < 1e-9);
});

test('bites kill on autopilot', () => {
    const w = world(WILD);
    const id = control(w);
    faraway(w, id);
    auto(w, true);
    applyAct(w, { seq: ++seq, action: 'roll' }); // no rolling on autopilot
    const c = predatorBeside(w, id);
    w.step();
    assert.equal(at(w, id), -1, 'eaten, as anyone would be');
    assert.equal(happened(w, 'bite', id).length, 0);
    assert.equal(happened(w, 'dodge', id).length, 0);
    const [death] = happened(w, 'death', id);
    assert.equal(death.cause, 'eaten');
    assert.equal(death.by, c);
    assert.equal(happened(w, 'heir', id).length, 1, 'and the line carries on');
    assert.equal(playerSnapshot(w).auto, true);
});
