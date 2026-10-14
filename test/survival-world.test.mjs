// Stage 4, package 2 (survival), in a world: the cold's cost and death by
// freezing, the camp fire, warming by it, the cloak (worn, made, worn out, a
// legend), wild berries and fruit (placed, ripening, picked), deep snow
// slowing walking, and the save round trip with all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { winterOf } from '../src/calendar.js';
import { snowLineAt, depthAt, snowPace } from '../src/snow.js';
import { WARMTH, cloakWarmth } from '../src/warmth.js';
import { BIOME } from '../src/terrain.js';
import { World, STATE } from '../src/world.js';
import { setParam, Packer } from '../src/sim.js';
import { takeControl, applyAct, applyInput, playerSnapshot } from '../src/player.js';
import { KIND, TASK, ITEM_KINDS, newItem, hold, handWork } from '../src/items.js';
import { feel, COLD, SNOW_EVERY, FIRE_CLEAR, WARM_NEAR, WARM_FAR } from '../src/cold.js';
import { PLANT, crop } from '../src/plants.js';
import { saveWorld, loadWorld } from '../src/save.js';
import { wrapDelta, livingIndexOf } from '../src/util.js';

const C = defaults.calendar;
const DAY = C.day;
const SEASON = DAY * C.seasonDays;
const YEAR = SEASON * 4;
const NOON = C.dawn + C.light / 2; // into a day
const NIGHT = C.dawn + C.light + C.dusk; // night falls, into a day
// A moment: year y (1, 2, ...), season s (0..3), day d of it (0..5), and an hour into the day.
const moment = (y, s, d, hour) => (y - 1) * YEAR + s * SEASON + d * DAY + hour;

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });
// A flat world of one tribe and no animals (the chill is the air's alone).
const EMPTY = { 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 };
// The world at `time` (the step about to be taken: its clock).
const jump = (w, time) => {
    w.time = time;
    w.clock();
};
// A year of seed's whose winter is `hard` (0 mild .. 2 hard).
const yearOf = (seed, hard) => {
    for (let y = 2; y < 60; y++) if (winterOf(C, seed, y) === hard) return y;
    throw new Error('no such winter');
};
const adultsOf = (w) => {
    const out = [];
    for (let i = 0; i < w.humans.n; i++) if (w.humans.age[i] >= w.p.human.maturity) out.push(i);
    return out;
};
const dist = (w, i, x, y) => Math.hypot(wrapDelta(w.humans.x[i] - x, w.width), wrapDelta(w.humans.y[i] - y, w.height));
// Person i, an adult with its life ahead, at (x, y) with `energy`.
function alone(w, i, x, y, energy = w.p.human.maxEnergy) {
    const pop = w.humans;
    pop.x[i] = x;
    pop.y[i] = y;
    pop.energy[i] = energy;
    pop.lifespan[i] = pop.age[i] + 1e7;
}
let seq = 0;
// The player stands where it is for a step.
const stand = (w, id) => {
    const j = livingIndexOf(w.humans, id);
    applyInput(w, { seq: ++seq, x: w.humans.x[j], y: w.humans.y[j], heading: 0, speed: 0, crouch: false });
    w.step();
};

// ---- The cold -------------------------------------------------------------------------------

test('the simulation keeps the page\'s warmth numbers (params.cold and warmth.js WARMTH agree)', () => {
    for (const k of Object.keys(WARMTH)) assert.equal(defaults.cold[k], WARMTH[k], k);
});

test('the cold costs energy: out on a hard winter night with no cloak a person freezes to death; by a lit fire it does not', () => {
    const seed = 3;
    const w = world(EMPTY, seed);
    const t = w.tribes[0];
    t.store = 0;
    t.wood = 0; // (no fire)
    const [a, b] = adultsOf(w);
    for (let i = 0; i < w.humans.n; i++) if (i !== a && i !== b) w.humans.energy[i] = 0; // (only the two)
    w.humans.compact();
    jump(w, moment(yearOf(seed, 2), 3, 4, NIGHT + 10)); // a hard winter's night
    alone(w, 0, t.camp.x + 300, t.camp.y, 30); // far out, with little in it
    alone(w, 1, t.camp.x, t.camp.y, 30);       // at camp
    assert.equal(feel(w, 0, t), 1, 'a hard winter night: full exposure, with no cloak, no fire');
    const ida = w.humans.id[0];
    const idb = w.humans.id[1];
    let froze = null;
    for (let k = 0; k < 600 && !froze; k++) {
        w.step();
        froze = w.events.find((e) => e.type === 'death' && e.id === ida) ?? null;
    }
    assert.ok(froze, 'it died out there');
    assert.equal(froze.cause, 'froze', 'of the cold');
    assert.equal(w.deaths.human.froze, 1);
    // The one at camp: the fire lit (wood enough), and it lives on.
    t.wood = 1000;
    let j = livingIndexOf(w.humans, idb);
    assert.ok(j >= 0, 'the other lives (so far)');
    w.humans.energy[j] = 30;
    for (let k = 0; k < 400; k++) w.step();
    assert.ok(t.fire > 0, 'the fire lit');
    j = livingIndexOf(w.humans, idb);
    assert.ok(j >= 0 && w.humans.energy[j] > 20, 'by the fire, warm enough');
    feel(w, j, t);
    assert.ok(COLD.exposure < w.p.cold.comfort && COLD.near === t.fire, `by the fire: exposure ${COLD.exposure}`);
});

test('the fire: lit at night while there is wood, burning it, by day in the cold, out without wood; it warms only near the camp', () => {
    const seed = 3;
    const w = world(EMPTY, seed);
    const t = w.tribes[0];
    const I = w.p.items;
    const nightLen = C.day - NIGHT;
    jump(w, moment(2, 1, 2, NOON)); // a summer's day: no fire
    w.step();
    assert.equal(t.fire, 0, 'out by day in summer');
    jump(w, moment(2, 1, 2, NIGHT + 5)); // a summer night
    t.wood = 100;
    w.step();
    assert.equal(t.fire, 1, 'lit at night, burning well');
    assert.ok(Math.abs(t.wood - (100 - (I.fire / nightLen) * t.members)) < 1e-9, 'burning items.fire wood a member a night');
    t.wood = I.fireLow * t.members * 0.4;
    w.step();
    assert.ok(t.fire > 0 && t.fire < 0.5, `burning low: ${t.fire}`);
    t.wood = 0;
    w.step();
    assert.equal(t.fire, 0, 'out, without wood');
    // By day in a hard winter: lit (the chill at camp is over items.fireDay).
    jump(w, moment(yearOf(seed, 2), 3, 3, NOON));
    t.wood = 100;
    w.step();
    assert.ok(t.fire > 0, 'by day in the cold');
    // It warms within items.fireReach of the camp's centre.
    const i = adultsOf(w)[0];
    alone(w, i, t.camp.x + I.fireReach * 0.5, t.camp.y);
    feel(w, i, t);
    const near = COLD.exposure;
    assert.ok(COLD.near > 0);
    alone(w, i, t.camp.x + I.fireReach * 1.5, t.camp.y);
    feel(w, i, t);
    assert.equal(COLD.near, 0);
    assert.ok(COLD.exposure > near * 5, 'away from the fire, much colder');
    // Items off: a fire that needs no wood.
    const v = world({ ...EMPTY, 'items.enabled': false }, seed);
    jump(v, moment(2, 1, 2, NIGHT + 5));
    v.step();
    assert.equal(v.tribes[0].fire, 1);
});

test('a cold spell: one without a cloak comes home to the fire and warms by it (STATE.WARMING); one with a cloak works on', () => {
    const seed = 3;
    const w = world(EMPTY, seed);
    const t = w.tribes[0];
    t.store = 5000;
    t.wood = 5000;
    jump(w, moment(yearOf(seed, 2), 3, 3, C.dawn + 200)); // a hard winter's morning
    const [a, b] = adultsOf(w);
    alone(w, a, t.camp.x + 80, t.camp.y);
    alone(w, b, t.camp.x - 80, t.camp.y);
    hold(w, b, newItem(w, KIND.CLOAK, 0, '', 0, t.id));
    const ida = w.humans.id[a];
    const idb = w.humans.id[b];
    let warming = false;
    let cloakedWarmed = false;
    for (let k = 0; k < 600; k++) {
        w.step();
        const i = livingIndexOf(w.humans, ida);
        const j = livingIndexOf(w.humans, idb);
        if (w.humans.state[i] === STATE.WARMING) warming = true;
        if (j >= 0 && w.humans.state[j] === STATE.WARMING) cloakedWarmed = true;
    }
    const i = livingIndexOf(w.humans, ida);
    assert.ok(warming, 'warming by the fire');
    const d = dist(w, i, t.camp.x, t.camp.y);
    assert.ok(d >= WARM_NEAR - 1e-6 && d <= WARM_FAR + 1e-6, `in the ring around the fire: ${d.toFixed(2)} off its centre`);
    assert.ok(!cloakedWarmed, 'the cloaked one did not need to');
});

test('nobody stands in the fire pit: at camp, asleep, idle or crafting, at least FIRE_CLEAR from its centre', () => {
    const w = world(EMPTY, 3);
    const t = w.tribes[0];
    t.store = 5000;
    jump(w, moment(2, 1, 2, NIGHT + 50)); // a summer night: everyone home asleep
    for (let i = 0; i < w.humans.n; i++) alone(w, i, t.camp.x + (i % 3) * 0.5, t.camp.y); // (all in the middle)
    for (let k = 0; k < 40; k++) w.step();
    for (let i = 0; i < w.humans.n; i++) {
        const d = dist(w, i, t.camp.x, t.camp.y);
        assert.ok(d >= FIRE_CLEAR - 1e-6 && d < w.p.human.campRadius, `person ${w.humans.id[i]} at ${d.toFixed(2)} (state ${w.humans.state[i]})`);
    }
});

// ---- The cloak ------------------------------------------------------------------------------

test('the cloak: worn in its own slot, warmer when rare; it wears by the cold it keeps off, and breaks', () => {
    const w = world(EMPTY, 3);
    const t = w.tribes[0];
    t.wood = 0;
    jump(w, moment(yearOf(3, 2), 3, 3, NIGHT + 100));
    const i = adultsOf(w)[0];
    alone(w, i, t.camp.x + 200, t.camp.y);
    feel(w, i, t);
    const bare = COLD.exposure;
    const cloak = newItem(w, KIND.CLOAK, 0, '', 0, t.id);
    hold(w, i, cloak);
    assert.equal(w.humans.cloak[i], cloak.id, 'in the cloak slot');
    assert.notEqual(w.humans.weapon[i], cloak.id);
    assert.notEqual(w.humans.tool[i], cloak.id);
    assert.equal(w.humans.gear[i] >> 3, KIND.SPEAR, 'the spear still in hand');
    feel(w, i, t);
    assert.ok(Math.abs(COLD.exposure - bare * (1 - w.p.cold.cloak)) < 1e-12, 'a plain cloak keeps off its share');
    const rare = newItem(w, KIND.CLOAK, 1, 'warmth', 0, t.id);
    assert.ok(cloakWarmth(rare, w.p.cold) > cloakWarmth(cloak, w.p.cold), 'a rare one is warmer');
    assert.ok(rare.max > cloak.max, 'and lasts longer');
    assert.equal(cloak.max, w.p.items.cloakDays * C.day, 'a cloak lasts cloakDays days of full chill');
    // Wear: by the chill it faces, step by step; worn through, it breaks.
    const id = w.humans.id[i];
    const before = cloak.wear;
    w.step();
    assert.ok(cloak.wear < before && cloak.wear >= before - 1, `worn: ${before - cloak.wear}`);
    cloak.wear = 0.5;
    for (let k = 0; k < 3 && w.items.has(cloak.id); k++) w.step();
    assert.ok(!w.items.has(cloak.id), 'worn through');
    assert.ok(w.itemStats.broke[KIND.CLOAK] >= 1);
    assert.equal(w.humans.cloak[livingIndexOf(w.humans, id)], 0, 'off its back');
    assert.equal(ITEM_KINDS[KIND.CLOAK], 'cloak');
    assert.equal(KIND.CLOAK, 7);
    assert.deepEqual(w.p.items.costs.cloak, { wood: 0, flint: 0, hide: 3 });
});

test('cloaks for all: in autumn a tribe with hides makes them, and its people put them on; in summer it makes none', () => {
    const w = world(EMPTY, 3);
    const t = w.tribes[0];
    t.store = 5000;
    t.hide = 60;
    t.wood = 500;
    jump(w, moment(2, 2, 1, C.dawn + 300)); // an autumn morning
    for (let i = 0; i < w.humans.n; i++) w.humans.lifespan[i] = w.humans.age[i] + 1e7;
    let made = 0;
    for (let k = 0; k < 2500; k++) {
        w.step();
        for (const e of w.events) if (e.type === 'crafted' && e.kind === KIND.CLOAK) made++;
    }
    assert.ok(made >= 3, `cloaks made: ${made}`);
    let worn = 0;
    for (let i = 0; i < w.humans.n; i++) {
        if (!w.humans.cloak[i]) continue;
        worn++;
        assert.equal(w.items.get(w.humans.cloak[i]).kind, KIND.CLOAK);
    }
    assert.ok(worn >= 3, `worn: ${worn}`);
    assert.ok(t.hide <= 60 - 3 * made + 1e-9, 'three hides each');
    const v = world(EMPTY, 3);
    const u = v.tribes[0];
    u.store = 5000;
    u.hide = 60;
    jump(v, moment(2, 1, 1, C.dawn + 300));
    for (let k = 0; k < 1500; k++) {
        v.step();
        for (const e of v.events) assert.ok(!(e.type === 'crafted' && e.kind === KIND.CLOAK), 'no cloaks in summer');
    }
});

test('the player crafts a cloak (C): from 3 hides, put on at once; the snapshot says what it wears, how cold it is, whether it is warm', () => {
    const w = world(EMPTY, 3);
    const t = w.tribes[0];
    const i = adultsOf(w)[0];
    const id = w.humans.id[i];
    alone(w, i, t.camp.x, t.camp.y);
    takeControl(w, id, 'god');
    t.hide = 3;
    applyAct(w, { seq: ++seq, action: 'craft', kind: 'cloak', flint: false });
    stand(w, id);
    assert.equal(t.hide, 0, 'three hides taken');
    assert.ok(w.player.crafting && w.player.crafting.kind === KIND.CLOAK);
    let made = null;
    for (let k = 0; k < w.p.items.craftSteps + 2 && !made; k++) {
        stand(w, id);
        made = w.events.find((e) => e.type === 'crafted') ?? null;
    }
    assert.ok(made && made.kind === KIND.CLOAK, 'a cloak made');
    assert.equal(w.humans.cloak[livingIndexOf(w.humans, id)], made.item, 'and worn');
    const s = playerSnapshot(w);
    assert.equal(s.cloak, made.item);
    assert.equal(typeof s.cold, 'number');
    assert.equal(typeof s.warm, 'boolean');
    // A second: the first is laid among the camp's goods.
    t.hide = 3;
    applyAct(w, { seq: ++seq, action: 'craft', kind: KIND.CLOAK, flint: false });
    for (let k = 0; k < w.p.items.craftSteps + 3; k++) stand(w, id);
    assert.notEqual(w.humans.cloak[livingIndexOf(w.humans, id)], made.item, 'the new one on');
    const old = w.items.get(made.item);
    const takenBy = old.bearer ? livingIndexOf(w.humans, old.bearer) : -1;
    assert.ok(t.goods.includes(made.item) || (takenBy >= 0 && w.humans.cloak[takenBy] === made.item && old.bearer !== id),
        'the old one laid among the camp\'s goods (where a tribe-mate may take it up)');
    // At night by the lit fire: warm; out on a hard winter night: cold.
    jump(w, moment(yearOf(3, 2), 3, 3, NIGHT + 100));
    t.wood = 1000;
    stand(w, id);
    assert.equal(playerSnapshot(w).warm, true, 'by the fire');
    w.humans.x[livingIndexOf(w.humans, id)] = t.camp.x + 200;
    const r = playerSnapshot(w);
    assert.equal(r.warm, false);
    assert.ok(r.cold > 0.3, `cold out there: ${r.cold}`);
});

test('a cloak that comes through three hard winters on one back is a legend (winters)', () => {
    const w = world(EMPTY, 3);
    const t = w.tribes[0];
    const i = adultsOf(w)[0];
    const id = w.humans.id[i];
    w.humans.lifespan[i] = w.humans.age[i] + 1e8;
    const cloak = newItem(w, KIND.CLOAK, 1, 'warmth', 0, t.id);
    hold(w, i, cloak);
    let hard = 0;
    for (let y = 2; y < 60 && cloak.rarity !== 2; y++) {
        // The first step of winter, and of the spring after it.
        cloak.wear = cloak.max; // (it would wear out: the deed is what is tested)
        jump(w, moment(y, 3, 0, 0));
        w.step();
        jump(w, moment(y + 1, 0, 0, 0));
        w.step();
        if (winterOf(C, 3, y) === 2) hard++;
        const j = livingIndexOf(w.humans, id);
        assert.ok(j >= 0);
        w.humans.energy[j] = w.p.human.maxEnergy;
    }
    assert.equal(hard, w.p.items.winters);
    assert.equal(cloak.rarity, 2, 'a legend');
    assert.equal(cloak.legend.deed, 'winters');
    assert.equal(w.itemStats.legends.winters, 1);
});

// ---- Berries and fruit -----------------------------------------------------------------------

test('plants: a few hundred, berry bushes by meadows and forest edges, fruit trees by meadows and wetland; none on a flat world', () => {
    const w = world({}, 1);
    const pl = w.plants;
    assert.ok(pl && pl.n > 100 && pl.n <= w.p.plants.berries + w.p.plants.fruit, `plants: ${pl?.n}`);
    let berries = 0;
    let fruit = 0;
    for (let j = 0; j < pl.n; j++) {
        const b = w.terrain.biomeGrid[w.grass.index(pl.x[j], pl.y[j])];
        if (pl.kind[j] === PLANT.BERRY) {
            berries++;
            assert.ok(b === BIOME.MEADOW || b === BIOME.FOREST, `a bush on ${b}`);
        } else {
            fruit++;
            assert.ok(b === BIOME.MEADOW || b === BIOME.WETLAND, `a tree on ${b}`);
        }
    }
    assert.ok(berries > 0 && fruit > 0 && berries <= w.p.plants.berries && fruit <= w.p.plants.fruit);
    // The same world grows the same plants; another seed, others.
    assert.deepEqual([...world({}, 1).plants.x], [...pl.x]);
    assert.notDeepEqual([...world({}, 2).plants.x.slice(0, 10)], [...pl.x.slice(0, 10)]);
    assert.equal(world(EMPTY).plants, null);
    assert.equal(world({ 'plants.enabled': false }).plants, null);
});

test('ripening: berries in summer, fruit in autumn, bare otherwise; picked down by the player\'s E, and whole again the next year', () => {
    assert.equal(crop(PLANT.BERRY, 0.1), 0, 'no berries in spring');
    assert.equal(crop(PLANT.BERRY, 0.4), 1, 'ripe in summer');
    assert.equal(crop(PLANT.BERRY, 0.65), 0, 'gone in autumn');
    assert.equal(crop(PLANT.FRUIT, 0.4), 0, 'no fruit in summer');
    assert.equal(crop(PLANT.FRUIT, 0.65), 1, 'ripe in autumn');
    assert.equal(crop(PLANT.FRUIT, 0.9), 0, 'gone in winter');
    const w = world({ 'carnivore.initial': 0 }, 1);
    const pl = w.plants;
    const B = [...pl.kind].indexOf(PLANT.BERRY);
    const F = [...pl.kind].indexOf(PLANT.FRUIT);
    jump(w, moment(2, 0, 3, 0));
    w.step();
    assert.equal(pl.fruit[B], 0, 'spring: none');
    jump(w, moment(2, 1, 3, 0));
    const rev = pl.rev;
    w.step();
    assert.equal(pl.fruit[B], 1, 'summer: berries');
    assert.equal(pl.fruit[F], 0);
    assert.ok(pl.rev > rev, 'a change, for the snapshot');
    // The snapshot: the plants described once, then the fruit when it changes.
    const packer = new Packer();
    const s1 = packer.pack(w);
    assert.equal(s1.newPlants.kind.length, pl.n);
    assert.ok(s1.fruit instanceof Uint8Array && s1.fruit[B] === 255);
    const s2 = packer.pack(w);
    assert.equal(s2.newPlants, undefined, 'described once');
    assert.equal(s2.fruit, undefined, 'unchanged: not sent again');
    // Picking: the player by the bush, E held.
    const i = adultsOf(w)[0];
    const id = w.humans.id[i];
    alone(w, i, pl.x[B] + 1, pl.y[B]);
    w.humans.carry[i] = 0;
    takeControl(w, id, 'god');
    assert.equal(handWork(w, pl.x[B] + 1, pl.y[B], w.tribeById.get(w.humans.tribe[i])), 'fruit');
    applyAct(w, { seq: ++seq, action: 'gather', on: true });
    for (let k = 0; k < 10; k++) stand(w, id);
    const j = livingIndexOf(w.humans, id);
    assert.ok(Math.abs(w.humans.carry[j] - 10 * w.p.plants.pick) < 1e-6, `picked: ${w.humans.carry[j]}`);
    assert.ok(Math.abs(pl.fruit[B] - (1 - (10 * w.p.plants.pick) / w.p.plants.berryFood)) < 1e-5, 'picked down');
    assert.equal(playerSnapshot(w).gathering, 'fruit');
    assert.ok(w.plantStats.picked >= 10 * w.p.plants.pick - 1e-9);
    const s3 = packer.pack(w);
    assert.ok(s3.fruit && s3.fruit[B] < 255, 'the picked bush sent');
    // Autumn: the berries fall, the fruit is ripe; next summer, whole again.
    jump(w, moment(2, 2, 4, 0));
    w.step();
    assert.equal(pl.fruit[B], 0);
    assert.equal(pl.fruit[F], 1, 'autumn: fruit');
    jump(w, moment(3, 1, 3, 0));
    w.step();
    assert.equal(pl.fruit[B], 1, 'a new year, a whole crop');
});

test('foragers pick a ripe bush in sight before they hunt, and bring the food home', () => {
    const w = world({ 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 }, 1);
    const pl = w.plants;
    const t = w.tribes[0];
    jump(w, moment(2, 1, 1, 0));
    w.step();
    const B = [...pl.kind].indexOf(PLANT.BERRY);
    t.camp.x = pl.x[B] + 30;
    t.camp.y = pl.y[B];
    t.paths = w.terrain.pathField(t.camp.x, t.camp.y);
    t.store = 0;
    for (let i = 0; i < w.humans.n; i++) alone(w, i, t.camp.x, t.camp.y);
    const before = w.plantStats.picked;
    let home = 0;
    for (let k = 0; k < 1000; k++) {
        const s = t.store;
        w.step();
        if (t.store > s) home += t.store - s;
    }
    assert.ok(w.plantStats.picked - before > 20, `picked: ${w.plantStats.picked - before}`);
    assert.ok(pl.fruit[B] < 1, 'the bush picked down');
    assert.ok(home > 0, 'food into the store');
});

// ---- Snow underfoot -------------------------------------------------------------------------

test('deep snow slows walking: people cover less ground with the same effort; the grid is snow.js\'s depth', () => {
    const seed = 3;
    const Y = yearOf(seed, 2);
    const w = world({}, seed);
    jump(w, moment(Y, 3, 5, NOON));
    const at = w.time - (w.time % SNOW_EVERY);
    const line = snowLineAt(C, seed, at);
    let deep = 0;
    for (let k = 0; k < w.snowPace.length; k++) {
        const want = snowPace(w.p.snow.slow, depthAt(line, w.lowland[k], w.terrain.biomeGrid[k] === BIOME.SNOW));
        assert.ok(Math.abs(w.snowPace[k] - want) < 1e-6);
        if (w.snowPace[k] < 0.8) deep++;
    }
    assert.ok(deep > 0, 'deep snow somewhere in a hard winter');
    // A person walking home at dusk, on deep snow and on bare ground.
    const walk = (pace) => {
        const v = world({ 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 }, seed);
        jump(v, moment(Y, 3, 5, C.dawn + C.light + 10)); // dusk: home
        v.snowPace.fill(pace);
        const t = v.tribes[0];
        const i = 0;
        alone(v, i, t.camp.x + 100, t.camp.y);
        v.humans.task[i] = TASK.NONE;
        const x0 = v.humans.x[i];
        const y0 = v.humans.y[i];
        const e0 = v.humans.energy[i];
        v.step();
        return { moved: Math.hypot(wrapDelta(v.humans.x[i] - x0, v.width), wrapDelta(v.humans.y[i] - y0, v.height)), spent: e0 - v.humans.energy[i] };
    };
    const bare = walk(1);
    const snow = walk(w.p.snow.slow);
    assert.ok(bare.moved > 0.1, `it walks: ${bare.moved}`);
    assert.ok(Math.abs(snow.moved - w.p.snow.slow * bare.moved) < 1e-6, `slower in deep snow: ${snow.moved} against ${bare.moved}`);
    assert.ok(Math.abs(snow.spent - bare.spent) < 1e-9, 'the same effort');
});

// ---- Saves ----------------------------------------------------------------------------------

test('save, load, continue = run straight: in a hard winter, cloaks worn and wearing, berries half picked', () => {
    const p = config();
    const make = () => {
        const w = new World(p, { seed: 4, aspect: 1.6 });
        jump(w, moment(yearOf(4, 2), 3, 1, C.dawn + C.light - 400)); // a hard winter's afternoon, the night to come
        let k = 0;
        for (let i = 0; i < w.humans.n; i += 2, k++) hold(w, i, newItem(w, KIND.CLOAK, k % 3 === 0 ? 1 : 0, k % 3 === 0 ? 'warmth' : '', 0, w.humans.tribe[i]));
        w.plants.taken[3] = 0.4;
        w.plants.taken[7] = 0.9;
        return w;
    };
    const straight = make();
    const saved = make();
    const N = straight.time + 700;
    const M = N + 900;
    while (straight.time < N) straight.step();
    while (saved.time < N) saved.step();
    const data = saveWorld(saved);
    const loaded = loadWorld(data);
    assert.equal(saveWorld(loaded).json, data.json, 'loaded at once: the same');
    while (straight.time < M) straight.step();
    while (loaded.time < M) loaded.step();
    const a = saveWorld(loaded);
    const b = saveWorld(straight);
    assert.equal(a.json, b.json, 'run on: the same state');
    for (const key of Object.keys(a.bins)) assert.ok(Buffer.from(a.bins[key].buffer).equals(Buffer.from(b.bins[key].buffer)), `${key} the same`);
    let worn = 0;
    for (let i = 0; i < loaded.humans.n; i++) if (loaded.humans.cloak[i]) worn++;
    assert.ok(worn > 0, 'cloaks worn');
    assert.ok([...loaded.items.values()].some((it) => it.kind === KIND.CLOAK && it.wear < it.max), 'cloaks wearing');
    assert.ok(loaded.snowPace !== null && loaded.snowPace.some((v) => v < 1), 'snow underfoot');
    assert.equal(loaded.plants.taken[7], straight.plants.taken[7]);
});
