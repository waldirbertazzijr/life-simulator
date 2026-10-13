// Items on the page (package 3b): what the HUD's equipment cross shows, the
// craft menu's choices, cycling, E with items lying about, the skill and the
// tool, the banners, and the god view's legends, against the shapes the
// simulation sends (planning's wp-3-interface.md). No DOM: a fake world with
// the Mirror's shape, a fake HUD and input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Modes } from '../src/play/modes.js';
import { POSE } from '../src/view3d/animate.js';
import {
    equipment, itemName, kindName, craftRows, cycled, cycleAct, legendRows, nearestLying, pickupText, skillOf, costText,
} from '../src/play/gear.js';
import { personName } from '../src/play/names.js';
import { ITEM_KINDS, TASK, flatSpot } from '../src/items.js';
import { noticeFor } from '../src/play/calls.js';
import { workOf, crossName } from '../src/play/hud-state.js';
import { Pouch, contents } from '../src/play/pouch.js';

// An item as the Mirror keeps it (its kind a KIND code), and a legend (with
// its skill's name, as items.js's forge gives it).
let nextId = 100;
const item = (kind, more = {}) => ({
    id: nextId++, kind: ITEM_KINDS.indexOf(kind), rarity: 0, trait: '', mult: 1, maker: 0, tribe: 1, made: 0, gens: 0, legend: null,
    bearer: 0, x: 0, y: 0, wear: 1, kills: 0, ...more,
});
const WORD = { spear: 'Flight', bow: 'Rain', club: 'Quake' };
const legend = (kind, name, more = {}) => item(kind, {
    rarity: 2, trait: 'range', mult: 1.5, wear: 1,
    legend: { name, skill: WORD[kind] ? `${WORD[kind]} of ${name}` : '', deed: 'kills', time: 0, history: [] }, ...more,
});

// A world with the Mirror's shape: Ana (7) at her camp (100, 100), Oren (8)
// away, Sefa (20) of another tribe; items, and the messages it was sent.
const COLS = ['x', 'y', 'heading', 'id', 'age', 'energy', 'speedGene', 'generation', 'children', 'kills', 'tribe', 'carry', 'parent'];
function fakeWorld(items = []) {
    const pop = () => Object.fromEntries([['n', 0], ...COLS.map((c) => [c, []])]);
    const flag = { pattern: 'bands', colors: ['#4a90e2', '#f2c14e', '#1b1d22'] };
    const w = {
        p: structuredClone(defaults), width: 1000, height: 600, terrain: null, time: 1000,
        herbivores: pop(), carnivores: pop(), humans: pop(),
        tribeById: new Map([
            [1, { id: 1, name: 'Kamari', camp: { x: 100, y: 100 }, store: 120, wood: 5, flint: 1, hide: 0, flag, aggression: 0.3, sociality: 0.6 }],
            [2, { id: 2, name: 'Urek', camp: { x: 700, y: 400 }, store: 40, wood: 0, flint: 0, hide: 0, flag, aggression: 0.8, sociality: 0.2 }],
        ]),
        fallen: [],
        items: new Map(items.map((it) => [it.id, it])),
        byBearer: new Map(),
        legends: [],
        player: null, snapped: false, pose: null, events: [], acts: [],
        carcasses: [], grass: { g: [0.5], index: () => 0 },
        control() {},
        input() {},
        act(msg) {
            this.acts.push(msg);
        },
        find(id) {
            return World.prototype.find.call(this, id);
        },
        descendant: () => 0,
        add(kind, props) {
            const p = this[kind];
            const row = { x: 0, y: 0, heading: 0, age: 2000, energy: 100, speedGene: 1, generation: 0, children: 0, kills: 0, tribe: 1, carry: 0, parent: 0, ...props };
            for (const c of COLS) p[c][p.n] = row[c];
            p.n++;
        },
    };
    w.add('humans', { id: 7, x: 100, y: 102, age: 3000 });
    w.add('humans', { id: 8, x: 300, y: 300, age: 5000 });
    w.add('humans', { id: 20, x: 700, y: 400, tribe: 2, age: 1000 });
    return w;
}

// Modes over that world, in Ana's body, the simulation reporting on her
// with `player` (merged over a plain report).
function inBody(items = [], player = {}) {
    const world = fakeWorld(items);
    const state = { poses: [], paused: false };
    const input = {
        mode: 'off', x: 0, y: 0, sprinting: false, capture: null, locks: 0, unlocks: 0,
        setMode(m) {
            this.mode = m;
        },
        takeLook: () => ({ dx: 0, dy: 0 }),
        clear() {},
        lock() {
            this.locks++;
        },
        unlock() {
            this.unlocks++;
        },
    };
    const hud = {
        banners: [], notices: [], menu: null,
        show() {},
        banner(kind, text) {
            this.banners.push([kind, text]);
        },
        notice(text, refused) {
            this.notices.push([text, !!refused]);
        },
        flash() {},
        clear() {},
        hideSummary() {},
        craftMenu(model, actions) {
            this.menu = model;
            this.actions = actions;
        },
        update(s) {
            this.s = s;
            this.prompt = s.prompt ? s.prompt.map((p) => p.join(' ')) : null;
        },
    };
    const modes = new Modes({
        world, input, hud,
        rig: () => null, follow() {}, followed: () => 0, setView() {}, setSpeed() {}, getSpeed: () => 1,
        setPaused: (p) => {
            state.paused = p;
        },
        getPaused: () => state.paused,
        inBody() {}, openPicker() {}, changed() {},
        pose: (id, code) => state.poses.push(['pose', id, code]),
        hold: (id, code) => state.poses.push(['hold', id, code]),
        release: (id) => state.poses.push(['release', id]),
    });
    const frame = (dt = 1 / 60) => {
        modes.move(dt);
        modes.after(dt);
        world.events = [];
    };
    modes.become(7);
    world.player = {
        id: 7, x: 100, y: 102, heading: 0, reload: 0, carry: 0, energy: 100, spirit: 100, gathering: false, butchering: 0,
        weapon: 0, tool: 0, kit: { weapons: [], tools: [] }, crafting: null, skill: 0, ...player,
    };
    frame();
    return { world, state, input, hud, modes, frame, last: () => world.acts.at(-1) };
}

// ---- Names, kinds and costs ----

test('items are named for their kind, their trait, or their legend', () => {
    assert.equal(itemName(item('spear')), 'Plain spear');
    assert.equal(itemName(item('bow', { rarity: 1, trait: 'accuracy' })), 'True bow');
    assert.equal(itemName(item('knife', { rarity: 1, trait: 'effect' })), 'Keen knife');
    assert.equal(itemName(item('club', { rarity: 1, trait: 'mystery' })), 'Fine club');
    assert.equal(itemName(legend('spear', 'Grey Fang')), 'Grey Fang');
    assert.equal(kindName(2), 'bow', 'a KIND code');
    assert.equal(kindName('torch'), 'torch');
    assert.deepEqual(skillOf(item('spear')), { name: 'Piercing throw', cost: 30 });
    assert.deepEqual(skillOf(legend('bow', "Heron's Reach"), 25), { name: "Rain of Heron's Reach", cost: 25 }, "a legend's, by its own name, at the simulation's cost");
    assert.equal(skillOf(item('knife')), null, 'tools have none');
    assert.equal(costText({ wood: 3, hide: 1 }), '3 wood · 1 hide');
});

// ---- The equipment cross ----

test('the HUD shows the weapon and tool in hand, with rarity, wear, spares, skill and crafting', () => {
    const spear = legend('spear', 'Grey Fang', { kills: 31 });
    const knife = item('knife', { rarity: 1, trait: 'effect', wear: 0.35 });
    const spare = item('bow');
    const w = fakeWorld([spear, knife, spare]);
    const p = { weapon: spear.id, tool: knife.id, kit: { weapons: [spare.id], tools: [] }, crafting: null, skill: 45 };
    let g = equipment(w, p);
    assert.equal(g.on, true);
    assert.deepEqual(g.weapon, { id: spear.id, kind: 'spear', rarity: 'legendary', wear: 1, spares: 1, name: 'Grey Fang' });
    assert.deepEqual(g.tool, { id: knife.id, kind: 'knife', rarity: 'rare', wear: 0.35, spares: 0, name: 'Keen knife' });
    assert.deepEqual(g.skill, { name: 'Flight of Grey Fang', cost: 45 });
    assert.equal(g.crafting, null);
    // Crafting a bow, a third of the way.
    g = equipment(w, { ...p, crafting: { kind: 2, until: w.time + 100 } });
    assert.equal(g.crafting.kind, 'bow');
    assert.ok(Math.abs(g.crafting.progress - 1 / 3) < 1e-9);
    // Empty hands.
    g = equipment(w, { weapon: 0, tool: 0, kit: { weapons: [], tools: [] }, skill: 0 });
    assert.deepEqual([g.weapon, g.tool, g.skill], [null, null, null]);
    // A world without items: the plain spear it always was.
    const old = fakeWorld();
    delete old.items;
    g = equipment(old, { id: 7 });
    assert.equal(g.on, false);
    assert.equal(g.weapon.kind, 'spear');
    assert.equal(g.weapon.legacy, true);
    // Items turned off in the simulation: the same.
    const off = fakeWorld([spear]);
    off.p.items = { enabled: false };
    assert.equal(equipment(off, p).on, false);
});

test("drawHud hands the HUD the cross and the store's materials", () => {
    const bow = item('bow', { rarity: 1, trait: 'reload', wear: 0.8 });
    const t = inBody([bow], { weapon: bow.id, skill: 30 });
    t.modes.drawHud(1 / 60);
    assert.equal(t.hud.s.gear.weapon.name, 'Swift bow');
    assert.equal(t.hud.s.gear.skill.name, 'Volley');
    assert.deepEqual(t.hud.s.materials, { wood: 5, flint: 1, hide: 0 });
    delete t.world.items;
    t.modes.drawHud(1 / 60);
    assert.equal(t.hud.s.materials, null, 'no materials without items');
});

// ---- Cycling ----

test('the arrows swap in the next spare, only when there is one', () => {
    assert.deepEqual(cycleAct({ kit: { weapons: [5], tools: [] } }, 'weapon'), { action: 'cycle', slot: 'weapon' });
    assert.equal(cycleAct({ kit: { weapons: [5], tools: [] } }, 'tool'), null);
    assert.deepEqual(cycled(1, [5, 6]), { held: 5, spares: [6, 1] }, 'the held one goes to the back');
    assert.deepEqual(cycled(0, [5]), { held: 5, spares: [] }, 'from empty hands');
    const spear = item('spear');
    const club = item('club');
    const t = inBody([spear, club], { weapon: spear.id, kit: { weapons: [club.id], tools: [] } });
    t.modes.action('cycle-weapon');
    assert.deepEqual([t.last().action, t.last().slot], ['cycle', 'weapon']);
    const n = t.world.acts.length;
    t.modes.action('cycle-tool');
    assert.equal(t.world.acts.length, n, 'no spare tool: nothing sent');
});

// ---- The craft menu ----

test('the craft menu offers what the store can pay for', () => {
    const store = { wood: 3, flint: 1, hide: 0 };
    const rows = craftRows(store, defaults);
    const can = Object.fromEntries(rows.map((r) => [r.kind, r.can]));
    assert.deepEqual(can, { spear: true, bow: false, club: true, knife: true, basket: true, torch: true });
    assert.equal(rows.find((r) => r.kind === 'bow').text, '3 wood · 1 hide');
    // With a flint for a chance of rare: one more flint each.
    const rare = Object.fromEntries(craftRows(store, defaults, true).map((r) => [r.kind, r.can]));
    assert.deepEqual(rare, { spear: true, bow: false, club: true, knife: false, basket: true, torch: true });
    assert.equal(craftRows(store, defaults, true).find((r) => r.kind === 'knife').text, '2 flint');
    // The simulation's own costs, if it has them.
    const p = { items: { costs: { ...defaults.items.costs, spear: { wood: 9, flint: 0, hide: 0 } } } };
    assert.equal(craftRows(store, p).find((r) => r.kind === 'spear').can, false);
});

test('C at camp opens the menu; keys choose, craft and close it', () => {
    const t = inBody();
    const { modes, hud, input } = t;
    modes.action('craft');
    assert.ok(hud.menu, 'open');
    assert.equal(hud.menu.rows[hud.menu.index].kind, 'spear', 'the first it can pay for');
    assert.equal(input.unlocks, 1, 'the pointer is let go');
    assert.equal(typeof input.capture, 'function', 'its keys are the menu’s');
    assert.equal(input.capture('ArrowDown'), true);
    assert.equal(hud.menu.rows[hud.menu.index].kind, 'bow');
    input.capture('Enter');
    assert.deepEqual(hud.notices.at(-1), ['The store lacks 3 wood · 1 hide', true], 'the store cannot pay');
    assert.ok(hud.menu, 'still open');
    input.capture('KeyF');
    assert.equal(hud.menu.flint, true);
    input.capture('ArrowUp');
    input.capture('Enter');
    const a = t.last();
    assert.deepEqual([a.action, a.kind, a.flint], ['craft', 'spear', true]);
    assert.equal(hud.menu, null, 'closed');
    assert.equal(input.capture, null);
    assert.equal(input.locks, 1, 'the pointer taken again');
    // Crafting: seated at the work while the simulation says so.
    t.frame();
    assert.deepEqual(t.state.poses.at(-1), ['hold', 7, POSE.CRAFT]);
    t.world.player.crafting = { kind: 1, until: t.world.time + 150 };
    t.frame(1);
    assert.deepEqual(t.state.poses.at(-1), ['hold', 7, POSE.CRAFT]);
    t.world.player.crafting = null;
    t.frame();
    assert.deepEqual(t.state.poses.at(-1), ['release', 7], 'done (or moved): up again');
    // Esc, C and a move close it; a mouse pick crafts.
    for (const close of [() => input.capture('Escape'), () => input.capture('KeyC'), () => modes.action('move')]) {
        modes.action('craft');
        assert.ok(hud.menu);
        close();
        assert.equal(hud.menu, null);
    }
    modes.action('craft');
    hud.actions.pick('torch');
    assert.deepEqual([t.last().action, t.last().kind, t.last().flint], ['craft', 'torch', false]);
    assert.equal(input.capture, null, 'closed, it takes no keys');
});

test('the craft menu only at camp, for an adult', () => {
    const t = inBody();
    t.modes.body.x = 200;
    t.modes.action('craft');
    assert.equal(t.hud.menu, null);
    assert.deepEqual(t.hud.notices.at(-1), ['Craft at your camp', true]);
    t.world.humans.age[0] = 300;
    t.modes.body.x = 100;
    t.modes.action('craft');
    assert.deepEqual(t.hud.notices.at(-1), ['A child cannot craft', true]);
    // No items in this world: C does nothing.
    const old = inBody();
    delete old.world.items;
    old.modes.action('craft');
    assert.equal(old.hud.menu, null);
    assert.equal(old.hud.notices.length, 0);
});

// ---- E with items about ----

test('E picks up an item at your feet first, one farther off only where the rack has nothing', () => {
    const near = item('bow', { rarity: 1, trait: 'range', x: 101, y: 103 });
    const t = inBody([near]);
    const what = () => t.modes.interaction();
    assert.deepEqual(what(), { kind: 'pickup', id: near.id, item: near }, 'at your feet, before the rack');
    t.world.carcasses = [{ id: 77, x: 102, y: 102 }];
    assert.equal(what().kind, 'butcher', 'a fresh kill first');
    t.world.carcasses = [];
    near.x = 105; // 5 away: in reach, not at your feet
    assert.equal(what().kind, 'take', 'the rack first');
    t.world.tribeById.get(1).store = 0;
    assert.equal(what().kind, 'pickup', 'nothing at the rack: the item');
    t.modes.body.x = 150;
    near.x = 152;
    near.y = 104;
    assert.equal(what().kind, 'pickup', 'before gathering');
    near.x = 160;
    assert.equal(what().kind, 'gather', 'out of reach');
    near.bearer = 8;
    near.x = 151;
    assert.equal(what().kind, 'gather', 'borne by someone: not lying');
    // And E does it; the prompt names it, in its rarity's colour.
    near.bearer = 0;
    t.modes.drawHud(1 / 60);
    assert.deepEqual(t.hud.s.prompt[0], ['E', 'Pick up Long bow (rare)', 'rare']);
    t.modes.action('interact');
    assert.deepEqual([t.last().action, t.last().item], ['pickup', near.id]);
    assert.equal(pickupText(item('spear')), 'Pick up plain spear');
    assert.equal(pickupText(legend('club', 'Old Knot')), 'Pick up Old Knot (legendary club)');
    assert.deepEqual(nearestLying(t.world, 0, 0, 6), null);
});

// ---- Attacks by weapon, the tool, the skill ----

test('the weapon in hand decides the attack and its pose; unarmed, none', () => {
    const bow = item('bow');
    const club = item('club');
    const t = inBody([bow, club], { weapon: bow.id });
    const { modes, state, world } = t;
    const again = () => {
        world.player.reload = 20;
        t.frame();
        world.player.reload = 0;
        t.frame();
    };
    modes.action('attack', {});
    assert.deepEqual(state.poses.at(-1), ['pose', 7, POSE.SHOOT], 'a bow shoots');
    again();
    world.add('herbivores', { id: 61, x: 100, y: 105 });
    modes.body.yaw = Math.PI / 2;
    world.player.weapon = club.id;
    modes.action('attack', {});
    assert.deepEqual(state.poses.at(-1), ['pose', 7, POSE.SWING], 'a club swings');
    assert.equal(t.last().target, 61, 'at what is within its reach');
    again();
    t.frame();
    // Charging holds the weapon's own wind-up.
    t.input.charging = true;
    t.frame();
    assert.deepEqual(state.poses.at(-1), ['hold', 7, POSE.SWING]);
    t.input.charging = false;
    t.frame();
    world.player.weapon = 0;
    const n = world.acts.length;
    modes.action('attack', {});
    assert.equal(world.acts.length, n, 'no weapon, no attack');
});

test('right click uses the tool: a knife cuts, a torch is brandished, a basket gathers', () => {
    const knife = item('knife');
    const torch = item('torch');
    const basket = item('basket');
    const t = inBody([knife, torch, basket], { tool: knife.id });
    const { modes, state, world } = t;
    modes.action('tool');
    assert.deepEqual([t.last().action, typeof t.last().dx], ['tool', 'number']);
    assert.deepEqual(state.poses.at(-1), ['pose', 7, POSE.JAB]);
    world.player.tool = torch.id;
    modes.action('tool');
    assert.deepEqual(state.poses.at(-1), ['pose', 7, POSE.SWING]);
    world.player.tool = basket.id;
    modes.body.x = 150; // on grass outside camp
    modes.action('tool');
    assert.deepEqual([t.last().action, t.last().on], ['gather', true], 'as E');
    modes.action('tool');
    assert.deepEqual([t.last().action, t.last().on], ['gather', false], 'and again, off');
    world.player.tool = 0;
    modes.action('tool');
    assert.deepEqual(t.hud.notices.at(-1), ['No tool in hand', true]);
});

test('Shift + right click: the skill, refused on the page when Spirit is short', () => {
    const spear = item('spear');
    const t = inBody([spear], { weapon: spear.id, skill: 30, spirit: 20 });
    const { modes, world, hud, state } = t;
    const n = world.acts.length;
    modes.action('skill');
    assert.equal(world.acts.length, n, 'not sent');
    assert.deepEqual(hud.notices.at(-1), ['Not enough Spirit for Piercing throw', true]);
    world.player.spirit = 30;
    modes.action('skill');
    const a = t.last();
    assert.deepEqual([a.action, a.lock, typeof a.dx, typeof a.dy, a.target], ['skill', false, 'number', 'number', 0]);
    assert.deepEqual(state.poses.at(-1), ['pose', 7, POSE.THROW]);
    world.player.weapon = 0;
    modes.action('skill');
    assert.deepEqual(hud.notices.at(-1), ['No weapon skill', true]);
});

// ---- What happens to your items ----

test('LEGEND FORGED for your item; a word when yours breaks or is made', () => {
    const spear = legend('spear', 'Grey Fang');
    const bow = item('bow', { rarity: 1, trait: 'accuracy' });
    const t = inBody([spear, bow], { weapon: spear.id });
    const { world, hud } = t;
    world.events = [{ type: 'legend', item: spear.id, name: 'Grey Fang', kind: 1, bearer: 7, tribe: 1, deed: 'kills', time: 1000 }];
    t.modes.after(1 / 60);
    assert.deepEqual(hud.banners.at(-1), ['legend', 'Grey Fang']);
    world.events = [{ type: 'legend', item: spear.id, name: 'Other', kind: 1, bearer: 8, tribe: 1, deed: 'kills', time: 1001 }];
    t.modes.after(1 / 60);
    assert.equal(hud.banners.length, 1, "someone else's legend: not a banner");
    world.events = [{ type: 'broke', item: bow.id, kind: 2, bearer: 7, x: 0, y: 0, time: 1002 }];
    t.modes.after(1 / 60);
    assert.deepEqual(hud.notices.at(-1), ['Your true bow broke', true]);
    world.events = [{ type: 'crafted', id: 7, item: bow.id, kind: 2, rarity: 1, tribe: 1, by: 7, time: 1003 }];
    t.modes.after(1 / 60);
    assert.deepEqual(hud.notices.at(-1), ['Made: True bow (rare)', false]);
    world.events = [];
});

// ---- Legends in the god view ----

test('the legends list: name, kind, bearer, tribe, kills, generations', () => {
    const fang = legend('spear', 'Grey Fang', { bearer: 8, kills: 31, gens: 2 });
    const reach = legend('bow', "Heron's Reach", { bearer: 0, tribe: 2, kills: 4, gens: 3 });
    const lost = legend('club', 'Old Knot', { bearer: 999, kills: 9 });
    const w = fakeWorld([fang, reach, lost]);
    w.legends = [fang, reach, lost];
    const rows = legendRows(w);
    assert.equal(rows.length, 3);
    assert.deepEqual(
        { ...rows[0], tribe: rows[0].tribe.name },
        { id: fang.id, name: 'Grey Fang', kind: 'spear', bearer: 8, bearerName: personName(8), where: personName(8), tribe: 'Kamari', kills: 31, gens: 2 },
    );
    assert.deepEqual([rows[1].bearer, rows[1].where, rows[1].tribe.name, rows[1].gens], [0, 'lying', 'Urek', 3], 'on the ground: its makers');
    assert.deepEqual([rows[2].bearer, rows[2].where], [0, 'lost'], 'its bearer not in the world');
    assert.deepEqual(legendRows({ ...w, legends: undefined }), [], 'no legends field: none');
});

// ---- Wood and flint by hand (the simulation's side: test/materials.test.mjs) ----

// Where the fake world's tribe 1 (a flat world) finds wood and flint: E there
// chops or knaps (items.js handWork, the same test the simulation makes).
const spotOf = (w, mat) => flatSpot(w, w.tribeById.get(1), mat);

test('E chops wood and knaps flint where the ground gives them, while held; the prompt says which', () => {
    const t = inBody();
    const { modes, world, state, frame } = t;
    const prompt = () => {
        modes.drawHud(1 / 60);
        return t.hud.prompt;
    };
    const wood = spotOf(world, TASK.WOOD);
    modes.body.x = wood.x;
    modes.body.y = wood.y;
    assert.deepEqual(modes.interaction(), { kind: 'chop' });
    assert.deepEqual(prompt(), ['E Chop wood']);
    modes.action('interact');
    assert.deepEqual([t.last().action, t.last().on], ['gather', true], 'the simulation decides by the ground too');
    assert.deepEqual(state.poses.at(-1), ['hold', 7, POSE.CHOP]);
    world.player.gathering = 'wood';
    world.player.wood = 1.3;
    frame();
    assert.equal(modes.doing?.kind, 'chop', 'the simulation is at it');
    assert.deepEqual(prompt(), ['E Chopping wood']);
    // The pouch turns to the wood picked up; the work bar fills as the load does.
    const most = world.p.items.load;
    assert.deepEqual([t.hud.s.pouch.kind, t.hud.s.pouch.name], ['wood', `Wood 1 / ${most}`]);
    assert.equal(t.hud.s.work.label, 'Chopping wood');
    assert.ok(Math.abs(t.hud.s.work.progress - 1.3 / most) < 1e-9);
    modes.action('interact-end');
    assert.deepEqual([t.last().action, t.last().on], ['gather', false], 'let go of E: it stops');
    assert.deepEqual(state.poses.at(-1), ['release', 7]);
    world.player.gathering = false;
    frame();

    // The simulation stops it itself (the load full): let go of here too.
    modes.action('interact');
    world.player.gathering = 'wood';
    frame();
    world.player.gathering = false;
    world.player.wood = world.p.items.load;
    frame();
    assert.equal(modes.doing, null);
    assert.equal(modes.interaction(), null, 'full: nothing more to chop');

    const flint = spotOf(world, TASK.FLINT);
    modes.body.x = flint.x;
    modes.body.y = flint.y;
    world.player.wood = 2;
    assert.deepEqual(prompt(), ['E Knap flint']);
    modes.action('interact');
    assert.deepEqual(state.poses.at(-1), ['hold', 7, POSE.KNAP]);
    world.player.gathering = 'flint';
    frame();
    assert.deepEqual(prompt(), ['E Knapping flint']);
    modes.action('move');
    assert.deepEqual([t.last().action, t.last().on], ['gather', false], 'a move stops it');

    // Elsewhere outside camp: food, as before (E again stops it).
    modes.body.x = 150;
    modes.body.y = 102;
    assert.deepEqual(prompt(), ['E Gather']);
    // A basket (right click) does as E does there.
    const basket = item('basket');
    world.items.set(basket.id, basket);
    world.player.tool = basket.id;
    modes.body.x = wood.x;
    modes.body.y = wood.y;
    world.player.wood = 0;
    world.player.gathering = false;
    frame(1);
    modes.action('tool');
    assert.deepEqual([t.last().action, t.last().on, modes.doing?.kind], ['gather', true, 'chop']);
});

test('at the rack, E stores the wood and flint you carry too', () => {
    const t = inBody([], { wood: 3.4 });
    const { modes, world } = t;
    const prompt = () => {
        modes.drawHud(1 / 60);
        return t.hud.prompt;
    };
    assert.deepEqual(modes.interaction(), { kind: 'store', amount: 0, wood: 3.4 }, 'wood alone, no food');
    assert.deepEqual(prompt(), ['E Store 3 wood']);
    world.player.carry = 30;
    world.player.flint = 0.5;
    assert.deepEqual(prompt(), ['E Store 30 food, 3 wood, flint', 'R Eat']);
    modes.action('interact');
    assert.equal(t.last().action, 'store');
    world.player.carry = 0;
    world.player.wood = 0;
    world.player.flint = 0;
    assert.deepEqual(prompt(), ['E Take 40 food'], 'empty hands: food for the road');
});

test('the calls slot and the map learn Gather wood and Gather flint', () => {
    const t = inBody();
    const { modes } = t;
    for (let k = 0; k < 5; k++) modes.action('cycle-call');
    assert.equal(modes.calls.call.kind, 'wood');
    modes.action('cycle-call');
    assert.equal(modes.calls.call.kind, 'flint');
    modes.action('call');
    assert.deepEqual([t.last().action, t.last().kind], ['call', 'flint']);
    modes.drawHud(1 / 60);
    assert.equal(t.hud.s.call.name, 'Gather flint');
    // Without items, ↑ passes them by.
    t.world.p.items.enabled = false;
    modes.action('cycle-call');
    for (let k = 0; k < 4; k++) modes.action('cycle-call');
    assert.equal(modes.calls.call.kind, 'move');
    modes.action('cycle-call');
    assert.equal(modes.calls.call.kind, 'rally');
    // The answers.
    assert.equal(noticeFor({ type: 'call', kind: 'wood', tribe: 1 }), 'Gather wood — the idle go for wood');
    assert.equal(noticeFor({ type: 'call', kind: 'flint', tribe: 1, hungry: true }), 'Gather flint — once the camp is fed');
    assert.equal(noticeFor({ type: 'refused', kind: 'flint', reason: 'nowhere', tribe: 1 }), 'No flint within reach of the camp');
});

// ---- The work bar and the pouch (hud-state.js workOf, pouch.js) ----

// The simulation's report on Ana, at rest, merged with `more`.
const report = (w, more = {}) => ({
    id: 7, carry: 0, wood: 0, flint: 0, loadMax: w.p.items.load, gathering: false, butchering: 0,
    weapon: 0, tool: 0, kit: { weapons: [], tools: [] }, crafting: null, skill: 0, ...more,
});
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("the work bar: each timed act with how far along it is, from the simulation's report", () => {
    const w = fakeWorld();
    const P = w.p;
    const work = (more) => {
        const p = report(w, more);
        return workOf(w, p, equipment(w, p), contents(w, p, p.carry));
    };
    assert.equal(work({}), null, 'idle: no bar');
    assert.equal(workOf(w, null, null, null), null, 'no report yet: none');
    // Butchering: the carcass's cut.
    w.carcasses = [{ id: 41, x: 0, y: 0, meat: 50, cut: 0.9 }, { id: 40, x: 103, y: 102, meat: 30, cut: 0.5 }];
    assert.deepEqual(work({ butchering: 40 }), { label: 'Butchering', progress: 0.5 });
    w.carcasses = [];
    assert.deepEqual(work({ butchering: 40 }), { label: 'Butchering', progress: 0 }, 'its carcass not seen yet');
    // Crafting: the time left of items.craftSteps.
    const craft = work({ crafting: { kind: ITEM_KINDS.indexOf('spear'), until: w.time + P.items.craftSteps / 4 } });
    assert.equal(craft.label, 'Crafting a spear');
    assert.ok(near(craft.progress, 0.75));
    // Chopping and knapping: the load (wood and flint together) filling toward loadMax.
    assert.deepEqual(work({ gathering: 'wood', wood: 2, flint: 2 }), { label: 'Chopping wood', progress: 4 / P.items.load });
    assert.deepEqual(work({ gathering: 'flint', flint: 6, loadMax: 12 }), { label: 'Knapping flint', progress: 0.5 }, 'a basket carries more');
    // Gathering food: the pouch filling toward full, where the simulation stops it (more with a basket).
    assert.deepEqual(work({ gathering: 'food', carry: 40 }), { label: 'Gathering', progress: 40 / P.human.carryMax });
    const basket = work({ gathering: true, carry: 60, loadMax: P.items.load * P.items.basket });
    assert.equal(basket.label, 'Gathering');
    assert.ok(near(basket.progress, 60 / (P.human.carryMax * P.items.basket)));
});

test('the work bar on the HUD: E at a kill shows Butchering filling, gone when it is cut up', () => {
    const t = inBody();
    const { modes, world, frame, hud } = t;
    world.carcasses = [{ id: 40, x: 103, y: 102, meat: 30, cut: 0 }];
    modes.action('interact');
    assert.equal(t.last().action, 'butcher');
    world.player.butchering = 40;
    world.carcasses[0].cut = 0.5;
    frame();
    modes.drawHud(1 / 60);
    assert.deepEqual(hud.s.work, { label: 'Butchering', progress: 0.5 });
    world.carcasses = [];
    world.player.butchering = 0;
    frame();
    modes.drawHud(1 / 60);
    assert.equal(hud.s.work, null, 'done: the bar goes');
    // Crafting at camp, once the simulation says so (nothing more under the cross).
    world.player.crafting = { kind: ITEM_KINDS.indexOf('bow'), until: world.time + world.p.items.craftSteps / 2 };
    modes.drawHud(1 / 60);
    assert.equal(hud.s.work.label, 'Crafting a bow');
    assert.ok(near(hud.s.work.progress, 0.5));
});

test('the pouch: ↓ goes through the kinds you carry, passing empty ones by; food is always there', () => {
    const w = fakeWorld();
    const pouch = new Pouch();
    const c = (food, wood = 0, flint = 0) => contents(w, report(w, { wood, flint }), food);
    assert.equal(pouch.cycle(c(30)), 'food', 'food alone: it stays');
    assert.equal(pouch.cycle(c(0)), 'food', 'even empty');
    assert.equal(pouch.cycle(c(30, 0, 2)), 'flint', 'no wood: passed by');
    assert.equal(pouch.cycle(c(30, 0, 2)), 'food');
    assert.equal(pouch.cycle(c(30, 3, 2)), 'wood');
    assert.equal(pouch.cycle(c(30, 3, 2)), 'flint');
    assert.equal(pouch.cycle(c(30, 3, 2)), 'food');
    assert.equal(pouch.cycle(c(0, 3)), 'wood');
    assert.equal(pouch.cycle(c(0, 3)), 'food', 'an empty pouch of food still has its turn');
});

test('the pouch turns to what you pick up, and back to food from a kind gone', () => {
    const w = fakeWorld();
    const pouch = new Pouch();
    const c = (food, wood = 0, flint = 0) => contents(w, report(w, { wood, flint }), food);
    pouch.keep(7, c(20, 3));
    assert.equal(pouch.kind, 'food', 'someone new starts on food, whatever they carry');
    pouch.keep(7, c(20, 3.4));
    assert.equal(pouch.kind, 'wood', 'chopping');
    pouch.keep(7, c(20, 3.4, 0.2));
    assert.equal(pouch.kind, 'flint', 'knapping');
    pouch.keep(7, c(18, 3.4, 0.2));
    assert.equal(pouch.kind, 'flint', 'eating does not turn it');
    pouch.keep(7, c(25, 3.4, 0.2));
    assert.equal(pouch.kind, 'food', 'gathering or butchering');
    pouch.cycle(c(25, 3.4, 0.2));
    assert.equal(pouch.kind, 'wood');
    pouch.keep(7, c(25, 3.4, 0.2));
    assert.equal(pouch.kind, 'wood', 'nothing new: it stays where ↓ left it');
    pouch.keep(7, c(25));
    assert.equal(pouch.kind, 'food', 'stored at the rack: back to food');
    pouch.cycle(c(25, 0, 1));
    pouch.keep(8, c(0, 0, 1));
    assert.equal(pouch.kind, 'food', 'someone else: food again');
});

test("the pouch's slot: the count inside, how full, the other kinds, and the name under the cross", () => {
    const w = fakeWorld();
    const P = w.p;
    const load = P.items.load;
    const pouch = new Pouch();
    const c = (food, wood = 0, flint = 0, loadMax = load) => contents(w, report(w, { wood, flint, loadMax }), food);
    assert.deepEqual(pouch.view(c(40.7, 5, 3)), {
        kind: 'food', count: 40, max: P.human.carryMax, fill: 40.7 / P.human.carryMax, full: false, others: ['wood', 'flint'], name: `Food 40 / ${P.human.carryMax}`,
    });
    pouch.cycle(c(40.7, 5, 3));
    assert.deepEqual(pouch.view(c(40.7, 5, 3)), {
        kind: 'wood', count: 5, max: load, fill: 5 / load, full: true, others: ['food', 'flint'], name: `Wood 5 / ${load}`,
    }, 'the load full (wood and flint share it): no more fits');
    assert.deepEqual(pouch.view(c(0.5, 2.6)), {
        kind: 'wood', count: 2, max: load, fill: 2.6 / load, full: false, others: [], name: `Wood 2 / ${load}`,
    }, 'less than a bite of food: no dot for it');
    const bag = pouch.view(c(0, 2, 0, load * P.items.basket));
    assert.deepEqual([bag.name, bag.max], [`Wood 2 / ${load * P.items.basket}`, load * P.items.basket], 'a basket carries more');
    assert.equal(pouch.view(c(10)).kind, 'food', 'its kind gone: food');
    const food = new Pouch().view(c(P.human.carryMax));
    assert.deepEqual([food.fill, food.full], [1, true]);
    // Under the cross: the pouch's reading on wood or flint, else the weapon's name.
    const spear = { name: 'Grey Fang', rarity: 'legendary' };
    assert.deepEqual(crossName({ weapon: spear }, pouch.view(c(0, 5))), { text: `Wood 5 / ${load}`, tint: '' });
    assert.deepEqual(crossName({ weapon: spear }, new Pouch().view(c(9, 5))), { text: 'Grey Fang', tint: 'legendary' });
    assert.deepEqual(crossName({ weapon: null }, new Pouch().view(c(9))), { text: 'Unarmed', tint: '' });
});

test('↓ in a body turns the slot, the name under the cross follows, and R still eats food', () => {
    const bow = item('bow', { rarity: 1, trait: 'reload' });
    const t = inBody([bow], { weapon: bow.id, skill: 30, carry: 30, wood: 5, flint: 0, loadMax: 8 });
    const { modes, world, frame, hud } = t;
    modes.drawHud(1 / 60);
    assert.deepEqual([hud.s.pouch.kind, hud.s.pouch.count, hud.s.pouch.others], ['food', 30, ['wood']]);
    assert.deepEqual(hud.s.item, { text: 'Swift bow', tint: 'rare' });
    modes.action('cycle-pouch');
    modes.drawHud(1 / 60);
    assert.deepEqual([hud.s.pouch.kind, hud.s.pouch.count, hud.s.pouch.others], ['wood', 5, ['food']]);
    assert.deepEqual(hud.s.item, { text: 'Wood 5 / 8', tint: '' });
    modes.action('eat');
    assert.equal(t.last().action, 'eat', 'R eats food, whatever the slot shows');
    modes.action('cycle-pouch');
    modes.drawHud(1 / 60);
    assert.equal(hud.s.pouch.kind, 'food', 'no flint: passed by');
    // Knapping: the slot turns to the flint as it comes.
    world.player.gathering = 'flint';
    world.player.flint = 0.4;
    frame();
    modes.drawHud(1 / 60);
    assert.deepEqual([hud.s.pouch.kind, hud.s.item.text], ['flint', 'Flint 0 / 8']);
    assert.deepEqual(hud.s.work, { label: 'Knapping flint', progress: 5.4 / 8 });
});
