// Items (package 3, src/items.js): materials, the kinds and what each does,
// wear, crafting and its costs, rarity, culture, legends and their deeds,
// what happens to a bearer's items at death, lying about and picked up,
// butchering for everyone, the player's acts, and the snapshot to the Mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { Sim, setParam, ITEM_STRIDE, TRIBE_STRIDE } from '../src/sim.js';
import { Mirror } from '../src/mirror.js';
import { takeControl, applyInput, applyAct, playerSnapshot } from '../src/player.js';
import {
    ITEM_KINDS, KIND, TASK, costOf, SKILLS, newItem, hold, unhold, heldLike, lay, wearItem, weaponStats, guards, blowOf,
    efficiencyOf, carryOf, shielded, killed, credit, raiderKilled, raided, splitItems,
    affords, spend, fraction, richness, forge, describe,
} from '../src/items.js';
import { wildPickup, tallyTribes, craft, rareChance } from '../src/tasks.js';
import { BIOME } from '../src/terrain.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// Flat, one tribe, and no animals but those a test puts there.
const EMPTY = { 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 };

const wrap = (v, size) => ((v % size) + size) % size;
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const dist = (w, ax, ay, bx, by) => Math.hypot(wrapDelta(ax - bx, w.width), wrapDelta(ay - by, w.height));
const indexIn = (pop, id) => pop.id.subarray(0, pop.n).indexOf(id);
const at = (w, id) => indexIn(w.humans, id);
const happened = (w, type) => w.events.filter((e) => e.type === type);

let seq = 0;
const input = (w, x, y, more = {}) => applyInput(w, { seq: ++seq, x, y, heading: 0, speed: 0, crouch: false, ...more });
const act = (w, action, more = {}) => applyAct(w, { seq: ++seq, action, ...more });

// The adults of the first tribe (indices).
function adults(w) {
    const pop = w.humans;
    const out = [];
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === w.tribes[0].id && pop.age[i] >= w.p.human.maturity) out.push(i);
    return out;
}

// A new item of `kind` in person i's hand, in place of what it held there.
function give(w, i, kind, rarity = 0, trait = '') {
    const held = heldLike(w, i, kind);
    if (held) {
        unhold(w, i, held);
        w.items.delete(held.id);
    }
    const item = newItem(w, kind, rarity, trait, 0, w.humans.tribe[i]);
    hold(w, i, item);
    return item;
}

// Empty person i's hands (the items are gone).
function disarm(w, i) {
    for (const id of [w.humans.weapon[i], w.humans.tool[i]]) {
        if (!id) continue;
        unhold(w, i, w.items.get(id));
        w.items.delete(id);
    }
}

// Person i, an adult with its life ahead of it, fed, at (x, y); the rest of
// its tribe far off at camp, so nobody helps or gets in the way.
function alone(w, i, x, y) {
    const pop = w.humans;
    pop.x[i] = wrap(x, w.width);
    pop.y[i] = wrap(y, w.height);
    pop.age[i] = Math.max(pop.age[i], w.p.human.maturity);
    pop.lifespan[i] = w.p.human.lifespan;
    pop.energy[i] = 140;
    pop.timer[i] = 0;
}

// A grazer at (x, y) facing `heading`, on good grass, slow to notice anyone.
function grazer(w, x, y, { heading = 0, sense = 0.3, energy = 60 } = {}) {
    const pop = w.herbivores;
    const i = w.spawn(pop, w.p.herbivore, wrap(x, w.width), wrap(y, w.height), energy, 1.3, sense, 1000);
    pop.heading[i] = heading;
    w.grass.g[w.grass.index(pop.x[i], pop.y[i])] = 1;
    return pop.id[i];
}

// A predator at (x, y): hungry and ready (or, resting: catching its breath a long while).
function predatorAt(w, x, y, { resting = false, energy = 50 } = {}) {
    const pop = w.carnivores;
    const i = w.spawn(pop, w.p.carnivore, wrap(x, w.width), wrap(y, w.height), energy, 1.5, 0.8, 1000);
    if (resting) {
        pop.timer[i] = 1000;
        pop.state[i] = STATE.RESTING;
    }
    return pop.id[i];
}

// A newborn of person `parent` (an index) in its tribe, at (x, y), of `age`.
function childOf(w, parent, x, y, age = 0) {
    const pop = w.humans;
    const i = w.spawn(pop, w.p.human, wrap(x, w.width), wrap(y, w.height), 100, 1, 1, age, parent);
    pop.tribe[i] = pop.tribe[parent];
    for (const f of ['carry', 'goal', 'weapon', 'tool', 'gear', 'task', 'work', 'make', 'load', 'hides', 'crafted']) pop[f][i] = 0;
    return i;
}

// A spot far from every camp (on the grass grid's corners).
function farSpot(w) {
    let best = null;
    for (let y = 0; y < w.height; y += 20) {
        for (let x = 0; x < w.width; x += 20) {
            let d = Infinity;
            for (const t of w.tribes) d = Math.min(d, dist(w, t.camp.x, t.camp.y, x, y));
            if (!best || d > best.d) best = { x, y, d };
        }
    }
    return best;
}

// ---- The switch, and the start -------------------------------------------------------

test('items off: none exist, nobody holds one, and tribes have no materials', () => {
    const w = world({ 'items.enabled': false });
    assert.equal(w.itemsOn, false);
    for (let k = 0; k < 200; k++) w.step();
    assert.equal(w.items.size, 0);
    assert.equal(w.carcasses.size, 0, 'hunters eat their kills on the spot, as before');
    for (let i = 0; i < w.humans.n; i++) assert.equal(w.humans.weapon[i] + w.humans.tool[i] + w.humans.task[i], 0);
    for (const t of w.tribes) assert.deepEqual([t.wood, t.flint, t.hide], [0, 0, 0]);
});

test('every adult starts with a plain spear; children with nothing', () => {
    const w = world();
    const pop = w.humans;
    let spears = 0;
    for (let i = 0; i < pop.n; i++) {
        if (pop.age[i] < w.p.human.maturity) {
            assert.equal(pop.weapon[i], 0);
            continue;
        }
        const item = w.items.get(pop.weapon[i]);
        assert.equal(item.kind, KIND.SPEAR);
        assert.equal(item.rarity, 0);
        assert.equal(item.wear, w.p.items.uses);
        assert.equal(item.bearer, pop.id[i]);
        assert.equal(pop.gear[i], KIND.SPEAR * 8);
        assert.equal(pop.tool[i], 0);
        spears++;
    }
    assert.equal(spears, w.p.human.tribes * w.p.human.perTribe * 0.8);
    assert.deepEqual(ITEM_KINDS, ['', 'spear', 'bow', 'club', 'knife', 'basket', 'torch']);
});

// ---- Materials -------------------------------------------------------------------------

test('a tribe finds wood in forest and flint on rock, by land; on a flat world, a little anywhere', () => {
    const w = world();
    const T = w.terrain;
    let rich = 0;
    for (const t of w.tribes) {
        for (const [spot, mat, biome] of [[t.woodSpot, TASK.WOOD, BIOME.FOREST], [t.flintSpot, TASK.FLINT, BIOME.ROCK]]) {
            if (spot === null) continue;
            assert.ok(!T.blocked(spot.x, spot.y), 'on open ground');
            assert.ok(spot.paths instanceof Int32Array, 'with a way there');
            assert.ok(richness(w, spot.x, spot.y, mat) > 0);
            if (spot.rich) {
                assert.equal(T.biomeGrid[w.grass.index(spot.x, spot.y)], biome);
                assert.equal(richness(w, spot.x, spot.y, mat), 1);
                rich++;
            }
        }
    }
    assert.ok(rich >= w.tribes.length, `rich spots: ${rich}`);
    const flat = world(EMPTY);
    const t = flat.tribes[0];
    for (const spot of [t.woodSpot, t.flintSpot]) {
        assert.equal(spot.rich, false);
        assert.ok(dist(flat, spot.x, spot.y, t.camp.x, t.camp.y) > flat.p.human.campRadius);
        assert.equal(richness(flat, spot.x, spot.y, TASK.WOOD), flat.p.items.poor);
        assert.equal(richness(flat, spot.x, spot.y, TASK.FLINT), flat.p.items.poor);
    }
});

test('an errand: to the spot for wood, a load home, into the store', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const [first] = adults(w);
    disarm(w, first); // someone needs a spear...
    t.store = 5000;   // ...and the camp is fed
    let chopped = 0;
    let went = 0;
    let load = 0;
    let before = t.wood;
    let brought = 0;
    for (let k = 0; k < 4000 && brought === 0; k++) {
        w.step();
        chopped += happened(w, 'chop').length;
        for (let i = 0; i < w.humans.n; i++) {
            if (w.humans.task[i] !== TASK.WOOD) continue;
            went = Math.max(went, dist(w, w.humans.x[i], w.humans.y[i], t.camp.x, t.camp.y));
            load = Math.max(load, w.humans.load[i]);
        }
        if (t.wood > before) brought = t.wood - before;
        before = t.wood;
    }
    assert.ok(chopped > 0, 'chop strokes');
    assert.ok(went > dist(w, t.woodSpot.x, t.woodSpot.y, t.camp.x, t.camp.y) - 5, 'out to the spot');
    assert.equal(load, w.p.items.load, 'a full load...');
    assert.ok(brought > 0, '...into the store (where a crafter may take some at once)');
});

// Count a tribe's members and adults, as stepTribes does.
function count(w) {
    for (const t of w.tribes) {
        t.members = 0;
        t.adults = 0;
    }
    for (let i = 0; i < w.humans.n; i++) {
        const t = w.tribeById.get(w.humans.tribe[i]);
        t.members++;
        if (w.humans.age[i] >= w.p.human.maturity) t.adults++;
    }
}

// ---- The kinds -------------------------------------------------------------------------

test('weapons as the table says: the spear is today\'s, a bow reaches ×1.6 and reloads ×0.6, a club strikes within 4', () => {
    const w = world(EMPTY);
    const P = w.p.human;
    const out = {};
    const stat = (kind, rarity = 0, trait = '') => weaponStats(w, newItem(w, kind, rarity, trait, 0, 1), out);
    assert.deepEqual([stat(KIND.SPEAR).range, out.hit, out.reload], [P.throwRange, 1, P.reload]);
    assert.ok(Math.abs(stat(KIND.BOW).range - P.throwRange * 1.6) < 1e-9);
    assert.deepEqual([out.hit, out.reload], [0.9, 18]);
    assert.deepEqual([stat(KIND.CLUB).range, out.hit, out.reload], [4, 1, P.reload]);
    // A rare one: one trait × 1.25.
    assert.equal(stat(KIND.SPEAR, 1, 'range').range, P.throwRange * 1.25);
    assert.equal(stat(KIND.SPEAR, 1, 'accuracy').hit, 1.25);
    assert.equal(stat(KIND.SPEAR, 1, 'reload').reload, 24);
    assert.equal(stat(KIND.BOW, 2, 'range').range, P.throwRange * 1.6 * 1.5);
});

// A hunter alone with a grazer `d` ahead: does it throw this step, and with what?
function huntAt(kind, d) {
    const w = world({ ...EMPTY, 'human.perTribe': 1 });
    const t = w.tribes[0];
    t.aggression = 0;
    t.store = 0;
    const i = 0;
    alone(w, i, t.camp.x + 100, t.camp.y);
    count(w);
    if (kind) give(w, i, kind);
    else disarm(w, i);
    grazer(w, t.camp.x + 100 + d, t.camp.y);
    w.step();
    const shot = w.events.find((e) => e.type === 'throw' || e.type === 'swing');
    return { shot, state: w.humans.state[i] };
}

test('a bow shoots from beyond a spear\'s throw; the unarmed and a club do not hunt from afar', () => {
    assert.equal(huntAt(KIND.SPEAR, 20).shot, undefined, 'a spear walks closer');
    assert.equal(huntAt(KIND.SPEAR, 20).state, STATE.HUNTING);
    const bow = huntAt(KIND.BOW, 20);
    assert.equal(bow.shot.type, 'throw');
    assert.equal(bow.shot.weapon, KIND.BOW);
    assert.equal(huntAt(KIND.CLUB, 20).state, STATE.GATHERING, 'a club does not stalk a grazer');
    const club = huntAt(KIND.CLUB, 3);
    assert.equal(club.shot.type, 'swing');
    assert.equal(club.shot.weapon, KIND.CLUB);
    assert.equal(huntAt(0, 10).shot, undefined, 'empty-handed, no hunting');
    assert.equal(huntAt(0, 10).state, STATE.GATHERING);
});

test('against a predator a club counts double and a bow not at all; a club hurts strangers more', () => {
    const w = world(EMPTY);
    const [j, ...mates] = adults(w);
    for (const k of mates) alone(w, k, w.humans.x[j] + 1, w.humans.y[j]);
    const n = mates.length;
    assert.equal(guards(w, j), n + 2 - 0, 'spears: 1 each, and the two children');
    give(w, mates[0], KIND.CLUB);
    give(w, mates[1], KIND.BOW);
    assert.equal(guards(w, j), n + 2 + 1 - 1);
    assert.equal(blowOf(w, w.humans, mates[0]), 1.5);
    assert.equal(blowOf(w, w.humans, mates[1]), 1);
});

test('a knife: more meat from a kill, cut up twice as fast; a basket carries half as much again', () => {
    const w = world(EMPTY);
    const [i] = adults(w);
    const P = w.p.human;
    assert.equal(efficiencyOf(w, w.humans, i), P.efficiency);
    give(w, i, KIND.KNIFE);
    assert.equal(efficiencyOf(w, w.humans, i), 0.85);
    give(w, i, KIND.KNIFE, 1, 'effect');
    assert.ok(Math.abs(efficiencyOf(w, w.humans, i) - (0.7 + 0.15 * 1.25)) < 1e-12);
    assert.equal(carryOf(w, w.humans, i), 1);
    give(w, i, KIND.BASKET);
    assert.equal(carryOf(w, w.humans, i), 1.5);
});

test('a torch: a predator does not take its bearer; it burns down and goes out', () => {
    const run = (torch) => {
        const w = world({ ...EMPTY, 'human.perTribe': 1 });
        const t = w.tribes[0];
        alone(w, 0, t.camp.x + 200, t.camp.y);
        if (torch) give(w, 0, KIND.TORCH);
        const p = predatorAt(w, t.camp.x + 202, t.camp.y);
        w.step();
        return { w, alive: w.humans.n === 1 && w.humans.energy[0] > 0, predator: w.carnivores.state[indexIn(w.carnivores, p)] };
    };
    assert.equal(run(false).alive, false, 'without one, eaten');
    const { w, alive, predator } = run(true);
    assert.equal(alive, true);
    assert.equal(predator, STATE.RESTING, 'it backs off');
    assert.equal(shielded(w, 0), true);
    // It burns down: out at its time (the next sweep).
    const torch = w.items.get(w.humans.tool[0]);
    assert.ok(fraction(w, torch) > 0.99);
    torch.expires = w.time + 5;
    for (let k = 0; k < 60 && w.humans.tool[0]; k++) w.step();
    assert.equal(w.humans.tool[0], 0);
    assert.equal(w.items.has(torch.id), false);
    assert.equal(shielded(w, 0), false);
});

// ---- Wear -------------------------------------------------------------------------------

test('wear: a normal item breaks after 40 uses, a rare one after 60 (75 if durable); a legend never', () => {
    const w = world(EMPTY);
    const [i] = adults(w);
    const uses = (rarity, trait = '') => {
        const item = give(w, i, KIND.SPEAR, rarity, trait);
        let n = 0;
        w.events.length = 0;
        while (w.items.has(item.id) && n < 500) {
            wearItem(w, i, item);
            n++;
        }
        return { n, broke: happened(w, 'broke') };
    };
    const normal = uses(0);
    assert.equal(normal.n, 40);
    assert.equal(normal.broke.length, 1);
    assert.equal(normal.broke[0].bearer, w.humans.id[i]);
    assert.equal(normal.broke[0].kind, KIND.SPEAR);
    assert.equal(w.humans.weapon[i], 0, 'the hand is empty');
    assert.equal(w.humans.gear[i] >> 3, 0);
    assert.equal(uses(1).n, 60);
    assert.equal(uses(1, 'durability').n, 75);
    assert.equal(uses(2, 'range').n, 500, 'never');
});

// ---- Crafting ---------------------------------------------------------------------------

test('costs (params.items.costs, by name): spear 2 wood, bow 3 wood and a hide, club 2 wood, knife a flint, basket 2 wood, torch 1 wood', () => {
    const p = config();
    assert.deepEqual(Object.keys(p.items.costs), ITEM_KINDS.slice(1));
    assert.deepEqual(ITEM_KINDS.slice(1).map((k) => Object.values(p.items.costs[k])), [[2, 0, 0], [3, 0, 1], [2, 0, 0], [0, 1, 0], [2, 0, 0], [1, 0, 0]]);
    assert.deepEqual(Object.keys(p.items.costs.bow), ['wood', 'flint', 'hide']);
    assert.equal(costOf(p, KIND.KNIFE), p.items.costs.knife);
    const t = { wood: 3, flint: 0, hide: 0 };
    assert.equal(affords(p, t, KIND.BOW), false);
    t.hide = 1;
    assert.equal(affords(p, t, KIND.BOW), true);
    spend(p, t, KIND.BOW);
    assert.deepEqual([t.wood, t.flint, t.hide], [0, 0, 0]);
    spend(p, t, KIND.BOW, -1);
    assert.deepEqual([t.wood, t.flint, t.hide], [3, 0, 1], 'and back');
    // The other numbers the page reads.
    assert.equal(p.items.enabled, true);
    assert.equal(p.items.craftSteps, 150);
    assert.equal(p.items.pickReach, 6);
});

test('an adult at camp makes what the tribe needs: items.craftSteps, paid from the store', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const [first] = adults(w);
    disarm(w, first);
    Object.assign(t, { store: 5000, wood: 2, flint: 0, aggression: 0, sociality: 0 }); // (a tribe that makes spears)
    let started = -1;
    let done = null;
    for (let k = 0; k < 3000 && !done; k++) {
        w.step();
        for (let i = 0; i < w.humans.n && started < 0; i++) if (w.humans.task[i] === TASK.CRAFT) started = w.time;
        done = happened(w, 'crafted')[0];
    }
    assert.ok(done, 'something made');
    assert.equal(done.kind, KIND.SPEAR);
    assert.equal(done.rarity, 0, 'no flint, no chance of rare');
    assert.equal(done.tribe, t.id);
    assert.equal(done.by, done.id);
    assert.equal(t.wood, 0);
    assert.equal(w.time - started, w.p.items.craftSteps, `${w.time - started} steps`);
    const item = w.items.get(done.item);
    assert.equal(item.maker, done.by);
    // It went to the one with none, or lies in camp for it to take.
    for (let k = 0; k < 400 && w.humans.weapon[at(w, w.humans.id[first])] === 0; k++) w.step();
    assert.notEqual(w.humans.weapon[first], 0, 'the empty-handed one is armed again');
});

test('rarity: only with a flint more, a chance that grows with what the crafter has made', () => {
    const w = world(EMPTY);
    const I = w.p.items;
    const [i] = adults(w);
    const t = w.tribes[0];
    assert.equal(rareChance(I, 0), 0.2);
    assert.equal(rareChance(I, 5), 0.4);
    assert.equal(rareChance(I, 50), 0.6);
    const share = (flint, made) => {
        let rare = 0;
        for (let k = 0; k < 4000; k++) {
            w.humans.crafted[i] = made;
            const item = craft(w, i, KIND.SPEAR, flint, t);
            if (item.rarity === 1) {
                rare++;
                assert.ok(['range', 'accuracy', 'reload', 'durability'].includes(item.trait));
                assert.equal(item.mult, 1.25);
            }
            w.items.delete(item.id);
        }
        return rare / 4000;
    };
    assert.equal(share(false, 0), 0);
    assert.ok(Math.abs(share(true, 0) - 0.2) < 0.025);
    assert.ok(Math.abs(share(true, 10) - 0.6) < 0.025);
});

test('culture: aggressive tribes make clubs and knives, social ones bows and baskets', () => {
    const wants = (aggression, sociality, armed, hide = 5) => {
        const w = world(EMPTY);
        const t = w.tribes[0];
        Object.assign(t, { aggression, sociality, store: 5000, hide });
        for (const i of adults(w)) if (!armed) disarm(w, i);
        count(w);
        tallyTribes(w);
        return t.want;
    };
    assert.equal(wants(1, 0, false), KIND.CLUB);
    assert.equal(wants(0, 1, false), KIND.BOW);
    assert.equal(wants(0, 1, false, 0), KIND.SPEAR, 'no hide for a bow');
    assert.equal(wants(0, 0, false), KIND.SPEAR);
    assert.equal(wants(1, 0, true), KIND.KNIFE);
    assert.equal(wants(0, 1, true), KIND.BASKET);
    // A hungry camp makes weapons for the empty-handed, and knives, only.
    const w = world(EMPTY);
    const t = w.tribes[0];
    t.store = 0;
    count(w);
    tallyTribes(w);
    assert.equal(t.want, KIND.KNIFE, 'all armed, hungry: knives, no other tools');
    disarm(w, adults(w)[0]);
    tallyTribes(w);
    assert.notEqual(t.want, 0);
    assert.equal(t.wanted, 1);
});

// ---- Butchering for everyone -------------------------------------------------------------

test('a hunter\'s kill waits in a carcass: it cuts it up (items.butcher steps), eats its share, carries the rest and the hide home', () => {
    const w = world({ ...EMPTY, 'human.perTribe': 1 });
    const t = w.tribes[0];
    t.sociality = 0.5;
    t.aggression = 0;
    alone(w, 0, t.camp.x + 150, t.camp.y);
    w.humans.energy[0] = 100;
    const g = grazer(w, t.camp.x + 160, t.camp.y, { energy: 80 });
    const j = indexIn(w.herbivores, g);
    killed(w, 0, w.herbivores, j, efficiencyOf(w, w.humans, 0));
    w.die(w.herbivores, j, 'hunted', w.humans.id[0]);
    const c = w.carcasses.get(g);
    assert.equal(c.total, 80 * 0.7);
    assert.equal(c.by, w.humans.id[0]);
    assert.equal(c.hide, 1);
    assert.equal(w.humans.task[0], TASK.BUTCHER);
    const before = w.humans.energy[0] + w.humans.carry[0];
    let cutting = 0;
    let strokes = 0;
    let butchered = null;
    for (let k = 0; k < 200 && !butchered; k++) {
        w.step();
        if (w.humans.state[0] === STATE.BUTCHERING) cutting++;
        strokes += happened(w, 'butcher').filter((e) => e.id === w.humans.id[0]).length;
        butchered = happened(w, 'butchered')[0];
    }
    assert.ok(butchered && butchered.id === w.humans.id[0] && butchered.carcass === g);
    assert.equal(cutting, w.p.items.butcher);
    assert.equal(strokes, w.p.items.butcher / w.p.play.butcherEvery);
    assert.equal(w.carcasses.has(g), false);
    assert.equal(w.humans.task[0], TASK.NONE);
    assert.equal(w.humans.hides[0], 1);
    // Every bit of meat went into the hunter or its hands (less what living cost).
    const after = w.humans.energy[0] + w.humans.carry[0];
    assert.ok(Math.abs(after - before - c.total) < 4, `${before} + ${c.total} ≈ ${after} (less what living costs)`);
    assert.ok(w.humans.carry[0] > 0.4 * c.total, 'half of it to carry home');
    // With a knife: twice as fast.
    const v = world({ ...EMPTY, 'human.perTribe': 1 });
    alone(v, 0, v.tribes[0].camp.x + 150, v.tribes[0].camp.y);
    give(v, 0, KIND.KNIFE);
    const h = grazer(v, v.tribes[0].camp.x + 152, v.tribes[0].camp.y, { energy: 80 });
    killed(v, 0, v.herbivores, indexIn(v.herbivores, h), efficiencyOf(v, v.humans, 0));
    v.die(v.herbivores, indexIn(v.herbivores, h), 'hunted', v.humans.id[0]);
    assert.equal(v.carcasses.get(h).total, 80 * 0.85);
    let knifeSteps = 0;
    for (let k = 0; k < 100 && v.carcasses.has(h); k++) {
        v.step();
        if (v.humans.state[0] === STATE.BUTCHERING) knifeSteps++;
    }
    assert.equal(knifeSteps, w.p.items.butcher / 2);
});

test('in a whole world, hunters butcher their kills and hides reach the stores', () => {
    const w = world();
    let butchered = 0;
    let carcasses = 0;
    for (let k = 0; k < 3000; k++) {
        w.step();
        for (const e of w.events) {
            if (e.type === 'butchered' && e.id !== 0) butchered++;
            if (e.type === 'death' && e.cause === 'hunted' && w.carcasses.has(e.id)) carcasses++;
        }
    }
    assert.ok(butchered > 20, `${butchered} butchered`);
    assert.ok(carcasses > 20, 'each kill a carcass');
    assert.ok(w.tribes.some((t) => t.hide > 0), 'hides in store');
});

// ---- Legends -----------------------------------------------------------------------------

function legendOf(w, item, deed) {
    assert.equal(item.rarity, 2);
    assert.equal(item.mult, 1.5);
    assert.equal(item.wear, Infinity);
    assert.ok(item.trait && item.trait !== 'durability');
    assert.equal(item.legend.deed, deed);
    assert.match(item.legend.name, /^[A-Z][a-z]+('s)? [A-Z][a-z]+$/);
    assert.ok(item.legend.history.length >= 2, 'its story: made, and the deed');
    assert.equal(fraction(w, item), 1);
    const e = happened(w, 'legend').find((x) => x.item === item.id);
    assert.ok(e, 'a legend event');
    assert.equal(e.name, item.legend.name);
    assert.equal(e.deed, deed);
    assert.equal(e.kind, item.kind);
}

test('a legend from killing a famous predator, or from its sixtieth kill', () => {
    const w = world(EMPTY);
    const [i] = adults(w);
    const spear = w.items.get(w.humans.weapon[i]);
    const p = predatorAt(w, 10, 10);
    const c = w.carnivores;
    c.kills[indexIn(c, p)] = w.p.items.famous - 1;
    credit(w, spear, c, indexIn(c, p));
    assert.equal(spear.rarity, 0, 'not famous enough');
    c.kills[indexIn(c, p)] = w.p.items.famous;
    credit(w, spear, c, indexIn(c, p));
    legendOf(w, spear, 'famous');
    assert.equal(spear.legend.skill, `Flight of ${spear.legend.name}`);
    const bow = give(w, i, KIND.BOW, 1, 'reload');
    const g = indexIn(w.herbivores, grazer(w, 20, 20));
    for (let k = 1; k < w.p.items.kills; k++) credit(w, bow, w.herbivores, g);
    assert.equal(bow.rarity, 1);
    credit(w, bow, w.herbivores, g);
    legendOf(w, bow, 'kills');
    assert.equal(bow.trait, 'reload', 'a rare one keeps its trait');
    assert.equal(bow.legend.skill, `Rain of ${bow.legend.name}`);
});

test('a legend from three generations of one line, handed down at death in camp', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const [a] = adults(w);
    const pop = w.humans;
    alone(w, a, t.camp.x + 2, t.camp.y);
    const club = give(w, a, KIND.CLUB);
    const b = childOf(w, a, t.camp.x + 3, t.camp.y, 1000);
    const c = childOf(w, b, t.camp.x + 4, t.camp.y, 100);
    const [ida, idb, idc] = [pop.id[a], pop.id[b], pop.id[c]];
    const rev = club.rev;
    w.die(pop, a, 'old age');
    assert.equal(pop.weapon[at(w, idb)], club.id, 'the child takes it up');
    assert.equal(club.gens, 2);
    assert.ok(club.rev > rev, 'described again: its generations changed');
    assert.equal(describe(club).gens, 2);
    const handed = happened(w, 'picked').find((e) => e.item === club.id);
    assert.equal(handed.by, idb);
    assert.equal(handed.from, ida);
    w.step();
    w.die(pop, at(w, idb), 'old age');
    assert.equal(pop.weapon[at(w, idc)], club.id, 'a grandchild too, though a child');
    assert.equal(club.gens, 3);
    legendOf(w, club, 'generations');
    assert.equal(club.line, ida, 'the line it was handed down in (from its first bearer)');
});

test('a legend from striking down raiders in its own camp, and from outliving its makers', () => {
    const w = world({ 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 2 });
    const [A, B] = w.tribes;
    const pop = w.humans;
    const defender = adults(w)[0];
    alone(w, defender, A.camp.x, A.camp.y);
    const spear = w.items.get(pop.weapon[defender]);
    let raider = -1;
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === B.id && pop.age[i] >= w.p.human.maturity) raider = i;
    pop.x[raider] = A.camp.x + 3;
    pop.y[raider] = A.camp.y;
    for (let k = 0; k < w.p.items.defender; k++) raiderKilled(w, raider, A);
    legendOf(w, spear, 'defender');
    assert.equal(spear.raiders, w.p.items.defender);
    // B's spear, borne by one of A, outlives B.
    let theirs = -1;
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === B.id && pop.weapon[i]) theirs = i;
    const old = w.items.get(pop.weapon[theirs]);
    unhold(w, theirs, old);
    const mine = adults(w)[1];
    const had = heldLike(w, mine, KIND.SPEAR);
    unhold(w, mine, had);
    hold(w, mine, old);
    old.kills = w.p.items.outlived;
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === B.id) w.die(pop, i, 'killed');
    w.step();
    assert.equal(w.tribeById.has(B.id), false, 'B is gone');
    legendOf(w, old, 'outlived');
});

test('a legend never wears out, and lies on the ground for good', () => {
    const w = world(EMPTY);
    const [i] = adults(w);
    const spear = w.items.get(w.humans.weapon[i]);
    forge(w, spear, 'kills', 'test', 0);
    for (let k = 0; k < 100; k++) wearItem(w, i, spear);
    assert.equal(w.humans.weapon[i], spear.id);
    unhold(w, i, spear);
    lay(w, spear, 10, 10, null);
    spear.dropped = w.time - 10 * w.p.items.vanish;
    for (let k = 0; k < 60; k++) w.step();
    assert.equal(w.items.has(spear.id), true);
});

// ---- Death, lying about, picking up ----------------------------------------------------

test('dying at camp: the eldest child takes what is better than its own; the rest lies in camp', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const pop = w.humans;
    const [a] = adults(w);
    alone(w, a, t.camp.x, t.camp.y + 3);
    const rare = give(w, a, KIND.SPEAR, 1, 'range');
    const basket = give(w, a, KIND.BASKET);
    const young = childOf(w, a, t.camp.x, t.camp.y, 100);
    const eldest = childOf(w, a, t.camp.x, t.camp.y, 2000);
    const knife = give(w, eldest, KIND.KNIFE, 1, 'effect');
    const plain = give(w, eldest, KIND.SPEAR);
    const ids = [pop.id[young], pop.id[eldest]];
    w.die(pop, a, 'old age');
    const e = at(w, ids[1]);
    assert.equal(pop.weapon[e], rare.id, 'the rare spear to the eldest');
    assert.equal(pop.tool[e], knife.id, 'it keeps its better knife');
    assert.equal(pop.weapon[at(w, ids[0])], 0, 'nothing to the younger');
    assert.ok(t.goods.includes(plain.id), 'its old spear lies in camp');
    assert.ok(t.goods.includes(basket.id), 'and the basket it did not need... it had a knife');
    assert.equal(basket.bearer, 0);
    assert.ok(dist(w, basket.x, basket.y, t.camp.x, t.camp.y) < w.p.human.campRadius);
});

test('dying away from camp: it lies where the bearer fell, and is gone 3000 steps later', () => {
    const w = world(EMPTY);
    const [a] = adults(w);
    const far = farSpot(w);
    alone(w, a, far.x, far.y);
    const spear = w.items.get(w.humans.weapon[a]);
    w.die(w.humans, a, 'eaten');
    assert.equal(spear.bearer, 0);
    assert.deepEqual([spear.x, spear.y], [far.x, far.y]);
    assert.ok(w.wild.includes(spear.id));
    const dropped = happened(w, 'dropped').find((e) => e.item === spear.id);
    assert.deepEqual([dropped.x, dropped.y], [far.x, far.y]);
    for (let k = 0; k < w.p.items.vanish - 60; k++) w.step();
    assert.equal(w.items.has(spear.id), true, 'still there');
    let vanished = null;
    for (let k = 0; k < 120 && !vanished; k++) {
        w.step();
        vanished = happened(w, 'vanished').find((e) => e.item === spear.id);
    }
    assert.ok(vanished);
    assert.equal(w.items.has(spear.id), false);
    assert.equal(w.wild.includes(spear.id), false);
});

test('passing within 6 of something better, one takes it up and leaves its own; never a club for a spear', () => {
    const w = world(EMPTY);
    const [i] = adults(w);
    const far = farSpot(w);
    alone(w, i, far.x, far.y);
    const mine = w.items.get(w.humans.weapon[i]);
    mine.wear = 10;
    const club = newItem(w, KIND.CLUB, 0, '', 0, 1);
    lay(w, club, far.x + 3, far.y, null);
    wildPickup(w, i);
    assert.equal(w.humans.weapon[i], mine.id, 'not a club for a spear');
    const rare = newItem(w, KIND.SPEAR, 1, 'accuracy', 0, 1);
    lay(w, rare, far.x + 7, far.y, null);
    wildPickup(w, i);
    assert.equal(w.humans.weapon[i], mine.id, '7 away: too far');
    rare.x = far.x - 5;
    w.wildX[w.wild.indexOf(rare.id)] = rare.x;
    wildPickup(w, i);
    assert.equal(w.humans.weapon[i], rare.id);
    assert.equal(mine.bearer, 0, 'its own left behind');
    assert.ok(w.wild.includes(mine.id));
    assert.ok(happened(w, 'picked').some((e) => e.item === rare.id && e.by === w.humans.id[i]));
    // In the whole world: people find what others dropped.
    const v = world();
    let picked = 0;
    for (let k = 0; k < 4000; k++) {
        v.step();
        picked += happened(v, 'picked').length;
    }
    assert.ok(picked > 0);
});

test('a raider takes what lies in the camp it robs', () => {
    const w = world({ 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 2 });
    const [A, B] = w.tribes;
    const pop = w.humans;
    const rare = newItem(w, KIND.SPEAR, 1, 'range', 0, A.id);
    const basket = newItem(w, KIND.BASKET, 0, '', 0, A.id);
    const club = newItem(w, KIND.CLUB, 0, '', 0, A.id);
    for (const item of [rare, basket, club]) lay(w, item, A.camp.x + 2, A.camp.y, A);
    let raider = -1;
    for (let i = 0; i < pop.n; i++) if (pop.tribe[i] === B.id && pop.weapon[i]) raider = i;
    const own = w.items.get(pop.weapon[raider]);
    raided(w, raider, A);
    assert.equal(A.goods.length, 0, 'the camp is bare');
    assert.equal(pop.weapon[raider], rare.id);
    assert.equal(pop.tool[raider], basket.id);
    assert.ok(B.goods.includes(own.id) && B.goods.includes(club.id), 'the rest home to its own camp');
    assert.ok(dist(w, club.x, club.y, B.camp.x, B.camp.y) < w.p.human.campRadius);
});

test('a daughter tribe takes half the materials and every other thing lying in camp', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    Object.assign(t, { wood: 10, flint: 3, hide: 8 });
    for (let k = 0; k < 4; k++) lay(w, newItem(w, KIND.TORCH, 0, '', 0, t.id), t.camp.x, t.camp.y, t);
    const daughter = { id: 99, camp: { x: t.camp.x + 300, y: t.camp.y }, goods: [] };
    w.tribeById.set(99, daughter);
    splitItems(w, t, daughter);
    assert.deepEqual([t.wood, t.flint, t.hide, daughter.wood, daughter.flint, daughter.hide], [5, 1.5, 4, 5, 1.5, 4]);
    assert.equal(t.goods.length, 2);
    assert.equal(daughter.goods.length, 2);
    for (const id of daughter.goods) {
        const item = w.items.get(id);
        assert.equal(item.camp, 99);
        assert.ok(dist(w, item.x, item.y, daughter.camp.x, daughter.camp.y) < 20);
    }
});

// ---- The player's hands ------------------------------------------------------------------

// An adult of the first tribe taken over, at its camp (or `x, y`). Its id and index.
function control(w, x, y) {
    const pop = w.humans;
    const [i] = adults(w);
    const t = w.tribes[0];
    alone(w, i, x ?? t.camp.x + 12, y ?? t.camp.y);
    pop.carry[i] = 0;
    assert.ok(takeControl(w, pop.id[i], 'god'));
    input(w, pop.x[i], pop.y[i]);
    return pop.id[i];
}

test('crafting by hand: at camp, from the store, items.craftSteps; into the kit; a move stops it and gives the materials back', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const id = control(w);
    t.wood = 5;
    t.flint = 1;
    t.store = 0; // (a hungry camp: the others make nothing, all being armed)
    act(w, 'craft', { kind: 'bow', flint: true });
    w.step();
    assert.equal(w.player.crafting, null, 'no hide: no bow');
    act(w, 'craft', { kind: KIND.SPEAR, flint: true });
    w.step();
    assert.deepEqual([t.wood, t.flint], [3, 0]);
    const p = playerSnapshot(w);
    assert.deepEqual(p.crafting, { kind: KIND.SPEAR, until: w.time - 1 + w.p.items.craftSteps });
    assert.equal(w.humans.state[at(w, id)], STATE.CRAFTING);
    let made = null;
    for (let k = 0; k < w.p.items.craftSteps + 50 && !made; k++) {
        w.step();
        made = happened(w, 'crafted')[0];
    }
    assert.ok(made);
    assert.equal(made.by, id);
    assert.equal(w.time - 1, p.crafting.until, 'done at its time');
    assert.deepEqual(playerSnapshot(w).kit.weapons, [made.item], 'the hand was full: into the kit');
    assert.equal(w.humans.crafted[at(w, id)], 1);
    // Begun again, then walked off.
    act(w, 'craft', { kind: 'torch' });
    w.step();
    assert.equal(t.wood, 2);
    const i = at(w, id);
    input(w, w.humans.x[i] + 1, w.humans.y[i]);
    w.step();
    assert.equal(w.player.crafting, null);
    assert.equal(t.wood, 3, 'the wood back');
    // Away from camp: not at all.
    w.humans.x[i] += 100;
    input(w, w.humans.x[i], w.humans.y[i]);
    w.step();
    act(w, 'craft', { kind: 'torch' });
    w.step();
    assert.equal(w.player.crafting, null);
});

test('picking up, cycling, dropping', () => {
    const w = world(EMPTY);
    const far = farSpot(w);
    const id = control(w, far.x, far.y);
    const i = at(w, id);
    const spear = w.items.get(w.humans.weapon[i]);
    const bow = newItem(w, KIND.BOW, 0, '', 0, 1);
    lay(w, bow, far.x + 5, far.y, null);
    const club = newItem(w, KIND.CLUB, 0, '', 0, 1);
    lay(w, club, far.x + 8, far.y, null);
    act(w, 'pickup', { item: club.id });
    w.step();
    assert.equal(club.bearer, 0, '8 away: out of reach');
    act(w, 'pickup', { item: bow.id });
    w.step();
    let p = playerSnapshot(w);
    assert.equal(p.weapon, bow.id);
    assert.deepEqual(p.kit.weapons, [spear.id], 'the spear to the kit');
    assert.equal(spear.bearer, id);
    assert.equal(p.skill, SKILLS[KIND.BOW].cost);
    act(w, 'cycle', { slot: 'weapon' });
    w.step();
    p = playerSnapshot(w);
    assert.deepEqual([p.weapon, p.kit.weapons], [spear.id, [bow.id]]);
    // A full kit: what was in hand goes down.
    w.player.kit.weapons.push(newItem(w, KIND.SPEAR, 0, '', 0, 1).id);
    w.items.get(w.player.kit.weapons[1]).bearer = id;
    club.x = w.humans.x[i] + 2;
    w.wildX[w.wild.indexOf(club.id)] = club.x;
    act(w, 'pickup', { item: club.id });
    w.step();
    p = playerSnapshot(w);
    assert.equal(p.weapon, club.id);
    assert.equal(p.kit.weapons.length, 2);
    assert.equal(spear.bearer, 0, 'down where it stands');
    assert.ok(w.wild.includes(spear.id));
    act(w, 'drop', { item: bow.id });
    w.step();
    assert.deepEqual(playerSnapshot(w).kit.weapons.includes(bow.id), false);
    assert.equal(bow.bearer, 0);
    act(w, 'drop', { item: club.id });
    w.step();
    assert.equal(playerSnapshot(w).weapon, 0);
    assert.equal(playerSnapshot(w).skill, 0);
});

test('attacks by weapon: a bow shoots an arrow, a club swings and never leaves the hand, an empty hand does nothing', () => {
    const w = world(EMPTY);
    const far = farSpot(w);
    const id = control(w, far.x, far.y);
    const i = at(w, id);
    give(w, i, KIND.BOW);
    act(w, 'attack', { heavy: false, dx: 1, dy: 0, power: 0, target: 0 });
    w.step();
    assert.equal(w.spears.n, 1);
    assert.equal(w.spears.kind[0], KIND.BOW);
    assert.ok(Math.abs(Math.hypot(w.spears.vx[0], w.spears.vy[0]) - w.p.play.throwSpeed * w.p.items.arrowSpeed) < 1e-9, 'faster (items.arrowSpeed)');
    assert.ok(Math.abs(w.spears.range[0] - w.p.play.throwRange * w.p.items.arrowRange) < 1e-9, 'farther (items.arrowRange)');
    assert.equal(w.spears.pack()[5], KIND.BOW, 'an arrow, for the page');
    assert.equal(happened(w, 'throw')[0].weapon, KIND.BOW);
    assert.equal(w.humans.timer[i], 18 - 0, 'a bow reloads sooner');
    for (let k = 0; k < 30; k++) w.step();
    give(w, i, KIND.CLUB);
    // Creeping up behind a grazer facing away (crouched, it notices only within 3).
    input(w, w.humans.x[i], w.humans.y[i], { crouch: true });
    const g = grazer(w, far.x + 3.5, far.y, { heading: 0 });
    w.humans.timer[i] = 0;
    act(w, 'attack', { heavy: false, dx: 1, dy: 0, power: 0, target: 0 });
    w.step();
    assert.equal(w.spears.n, 0, 'nothing thrown');
    const swing = happened(w, 'swing')[0];
    assert.ok(swing && swing.id === id && swing.weapon === KIND.CLUB);
    assert.ok(happened(w, 'death').some((e) => e.id === g), 'an ambush kills');
    assert.equal(happened(w, 'hit')[0].weapon, KIND.CLUB);
    const club = w.items.get(w.humans.weapon[i]);
    assert.equal(club.uses, 1);
    assert.equal(club.kills, 1);
    disarm(w, i);
    w.humans.timer[i] = 0;
    act(w, 'attack', { heavy: false, dx: 1, dy: 0, power: 0, target: 0 });
    w.step();
    assert.equal(happened(w, 'throw').length + happened(w, 'swing').length + happened(w, 'jab').length, 0);
});

test('weapon skills cost Spirit: a piercing throw, a volley, a ground slam', () => {
    const w = world(EMPTY);
    const far = farSpot(w);
    const id = control(w, far.x, far.y);
    const i = at(w, id);
    const fly = (n) => {
        for (let k = 0; k < n; k++) w.step();
    };
    // Three grazers in a line ahead: the spear passes through two and stops in the third.
    const gs = [8, 12, 16, 19].map((d) => grazer(w, far.x + d, far.y, { heading: Math.PI / 2 }));
    act(w, 'skill', { dx: 1, dy: 0, target: 0 });
    w.step();
    const skill = happened(w, 'skill')[0];
    assert.deepEqual([skill.id, skill.kind, skill.name], [id, KIND.SPEAR, '']);
    assert.equal(w.player.spirit, w.p.play.spiritMax - 30 + w.p.play.spiritRegen);
    let dead = [];
    for (let k = 0; k < 20; k++) {
        w.step();
        dead = dead.concat(happened(w, 'death').map((e) => e.id));
    }
    assert.deepEqual(gs.map((g) => dead.includes(g)), [true, true, true, false]);
    // A volley: three arrows.
    give(w, i, KIND.BOW);
    w.humans.timer[i] = 0;
    act(w, 'skill', { dx: 0, dy: 1, target: 0 });
    w.step();
    assert.equal(w.spears.n, 3);
    assert.deepEqual([...w.spears.kind.subarray(0, 3)], [KIND.BOW, KIND.BOW, KIND.BOW]);
    fly(40);
    // Not enough Spirit: nothing.
    give(w, i, KIND.CLUB);
    w.player.spirit = 39;
    w.humans.timer[i] = 0;
    const near = predatorAt(w, far.x + 6, far.y, { resting: false, energy: 119 });
    const away = predatorAt(w, far.x + 12, far.y, { resting: false, energy: 119 });
    act(w, 'skill', { dx: 1, dy: 0, target: 0 });
    w.step();
    assert.equal(happened(w, 'skill').length, 0);
    w.player.spirit = 100;
    act(w, 'skill', { dx: 1, dy: 0, target: 0 });
    w.step();
    const c = w.carnivores;
    assert.equal(c.state[indexIn(c, near)], STATE.RESTING, 'driven off');
    assert.notEqual(c.state[indexIn(c, away)], STATE.RESTING, 'out of reach');
    assert.ok(w.player.spirit < 61);
});

test('tools: a knife cuts up a kill at double speed, a torch drives predators off and burns, a basket gathers', () => {
    const w = world(EMPTY);
    const far = farSpot(w);
    const id = control(w, far.x, far.y);
    const i = at(w, id);
    const knife = give(w, i, KIND.KNIFE);
    const g = grazer(w, far.x + 2, far.y, { heading: 0 });
    act(w, 'attack', { heavy: false, dx: 1, dy: 0, power: 0, target: 0 }); // a jab from behind: a kill
    w.step();
    assert.ok(w.carcasses.has(g));
    act(w, 'tool', { dx: 1, dy: 0, target: 0 });
    w.step();
    assert.equal(w.player.butcher, g);
    let steps = 1;
    while (w.carcasses.has(g) && steps < 100) {
        w.step();
        steps++;
    }
    assert.equal(steps, w.p.play.butcherSteps / 2);
    assert.equal(knife.uses, 1, 'a kill cut up');
    assert.equal(w.humans.hides[i], 1, 'and its hide');
    const torch = give(w, i, KIND.TORCH);
    const p = predatorAt(w, far.x + 5, far.y, { energy: 119 });
    const left = torch.expires;
    act(w, 'tool', { dx: 1, dy: 0, target: 0 });
    w.step();
    assert.equal(w.carnivores.state[indexIn(w.carnivores, p)], STATE.RESTING);
    assert.equal(torch.expires, left - 0.1 * torch.max);
    assert.equal(happened(w, 'tool')[0].kind, KIND.TORCH);
    give(w, i, KIND.BASKET);
    w.grass.g[w.grass.index(w.humans.x[i], w.humans.y[i])] = 1;
    act(w, 'tool', { dx: 1, dy: 0, target: 0 });
    w.step();
    assert.equal(w.player.gather, true);
    act(w, 'tool', { dx: 1, dy: 0, target: 0 });
    w.step();
    assert.equal(w.player.gather, false);
    // The hides go into the store with the food, at the rack.
    const t = w.tribes[0];
    w.humans.x[i] = t.camp.x;
    w.humans.y[i] = t.camp.y;
    input(w, t.camp.x, t.camp.y);
    w.step();
    const hide = t.hide;
    act(w, 'store');
    w.step();
    assert.equal(t.hide, hide + 1);
    assert.equal(happened(w, 'store')[0].hide, 1);
});

test('a player who dies with spares leaves them all; one who leaves a body puts the spares down', () => {
    const w = world(EMPTY);
    const far = farSpot(w);
    const id = control(w, far.x, far.y);
    const i = at(w, id);
    const spare = newItem(w, KIND.BOW, 0, '', 0, 1);
    spare.bearer = id;
    w.player.kit.weapons.push(spare.id);
    takeControl(w, id, 'god');
    assert.deepEqual(w.player.kit.weapons, [spare.id], 'the same body again: its spares kept');
    takeControl(w, 0, 'god');
    assert.equal(spare.bearer, 0);
    assert.ok(w.wild.includes(spare.id));
    control(w, far.x, far.y);
    const again = newItem(w, KIND.TORCH, 0, '', 0, 1);
    again.bearer = id;
    w.player.kit.tools.push(again.id);
    w.die(w.humans, i, 'eaten');
    assert.equal(again.bearer, 0);
    assert.equal(w.player.kit.tools.length, 0);
});

// ---- To the page ---------------------------------------------------------------------------

test('the snapshot carries items to the Mirror: described once, numbers each time, gone when gone; legends; who holds what', async () => {
    const host = { local: true, onmessage: null, send: (msg) => sim.handle(msg) };
    const sim = new Sim((msg) => host.onmessage(msg));
    const mirror = new Mirror(host);
    const params = structuredClone(defaults);
    mirror.reset(params, 3, 1.6);
    mirror.update(performance.now(), 16);
    await mirror.run(1);
    const show = () => {
        sim.dirty = true;
        sim.handle({ type: 'want' });
        mirror.update(performance.now() + 1e6, 16);
    };
    show();
    const w = sim.world;
    assert.equal(mirror.items.size, w.items.size);
    const pop = w.humans;
    let i = 0;
    while (!pop.weapon[i]) i++;
    const spear = w.items.get(pop.weapon[i]);
    const seen = mirror.items.get(spear.id);
    assert.deepEqual(
        { id: seen.id, kind: seen.kind, rarity: seen.rarity, bearer: seen.bearer, wear: seen.wear, kills: seen.kills },
        { id: spear.id, kind: KIND.SPEAR, rarity: 0, bearer: pop.id[i], wear: spear.wear / spear.max, kills: 0 },
    );
    assert.equal(mirror.byBearer.get(pop.id[i]).weapon, seen);
    assert.equal(mirror.byBearer.get(pop.id[i]).tool, undefined);
    // Described once: the next snapshot has numbers only.
    sim.dirty = true;
    let last = null;
    const post = sim.post;
    sim.post = (msg, t) => {
        last = msg;
        post(msg, t);
    };
    sim.handle({ type: 'want' });
    assert.equal(last.newItems.length, 0);
    assert.equal(last.items.length, w.items.size * ITEM_STRIDE);
    assert.equal(last.tribes.length, w.tribes.length * TRIBE_STRIDE);
    // A legend: described again; the Mirror lists it.
    forge(w, spear, 'famous', 'test', pop.id[i]);
    w.tribes[0].wood = 7;
    show();
    assert.equal(last.newItems.length, 1);
    assert.equal(mirror.legends[0], mirror.items.get(spear.id));
    assert.equal(mirror.legends[0].legend.name, spear.legend.name);
    assert.equal(mirror.legends[0].rarity, 2);
    assert.equal(mirror.legends[0].gens, 1, 'generations of one line, in the description');
    assert.equal(mirror.items.get(spear.id).wear, 1);
    assert.equal(mirror.tribeById.get(w.tribes[0].id).wood, 7);
    // Gone: listed once, and the Mirror forgets it.
    const other = w.items.get(pop.weapon[i + 1] || pop.weapon[i + 2]);
    w.items.delete(other.id);
    unhold(w, indexIn(pop, other.bearer), other);
    show();
    assert.deepEqual(last.goneItems, [other.id]);
    assert.equal(mirror.items.has(other.id), false);
    assert.equal(mirror.itemInfo.has(other.id), false);
});

test('snapshot.player says what is in hand, the spares, what is being made and what the skill costs', () => {
    const w = world(EMPTY);
    const id = control(w);
    const i = at(w, id);
    const p = playerSnapshot(w);
    assert.equal(p.weapon, w.humans.weapon[i]);
    assert.equal(p.tool, 0);
    assert.deepEqual(p.kit, { weapons: [], tools: [] });
    assert.equal(p.crafting, null);
    assert.equal(p.skill, 30);
    give(w, i, KIND.CLUB);
    assert.equal(playerSnapshot(w).skill, 40);
});
