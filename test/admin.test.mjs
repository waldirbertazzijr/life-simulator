// The admin console (src/admin.js in the simulation, src/play/console.js on
// the page): parsing and errors, each command on a headless World, the
// immortal player, the Sim's queue and its answers, and the page's console:
// history, Tab, keys, and the quiet "admin" mark of a Play game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Sim, setParam, COLUMNS } from '../src/sim.js';
import { takeControl, applyAct, playerSnapshot } from '../src/player.js';
import { strike } from '../src/spears.js';
import { KIND, unhold } from '../src/items.js';
import { COMMANDS, COMMAND_NAMES, parse, execute, helpText } from '../src/admin.js';
import { Console, completeLine, HISTORY_KEY } from '../src/play/console.js';
import { Input } from '../src/play/input.js';

const config = (set = {}) => {
    const p = structuredClone(defaults);
    for (const [path, value] of Object.entries(set)) setParam(p, path, value);
    return p;
};
const world = (set = {}, seed = 1) => new World(config(set), { seed, aspect: 1.6 });

// Flat, one tribe, no predators: nothing happens to the player by chance.
const QUIET = { 'terrain.enabled': false, 'carnivore.initial': 0, 'human.tribes': 1 };
// Flat, one tribe, predators about.
const WILD = { 'terrain.enabled': false, 'human.tribes': 1 };

const at = (w, id) => w.humans.id.subarray(0, w.humans.n).indexOf(id);
const wrap = (v, size) => ((v % size) + size) % size;
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const happened = (w, type) => w.events.filter((e) => e.type === type);

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

// A command line, run on the world as the Sim would (`more`: target...).
const run = (w, line, more = {}, sim = null) => execute(w, { ...parse(line), ...more }, sim);

// Person i's hands emptied (the items gone).
function disarm(w, i) {
    for (const id of [w.humans.weapon[i], w.humans.tool[i]]) {
        if (!id) continue;
        unhold(w, i, w.items.get(id));
        w.items.delete(id);
    }
}

// The person `id` far from every camp (no tribe-mate to drive a predator off).
function faraway(w, id) {
    let best = null;
    for (let y = 0; y < w.height; y += 20) {
        for (let x = 0; x < w.width; x += 20) {
            let near = Infinity;
            for (const t of w.tribes) near = Math.min(near, Math.hypot(wrapDelta(t.camp.x - x, w.width), wrapDelta(t.camp.y - y, w.height)));
            if (!best || near > best.near) best = { x, y, near };
        }
    }
    const i = at(w, id);
    w.humans.x[i] = best.x;
    w.humans.y[i] = best.y;
    w.player.x = best.x;
    w.player.y = best.y;
}

// A hungry, rested predator right beside the person `id`: it catches it this step.
function predatorBeside(w, id) {
    const i = at(w, id);
    const c = w.carnivores;
    c.x[0] = wrap(w.humans.x[i] + 1, w.width);
    c.y[0] = w.humans.y[i];
    c.energy[0] = 50;
    c.timer[0] = 0;
    c.age[0] = 1000;
    c.lifespan[0] = w.p.carnivore.lifespan;
    return c.id[0];
}

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

// ---- Parsing and errors ---------------------------------------------------------------

test('a line is a command and its words', () => {
    assert.deepEqual(parse('  give  Bow legendary '), { cmd: 'give', args: ['Bow', 'legendary'] });
    assert.deepEqual(parse('HELP'), { cmd: 'help', args: [] });
    assert.equal(parse('   '), null);
    assert.equal(parse(''), null);
});

test('every command has a usage line and help for it', () => {
    for (const name of COMMAND_NAMES) {
        const c = COMMANDS[name];
        assert.ok(c.usage.startsWith(name), name);
        assert.ok(c.about.length > 5, name);
        assert.ok(helpText(name).startsWith(c.usage), name);
    }
    const all = helpText();
    for (const name of COMMAND_NAMES) assert.ok(all.split('\n').some((l) => l.startsWith(name)), `help lists ${name}`);
    assert.equal(helpText('nope'), null);
    assert.ok(helpText('GIVE').includes('kinds: spear bow club knife basket torch'));
});

test('a wrong command says what was wrong, and how to type it', () => {
    const w = world(QUIET);
    control(w);
    const unknown = run(w, 'fly 3');
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /unknown command "fly"/);
    const bad = run(w, 'give sword');
    assert.equal(bad.ok, false);
    assert.equal(bad.changed, false);
    assert.match(bad.text, /no such kind: sword/);
    assert.match(bad.text, /\nusage: give <kind> \[normal\|rare\|legendary\] \[trait\]$/);
    for (const line of ['give', 'give bow shiny', 'give knife rare range', 'give spear normal range', 'give bow legendary durability',
        'store gold 3', 'store wood', 'store wood lots', 'carry hide 2', 'spawn dragon', 'spawn herbivore 1000', 'spawn herbivore 0',
        'kill 99999999', 'kill x', 'tp 3', 'tp a b', 'skip', 'skip -5', 'skip 99999999', 'set nope.x 1', 'set herbivore.speed abc',
        'set herbivore.speed', 'get nope', 'immortal maybe', 'legend shield', 'rare fast', 'help nope', 'seed 5']) {
        const r = run(w, line);
        assert.equal(r.ok, false, line);
        assert.match(r.text, /\nusage: /, line);
    }
});

test('with nobody to do it to, the command says so', () => {
    const w = world(QUIET);
    const r = run(w, 'heal');
    assert.equal(r.ok, false);
    assert.match(r.text, /^nobody: take control of someone, or follow a creature/);
    // In God view with nobody controlled, "you" is the creature followed...
    w.follow(w.herbivores.id[0]);
    w.herbivores.energy[0] = 10;
    assert.equal(run(w, 'heal').ok, true);
    assert.equal(w.herbivores.energy[0], w.p.herbivore.maxEnergy);
    // ...which must be a person for items, and the controlled one for Spirit.
    assert.match(run(w, 'give spear').text, /^you follow a grazer: that is for people/);
    w.follow(w.humans.id[0]);
    assert.equal(run(w, 'store food 10').ok, true);
    assert.match(run(w, 'spirit').text, /^that is for the person you control/);
    assert.match(run(w, 'immortal').text, /^that is for the person you control/);
});

test('read-only commands change nothing, and draw no random numbers', () => {
    const a = world({}, 4);
    const b = world({}, 4);
    for (const line of ['help', 'help give', 'get', 'get herbivore', 'get human.speed', 'stats']) {
        const r = run(b, line);
        assert.equal(r.ok, true, line);
        assert.equal(r.changed, false, line);
    }
    assert.equal(digest(a, 600), digest(b, 600));
});

// ---- Items ------------------------------------------------------------------------------------

test('give: into the empty hand, else the kit, else at your feet', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    let r = run(w, 'give spear');
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.match(r.text, /in your hand$/);
    const first = w.items.get(w.humans.weapon[i]);
    assert.equal(first.kind, KIND.SPEAR);
    assert.equal(first.rarity, 0);
    assert.equal(first.bearer, id);
    assert.equal(first.maker, id);
    for (let k = 0; k < w.p.items.kit; k++) assert.match(run(w, 'give club').text, /in your kit \(→ takes it up\)$/);
    assert.equal(w.player.kit.weapons.length, w.p.items.kit);
    for (const kit of w.player.kit.weapons) assert.equal(w.items.get(kit).bearer, id);
    r = run(w, 'give bow');
    assert.match(r.text, /at your feet$/);
    const lying = [...w.items.values()].at(-1);
    assert.equal(lying.kind, KIND.BOW);
    assert.equal(lying.bearer, 0);
    assert.ok(Math.hypot(wrapDelta(lying.x - w.humans.x[i], w.width), wrapDelta(lying.y - w.humans.y[i], w.height)) < 1e-9);
    assert.equal(w.humans.weapon[i], first.id, 'the hand keeps what it held');
    // A tool goes to the tool hand.
    assert.match(run(w, 'give knife').text, /in your hand$/);
    assert.equal(w.items.get(w.humans.tool[i]).kind, KIND.KNIFE);
});

test('give rare: with the trait asked for, or one rolled', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    assert.equal(run(w, 'give bow rare range').ok, true);
    const bow = w.items.get(w.humans.weapon[i]);
    assert.equal(bow.rarity, 1);
    assert.equal(bow.trait, 'range');
    assert.equal(bow.mult, w.p.items.rare);
    assert.equal(bow.max, w.p.items.rareUses);
    assert.equal(run(w, 'give basket RARE').ok, true);
    const basket = w.items.get(w.humans.tool[i]);
    assert.equal(basket.rarity, 1);
    assert.ok(['effect', 'durability'].includes(basket.trait));
});

test('give legendary: a legend with a name and a history, its deed admin', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    const r = run(w, 'give bow legendary accuracy');
    assert.equal(r.ok, true);
    const bow = w.items.get(w.humans.weapon[i]);
    assert.equal(bow.rarity, 2);
    assert.equal(bow.trait, 'accuracy');
    assert.equal(bow.mult, w.p.items.legendary);
    assert.equal(bow.wear, Infinity);
    assert.ok(bow.legend.name.length > 3);
    assert.equal(bow.legend.deed, 'admin');
    assert.ok(bow.legend.skill.endsWith(bow.legend.name));
    assert.ok(bow.legend.history.length >= 2, 'its making, and the deed');
    assert.equal(bow.legend.history.at(-1).text, 'Made a legend by the gods');
    assert.ok(r.text.startsWith(bow.legend.name));
    const [e] = happened(w, 'legend');
    assert.equal(e.item, bow.id);
    assert.equal(e.bearer, id, 'yours: LEGEND FORGED shows');
    assert.equal(e.deed, 'admin');
    assert.equal(w.itemStats.legends.admin, 1);
    // A legend without a trait asked for rolls one (never durability).
    run(w, 'give torch legendary');
    const torch = w.items.get(w.humans.tool[i]);
    assert.equal(torch.trait, 'effect');
    assert.equal(playerSnapshot(w).weapon, bow.id);
});

test('legend, rare and repair work on what is in your hands', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    assert.match(run(w, 'legend').text, /^nothing in your hands/);
    run(w, 'give spear');
    run(w, 'give basket');
    const spear = w.items.get(w.humans.weapon[i]);
    const basket = w.items.get(w.humans.tool[i]);

    spear.wear = 10;
    const rev = spear.rev;
    let r = run(w, 'rare accuracy');
    assert.equal(r.ok, true);
    assert.equal(spear.rarity, 1);
    assert.equal(spear.trait, 'accuracy');
    assert.equal(spear.mult, w.p.items.rare);
    assert.ok(Math.abs(spear.wear / spear.max - 10 / w.p.items.uses) < 1e-9, 'the share of use left is kept');
    assert.ok(spear.rev > rev, 'the page is told again');
    // A tool's trait says which hand; durability lasts longer.
    assert.equal(run(w, 'rare effect').ok, true);
    assert.equal(basket.rarity, 1);
    assert.equal(basket.trait, 'effect');
    assert.equal(run(w, 'rare tool durability').ok, true);
    assert.equal(basket.max, w.p.items.rareUses * w.p.items.rare);
    assert.match(run(w, 'rare tool range').text, /^a basket's traits are effect, durability/);

    basket.wear = 1;
    r = run(w, 'repair');
    assert.equal(r.text, 'repaired: spear, basket');
    assert.equal(spear.wear, spear.max);
    assert.equal(basket.wear, basket.max);

    r = run(w, 'legend weapon');
    assert.equal(r.ok, true);
    assert.equal(spear.rarity, 2);
    assert.equal(spear.trait, 'accuracy', 'a rare trait is kept');
    assert.equal(run(w, 'legend weapon').changed, false, 'a legend already');
    assert.match(run(w, 'rare weapon').text, /is a legend: better than rare/);
    assert.equal(run(w, 'legend tool').ok, true);
    assert.equal(basket.rarity, 2);
    assert.notEqual(basket.trait, 'durability');
    assert.equal(run(w, 'repair').changed, false, 'legends never wear');
});

test('repair relights a torch, and mends the spares too', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    run(w, 'give torch');
    run(w, 'give torch');
    const torch = w.items.get(w.humans.tool[i]);
    const spare = w.items.get(w.player.kit.tools[0]);
    for (let k = 0; k < 100; k++) w.step();
    torch.expires = w.time + 5;
    spare.wear = 2;
    run(w, 'repair');
    assert.equal(torch.expires, w.time + torch.max);
    assert.equal(spare.wear, spare.max);
});

test('with items off, the item commands say so', () => {
    const w = world({ ...QUIET, 'items.enabled': false });
    control(w);
    for (const line of ['give spear', 'legend', 'rare', 'repair', 'store wood 5', 'carry wood 2']) {
        assert.match(run(w, line).text, /^items are off in this world/, line);
    }
    assert.equal(run(w, 'store food 5').ok, true);
    assert.match(run(w, 'stats').text, /items: off/);
});

// ---- The store, the hands, life and Spirit -------------------------------------------------------

test("store adds to your tribe's store, and takes from it, never below nothing", () => {
    const w = world(QUIET);
    const id = control(w);
    const tribe = w.tribeById.get(w.humans.tribe[at(w, id)]);
    const wood = tribe.wood;
    let r = run(w, 'store wood 50');
    assert.equal(r.ok, true);
    assert.equal(tribe.wood, wood + 50);
    assert.match(r.text, new RegExp(`^the ${tribe.name}'s wood: ${wood} → ${wood + 50}$`));
    run(w, 'store FLINT 7');
    run(w, 'store hide 2.5');
    assert.equal(tribe.flint, 7);
    assert.equal(tribe.hide, 2.5);
    const food = tribe.store;
    run(w, 'store food -40');
    assert.ok(Math.abs(tribe.store - (food - 40)) < 1e-9);
    run(w, 'store food -1e9');
    assert.equal(tribe.store, 0);
});

test('carry: food into the pouch, wood and flint into your load', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    disarm(w, i);
    let r = run(w, 'carry food 30');
    assert.equal(r.ok, true);
    assert.equal(w.humans.carry[i], 30);
    run(w, 'carry food 9999');
    assert.equal(w.humans.carry[i], w.p.human.carryMax, 'at most a full pouch');
    run(w, 'carry food -9999');
    assert.equal(w.humans.carry[i], 0);
    // Wood and flint: the player's load (player.wood, player.flint), together at most items.load.
    r = run(w, 'carry wood 3');
    assert.equal(r.ok, true);
    assert.equal(w.player.wood, 3);
    run(w, 'carry flint 100');
    assert.equal(w.player.flint, w.p.items.load - 3);
    // A basket carries more.
    run(w, 'give basket');
    run(w, 'carry flint 100');
    assert.equal(w.player.flint, w.p.items.load * w.p.items.basket - 3);
    // Not for someone you only follow.
    takeControl(w, 0, 'god');
    w.follow(id);
    assert.match(run(w, 'carry wood 1').text, /^that is for the person you control/);
    assert.equal(run(w, 'carry food 5').ok, true);
});

test('heal fills energy, spirit fills Spirit', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    w.humans.energy[i] = 12;
    w.player.spirit = 3;
    assert.equal(run(w, 'heal').text, `energy 12 → ${w.p.human.maxEnergy}`);
    assert.equal(w.humans.energy[i], w.p.human.maxEnergy);
    assert.equal(run(w, 'spirit').ok, true);
    assert.equal(w.player.spirit, w.p.play.spiritMax);
});

// ---- Immortal ----------------------------------------------------------------------------------

test('immortal: a bite takes nothing, and the player is not eaten on autopilot either', () => {
    const w = world(WILD);
    const id = control(w);
    faraway(w, id);
    assert.equal(run(w, 'immortal').text.startsWith('immortal: on'), true, 'no argument: switch');
    assert.ok(w.immortal);
    const e0 = w.humans.energy[at(w, id)];
    predatorBeside(w, id);
    w.step();
    assert.equal(happened(w, 'bite').length, 1, 'bitten...');
    assert.equal(w.humans.energy[at(w, id)], e0, '...for nothing, hunger neither');
    // On autopilot a predator would eat anyone: not the immortal player.
    applyAct(w, { seq: 1, action: 'auto', on: true });
    for (let k = 0; k < 30; k++) {
        predatorBeside(w, id);
        w.step();
        assert.ok(at(w, id) >= 0, 'alive');
        assert.equal(happened(w, 'death').filter((e) => e.id === id).length, 0);
    }
    assert.ok(w.humans.energy[at(w, id)] >= e0);
});

test('immortal: spears, starvation and old age do not kill; off, they do', () => {
    const w = world(QUIET);
    const id = control(w);
    faraway(w, id);
    run(w, 'immortal on');
    let i = at(w, id);
    const e0 = w.humans.energy[i];
    strike(w, w.humans, i, 0, 1, 0, KIND.SPEAR, 0, 1000); // (a spear through the heart)
    assert.equal(w.humans.energy[i], e0);
    assert.equal(happened(w, 'death').length, 0);
    w.step();
    i = at(w, id);
    assert.ok(i >= 0);
    // Starving: life held where it was, however low.
    w.humans.energy[i] = 0.01;
    w.immortal.life = 0.01;
    w.humans.carry[i] = 0;
    for (let k = 0; k < 20; k++) w.step();
    i = at(w, id);
    assert.ok(i >= 0 && w.humans.energy[i] > 0, 'not starved');
    // Old age: another year.
    w.humans.energy[i] = 100;
    w.humans.age[i] = w.humans.lifespan[i];
    w.step();
    i = at(w, id);
    assert.ok(i >= 0, 'not dead of old age');
    assert.ok(w.humans.lifespan[i] > w.humans.age[i]);
    assert.match(run(w, 'kill me').text, /^you are immortal: immortal off first/);
    assert.equal(run(w, 'immortal off').text, 'immortal: off');
    assert.equal(w.immortal, null);
    assert.equal(strike(w, w.humans, i, 0, 1, 0, KIND.SPEAR, 0, 1000), true, 'mortal again');
});

test('immortal is for whoever you control: a stranger is not spared', () => {
    const w = world(QUIET);
    const id = control(w);
    run(w, 'immortal on');
    const k = w.humans.id.subarray(0, w.humans.n).findIndex((x) => x !== id);
    assert.equal(strike(w, w.humans, k, 0, 1, 0, KIND.SPEAR, 0, 1000), true);
});

// ---- Spawning and killing ---------------------------------------------------------------------------

test('spawn: adults near you; people join your tribe, with a spear', () => {
    const w = world(QUIET);
    const id = control(w);
    const i = at(w, id);
    const x = w.humans.x[i];
    const y = w.humans.y[i];
    const h = w.herbivores.n;
    let r = run(w, 'spawn herbivore 3');
    assert.equal(r.ok, true);
    assert.equal(w.herbivores.n, h + 3);
    const spawned = Array.from(w.herbivores.id.subarray(h, h + 3));
    for (let k = h; k < h + 3; k++) {
        assert.ok(Math.hypot(wrapDelta(w.herbivores.x[k] - x, w.width), wrapDelta(w.herbivores.y[k] - y, w.height)) <= 15);
        assert.equal(w.herbivores.age[k], w.p.herbivore.maturity);
        assert.ok(w.herbivores.energy[k] > 0);
    }
    r = run(w, 'spawn carnivores 2');
    assert.equal(r.ok, true);
    assert.equal(w.carnivores.n, 2);
    const n = w.humans.n;
    r = run(w, 'spawn person 2');
    assert.equal(r.ok, true);
    assert.match(r.text, /joined the /);
    assert.equal(w.humans.n, n + 2);
    for (let k = n; k < n + 2; k++) {
        assert.equal(w.humans.tribe[k], w.humans.tribe[i]);
        assert.ok(w.humans.age[k] >= w.p.human.maturity);
        assert.equal(w.items.get(w.humans.weapon[k]).kind, KIND.SPEAR);
    }
    // The newcomers live on: none starves or dies of age (the tribe may hunt
    // them; the herd as a whole may shrink meanwhile, at the pace of life).
    const ends = [];
    for (let s = 0; s < 50; s++) {
        w.step();
        for (const e of w.events) if (e.type === 'death' && spawned.includes(e.id)) ends.push(e.cause);
    }
    assert.deepEqual(ends.filter((c) => c !== 'hunted' && c !== 'eaten'), [], 'they live on');
});

test('spawn a person, following a grazer: it joins the nearest tribe', () => {
    const w = world({ 'terrain.enabled': false, 'human.tribes': 3 });
    const t = w.tribes[2];
    w.herbivores.x[0] = t.camp.x + 3;
    w.herbivores.y[0] = t.camp.y;
    w.follow(w.herbivores.id[0]);
    assert.equal(run(w, 'spawn person').ok, true);
    assert.equal(w.humans.tribe[w.humans.n - 1], t.id);
});

test('kill: the lock-on (or what is aimed at), else the one followed; gone at once', () => {
    const w = world(WILD);
    const id = control(w);
    const prey = w.herbivores.id[5];
    const n = w.herbivores.n;
    let r = run(w, 'kill', { target: prey });
    assert.equal(r.ok, true);
    assert.equal(r.text, `herbivore #${prey} is dead`);
    assert.equal(w.herbivores.n, n - 1, 'compacted at once');
    assert.equal(w.find(prey), null);
    const [death] = happened(w, 'death').filter((e) => e.id === prey);
    assert.equal(death.cause, 'admin');
    // In a body, with nothing locked or aimed at, the one followed is you: no.
    assert.match(run(w, 'kill').text, /^no target/);
    // An id.
    const wolf = w.carnivores.id[0];
    assert.equal(run(w, `kill ${wolf}`).ok, true);
    assert.equal(w.find(wolf), null);
    assert.match(run(w, `kill ${wolf}`).text, /^nobody alive has the id/);
    // God view, following someone: it.
    takeControl(w, 0, 'god');
    w.follow(w.herbivores.id[0]);
    const followed = w.herbivores.id[0];
    assert.equal(run(w, 'kill').ok, true);
    assert.equal(w.find(followed), null);
    // kill me: your heir carries on.
    takeControl(w, id, 'god');
    assert.equal(run(w, 'kill me').ok, true);
    w.step();
    assert.ok(w.player === null || w.player.id !== id);
});

// ---- Moving and time ------------------------------------------------------------------------------

test('tp: your body jumps, and the page is told to follow (snap)', () => {
    const w = world(QUIET);
    const id = control(w);
    playerSnapshot(w);
    let r = run(w, 'tp 100 200');
    assert.equal(r.ok, true);
    let i = at(w, id);
    assert.equal(w.humans.x[i], 100);
    assert.equal(w.humans.y[i], 200);
    const s = playerSnapshot(w);
    assert.equal(s.snap, true);
    assert.equal(s.x, 100);
    w.step();
    i = at(w, id);
    assert.equal(w.humans.x[i], 100, 'the page has no say until it has jumped');
    // Across the edge, wrapped; to camp.
    run(w, `tp ${w.width + 5} -5`);
    assert.equal(w.humans.x[at(w, id)], 5);
    assert.equal(w.humans.y[at(w, id)], w.height - 5);
    run(w, 'tp camp');
    const camp = w.tribeById.get(w.humans.tribe[at(w, id)]).camp;
    assert.equal(w.humans.x[at(w, id)], camp.x);
    assert.equal(w.humans.y[at(w, id)], camp.y);
    assert.match(run(w, 'tp').text, /^you are at /);
});

test('tp onto water is refused', () => {
    const w = world();
    control(w);
    let spot = null;
    for (let y = 0; y < w.height && !spot; y += 7) for (let x = 0; x < w.width && !spot; x += 7) if (w.terrain.isWater(x, y)) spot = { x, y };
    assert.ok(spot, 'the world has water');
    const r = run(w, `tp ${spot.x} ${spot.y}`);
    assert.equal(r.ok, false);
    assert.match(r.text, /water or a cliff/);
});

test('skip runs the world forward; your person lives on, and the page jumps back in', () => {
    const w = world(QUIET);
    const id = control(w);
    const t = w.time;
    const r = run(w, 'skip 300');
    assert.equal(r.ok, true);
    assert.equal(w.time, t + 300);
    assert.match(r.text, /^skipped 300 steps/);
    assert.equal(w.player.id, id);
    assert.equal(w.player.auto, false, 'steered by hand again');
    assert.equal(playerSnapshot(w).snap, true);
    // On the map (autopilot) it stays on autopilot.
    applyAct(w, { seq: 1, action: 'auto', on: true });
    run(w, 'skip 10');
    assert.equal(w.player.auto, true);
});

// ---- Parameters ----------------------------------------------------------------------------

test('set and get: live parameters, typed as they are', () => {
    const w = world(QUIET);
    let r = run(w, 'set herbivore.speed 0.7');
    assert.equal(r.ok, true);
    assert.equal(w.p.herbivore.speed, 0.7);
    assert.deepEqual(r.param, { path: 'herbivore.speed', value: 0.7 });
    assert.equal(r.text, 'herbivore.speed: 0.6 → 0.7');
    run(w, 'set items.enabled off');
    assert.equal(w.p.items.enabled, false);
    run(w, 'set items.costs.spear {"wood": 1, "flint": 0, "hide": 0}');
    assert.deepEqual(w.p.items.costs.spear, { wood: 1, flint: 0, hide: 0 });
    assert.equal(run(w, 'get herbivore.speed').text, 'herbivore.speed: 0.7');
    assert.match(run(w, 'get').text, /^groups: life calendar world terrain biomes/);
    assert.match(run(w, 'get items.costs').text, /^items\.costs\.spear: \{"wood":1/);
});

test('stats: populations, tribes, items by kind and rarity, legends', () => {
    const w = world(QUIET);
    const id = control(w);
    disarm(w, at(w, id));
    run(w, 'give bow legendary');
    run(w, 'give knife rare');
    const r = run(w, 'stats');
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.match(r.text, /herbivores \d+ · carnivores 0 · people \d+ in 1 tribe/);
    assert.match(r.text, /bow 1 \(1 legendary\)/);
    assert.match(r.text, /knife 1 \(1 rare\)/);
    assert.match(r.text, /spear \d+/);
    assert.match(r.text, /legends 1:\n {2}.+, a bow \(admin\) · .+ of the /);
});

// ---- The Sim: the queue, the answers -----------------------------------------------------------------

function startSim(set = {}, seed = 1) {
    const posted = [];
    const sim = new Sim((msg) => posted.push(msg));
    sim.handle({ type: 'start', gen: 1, seed, aspect: 1.6, params: config(set) });
    const snapshot = () => {
        sim.handle({ type: 'want' });
        return posted.filter((m) => m.type === 'snapshot').at(-1);
    };
    return { sim, snapshot, posted };
}

test('a command waits for the next step, and its answer comes as an event', () => {
    const { sim, snapshot } = startSim(QUIET);
    const w = sim.world;
    const id = control(w);
    const tribe = w.tribeById.get(w.humans.tribe[at(w, id)]);
    const wood = tribe.wood;
    snapshot();
    sim.handle({ type: 'admin', id: 7, cmd: 'store', args: ['wood', '50'], target: 0 });
    assert.equal(tribe.wood, wood, 'not between steps');
    sim.step();
    assert.equal(tribe.wood, wood + 50, 'at the start of the next');
    const snap = snapshot();
    const answer = snap.events.find((e) => e.type === 'admin');
    assert.deepEqual(
        { id: answer.id, cmd: answer.cmd, ok: answer.ok, changed: answer.changed, time: answer.time },
        { id: 7, cmd: 'store', ok: true, changed: true, time: snap.time - 1 },
    );
    assert.match(answer.text, /wood/);
    // Numbers for the page too (TRIBE_STRIDE: wood is the 11th).
    const k = snap.tribes.indexOf(tribe.id);
    assert.equal(snap.tribes[k + 10], wood + 50);
});

test('paused, a command runs at once; what it sets off is sent with it', () => {
    const { sim, snapshot } = startSim(WILD);
    sim.handle({ type: 'pause', paused: true });
    snapshot();
    const prey = sim.world.herbivores.id[3];
    const t = sim.world.time;
    sim.handle({ type: 'admin', id: 1, cmd: 'kill', args: [String(prey)], target: 0 });
    assert.equal(sim.world.time, t, 'no step');
    const snap = snapshot();
    assert.ok(snap, 'a snapshot, though paused');
    const death = snap.events.find((e) => e.type === 'death');
    assert.equal(death.id, prey);
    assert.equal(death.cause, 'admin');
    const answer = snap.events.find((e) => e.type === 'admin');
    assert.equal(answer.ok, true);
    assert.ok(snap.events.indexOf(death) < snap.events.indexOf(answer));
    // A wrong one is answered too, with its usage.
    sim.handle({ type: 'admin', id: 2, cmd: 'give', args: [], target: 0 });
    const no = snapshot().events.find((e) => e.type === 'admin');
    assert.equal(no.ok, false);
    assert.match(no.text, /usage: give/);
});

test('skip through the Sim: its steps, events and samples go to the page', () => {
    const { sim, snapshot } = startSim(QUIET);
    snapshot();
    const t = sim.world.time;
    sim.handle({ type: 'admin', id: 3, cmd: 'skip', args: ['500'], target: 0 });
    sim.step();
    assert.equal(sim.world.time, t + 501);
    const snap = snapshot();
    assert.ok(snap.samples.length >= 40, 'sparkline samples of the skipped steps');
    const answer = snap.events.find((e) => e.type === 'admin');
    assert.match(answer.text, /^skipped 500 steps/);
    // Nobody glides from where they were before the jump.
    const f = new Float64Array(snap.buffer, 0, snap.size);
    const n = snap.counts[0];
    const prev = f.subarray(COLUMNS.length * n, (COLUMNS.length + 1) * n); // (herbivores: COLUMNS, then prev)
    assert.ok(prev.every((j) => j === -1));
});

// ---- The page's console --------------------------------------------------------------------------

// A console with fakes: the simulation's inbox, the input, modes, storage.
function terminal(more = {}) {
    const sent = [];
    const started = [];
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
    const input = { blocked: false, cleared: 0, unlocked: 0, clear() { this.cleared++; }, unlock() { this.unlocked++; } };
    const modes = { game: 'god', story: { played: new Map() } };
    const params = structuredClone(defaults);
    let events = [];
    const c = new Console({
        send: (m) => sent.push(m), start: (s) => started.push(s), target: () => 0, modes, params: () => params, input,
        events: () => events, storage, ...more,
    });
    const answer = (e) => {
        events = [{ type: 'admin', time: 0, changed: false, ...e }];
        c.frame();
        events = [];
    };
    return { c, sent, started, store, storage, input, modes, params, answer };
}
const keyEvent = (key, more = {}) => ({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, repeat: false, shiftKey: false, ...more });

test('the console opens and closes, letting go of the body while open', () => {
    const { c, input } = terminal();
    c.open();
    assert.equal(c.isOpen, true);
    assert.equal(input.blocked, true);
    assert.equal(input.cleared, 1);
    assert.equal(input.unlocked, 1);
    assert.match(c.lines[0].text, /^admin console/);
    assert.equal(c.key(keyEvent('Escape')), true);
    assert.equal(c.isOpen, false);
    assert.equal(input.blocked, false);
    c.open();
    c.key({ key: "'", code: 'Backquote', repeat: false });
    assert.equal(c.isOpen, false, 'the key left of 1, whatever it types');
    c.open();
    c.key(keyEvent('F2'));
    assert.equal(c.isOpen, false);
});

test('a key anywhere: ` and F2 open it; while open, every key is its', () => {
    const { c } = terminal();
    const ev = (props) => {
        const e = { code: '', key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'CANVAS' }, stopped: false, prevented: false, ...props };
        e.stopPropagation = () => {
            e.stopped = true;
        };
        e.preventDefault = () => {
            e.prevented = true;
        };
        c.watch(e);
        return e;
    };
    let e = ev({ code: 'KeyW', key: 'w' });
    assert.equal(e.stopped, false, 'closed: the game has it');
    ev({ code: 'Backquote', key: '`', target: { tagName: 'INPUT' } });
    assert.equal(c.isOpen, false, 'a backquote typed into the seed field');
    e = ev({ code: 'Backquote', key: '"' });
    assert.equal(c.isOpen, true);
    assert.equal(e.prevented, true, 'nothing typed');
    e = ev({ code: 'KeyW', key: 'w' });
    assert.equal(e.stopped, true, 'open: not the body\'s');
    assert.equal(e.prevented, false, '(it goes to the line)');
    e = ev({ code: 'KeyC', key: 'c', metaKey: true });
    assert.equal(e.stopped, false, 'copying from the log');
    ev({ code: 'Escape', key: 'Escape' });
    assert.equal(c.isOpen, false);
    ev({ code: 'F2', key: 'F2' });
    assert.equal(c.isOpen, true);
});

test('Enter sends a command with its words and target; help, seed and clear are the page\'s', () => {
    const { c, sent, started } = terminal({ target: () => 42 });
    c.open();
    c.value = 'give bow legendary';
    c.key(keyEvent('Enter'));
    assert.equal(c.value, '');
    assert.deepEqual(sent, [{ type: 'admin', id: 1, cmd: 'give', args: ['bow', 'legendary'], target: 42 }]);
    assert.deepEqual(c.lines.at(-1), { kind: 'cmd', text: 'give bow legendary' });
    c.submit('help');
    assert.equal(sent.length, 1, 'help is answered here');
    assert.ok(c.lines.some((l) => l.kind === 'ok' && l.text.startsWith('give <kind>')));
    c.submit('nonsense 3');
    assert.equal(sent.length, 1);
    assert.deepEqual(c.lines.at(-1), { kind: 'error', text: 'unknown command "nonsense": type help' });
    c.submit('seed 99');
    assert.deepEqual(started, [99]);
    c.submit('seed x');
    assert.deepEqual(started, [99]);
    assert.deepEqual(c.lines.slice(-2).map((l) => l.kind), ['error', 'usage']);
    c.submit('clear');
    assert.deepEqual(c.lines, []);
    c.submit('   ');
    assert.equal(sent.length, 1);
});

test('answers are logged: results, errors with their usage; a set is mirrored', () => {
    const { c, params, answer } = terminal();
    c.submit('give sword');
    answer({ id: 1, ok: false, text: 'no such kind: sword\nusage: give <kind>' });
    assert.deepEqual(c.lines.slice(-2), [{ kind: 'error', text: 'no such kind: sword' }, { kind: 'usage', text: 'usage: give <kind>' }]);
    c.submit('set herbivore.speed 0.9');
    answer({ id: 2, ok: true, changed: true, text: 'herbivore.speed: 0.6 → 0.9', param: { path: 'herbivore.speed', value: 0.9 } });
    assert.equal(params.herbivore.speed, 0.9);
    assert.deepEqual(c.lines.at(-1), { kind: 'ok', text: 'herbivore.speed: 0.6 → 0.9' });
});

test('↑ and ↓ walk the history, which this browser keeps', () => {
    const { c, storage } = terminal();
    for (const line of ['heal', 'spirit', 'spirit', 'store wood 5']) c.submit(line);
    assert.deepEqual(c.history, ['heal', 'spirit', 'store wood 5'], 'a repeat is kept once');
    c.value = 'giv';
    c.key(keyEvent('ArrowUp'));
    assert.equal(c.value, 'store wood 5');
    c.key(keyEvent('ArrowUp'));
    c.key(keyEvent('ArrowUp'));
    c.key(keyEvent('ArrowUp'));
    assert.equal(c.value, 'heal', 'the oldest');
    c.key(keyEvent('ArrowDown'));
    assert.equal(c.value, 'spirit');
    c.key(keyEvent('ArrowDown'));
    c.key(keyEvent('ArrowDown'));
    assert.equal(c.value, 'giv', 'back to what was being typed');
    assert.deepEqual(JSON.parse(storage.getItem(HISTORY_KEY)), ['heal', 'spirit', 'store wood 5']);
    // A new page finds it.
    const again = terminal({ storage });
    assert.deepEqual(again.c.history, ['heal', 'spirit', 'store wood 5']);
    // Storage that refuses: history for this visit only, nothing thrown.
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    const b = terminal({ storage: broken }).c;
    b.submit('heal');
    assert.deepEqual(b.history, ['heal']);
    assert.deepEqual(terminal({ storage: null }).c.history, []);
});

test('Tab completes commands, kinds, materials and parameters', () => {
    const params = structuredClone(defaults);
    assert.deepEqual(completeLine('gi'), { line: 'give ', choices: [] });
    assert.deepEqual(completeLine('give b'), { line: 'give b', choices: ['bow', 'basket'] });
    assert.deepEqual(completeLine('give bo'), { line: 'give bow ', choices: [] });
    assert.deepEqual(completeLine('give bow l'), { line: 'give bow legendary ', choices: [] });
    assert.deepEqual(completeLine('give bow rare acc'), { line: 'give bow rare accuracy ', choices: [] });
    assert.deepEqual(completeLine('store w'), { line: 'store wood ', choices: [] });
    assert.deepEqual(completeLine('spawn c'), { line: 'spawn carnivore ', choices: [] });
    assert.deepEqual(completeLine('help sk'), { line: 'help skip ', choices: [] });
    const s = completeLine('s');
    assert.equal(s.line, 's');
    assert.ok(['skip', 'set', 'seed', 'stats', 'spawn', 'spirit', 'store'].every((x) => s.choices.includes(x)));
    assert.deepEqual(completeLine('sp').choices.sort(), ['spawn', 'spirit']);
    assert.equal(completeLine('rep').line, 'repair ');
    assert.deepEqual(completeLine('set herb', params), { line: 'set herbivore.', choices: [] });
    assert.deepEqual(completeLine('set herbivore.sp', params), { line: 'set herbivore.speed ', choices: [] });
    assert.equal(completeLine('get items.co', params).line, 'get items.costs.');
    assert.deepEqual(completeLine('heal x'), { line: 'heal x', choices: [] });
    assert.deepEqual(completeLine('zzz'), { line: 'zzz', choices: [] });
    // The console logs the choices when Tab cannot decide.
    const { c } = terminal();
    c.value = 'sp';
    c.key(keyEvent('Tab'));
    assert.equal(c.value, 'sp');
    assert.equal(c.lines.at(-1).kind, 'info');
    assert.equal(c.lines.at(-1).text, 'spirit  spawn');
});

test('Play: a command that changes the world marks the game, quietly, until the next one', () => {
    const { c, modes, answer } = terminal();
    // God mode: no mark.
    c.submit('store wood 5');
    answer({ id: 1, ok: true, changed: true, text: 'ok' });
    assert.equal(c.markShown, false);
    modes.game = 'play';
    const game = (modes.story = { played: new Map() });
    // Reading changes nothing; a refusal changed nothing.
    c.submit('stats');
    answer({ id: 2, ok: true, changed: false, text: 'step 1' });
    c.submit('give sword');
    answer({ id: 3, ok: false, changed: false, text: 'no such kind\nusage: give' });
    assert.equal(c.markShown, false);
    c.submit('give bow legendary');
    answer({ id: 4, ok: true, changed: true, text: 'Grey Fang' });
    assert.equal(c.markShown, true);
    assert.equal(c.marked, game);
    // It stays for the rest of that game (on the map too)...
    c.frame();
    assert.equal(c.markShown, true);
    // ...and a new game starts without it.
    modes.story = { played: new Map() };
    c.frame();
    assert.equal(c.markShown, false);
    // An answer for a command typed in an earlier game marks nothing now.
    c.submit('heal');
    modes.story = { played: new Map() };
    answer({ id: 5, ok: true, changed: true, text: 'energy' });
    assert.equal(c.markShown, false);
});

test('the input hears nothing of the body while the console is open', () => {
    const target = new EventTarget();
    const canvas = new EventTarget();
    const doc = new EventTarget();
    doc.pointerLockElement = null;
    canvas.requestPointerLock = () => Promise.reject(new Error('no'));
    const input = new Input({ target, canvas, doc, now: () => 0 });
    const actions = [];
    input.onAction = (name) => actions.push(name);
    input.setMode('body');
    const fire = (on, type, props) => {
        const e = new Event(type, { cancelable: true });
        Object.assign(e, { code: '', key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, button: 0, pointerId: 1, clientX: 0, clientY: 0 }, props);
        on.dispatchEvent(e);
    };
    const { c } = terminal({ input });
    c.open();
    fire(target, 'keydown', { code: 'KeyE' });
    fire(target, 'keydown', { code: 'KeyW' });
    fire(canvas, 'pointerdown', { button: 2 });
    assert.deepEqual(actions, []);
    assert.equal(input.y, 0);
    c.close();
    fire(target, 'keydown', { code: 'KeyE' });
    assert.deepEqual(actions, ['interact']);
});

test('nobody controlled and no command: the world is the same as without the console', () => {
    // (make fingerprint checks this on the whole run; here, a Sim with an
    // empty queue steps exactly as a bare World.)
    const { sim } = startSim({}, 2);
    const w = world({}, 2);
    for (let k = 0; k < 400; k++) {
        sim.step();
        w.step();
    }
    assert.equal(digest(sim.world, 100), digest(w, 100));
    assert.equal(sim.world.immortal, null);
});
