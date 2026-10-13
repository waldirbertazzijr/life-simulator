// Leading a tribe (src/orders.js): standing orders, camps that move, calls
// from the player, the rally, and how all of it reaches the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { Sim, setParam, TRIBE_STRIDE } from '../src/sim.js';
import { Mirror } from '../src/mirror.js';
import { campSite } from '../src/tribes.js';
import { issueOrder, ORDER_KINDS, fighting, heeded } from '../src/orders.js';
import { takeControl, applyAct, applyInput } from '../src/player.js';
import { TASK } from '../src/items.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// Flat, no predators, one tribe: nothing happens by chance that a test does
// not ask for.
const QUIET = { 'terrain.enabled': false, 'carnivore.initial': 0, 'human.tribes': 1 };

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const dist = (w, ax, ay, bx, by) => Math.hypot(wrapDelta(ax - bx, w.width), wrapDelta(ay - by, w.height));
const steps = (w, n) => {
    for (let k = 0; k < n; k++) w.step();
};
const eventsOf = (w, type) => w.events.filter((e) => e.type === type);

// A valid camp site about `d` from the tribe's camp (with terrain), or null.
function siteNear(w, tribe, d) {
    for (let k = 0; k < 64; k++) {
        const a = (k * 2.39996) % (Math.PI * 2);
        const r = d * (1 + 0.15 * (k % 4));
        const x = (((tribe.camp.x + Math.cos(a) * r) % w.width) + w.width) % w.width;
        const y = (((tribe.camp.y + Math.sin(a) * r) % w.height) + w.height) % w.height;
        if (campSite(w, x, y) > -Infinity) return { x, y };
    }
    return null;
}

// A spot in a lake.
function water(w) {
    const T = w.terrain;
    for (let y = 5; y < w.height; y += 9) {
        for (let x = 5; x < w.width; x += 9) if (T.isWater(x, y) && T.isWater(x + 3, y) && T.isWater(x - 3, y)) return { x, y };
    }
    return null;
}

// Hash a world's state the way tools/fingerprint.mjs does.
function digest(w, n) {
    const h = createHash('sha256');
    for (let t = 1; t <= n; t++) {
        w.step();
        if (t % 100 === 0) h.update(`${w.herbivores.n},${w.carnivores.n},${w.humans.n},${w.tribes.length};`);
    }
    for (const pop of [w.herbivores, w.carnivores, w.humans]) {
        for (const f of ['x', 'y', 'energy']) h.update(Buffer.from(pop[f].buffer, 0, pop.n * 8));
    }
    return h.digest('hex').slice(0, 16);
}

// ---- standing orders -----------------------------------------------------------

test('an order is given, replaced, and lapses after 3000 steps', () => {
    const w = world(QUIET);
    const tribe = w.tribes[0];
    assert.equal(tribe.order, null, 'a tribe starts with no order');
    const x = (tribe.camp.x + 120) % w.width;
    const y = tribe.camp.y;
    assert.equal(issueOrder(w, tribe, { kind: 'hunt', x, y }), true);
    assert.equal(tribe.order.kind, 'hunt');
    assert.equal(tribe.order.x, x);
    assert.equal(tribe.order.y, y);
    assert.deepEqual(eventsOf(w, 'call').map(({ tribe: t, kind, x: ex, y: ey }) => [t, kind, ex, ey]), [[tribe.id, 'hunt', x, y]]);

    steps(w, 1000);
    assert.equal(issueOrder(w, tribe.id, { kind: 'gather', x: 1, y: 2 }), true, 'by id as well');
    assert.equal(tribe.order.kind, 'gather', 'one standing order: the new one replaces it');
    assert.deepEqual([tribe.order.x, tribe.order.y], [tribe.camp.x, tribe.camp.y], 'gathering is about the camp');
    const given = w.time;
    steps(w, w.p.orders.lasts - 1);
    assert.equal(tribe.order?.kind, 'gather', 'still standing');
    steps(w, 1);
    assert.equal(w.time, given + w.p.orders.lasts);
    assert.equal(tribe.order, null, 'lapsed');

    assert.equal(issueOrder(w, tribe, { kind: 'dance', x, y }), false);
    assert.deepEqual(eventsOf(w, 'refused').map((e) => [e.kind, e.reason]), [['dance', 'unknown']]);
    assert.equal(tribe.order, null);
    assert.deepEqual(ORDER_KINDS, ['', 'hunt', 'gather', 'defend', 'move', 'wood', 'flint']); // (the snapshot's codes)
});

test('move camp: the camp, its paths and its store move', () => {
    const w = world({ 'carnivore.initial': 0, 'human.tribes': 1 });
    const tribe = w.tribes[0];
    const site = siteNear(w, tribe, 150);
    assert.ok(site, 'a valid site nearby');
    const store = tribe.store;
    const oldPaths = tribe.paths;
    issueOrder(w, tribe, { kind: 'hunt', x: site.x, y: site.y });
    assert.equal(issueOrder(w, tribe, { kind: 'move', x: site.x, y: site.y }), true);
    assert.deepEqual([tribe.camp.x, tribe.camp.y], [site.x, site.y]);
    assert.equal(tribe.store, store, 'the store goes with it');
    assert.notEqual(tribe.paths, oldPaths);
    assert.equal(tribe.paths[w.terrain.wayIndex(site.x, site.y)], 0, 'the way home now leads to the new camp');
    assert.equal(tribe.order, null, 'a move replaces the standing order');
    assert.deepEqual(eventsOf(w, 'call').at(-1), { type: 'call', tribe: tribe.id, kind: 'move', x: site.x, y: site.y, time: w.time });

    // People walk there: the children first of all, who keep near camp.
    steps(w, 900);
    const pop = w.humans;
    let children = 0;
    for (let i = 0; i < pop.n; i++) {
        if (pop.age[i] >= w.p.human.maturity) continue;
        children++;
        assert.ok(dist(w, pop.x[i], pop.y[i], site.x, site.y) < w.p.human.campRadius, 'a child is at the new camp');
    }
    assert.ok(children > 0);
});

test('move camp: an invalid site or a second move within the cooldown is refused and changes nothing', () => {
    const w = world({ 'carnivore.initial': 0, 'human.tribes': 1 });
    const tribe = w.tribes[0];
    const camp = { ...tribe.camp };
    const lake = water(w);
    assert.ok(lake);
    assert.equal(issueOrder(w, tribe, { kind: 'move', x: lake.x, y: lake.y }), false);
    assert.deepEqual(eventsOf(w, 'refused').map((e) => [e.tribe, e.kind, e.reason]), [[tribe.id, 'move', 'site']]);
    assert.deepEqual(tribe.camp, camp);

    const a = siteNear(w, tribe, 150);
    assert.equal(issueOrder(w, tribe, { kind: 'move', x: a.x, y: a.y }), true);
    steps(w, 10);
    const b = siteNear(w, tribe, 150);
    assert.equal(issueOrder(w, tribe, { kind: 'move', x: b.x, y: b.y }), false);
    assert.equal(eventsOf(w, 'refused').at(-1).reason, 'cooldown');
    assert.deepEqual([tribe.camp.x, tribe.camp.y], [a.x, a.y]);
    steps(w, w.p.orders.moveCooldown);
    assert.equal(issueOrder(w, tribe, { kind: 'move', x: b.x, y: b.y }), true, 'after the cooldown it may move again');
});

test('a hunt marker off the land is refused', () => {
    const w = world({ 'carnivore.initial': 0, 'human.tribes': 1 });
    const tribe = w.tribes[0];
    const lake = water(w);
    assert.equal(issueOrder(w, tribe, { kind: 'hunt', x: lake.x, y: lake.y }), false);
    assert.equal(eventsOf(w, 'refused')[0].reason, 'unreachable');
    assert.equal(tribe.order, null);
    // On land, the marker's own way-finding comes with it.
    const site = siteNear(w, tribe, 100);
    assert.equal(issueOrder(w, tribe, { kind: 'hunt', x: site.x, y: site.y }), true);
    assert.equal(tribe.order.paths[w.terrain.wayIndex(site.x, site.y)], 0);
    assert.equal(tribe.order.range, w.p.orders.huntRange);
});

test('a daughter tribe starts with no order', () => {
    const w = world({ ...QUIET, 'human.splitSize': 8 });
    const tribe = w.tribes[0];
    issueOrder(w, tribe, { kind: 'defend', x: 0, y: 0 });
    w.step();
    assert.equal(w.tribes.length, 2, 'it split');
    assert.equal(w.tribes[0].order?.kind, 'defend');
    assert.equal(w.tribes[1].order, null);
    assert.equal(w.tribes[1].nextMove, 0);
});

test('on autopilot with no calls, the world steps exactly as before', () => {
    const a = world();
    const b = world();
    assert.ok(takeControl(b, b.humans.id[0], 'god'));
    applyAct(b, { seq: 1, action: 'auto', on: true });
    assert.equal(digest(a, 3000), digest(b, 3000));
});

// ---- what orders make people do --------------------------------------------------

// Adults of `tribe`, as indices.
const adultsOf = (w, tribe) => {
    const pop = w.humans;
    const out = [];
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === tribe.id && pop.age[i] >= w.p.human.maturity) out.push(i);
    return out;
};

// Keep a tribe's store at `perMember` a member: fed enough to heed orders
// (orders.surplus: the store a birth needs), short of what would let them rest.
const keep = (tribe, perMember = 20) => {
    tribe.store = perMember * Math.max(1, tribe.members);
};

// Grazers people killed within `r` of (x, y), over `n` steps (the tribe's
// store kept as `keep` says, if given).
function huntedNear(w, n, x, y, r, tribe = null) {
    let near = 0;
    let all = 0;
    for (let k = 0; k < n; k++) {
        if (tribe) keep(tribe);
        w.step();
        for (const e of w.events) {
            if (e.type !== 'death' || e.cause !== 'hunted') continue;
            all++;
            if (dist(w, e.x, e.y, x, y) < r) near++;
        }
    }
    return { near, all };
}

test('hunt here: foragers make for the marker and hunt near it', () => {
    const run = (ordered) => {
        const w = world(QUIET, 4);
        const tribe = w.tribes[0];
        w.step(); // (the tribe counts its members)
        keep(tribe);
        const marker = { x: (tribe.camp.x + 450) % w.width, y: tribe.camp.y };
        if (ordered) issueOrder(w, tribe, { kind: 'hunt', ...marker });
        const range = w.p.orders.huntRange;
        const adults = new Set(adultsOf(w, tribe).map((i) => w.humans.id[i])); // (the adults when it was given)
        let hunted = { near: 0, all: 0 };
        const been = new Set(); // which of them got there
        for (let k = 0; k < 28; k++) {
            const h = huntedNear(w, 100, marker.x, marker.y, range + w.p.human.throwRange, tribe);
            hunted = { near: hunted.near + h.near, all: hunted.all + h.all };
            for (const i of adultsOf(w, tribe)) {
                if (adults.has(w.humans.id[i]) && dist(w, w.humans.x[i], w.humans.y[i], marker.x, marker.y) < range) been.add(w.humans.id[i]);
            }
        }
        return { hunted, there: been.size, adults: adults.size };
    };
    const ordered = run(true);
    const plain = run(false);
    assert.ok(ordered.there >= ordered.adults - 1, `${ordered.there} of ${ordered.adults} adults went to the marker`);
    assert.equal(plain.there, 0, 'without the order nobody goes so far');
    assert.ok(ordered.hunted.near > 0, 'they hunt there');
    assert.equal(plain.hunted.near, 0);
});

test('gather food: nobody hunts', () => {
    const run = (ordered) => {
        const w = world(QUIET, 2);
        const tribe = w.tribes[0];
        w.step();
        let hunting = 0;
        let hunted = 0;
        for (let k = 0; k < 2000; k++) {
            if (ordered && k % 1000 === 0) issueOrder(w, tribe, { kind: 'gather', x: 0, y: 0 });
            keep(tribe, ordered ? 25 : 20); // (ordered: fed clear of hungry, as people eat from it within the step)
            w.step();
            hunted += w.events.filter((e) => e.type === 'death' && e.cause === 'hunted').length;
            // (On the way to cut up a kill made before the order is not hunting.)
            for (let i = 0; i < w.humans.n; i++) if (w.humans.state[i] === STATE.HUNTING && w.humans.task[i] !== TASK.BUTCHER) hunting++;
        }
        return { hunting, hunted };
    };
    const plain = run(false);
    assert.ok(plain.hunted > 0 && plain.hunting > 0, 'they hunt when free to');
    assert.deepEqual(run(true), { hunting: 0, hunted: 0 });
});

test('defend camp: adults stay in camp and stand against predators', () => {
    const run = (ordered) => {
        const w = world({ ...QUIET }, 3);
        const tribe = w.tribes[0];
        w.step();
        // Well fed, with too little in store to rest: free, they would go out.
        for (let i = 0; i < w.humans.n; i++) w.humans.energy[i] = w.p.human.maxEnergy;
        tribe.aggression = 0; // a peaceful tribe: it would rather run
        if (ordered) issueOrder(w, tribe, { kind: 'defend', x: 0, y: 0 });
        for (let k = 0; k < 800; k++) {
            keep(tribe);
            w.step();
        }
        keep(tribe);
        const adults = adultsOf(w, tribe);
        const home = adults.filter((i) => dist(w, w.humans.x[i], w.humans.y[i], tribe.camp.x, tribe.camp.y) < w.p.human.campRadius);
        const guarding = adults.filter((i) => w.humans.state[i] === STATE.GUARDING);
        // A predator turns up beside the camp.
        const C = w.p.carnivore;
        w.spawn(w.carnivores, C, (tribe.camp.x + 25) % w.width, tribe.camp.y, 50, 1, 1, 1000);
        w.step();
        const fighting = adultsOf(w, tribe).filter((i) => w.humans.state[i] === STATE.FIGHTING).length;
        const fleeing = adultsOf(w, tribe).filter((i) => w.humans.state[i] === STATE.FLEEING).length;
        return { adults: adults.length, home: home.length, guarding: guarding.length, fighting, fleeing };
    };
    const ordered = run(true);
    assert.equal(ordered.home, ordered.adults, 'every adult is in camp');
    assert.equal(ordered.guarding, ordered.adults, 'on guard');
    assert.ok(ordered.fighting > 0 && ordered.fleeing === 0, `they stand: ${JSON.stringify(ordered)}`);
    const plain = run(false);
    assert.ok(plain.home < plain.adults, 'without the order they go out');
    assert.equal(plain.fighting, 0, 'and a peaceful tribe does not fight');
});

test('a hungry tribe sets its order aside to feed itself, but meets predators and raiders as ordered', () => {
    const w = world(QUIET, 2);
    const tribe = w.tribes[0];
    w.step();
    tribe.store = 0;
    issueOrder(w, tribe, { kind: 'gather', x: 0, y: 0 });
    assert.equal(eventsOf(w, 'call')[0].hungry, true, 'the page is told');
    let hunted = 0;
    for (let k = 0; k < 2000; k++) {
        tribe.store = 0;
        w.step();
        hunted += w.events.filter((e) => e.type === 'death' && e.cause === 'hunted').length;
    }
    assert.equal(tribe.order?.kind, 'gather', 'the order stands...');
    assert.ok(hunted > 0, '...but hungry, they hunt');

    issueOrder(w, tribe, { kind: 'defend', x: 0, y: 0 });
    for (let k = 0; k < 300; k++) {
        tribe.store = 0;
        w.step();
    }
    const out = adultsOf(w, tribe).filter((i) => w.humans.state[i] !== STATE.GUARDING);
    assert.ok(out.length > 0, 'hungry, they go out for food');
    assert.equal(fighting(tribe), 1, 'and still stand against predators');
    tribe.store = w.p.human.birthCost + (w.p.human.reserve + 10) * tribe.members; // (a birth's worth, and more)
    assert.equal(heeded(w.p, tribe), tribe.order, 'fed again, they heed it');

    // Hunt here only moves where they forage: it stands though they are
    // hungry, unless the store is nearly empty (orders.starving a member).
    tribe.store = (w.p.orders.starving + 1) * tribe.members;
    const site = { x: (tribe.camp.x + 100) % w.width, y: tribe.camp.y };
    issueOrder(w, tribe, { kind: 'hunt', ...site });
    assert.equal(eventsOf(w, 'call').at(-1).hungry, false);
    assert.equal(heeded(w.p, tribe), tribe.order);
    tribe.store = 0;
    assert.equal(heeded(w.p, tribe), null, 'an empty camp hunts near home');
});

test('defend camp: a raider meets every adult', () => {
    const run = (ordered) => {
        const w = world({ ...QUIET, 'human.tribes': 2, 'human.guard': 1 }, 5);
        const [a, b] = w.tribes;
        w.step(); // (the tribes count their adults)
        const pop = w.humans;
        // Everyone of b is out, 100 from its camp; one adult of a is at b's
        // camp, raiding.
        let raider = -1;
        for (let i = 0; i < pop.n; i++) {
            if (pop.tribe[i] === b.id) {
                pop.x[i] = (b.camp.x + 100) % w.width;
                pop.y[i] = b.camp.y;
            } else if (raider < 0 && pop.age[i] >= w.p.human.maturity) raider = i;
        }
        const id = pop.id[raider];
        pop.x[raider] = b.camp.x;
        pop.y[raider] = b.camp.y;
        pop.goal[raider] = b.id;
        pop.carry[raider] = 0;
        pop.energy[raider] = 100;
        b.store = 500;
        b.sociality = 1;
        if (ordered) issueOrder(w, b, { kind: 'defend', x: 0, y: 0 });
        w.step();
        const i = w.humans.id.subarray(0, w.humans.n).indexOf(id);
        return { alive: i >= 0, carry: i >= 0 ? w.humans.carry[i] : 0, defenders: b.adults };
    };
    const plain = run(false);
    assert.ok(plain.alive && plain.carry >= 150, 'an empty camp is robbed');
    const ordered = run(true);
    assert.ok(ordered.defenders > 3);
    assert.equal(ordered.alive, false, 'every adult defends it, wherever they are');
});

// ---- calls from the player, and the rally ------------------------------------------

const at = (w, id) => w.humans.id.subarray(0, w.humans.n).indexOf(id);
let seq = 0;
const call = (w, kind, x = 0, y = 0) => applyAct(w, { seq: ++seq, action: 'call', kind, x, y });

// Take over an adult of the first tribe, standing at its camp with its whole
// life ahead; returns its id.
function lead(w, mode = 'god') {
    const pop = w.humans;
    const tribe = w.tribes[0];
    let i = 0;
    while (pop.tribe[i] !== tribe.id || pop.age[i] < w.p.human.maturity) i++;
    pop.age[i] = w.p.human.maturity;
    pop.lifespan[i] = w.p.human.lifespan;
    pop.energy[i] = 140;
    pop.x[i] = tribe.camp.x;
    pop.y[i] = tribe.camp.y;
    assert.ok(takeControl(w, pop.id[i], mode));
    return pop.id[i];
}

// Walk the controlled person `n` steps along x at `v` a step, as the page would.
function walk(w, id, n, v = 0.4) {
    for (let k = 0; k < n; k++) {
        const i = at(w, id);
        applyInput(w, { seq: ++seq, x: w.humans.x[i] + v, y: w.humans.y[i], heading: 0, speed: v, crouch: false });
        w.step();
    }
}

const following = (w) => {
    const pop = w.humans;
    const out = [];
    for (let i = 0; i < pop.n; i++) if (pop.state[i] === STATE.FOLLOWING) out.push(i);
    return out;
};

test('only your tribe takes orders; a child cannot call', () => {
    const w = world({ ...QUIET, 'human.tribes': 2 });
    const [a, b] = w.tribes;
    lead(w);
    const x = (a.camp.x + 80) % w.width;
    call(w, 'hunt', x, a.camp.y);
    w.step();
    assert.equal(a.order?.kind, 'hunt');
    assert.equal(b.order, null);
    assert.deepEqual(eventsOf(w, 'call').map((e) => [e.tribe, e.kind]), [[a.id, 'hunt']]);

    const pop = w.humans;
    let child = 0;
    while (pop.tribe[child] !== a.id || pop.age[child] >= w.p.human.maturity) child++;
    assert.ok(takeControl(w, pop.id[child], 'god'));
    call(w, 'defend');
    call(w, 'rally');
    w.step();
    assert.deepEqual(eventsOf(w, 'refused').map((e) => [e.tribe, e.kind, e.reason]), [[a.id, 'defend', 'child'], [a.id, 'rally', 'child']]);
    assert.equal(a.order?.kind, 'hunt', 'unchanged');
});

test('a rally costs 40 Spirit and is refused when short, or with nobody near', () => {
    const w = world(QUIET);
    const id = lead(w);
    const Q = w.p.play;
    call(w, 'rally');
    w.step();
    const [r] = eventsOf(w, 'rally');
    assert.ok(r && r.count > 0 && r.tribe === w.tribes[0].id, 'tribe-mates at camp answer');
    assert.ok(Math.abs(w.player.spirit - (Q.spiritMax - w.p.orders.rallyCost + Q.spiritRegen)) < 1e-9);

    w.player.spirit = 39;
    call(w, 'rally');
    w.step();
    assert.equal(eventsOf(w, 'refused')[0]?.reason, 'spirit');
    assert.ok(Math.abs(w.player.spirit - (39 + Q.spiritRegen)) < 1e-9, 'nothing spent');

    // Alone, far out: nobody to rally.
    const i = at(w, id);
    w.humans.x[i] = (w.humans.x[i] + 300) % w.width;
    w.player.spirit = 100;
    call(w, 'rally');
    w.step();
    assert.equal(eventsOf(w, 'refused')[0]?.reason, 'nobody');
    assert.ok(w.player.spirit > 100 - 1, 'nothing spent');
});

test('rallied adults within 60 follow you for 450 steps, keeping close', () => {
    const w = world(QUIET, 2);
    const tribe = w.tribes[0];
    tribe.store = 0; // (free, they would go off foraging)
    const id = lead(w);
    const pop = w.humans;
    const O = w.p.orders;
    // One adult out of reach.
    let far = -1;
    for (let i = 0; i < pop.n; i++) {
        if (pop.id[i] !== id && pop.age[i] >= w.p.human.maturity) {
            far = pop.id[i];
            pop.x[i] = (tribe.camp.x + 200) % w.width;
            break;
        }
    }
    call(w, 'rally');
    w.step();
    const count = eventsOf(w, 'rally')[0].count;
    const adults = adultsOf(w, tribe).length;
    assert.equal(count, adults - 2, 'every adult in reach but the far one (and you)');
    const children = [];
    for (let i = 0; i < pop.n; i++) if (pop.age[i] < w.p.human.maturity) children.push(pop.id[i]);

    walk(w, id, 300);
    const me = at(w, id);
    const near = following(w).map((i) => dist(w, pop.x[i], pop.y[i], pop.x[me], pop.y[me]));
    assert.equal(near.length, count, 'all of them still follow, 120 units from camp');
    assert.ok(Math.max(...near) < O.keep + 1, `they keep close: ${near.map((d) => d.toFixed(1))}`);
    assert.ok(!following(w).some((i) => pop.id[i] === far || children.includes(pop.id[i])), 'nobody else');
    const mates = adultsOf(w, tribe).filter((i) => i !== me && dist(w, pop.x[i], pop.y[i], pop.x[me], pop.y[me]) < w.p.human.groupRadius);
    assert.ok(mates.length >= count, 'together, for teamwork and defence');

    walk(w, id, 449 - 300);
    assert.equal(following(w).length, count, 'until the end');
    walk(w, id, 2);
    assert.equal(following(w).length, 0, 'and then back to their own lives');
});

test('followers hunt what you attack', () => {
    const w = world(QUIET, 3);
    const id = lead(w);
    call(w, 'rally');
    walk(w, id, 30, 0);
    // A grazer 25 away that pays people no heed.
    const me = at(w, id);
    const G = w.herbivores;
    const j = 0;
    G.x[j] =(w.humans.x[me] + 25) % w.width;
    G.y[j] = w.humans.y[me];
    G.senseGene[j] = 0.01;
    G.energy[j] = 60;
    const prey = G.id[j];
    applyAct(w, { seq: ++seq, action: 'attack', heavy: false, target: prey });
    assert.equal(w.player.lastTarget, prey);
    w.step();
    const pop = w.humans;
    const hunters = [];
    for (let i = 0; i < pop.n; i++) if (pop.state[i] === STATE.HUNTING && pop.focus[i] === prey) hunters.push(pop.id[i]);
    assert.ok(hunters.length > 0, 'they go for it');
    let death = null;
    for (let k = 0; k < 300 && !death; k++) {
        w.step();
        death = w.events.find((e) => e.type === 'death' && e.id === prey) ?? null;
    }
    assert.ok(death && death.cause === 'hunted' && hunters.includes(death.by), 'and bring it down');
});

test('following ends when you die, hand over, or go on autopilot', () => {
    const w = world(QUIET, 4);
    const id = lead(w);
    call(w, 'rally');
    walk(w, id, 5, 0);
    const count = following(w).length;
    assert.ok(count > 0);
    applyAct(w, { seq: ++seq, action: 'auto', on: true });
    w.step();
    assert.equal(following(w).length, 0, 'on autopilot');
    assert.equal(w.player.rally, null);
    applyAct(w, { seq: ++seq, action: 'auto', on: false });
    w.step();
    assert.equal(following(w).length, 0, 'and not again on coming back');

    w.player.spirit = 100;
    call(w, 'rally');
    walk(w, id, 5, 0);
    assert.ok(following(w).length > 0);
    w.die(w.humans, at(w, id), 'killed');
    w.step(); // (the heir takes over at the end of it)
    assert.notEqual(w.player.id, id);
    w.step();
    assert.equal(following(w).length, 0, 'the heir is not followed');
});

test('orders are heard on autopilot, rallies are not', () => {
    const w = world(QUIET);
    lead(w);
    applyAct(w, { seq: ++seq, action: 'auto', on: true });
    call(w, 'gather');
    call(w, 'rally');
    w.step();
    assert.equal(w.tribes[0].order?.kind, 'gather');
    assert.equal(eventsOf(w, 'refused')[0]?.reason, 'away');
    assert.ok(w.player.spirit >= 100 - 1e-9, 'no Spirit spent');
});

test('a call through the Sim reaches the page as events', () => {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed: 1, aspect: 1.6, params: config(QUIET) });
    const id = lead(sim.world);
    sim.handle({ type: 'control', id, mode: 'play' });
    sim.handle({ type: 'act', seq: 1, action: 'call', kind: 'defend', x: 0, y: 0 });
    sim.step();
    sim.handle({ type: 'want' });
    const snap = posted.filter((m) => m.type === 'snapshot').at(-1);
    const tribe = sim.world.tribes[0];
    assert.deepEqual(snap.events.filter((e) => e.type === 'call'), [{ type: 'call', tribe: tribe.id, kind: 'defend', x: tribe.camp.x, y: tribe.camp.y, time: 0, hungry: false }]);
    assert.equal(snap.tribes[7], ORDER_KINDS.indexOf('defend'));
});

// ---- on the page ---------------------------------------------------------------

test('a camp that moves and an order reach the page', async () => {
    const host = { local: true, onmessage: null, send: (msg) => sim.handle(msg) };
    const sim = new Sim((msg) => host.onmessage(msg));
    const mirror = new Mirror(host);
    mirror.reset(config({ 'carnivore.initial': 0 }), 3, 1.6);
    let now = performance.now();
    // Step, then a frame that asks for the snapshot of that moment, and one
    // that shows it.
    const frame = async (n = 1) => {
        await mirror.run(n);
        for (let k = 0; k < 2; k++) {
            now += 1000;
            mirror.update(now, 16);
        }
    };
    await frame();
    const w = sim.world;
    const tribe = w.tribes[0];
    const shown = mirror.tribeById.get(tribe.id);
    assert.equal(shown.order, null);
    assert.deepEqual(shown.camp, tribe.camp);

    const site = siteNear(w, tribe, 160);
    issueOrder(w, tribe, { kind: 'hunt', x: site.x, y: site.y });
    await frame();
    assert.deepEqual(mirror.tribeById.get(tribe.id).order, { kind: 'hunt', x: site.x, y: site.y });

    issueOrder(w, tribe, { kind: 'move', x: site.x, y: site.y });
    await frame();
    const t = mirror.tribeById.get(tribe.id);
    assert.deepEqual([t.camp.x, t.camp.y], [site.x, site.y], 'the camp moved on the page');
    assert.equal(t.order, null);

    // The numbers: TRIBE_STRIDE per tribe.
    assert.equal(mirror.base.tribes.length, w.tribes.length * TRIBE_STRIDE);
});
