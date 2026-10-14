// The save system (src/save.js): a world run N steps, saved, loaded and run
// M more must be the very world run N + M steps without saving, to the bit
// (tools/fingerprint.mjs's trail, and every saved field besides); on several
// seeds, with items on and off, on a flat world, at night, and with a person
// played mid-hunt (a spear in flight, a kill on the ground), a rally under
// way, an item being made, and acts and calls waiting for the next step.
// And a save from another version is refused; a file round-trips; the Sim
// answers save and load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Sim, setParam, startHash } from '../src/sim.js';
import { takeControl, applyInput, applyAct } from '../src/player.js';
import { KIND } from '../src/items.js';
import { createRng } from '../src/rng.js';
import { wrapDelta, wrapPos, livingIndexOf } from '../src/util.js';
import { saveWorld, loadWorld, packFile, unpackFile, saveSize, SaveError, SAVE_VERSION } from '../src/save.js';
import { Trail } from '../tools/fingerprint.mjs';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};

// Two saves hold the same world: the same state, to the byte.
function same(a, b, what) {
    if (a.json !== b.json) {
        let k = 0;
        while (k < a.json.length && a.json[k] === b.json[k]) k++;
        assert.fail(`${what}: the states differ at ${k}:\n  ${a.json.slice(Math.max(0, k - 160), k + 80)}\n  ${b.json.slice(Math.max(0, k - 160), k + 80)}`);
    }
    assert.deepEqual(Object.keys(a.bins), Object.keys(b.bins), what);
    for (const k of Object.keys(a.bins)) {
        const x = Buffer.from(a.bins[k].buffer, a.bins[k].byteOffset, a.bins[k].byteLength);
        const y = Buffer.from(b.bins[k].buffer, b.bins[k].byteOffset, b.bins[k].byteLength);
        assert.ok(x.equals(y), `${what}: ${k} differs`);
    }
}

// ---- A person played, by a driver that decides from the world alone --------------
//
// So the world run straight and the world saved and loaded hear the same
// acts at the same steps, exactly when they are the same world.

const P = (w) => w.player;
const self = (w) => (w.player && w.player.id ? livingIndexOf(w.humans, w.player.id) : -1);
const seqOf = (w) => w.time + 1; // inputs numbered by the step (always above the last accepted)

function nearestGrazer(w, x, y, r) {
    const G = w.herbivores;
    let best = -1;
    let bestD2 = r * r;
    for (let j = 0; j < G.n; j++) {
        if (G.energy[j] <= 0) continue;
        const dx = wrapDelta(G.x[j] - x, w.width);
        const dy = wrapDelta(G.y[j] - y, w.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = j;
        }
    }
    return best;
}

// At step `pre`: take over an adult of the tribe with the most adults, at its
// camp with three of its adults near (a rally finds them), the store
// stocked (with items, it starts making a knife, with a flint more), and a
// rally called.
function setup(w) {
    const pop = w.humans;
    const tribe = [...w.tribes].sort((a, b) => b.adults - a.adults || a.id - b.id)[0];
    const adults = [];
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === tribe.id && pop.age[i] >= w.p.human.maturity && pop.energy[i] > 0) adults.push(i);
    assert.ok(adults.length >= 2, 'a tribe with adults');
    const i = adults[0];
    pop.energy[i] = w.p.human.maxEnergy;
    pop.lifespan[i] = Math.max(pop.lifespan[i], pop.age[i] + 1e6);
    adults.slice(0, 4).forEach((k, n) => {
        pop.x[k] = wrapPos(tribe.camp.x + 2 * n, w.width);
        pop.y[k] = wrapPos(tribe.camp.y + n, w.height);
    });
    assert.ok(takeControl(w, pop.id[i], 'play'));
    if (w.itemsOn) {
        tribe.wood += 40;
        tribe.flint += 40;
        tribe.hide += 10;
        applyAct(w, { seq: seqOf(w), action: 'craft', kind: KIND.KNIFE, flint: true });
    }
    applyAct(w, { seq: seqOf(w), action: 'call', kind: 'rally', x: pop.x[i], y: pop.y[i] });
}

// Before each step: what the person does, by the step.
function drive(w, pre, saveAt) {
    const t = w.time;
    if (t === pre) return setup(w);
    if (t < pre) return;
    const i = self(w);
    if (i < 0) return;
    const pl = P(w);
    const pop = w.humans;
    const x = pop.x[i];
    const y = pop.y[i];
    if (t === pre + 5) {
        // A grazer put right in front: a heavy throw, locked on to it (a kill to butcher).
        const j = nearestGrazer(w, x, y, 1e9);
        w.herbivores.x[j] = wrapPos(x + 8, w.width);
        w.herbivores.y[j] = y;
        applyAct(w, { seq: seqOf(w), action: 'attack', heavy: true, power: 1, dx: 1, dy: 0, target: w.herbivores.id[j], lock: true });
        return;
    }
    if (t === saveAt - 1) {
        // Into the blue: a spear in flight when the world is saved.
        applyAct(w, { seq: seqOf(w), action: 'attack', heavy: true, power: 1, dx: -1, dy: 0, target: 0, lock: false });
        return;
    }
    if (t < saveAt + 320) return; // (the knife is made where it stands)
    if (t === saveAt + 700) applyAct(w, { seq: seqOf(w), action: 'auto', on: true });   // to the map: the AI walks it
    if (t === saveAt + 900) applyAct(w, { seq: seqOf(w), action: 'auto', on: false });  // and back
    if (pl.auto) return;
    // Hunting: after the nearest grazer, a throw from close, butchering a kill.
    for (const c of w.carcasses.values()) {
        if (c.by !== pl.id || pl.butcher === c.id) continue;
        const d = Math.hypot(wrapDelta(c.x - x, w.width), wrapDelta(c.y - y, w.height));
        if (d < 3) {
            applyAct(w, { seq: seqOf(w), action: 'butcher', on: true, id: c.id });
            return;
        }
    }
    if (pl.butcher) return;
    const j = nearestGrazer(w, x, y, 150);
    if (j < 0) return;
    const dx = wrapDelta(w.herbivores.x[j] - x, w.width);
    const dy = wrapDelta(w.herbivores.y[j] - y, w.height);
    const d = Math.hypot(dx, dy) || 1;
    if (d < 13 && pop.timer[i] === 0) {
        applyAct(w, { seq: seqOf(w), action: 'attack', heavy: false, dx: dx / d, dy: dy / d, target: w.herbivores.id[j], lock: true });
    } else if (t % 2 === 0) {
        const v = Math.min(d - 6, w.p.human.speed * pop.speedGene[i]);
        if (v > 0) applyInput(w, { seq: seqOf(w), x: x + (dx / d) * v * 2, y: y + (dy / d) * v * 2, heading: Math.atan2(dy, dx), speed: v, crouch: d < 30 });
    }
}

// Between steps, right before the save: acts and calls waiting for the next
// step, and a move the page has proposed.
function waiting(w) {
    const i = self(w);
    if (i < 0) return;
    const pop = w.humans;
    applyAct(w, { seq: seqOf(w), action: 'eat' });
    applyAct(w, { seq: seqOf(w), action: 'call', kind: 'hunt', x: pop.x[i] + 40, y: pop.y[i] });
    applyInput(w, { seq: seqOf(w), x: pop.x[i], y: pop.y[i], heading: pop.heading[i], speed: 0, crouch: false });
}

// Run `w` from its time to step `to`, the driver deciding before each step.
function run(w, trail, to, play) {
    while (w.time < to) {
        if (play) drive(w, play.pre, play.saveAt);
        w.step();
        trail.step(w, w.time);
    }
}

// The test: a world run straight to N + M, and the same world saved at N,
// loaded, and run on to N + M, must leave the same trail and the same state.
function saveLoadContinue({ seed, set = {}, N, M, play = false }) {
    const p = config(set);
    const straight = new World(p, { seed, aspect: 1.6 });
    const saved = new World(p, { seed, aspect: 1.6 });
    const ts = new Trail();
    const tl = new Trail();
    const plan = play ? { pre: N - 40, saveAt: N } : null;
    run(straight, ts, N, plan);
    run(saved, tl, N, plan);
    if (play) {
        waiting(straight);
        waiting(saved);
    }
    const t0 = performance.now();
    const data = saveWorld(saved);
    const ms = performance.now() - t0;
    const loaded = loadWorld(data);
    same(saveWorld(loaded), data, `seed ${seed}: loaded at once`);
    run(straight, ts, N + M, plan);
    run(loaded, tl, N + M, plan);
    assert.equal(tl.digest(loaded), ts.digest(straight), `seed ${seed}: the trail`);
    same(saveWorld(loaded), saveWorld(straight), `seed ${seed}: at the end`);
    return { data, ms, loaded, straight, saved };
}

test('the rng: state() and restore() carry on the same stream, and draw nothing', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let k = 0; k < 7; k++) a.next();
    a.gauss(); // (a spare cached)
    for (let k = 0; k < 7; k++) b.next();
    b.gauss();
    const s = a.state();
    assert.equal(a.next(), b.next());
    const c = createRng(1);
    c.restore(s);
    const d = createRng(9);
    d.restore(JSON.parse(JSON.stringify(s)));
    assert.equal(c.gauss(), d.gauss()); // the spare
    for (let k = 0; k < 100; k++) assert.equal(c.next(), d.next());
    // A fresh stream's state, before any draw (a seed above 2^31).
    const e = createRng(0xfffffff0);
    const f = createRng(3);
    f.restore(e.state());
    for (let k = 0; k < 10; k++) assert.equal(e.next(), f.next());
});

test('save, load, continue = run straight: an uncontrolled world, items on (seeds 1, 2)', () => {
    for (const seed of [1, 2]) saveLoadContinue({ seed, N: 1500, M: 1500 });
});

test('save, load, continue = run straight: at night, across the dawn (seed 3)', () => {
    const { data } = saveLoadContinue({ seed: 3, N: 3300, M: 1300 });
    const s = JSON.parse(data.json);
    assert.equal(s.world.night, true, 'saved at night');
});

test('save, load, continue = run straight: items off (seeds 4, 5)', () => {
    for (const seed of [4, 5]) saveLoadContinue({ seed, set: { 'items.enabled': false }, N: 1500, M: 1500 });
});

test('save, load, continue = run straight: a person played mid-hunt, a rally under way, a knife being made', () => {
    for (const seed of [1, 6]) {
        const { saved, loaded, straight } = saveLoadContinue({ seed, N: 1600, M: 1600, play: true });
        // What the save caught under way.
        const s = JSON.parse(saveWorld(saved).json).world.player;
        assert.ok(s, 'a player');
        assert.ok(s.crafting && s.crafting.kind === KIND.KNIFE, 'a knife being made');
        assert.ok(s.rally && s.rally.until > saved.time, 'a rally under way');
        assert.ok(s.acts.length >= 1 && s.calls.length >= 1 && s.input, 'acts, calls and a move waiting');
        assert.ok(saved.spears.n >= 1, 'a spear in flight');
        assert.ok(saved.carcasses.size >= 1, 'kills on the ground');
        // And it played on: the knife made, grazers hunted.
        assert.equal(loaded.player.id, straight.player.id);
        const i = self(loaded);
        assert.ok(i >= 0, 'alive');
        assert.ok(loaded.humans.crafted[i] >= 1, 'the knife made');
        assert.ok(loaded.humans.kills[i] >= 2, `kills: ${loaded.humans.kills[i]}`);
    }
});

test('the comparison is not blind: one draw off, and the trail differs', () => {
    const p = config();
    const a = new World(p, { seed: 2, aspect: 1.6 });
    const ta = new Trail();
    const tb = new Trail();
    run(a, ta, 600, null);
    const b = loadWorld(saveWorld(a));
    b.rng.next();
    for (const k of Object.keys(ta)) tb[k] = ta[k].copy();
    run(a, ta, 1200, null);
    run(b, tb, 1200, null);
    assert.notEqual(tb.digest(b), ta.digest(a));
});

test('save, load, continue = run straight: a person played with items off, and on a flat world', () => {
    saveLoadContinue({ seed: 7, set: { 'items.enabled': false }, N: 1400, M: 1400, play: true });
    saveLoadContinue({ seed: 8, set: { 'terrain.enabled': false }, N: 1400, M: 1400, play: true });
});

test('saving changes nothing in the world saved', () => {
    const p = config();
    const a = new World(p, { seed: 9, aspect: 1.6 });
    const b = new World(p, { seed: 9, aspect: 1.6 });
    const ta = new Trail();
    const tb = new Trail();
    run(a, ta, 800, { pre: 760, saveAt: 800 });
    run(b, tb, 800, { pre: 760, saveAt: 800 });
    saveWorld(a);
    saveWorld(a);
    run(a, ta, 1600, { pre: 760, saveAt: 800 });
    run(b, tb, 1600, { pre: 760, saveAt: 800 });
    assert.equal(ta.digest(a), tb.digest(b));
});

test('a save is small and quick', (t) => {
    const w = new World(config(), { seed: 2, aspect: 1.6 });
    for (let k = 0; k < 3000; k++) w.step();
    saveWorld(w); // (warm)
    let ms = Infinity;
    let data;
    for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        data = saveWorld(w);
        ms = Math.min(ms, performance.now() - t0);
    }
    const t0 = performance.now();
    loadWorld(data);
    const loadMs = performance.now() - t0;
    const bytes = saveSize(data);
    const file = packFile({ data, page: null, savedAt: 0 }).byteLength;
    t.diagnostic(`save ${ms.toFixed(1)} ms, ${(bytes / 1e6).toFixed(2)} MB (file ${(file / 1e6).toFixed(2)} MB), load ${loadMs.toFixed(0)} ms; ${w.herbivores.n}/${w.carnivores.n}/${w.humans.n}, ${w.items.size} items`);
    assert.ok(bytes < 2.5e6, `${bytes} bytes`);
    assert.ok(ms < 200, `${ms} ms`);
});

test('a save from another version is refused, clearly, and nothing is built', () => {
    const w = new World(config(), { seed: 1, aspect: 1.6 });
    const data = saveWorld(w);
    assert.throws(() => loadWorld({ ...data, version: SAVE_VERSION + 1 }), (err) => err instanceof SaveError && /another version/.test(err.message));
    assert.throws(() => loadWorld({ ...data, format: 'something else' }), SaveError);
    assert.throws(() => loadWorld({ ...data, json: '{' }), SaveError);
    assert.throws(() => loadWorld({ ...data, bins: { ...data.bins, herbivore: new Float64Array(3) } }), SaveError);
    // A file from another version too.
    const bytes = packFile({ data: { ...data, version: SAVE_VERSION + 1 }, page: null, savedAt: 0 });
    assert.throws(() => unpackFile(bytes), (err) => err instanceof SaveError && /another version/.test(err.message));
    assert.throws(() => unpackFile(new Uint8Array(40)), SaveError);
});

test('a save as a file (.lifesave) comes back the same', () => {
    const w = new World(config(), { seed: 5, aspect: 1.6 });
    for (let k = 0; k < 600; k++) w.step();
    const data = saveWorld(w);
    const page = { speed: 4, view: 'map', modes: { game: 'god' } };
    const bytes = packFile({ data, page, savedAt: 1234 });
    const back = unpackFile(bytes.buffer.slice(0));
    assert.deepEqual(back.page, page);
    assert.equal(back.savedAt, 1234);
    assert.deepEqual(back.meta, data.meta);
    same(back.data, data, 'the file');
    same(saveWorld(loadWorld(back.data)), data, 'loaded from the file');
});

test('the Sim answers save with the world, and load with started, as for a new world', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 4, aspect: 1.6, params: config() });
    for (let k = 0; k < 300; k++) sim.step();
    sim.handle({ type: 'save', slot: 'auto', id: 7 });
    const saved = posted.find((m) => m.type === 'saved');
    assert.equal(saved.slot, 'auto');
    assert.equal(saved.id, 7);
    assert.ok(saved.ms >= 0 && saved.bytes > 0);
    assert.equal(saved.data.meta.time, 300);
    assert.equal(saved.data.meta.seed, 4);
    const before = saveWorld(sim.world);
    for (let k = 0; k < 50; k++) sim.step();
    sim.handle({ type: 'load', gen: 2, data: saved.data });
    const started = posted.filter((m) => m.type === 'started').at(-1);
    assert.equal(started.gen, 2);
    assert.equal(started.loaded, true);
    assert.equal(started.hash, startHash(loadWorld(saved.data)));
    assert.equal(sim.world.time, 300);
    same(saveWorld(sim.world), before, 'the loaded world');
    // A save that cannot be loaded leaves the world alone.
    const w = sim.world;
    sim.handle({ type: 'load', gen: 3, data: { ...saved.data, version: 0 } });
    assert.equal(sim.world, w);
    assert.equal(sim.gen, 2);
    const failed = posted.find((m) => m.type === 'loadFailed');
    assert.equal(failed.gen, 3);
    assert.match(failed.error, /another version/);
});

test('a loaded player numbers its inputs afresh and is jumped to (the Sim)', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 2, aspect: 1.6, params: config() });
    for (let k = 0; k < 200; k++) sim.step();
    const pop = sim.world.humans;
    let i = 0;
    while (pop.age[i] < sim.world.p.human.maturity) i++;
    sim.handle({ type: 'control', id: pop.id[i], mode: 'god' });
    sim.handle({ type: 'input', seq: 50, x: pop.x[i], y: pop.y[i], heading: 0, speed: 0, crouch: false });
    sim.step();
    assert.equal(sim.world.player.seq, 50);
    sim.handle({ type: 'save', slot: 1, id: 1 });
    const { data } = posted.find((m) => m.type === 'saved');
    sim.handle({ type: 'load', gen: 2, data });
    const pl = sim.world.player;
    assert.equal(pl.seq, 0);
    assert.equal(pl.snap, true);
    assert.equal(pl.input, null);
    sim.handle({ type: 'input', seq: 1, x: pl.x, y: pl.y, heading: 0, speed: 0, crouch: false });
    assert.equal(sim.world.player.input?.seq, 1);
});

test('a save missing params added since gets the defaults, not NaN', () => {
    const world = new World(defaults, { seed: 11 });
    for (let k = 0; k < 200; k++) world.step();
    const data = saveWorld(world);
    // Make it look like a save from before items.fire existed.
    const text = typeof data.json === 'string';
    const json = JSON.parse(text ? data.json : JSON.stringify(data.json));
    let stripped = 0;
    const strip = (o) => {
        if (o && typeof o === 'object' && o.items && typeof o.items === 'object' && 'fire' in o.items) {
            delete o.items.fire;
            stripped++;
        }
        for (const v of Object.values(o ?? {})) if (v && typeof v === 'object') strip(v);
    };
    strip(json);
    assert.ok(stripped >= 2, 'the param was taken out of both saved param sets');
    const loaded = loadWorld({ ...data, json: text ? JSON.stringify(json) : json });
    assert.equal(loaded.p.items.fire, defaults.items.fire);
});
