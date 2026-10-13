// Stage 4, package 1 (time and world), the simulation's side: lives on the
// calendar, the seasons in the grass and the animals, the night (people
// asleep at camp, bolder predators), and the world twice the size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World, STATE } from '../src/world.js';
import { setParam } from '../src/sim.js';
import { seasonal, when, winterOf } from '../src/calendar.js';
import { takeControl, applyAct, applyInput, playerSnapshot } from '../src/player.js';
import { wrapDelta } from '../src/util.js';
import { TASK } from '../src/items.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });
const C = defaults.calendar;
const DAY = C.day;
const SEASON = DAY * C.seasonDays;
const YEAR = SEASON * 4;
const NIGHT = C.dawn + C.light + C.dusk; // when night falls, into a day
const EMPTY = { 'terrain.enabled': false, 'carnivore.initial': 0, 'herbivore.initial': 0, 'human.tribes': 1 };
const at = (pop, id) => pop.id.subarray(0, pop.n).indexOf(id);
// The world at `time` (the step about to be taken: its clock).
const jump = (w, time) => {
    w.time = time;
    w.clock();
};
let seq = 0;

// ---- Lives on the calendar --------------------------------------------------------------

test('lives in steps: people come of age in an hour and die of old age at 4.4 to 5 hours (70 to 80 on the page); grazers live about 1.5 years, predators 2', () => {
    const P = defaults;
    assert.equal(YEAR, 108000, 'a year: 24 days of 4,500 steps');
    assert.equal(P.human.maturity, 54000, 'an hour at 1× (15 steps a second)');
    const shown = P.human.maturity / 16; // the page counts 16 years to coming of age
    assert.equal(shown, 3375);
    const young = P.human.lifespan * (1 - P.human.lifespanJitter);
    const old = P.human.lifespan * (1 + P.human.lifespanJitter);
    assert.ok(young / shown >= 70 && old / shown <= 80, `old age at ${young / shown} to ${old / shown} years`);
    assert.ok(old <= 270000 && young >= 0.85 * 270000, 'about five hours at most');
    assert.ok(P.herbivore.lifespan >= YEAR && P.herbivore.lifespan <= 1.5 * YEAR, 'a grazer: 1 to 1.5 years');
    assert.equal(P.carnivore.lifespan, 2 * YEAR, 'a predator: 2 years');
    // As born: give or take the jitter (people less, and costly genes only shorten them).
    const w = world();
    const within = (pop, sp, jitter) => {
        for (let i = 0; i < pop.n; i++) {
            const l = pop.lifespan[i] * (pop === w.humans ? Math.sqrt(Math.max(1, pop.upkeep[i])) : 1);
            assert.ok(l >= sp.lifespan * (1 - jitter) - 1e-6 && l <= sp.lifespan * (1 + jitter) + 1e-6, `${l} for ${sp.lifespan}`);
        }
    };
    within(w.herbivores, P.herbivore, P.lifespanJitter);
    within(w.carnivores, P.carnivore, P.lifespanJitter);
    within(w.humans, P.human, P.human.lifespanJitter);
    for (let i = 0; i < w.humans.n; i++) assert.ok(w.humans.lifespan[i] / shown <= 80, 'nobody past 80');
    // Daily needs as before the calendar (stage 3's paced values).
    assert.deepEqual([P.human.baseCost, P.human.moveCost, P.herbivore.baseCost, P.carnivore.baseCost, P.herbivore.grassEnergy], [0.015, 0.05, 0.025, 0.03, 5]);
});

test('hunger shortens a life: a step less for every step a person goes hungry', () => {
    const w = world(EMPTY);
    const pop = w.humans;
    const i = 0;
    pop.energy[i] = w.p.human.starving * w.p.human.maxEnergy * 0.5;
    const life = pop.lifespan[i];
    w.tribes[0].store = 0;
    w.step();
    assert.equal(pop.lifespan[i], life - 1);
});

// ---- The seasons ------------------------------------------------------------------------

test('seasonal(): each season its value, eased across the turn', () => {
    const w = (season, t) => ({ season, seasonT: t });
    assert.equal(seasonal(w(1, 0.5), 1, 2, 3, 4), 2);
    assert.equal(seasonal(w(3, 0.5), 1, 2, 3, 4), 4);
    assert.equal(seasonal(w(0, 0), 1, 2, 3, 4), 2.5, 'halfway at the turn from winter to spring');
    assert.ok(Math.abs(seasonal(w(0, 0.999999), 1, 2, 3, 4) - 1.5) < 1e-4, 'and from spring to summer');
    assert.equal(seasonal(w(2, 0.5), 0, 0, 0, 1, 0.1), 0);
});

test('grass grows fast in spring, steadily in summer, slowly in autumn, hardly in winter', () => {
    const w = world();
    const G = w.p.grass;
    const rate = (time) => {
        jump(w, time);
        return w.regrowth;
    };
    const mid = (s) => rate(s * SEASON + SEASON / 2);
    assert.ok(Math.abs(mid(0) - G.regrowth * G.seasons[0]) < 1e-12);
    assert.ok(mid(0) > mid(1) && mid(1) > mid(2) && mid(2) > mid(3), `${[0, 1, 2, 3].map(mid)}`);
    // And the grid regrows by it.
    const v = world(EMPTY);
    jump(v, SEASON + 10); // summer
    v.grass.g[0] = 0.5;
    v.step();
    assert.ok(Math.abs(v.grass.g[0] - (0.5 + v.regrowth * 0.5)) < 1e-12);
});

test('a hard winter slows the grass more than a normal one, a mild one less', () => {
    const G = defaults.grass;
    assert.ok(G.winters[0] > G.winters[1] && G.winters[1] > G.winters[2], 'mild, normal, hard');
    // Seeds whose first winter is mild, normal and hard.
    const seedOf = (kind) => {
        for (let s = 1; s < 500; s++) if (winterOf(C, s, 1) === kind) return s;
        throw new Error('none');
    };
    const midwinter = (kind) => {
        const w = world({ 'terrain.enabled': false }, seedOf(kind));
        jump(w, 3 * SEASON + SEASON / 2);
        assert.equal(w.winter, kind);
        return w.regrowth;
    };
    const [mild, normal, hard] = [0, 1, 2].map(midwinter);
    assert.ok(mild > normal && normal > hard, `${mild} ${normal} ${hard}`);
    assert.ok(Math.abs(normal - G.regrowth * G.seasons[3]) < 1e-12);
});

test('grazers fatten when full in the good months, draw on it in winter, and graze slower under the snow', () => {
    const w = world(EMPTY);
    const H = w.p.herbivore;
    const g = w.herbivores;
    const i = w.spawn(g, H, 500, 500, H.maxEnergy, 1.3, 0.55, H.maturity);
    const gi = w.grass.index(500, 500);
    // Summer, full, on good grass: past the stomach into fat.
    jump(w, SEASON + SEASON / 2);
    w.grass.g[gi] = 1;
    w.step();
    assert.equal(g.energy[i], H.maxEnergy);
    assert.ok(g.fat[i] > 0, 'fat laid on');
    // Winter, hungry, on bare ground: from fat to the stomach.
    jump(w, 3 * SEASON + SEASON / 2);
    assert.equal(w.fatCap, 0, 'no fattening in winter');
    g.energy[i] = 10;
    g.fat[i] = 500;
    w.grass.g[gi] = 0;
    w.step();
    assert.ok(Math.abs(g.energy[i] - H.draw * H.maxEnergy) < 1e-9, 'drawn up to its mark');
    assert.ok(g.fat[i] < 500);
    // Under the snow a bite is smaller.
    jump(w, 3 * SEASON + SEASON / 2);
    g.energy[i] = 10;
    g.fat[i] = 0;
    w.grass.g[gi] = 1;
    const before = g.energy[i];
    w.step();
    const eaten = g.energy[i] - before + H.baseCost * g.upkeep[i];
    assert.ok(Math.abs(eaten - H.bite * (1 - H.snowBite) * H.grassEnergy) < 1e-9, `${eaten}`);
});

test('births come in spring and summer, never in winter; grazers in autumn only on lush pasture', () => {
    const w = world();
    const chance = (s) => {
        jump(w, s * SEASON + SEASON / 2);
        return [w.breedH, w.breedC, w.breedP];
    };
    for (const s of [0, 1]) assert.ok(chance(s).every((v) => v > 0), `season ${s}`);
    assert.ok(chance(0)[0] > chance(1)[0], 'mostly spring');
    assert.deepEqual(chance(3), [0, 0, 0], 'winter');
    assert.equal(chance(2)[1], 0, 'no predators in autumn');
    // Grazers' births follow the pasture: none where the grass is grazed
    // short (autumn's usual), as many as the season allows where it is lush.
    const H = w.p.herbivore;
    const g = w.herbivores;
    const births = (level) => {
        const v = world({ ...EMPTY, 'human.enabled': false });
        const i = v.spawn(v.herbivores, H, 500, 500, H.maxEnergy, 1.3, 0.55, H.maturity);
        v.herbivores.fat[i] = 600;
        v.time = 2 * SEASON + SEASON / 2; // (mid-autumn, by day)
        let born = 0;
        for (let k = 0; k < 3000 && !born; k++) {
            v.grass.level = level; // (the land's grass as the births see it this step)
            v.grass.g[v.grass.index(v.herbivores.x[0], v.herbivores.y[0])] = 1;
            v.step();
            born = v.herbivores.n - 1;
        }
        return born;
    };
    assert.equal(births(H.pasture[0] - 0.05), 0, 'grazed short: none');
    assert.ok(births(H.pasture[1] + 0.05) > 0, 'lush: a litter');
    assert.equal(g.n, w.herbivores.n);
});

test('a carcass is worth its stomach, its fat and its body', () => {
    const w = world(EMPTY);
    const H = w.p.herbivore;
    const g = w.herbivores;
    const i = w.spawn(g, H, 100, 100, 50, 1.3, 0.55, H.maturity);
    g.fat[i] = 300;
    assert.equal(w.meatOf(g, i), 50 + 300 + H.meat);
    const lamb = w.spawn(g, H, 100, 100, 50, 1.3, 0.55, 0);
    assert.equal(w.meatOf(g, lamb), 50 + H.meat / 4, 'a newborn: a quarter of the body');
});

test('the camp comes for what is left of the player’s big kill', () => {
    const w = world({ ...EMPTY, 'calendar.day': 1e9, 'calendar.light': 1e9 - 1000 }); // (a day that does not end)
    const t = w.tribes[0];
    const pop = w.humans;
    t.store = 0;
    let i = 0;
    while (pop.age[i] < w.p.human.maturity) i++;
    const id = pop.id[i];
    pop.x[i] = t.camp.x + 100;
    pop.y[i] = t.camp.y;
    assert.ok(takeControl(w, id, 'god'));
    applyInput(w, { seq: ++seq, x: pop.x[i], y: pop.y[i], heading: 0, speed: 0 });
    const H = w.p.herbivore;
    const g = w.spawn(w.herbivores, H, pop.x[i] + 2, pop.y[i], 80, 1.3, 0.01, H.maturity); // (it does not see you)
    const gid = w.herbivores.id[g];
    applyAct(w, { seq: ++seq, action: 'attack', heavy: false, dx: 1, dy: 0, power: 0, target: 0 });
    w.step();
    const c = w.carcasses.get(gid);
    assert.ok(c && c.total > 3 * w.p.human.carryMax, 'a grown grazer, several loads');
    assert.equal(c.tribe, t.id);
    let fetching = 0;
    for (let k = 0; k < 600 && !fetching; k++) {
        w.step();
        for (let j = 0; j < pop.n; j++) if (pop.id[j] !== id && pop.task[j] === TASK.BUTCHER && pop.work[j] === gid) fetching++;
    }
    assert.ok(fetching > 0, 'someone from camp comes for it');
});

// ---- The night ---------------------------------------------------------------------------

test('people head home at dusk, sleep at camp at night, and wake at dawn', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const pop = w.humans;
    // Daytime: out and about, nobody asleep.
    for (let k = 0; k < 2000; k++) w.step();
    assert.ok(!pop.state.subarray(0, pop.n).includes(STATE.SLEEPING), 'nobody sleeps by day');
    // Dusk: all go home.
    jump(w, C.dawn + C.light + 1);
    w.step();
    for (let i = 0; i < pop.n; i++) assert.ok([STATE.HOMEWARD, STATE.AT_CAMP].includes(pop.state[i]), `at dusk: ${pop.state[i]}`);
    // Night: in camp, asleep.
    while (w.time < NIGHT + 600) w.step();
    let asleep = 0;
    for (let i = 0; i < pop.n; i++) {
        const d = Math.hypot(wrapDelta(t.camp.x - pop.x[i], w.width), wrapDelta(t.camp.y - pop.y[i], w.height));
        if (pop.state[i] === STATE.SLEEPING) {
            asleep++;
            assert.ok(d < w.p.human.campRadius, 'asleep in camp');
        }
    }
    assert.equal(asleep, pop.n, 'everyone asleep');
    // Dawn: up.
    while (w.time < DAY + 5) w.step();
    assert.equal(when(C, w.time).part, 'dawn');
    assert.ok(!pop.state.subarray(0, pop.n).includes(STATE.SLEEPING), 'awake at dawn');
});

test('the player resting at camp at night is asleep, until dawn or a move', () => {
    const w = world(EMPTY);
    const t = w.tribes[0];
    const pop = w.humans;
    let i = 0;
    while (pop.age[i] < w.p.human.maturity) i++;
    const id = pop.id[i];
    assert.ok(takeControl(w, id, 'god'));
    pop.x[i] = t.camp.x;
    pop.y[i] = t.camp.y;
    applyInput(w, { seq: ++seq, x: t.camp.x, y: t.camp.y, heading: 0, speed: 0 });
    jump(w, NIGHT + 10);
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    w.step();
    assert.equal(pop.state[at(pop, id)], STATE.SLEEPING);
    assert.equal(playerSnapshot(w).resting, true, 'the same rest act');
    // A move wakes it.
    applyInput(w, { seq: ++seq, x: t.camp.x + 0.5, y: t.camp.y, heading: 0, speed: 0.5 });
    w.step();
    assert.notEqual(pop.state[at(pop, id)], STATE.SLEEPING);
    assert.equal(playerSnapshot(w).resting, false);
    // Asleep again, until dawn.
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    w.step();
    assert.equal(pop.state[at(pop, id)], STATE.SLEEPING);
    while (w.time < DAY) {
        w.step();
        if (w.time < DAY) assert.equal(pop.state[at(pop, id)], STATE.SLEEPING, `asleep at ${w.time}`);
    }
    w.step(); // (the first step of dawn)
    assert.equal(when(C, w.time - 1).part, 'dawn');
    assert.equal(playerSnapshot(w).resting, false, 'up at dawn');
    assert.notEqual(pop.state[at(pop, id)], STATE.SLEEPING);
    // By day, resting is only resting.
    applyAct(w, { seq: ++seq, action: 'rest', on: true });
    w.step();
    assert.equal(pop.state[at(pop, id)], STATE.AT_CAMP);
});

test('predators are bolder at night: they hunt when less hungry', () => {
    const run = (time) => {
        const w = world({ ...EMPTY, 'human.tribes': 0, 'human.enabled': false });
        const c = w.carnivores;
        const P = w.p.carnivore;
        const i = w.spawn(c, P, 500, 500, P.maxEnergy, 1.5, 0.8, P.maturity);
        c.fat[i] = P.hunt * 1.2 - P.maxEnergy; // fuller than it hunts at by day, not at night
        w.spawn(w.herbivores, w.p.herbivore, 520, 500, 50, 1.3, 0.55, 1000);
        jump(w, time);
        w.step();
        return c.state[0];
    };
    assert.equal(run(DAY / 3), STATE.SATED, 'by day it lets the grazer be');
    assert.equal(run(NIGHT + 100), STATE.CHASING, 'at night it goes for it');
});

test('predators roam wider at night and in winter', () => {
    const speed = (time) => {
        const w = world({ ...EMPTY, 'human.enabled': false });
        const c = w.carnivores;
        const P = w.p.carnivore;
        const i = w.spawn(c, P, 500, 500, 20, 1.5, 0.8, P.maturity);
        jump(w, time);
        const x = c.x[i];
        const y = c.y[i];
        w.step();
        assert.equal(c.state[i], STATE.ROAMING);
        return Math.hypot(c.x[i] - x, c.y[i] - y);
    };
    const day = speed(SEASON + DAY / 3);
    assert.ok(speed(SEASON + NIGHT + 100) > day * 1.2, 'at night');
    assert.ok(speed(3 * SEASON + SEASON / 2 + DAY / 3) > day * 1.2, 'in winter');
});

test('grazers bunch up at night', () => {
    const w = world({ ...EMPTY, 'human.enabled': false });
    const H = w.p.herbivore;
    const g = w.herbivores;
    const a = w.spawn(g, H, 500, 500, 80, 1.3, 0.55, 1000);
    const b = w.spawn(g, H, 530, 500, 80, 1.3, 0.55, 1000);
    for (const i of [a, b]) w.grass.g[w.grass.index(g.x[i], g.y[i])] = 1; // good grass: by day, no reason to move
    jump(w, SEASON + DAY / 3);
    w.step();
    assert.equal(g.x[a], 500, 'by day each grazes where it is');
    jump(w, SEASON + NIGHT + 50);
    for (let k = 0; k < 60; k++) w.step();
    assert.ok(Math.abs(g.x[b] - g.x[a]) <= H.herd + 1, `at night together: ${Math.abs(g.x[b] - g.x[a])}`);
});

// ---- The world --------------------------------------------------------------------------

test('the world is twice the area, at today’s density', () => {
    const w = world();
    assert.equal(w.p.world.area, 3200000);
    assert.deepEqual([w.width, w.height], [2263, 1414]);
    assert.equal(w.herbivores.n, 700);
    assert.equal(w.carnivores.n, 60);
    assert.equal(w.tribes.length, 8);
    assert.equal(w.humans.n, 80);
    // Camps apart, on open ground, each with its way home.
    for (const t of w.tribes) {
        assert.ok(t.paths, 'a path field');
        assert.ok(w.terrain.spawnable(t.camp.x, t.camp.y));
    }
});
