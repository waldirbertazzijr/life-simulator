// Leading your tribe on the page (src/play/calls.js, and its parts in
// modes.js, input.js and the HUD): the call slot, G at the crosshair, calls
// from the map, and the tribe's answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Input } from '../src/play/input.js';
import { Modes } from '../src/play/modes.js';
import { CALLS, Calls, noticeFor } from '../src/play/calls.js';

// A world with the Mirror's shape: one person (7) of tribe 1, at camp, and
// a stranger (20) of tribe 2; and every message it was sent.
const COLS = ['x', 'y', 'heading', 'id', 'age', 'energy', 'speedGene', 'generation', 'children', 'kills', 'tribe', 'carry', 'parent'];
function fakeWorld() {
    const pop = () => Object.fromEntries([['n', 0], ...COLS.map((c) => [c, []])]);
    const flag = { pattern: 'bands', colors: ['#4a90e2', '#f2c14e', '#1b1d22'] };
    const w = {
        p: structuredClone(defaults), width: 1000, height: 600, terrain: null, time: 0,
        herbivores: pop(), carnivores: pop(), humans: pop(),
        tribeById: new Map([
            [1, { id: 1, name: 'Kamari', color: '#4a90e2', camp: { x: 100, y: 100 }, store: 120, flag, order: null }],
            [2, { id: 2, name: 'Urek', color: '#f2c14e', camp: { x: 700, y: 400 }, store: 40, flag, order: null }],
        ]),
        player: null, snapped: false, pose: null, events: [], sent: [],
        control(id, mode) {
            this.sent.push({ type: 'control', id, mode });
        },
        input() {},
        act(msg) {
            this.sent.push({ type: 'act', ...msg });
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
    w.add('humans', { id: 7, x: 100, y: 102 });
    w.add('humans', { id: 20, x: 700, y: 400, tribe: 2 });
    return w;
}

function play({ crosshair = null } = {}) {
    const world = fakeWorld();
    const state = { speed: 1, changed: 0 };
    const input = {
        mode: 'off', x: 0, y: 0, sprinting: false,
        setMode(m) {
            this.mode = m;
        },
        takeLook: () => ({ dx: 0, dy: 0 }),
        clear() {},
    };
    const hud = {
        notices: [], shown: null,
        show() {}, banner() {}, flash() {}, summary() {}, hideSummary() {}, clear() {},
        update(s) {
            this.shown = { ...s };
        },
        notice(text, refused) {
            this.notices.push([text, refused]);
        },
    };
    const modes = new Modes({
        world, input, hud,
        rig: () => null,
        follow() {},
        followed: () => 0,
        setView() {},
        setSpeed: (s) => {
            state.speed = s;
        },
        getSpeed: () => state.speed,
        setPaused() {},
        getPaused: () => false,
        inBody() {},
        openPicker() {},
        changed: () => {
            state.changed++;
        },
        crosshair: () => crosshair,
    });
    const calls = () => world.sent.filter((m) => m.type === 'act' && m.action === 'call').map(({ kind, x, y }) => [kind, x, y]);
    return { world, input, hud, modes, calls };
}

test('↑ cycles the calls, round', () => {
    const c = new Calls();
    assert.deepEqual(CALLS.map((k) => k.kind), ['rally', 'hunt', 'gather', 'defend', 'move', 'wood', 'flint']);
    assert.equal(c.call.kind, 'rally');
    const seen = [];
    for (let k = 0; k < CALLS.length; k++) seen.push(c.cycle().kind);
    assert.deepEqual(seen, ['hunt', 'gather', 'defend', 'move', 'wood', 'flint', 'rally']);
    // Without items, Gather wood and flint are passed by.
    const bare = [];
    for (let k = 0; k < 5; k++) bare.push(c.cycle(false).kind);
    assert.deepEqual(bare, ['hunt', 'gather', 'defend', 'move', 'rally']);

    const { modes } = play();
    modes.become(7);
    modes.action('cycle-call');
    modes.action('cycle-call');
    assert.equal(modes.calls.call.kind, 'gather');
});

test('G gives the call at the crosshair, or where you stand', () => {
    const { modes, calls } = play({ crosshair: { x: 300, y: 250 } });
    modes.become(7);
    modes.action('call');
    assert.deepEqual(calls(), [['rally', 100, 102]], 'a rally is where you are');
    modes.action('cycle-call');
    modes.action('call');
    assert.deepEqual(calls().at(-1), ['hunt', 300, 250], 'an order goes where you look');

    const sky = play({ crosshair: null });
    sky.modes.become(7);
    sky.modes.calls.select('defend');
    sky.modes.action('call');
    assert.deepEqual(sky.calls(), [['defend', 100, 102]], 'looking at the sky: where you stand');
});

test("the tribe's answers become notices; others' are not yours", () => {
    const { world, hud, modes } = play();
    modes.become(7);
    world.events = [
        { type: 'call', tribe: 1, kind: 'hunt', x: 1, y: 2, time: 5 },
        { type: 'refused', tribe: 2, kind: 'move', reason: 'site', time: 5 },
        { type: 'rally', tribe: 1, count: 4, time: 5 },
        { type: 'refused', tribe: 1, kind: 'rally', reason: 'spirit', time: 5 },
    ];
    modes.after(1 / 60);
    assert.deepEqual(hud.notices, [
        [noticeFor(world.events[0]), false],
        ['Rally — 4 follow you', false],
        ['Not enough Spirit to rally', true],
    ]);
    assert.equal(noticeFor({ type: 'rally', count: 1 }), 'Rally — one follows you');
    assert.equal(noticeFor({ type: 'call', kind: 'gather', hungry: true }), 'Gather food — once the camp is fed');
    for (const reason of ['child', 'spirit', 'nobody', 'away', 'site', 'cooldown', 'unreachable', 'unknown']) {
        assert.ok(noticeFor({ type: 'refused', kind: 'move', reason }).length > 4, reason);
    }
});

test("the order's bearing and the call reach the HUD", () => {
    const { world, hud, modes } = play();
    modes.become(7);
    modes.action('cycle-call');
    modes.drawHud(1 / 60);
    assert.equal(hud.shown.order, null);
    assert.equal(hud.shown.call.kind, 'hunt');
    world.tribeById.get(1).order = { kind: 'hunt', x: 100, y: 300 };
    modes.drawHud(1 / 60);
    assert.ok(Math.abs(hud.shown.order - Math.PI / 2) < 1e-9, 'due south (+y) of you');
});

test('G is heard on the map; the arrows are the camera there', () => {
    const target = new EventTarget();
    const canvas = new EventTarget();
    const doc = new EventTarget();
    const input = new Input({ target, canvas, doc, now: () => 0 });
    const actions = [];
    input.onAction = (name) => actions.push(name);
    input.setMode('map');
    for (const code of ['KeyG', 'ArrowUp', 'KeyM']) {
        const e = new Event('keydown', { cancelable: true });
        Object.assign(e, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false });
        target.dispatchEvent(e);
    }
    assert.deepEqual(actions, ['call', 'map']);
});

test('on the map, an armed call is given where you click, once', () => {
    const { modes, calls, world } = play();
    modes.become(7);
    world.player = { id: 7, x: 100, y: 102, heading: 0 };
    modes.after(1 / 60);
    modes.action('map');
    assert.equal(modes.callAt(10, 20), false, 'nothing armed: a click only picks');
    modes.armCall('move');
    assert.equal(modes.calls.armed, 'move');
    assert.equal(modes.callAt(10, 20), true);
    assert.deepEqual(calls(), [['move', 10, 20]]);
    assert.equal(modes.calls.armed, null);
    assert.equal(modes.callAt(30, 40), false, 'once');

    modes.armCall('defend');
    assert.deepEqual(calls().at(-1), ['defend', 100, 100], 'about the camp: given at once');
    assert.equal(modes.calls.armed, null);

    modes.calls.select('hunt');
    modes.action('call'); // G on the map: arms the call in the slot...
    assert.equal(modes.calls.armed, modes.calls.call.kind);
    modes.action('call'); // ...and again, lets it go
    assert.equal(modes.calls.armed, null);
    modes.armCall('move');
    modes.armCall('move');
    assert.equal(modes.calls.armed, null, 'the same button twice: let go');
    modes.armCall('hunt');
    modes.action('map'); // back in your body
    assert.equal(modes.calls.armed, null, 'in a body nothing is armed');
});

test('letting go, or the end of the game, disarms a call: map clicks pick again', () => {
    for (const end of ['stop', 'gameOver']) {
        const { modes } = play();
        modes.become(7);
        modes.action('map');
        modes.armCall('hunt');
        assert.equal(modes.calls.armed, 'hunt');
        modes[end]();
        assert.equal(modes.calls.armed, null, end);
    }
});

test('a rally cannot be armed on the map', () => {
    const { modes } = play();
    modes.become(7);
    modes.action('map');
    modes.armCall('rally');
    assert.equal(modes.calls.armed, 'hunt');
    assert.equal(modes.calls.call.kind, 'hunt', 'the slot shows what is armed');
});
