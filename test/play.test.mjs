// The page side of playing a person (src/play/): names, input, the body,
// modes and the HUD's arithmetic. No DOM here: events go through node's own
// EventTarget, and the world is a small fake with the Mirror's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personName, years, ageText, relation, YEAR } from '../src/play/names.js';
import { Input } from '../src/play/input.js';
import { Body } from '../src/play/body.js';
import { Mirror } from '../src/mirror.js';
import { localHost, Sim } from '../src/sim.js';
import { params as defaults } from '../src/config.js';
import { World } from '../src/world.js';
import { Modes, mostExperienced, pickHeir, lockTarget, DEATH_SECONDS } from '../src/play/modes.js';
import { TrailBar, bearing, stripX } from '../src/play/hud.js';

// ---- The HUD's arithmetic ----

test('a dropping bar leaves a trailing segment that catches up', () => {
    const bar = new TrailBar();
    bar.set(1, 0.016);
    bar.set(0.6, 0.016);
    assert.equal(bar.value, 0.6);
    assert.equal(bar.trail, 1, 'what was lost still shows');
    for (let k = 0; k < 4; k++) bar.set(0.6, 0.1);
    assert.equal(bar.trail, 1, 'for a moment');
    for (let k = 0; k < 20; k++) bar.set(0.6, 0.1);
    assert.equal(bar.trail, 0.6, 'then it catches up');
    bar.set(0.8, 0.016);
    assert.equal(bar.trail, 0.8, 'rising has no trail');
    // A slow drain (sprinting) keeps only a short trail.
    for (let k = 0; k < 60; k++) bar.set(0.8 - k * 0.0025, 1 / 60);
    assert.ok(bar.trail - bar.value < 0.05, `trail ${bar.trail - bar.value}`);
});

test('compass bearings: north is up the map (−y), east is +x', () => {
    assert.equal(bearing(-Math.PI / 2), 0);
    assert.equal(bearing(0), 90);
    assert.equal(bearing(Math.PI / 2), 180);
    assert.equal(bearing(Math.PI), 270);
    assert.equal(stripX(0, 0, 400, 180), 200, 'straight ahead is the middle');
    assert.equal(stripX(90, 0, 400, 180), 400);
    assert.ok(Math.abs(stripX(10, 350, 400, 180) - (200 + (20 / 180) * 400)) < 1e-9, 'across north');
    assert.equal(stripX(180, 0, 400, 180), null, 'behind is off the strip');
});

// ---- Names ----

test("a person's name depends only on its id", () => {
    assert.equal(personName(42), personName(42));
    assert.notEqual(personName(42), personName(43));
    assert.equal(typeof personName(1), 'string');
});

test('names are varied and pronounceable', () => {
    const names = Array.from({ length: 1000 }, (_, k) => personName(k + 1));
    assert.ok(new Set(names).size >= 980, `only ${new Set(names).size} distinct names in 1000`);
    for (const n of names) {
        assert.match(n, /^[A-Z][a-z]{2,9}$/, n);
        assert.doesNotMatch(n.toLowerCase(), /[aeiou]{3}|[^aeiou]{4}/, n);
    }
});

test('ages are in years of 150 steps', () => {
    assert.equal(YEAR, 150);
    assert.equal(years(900), 6);
    assert.equal(years(149), 0);
    assert.equal(ageText(100), 'under a year');
    assert.equal(ageText(150), '1 year');
    assert.equal(ageText(4000), '26 years');
});

test('relations by generations', () => {
    assert.equal(relation(1), 'child');
    assert.equal(relation(2), 'grandchild');
    assert.equal(relation(3), 'great-grandchild');
    assert.equal(relation(6), 'descendant');
    assert.equal(relation(0), null);
    assert.equal(relation(-1), null);
});

// ---- Input ----

// A window, a canvas and a document made of node's EventTargets; `clock.t`
// is the time in ms.
function hands({ lock = 'reject' } = {}) {
    const clock = { t: 0 };
    const target = new EventTarget();
    const canvas = new EventTarget();
    const doc = new EventTarget();
    doc.pointerLockElement = null;
    doc.hidden = false;
    doc.exitPointerLock = () => {
        doc.pointerLockElement = null;
        doc.dispatchEvent(new Event('pointerlockchange'));
    };
    canvas.requestPointerLock = {
        reject: () => Promise.reject(new Error('no pointer lock here')),
        throw: () => {
            throw new Error('no pointer lock here');
        },
        grant: () => {
            doc.pointerLockElement = canvas;
            doc.dispatchEvent(new Event('pointerlockchange'));
        },
    }[lock];
    const input = new Input({ target, canvas, doc, now: () => clock.t });
    const actions = [];
    input.onAction = (name, info) => actions.push(info ? [name, info] : name);
    const fire = (on, type, props = {}, from = null) => {
        const e = new Event(type, { cancelable: true });
        Object.assign(e, { code: '', key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, props);
        if (from) Object.defineProperty(e, 'target', { value: from });
        on.dispatchEvent(e);
        return e;
    };
    const key = (type, code, props, from) => fire(target, type, { code, ...props }, from);
    return { clock, target, canvas, doc, input, actions, fire, key };
}

test('a tap rolls on release, a hold sprints', () => {
    const { clock, input, actions, key } = hands();
    input.setMode('body');
    key('keydown', 'Space');
    clock.t = 120;
    assert.equal(input.sprinting, false);
    key('keyup', 'Space');
    assert.deepEqual(actions, ['roll']);
    clock.t = 1000;
    key('keydown', 'Space');
    clock.t = 1300;
    key('keydown', 'Space', { repeat: true });
    assert.equal(input.sprinting, true);
    key('keyup', 'Space');
    assert.equal(input.sprinting, false);
    assert.deepEqual(actions, ['roll'], 'a hold does not roll');
});

test('WASD are axes relative to the look; other keys are actions', () => {
    const { input, actions, key } = hands();
    input.setMode('body');
    key('keydown', 'KeyW');
    key('keydown', 'KeyD');
    assert.equal(input.y, 1);
    assert.equal(input.x, 1);
    key('keyup', 'KeyW');
    assert.equal(input.y, 0);
    for (const code of ['KeyX', 'KeyQ', 'KeyE', 'KeyV', 'KeyM', 'KeyP', 'KeyR', 'ArrowUp']) key('keydown', code);
    key('keydown', 'KeyX', { repeat: true });
    assert.deepEqual(actions, ['move', 'move', 'crouch', 'lock', 'interact', 'view', 'map', 'pause', 'eat', 'cycle-call']);
});

test('input ignores keys typed into a text field', () => {
    const { input, actions, key } = hands();
    const field = { tagName: 'INPUT' };
    input.setMode('body');
    key('keydown', 'KeyW', {}, field);
    key('keydown', 'KeyM', {}, field);
    key('keydown', 'Space', {}, field);
    key('keyup', 'Space', {}, field);
    assert.equal(input.y, 0);
    assert.deepEqual(actions, []);
    input.setMode('map');
    key('keydown', 'KeyM', {}, field);
    assert.deepEqual(actions, []);
});

test('disabled input ignores keys', () => {
    const { input, actions, key, fire, canvas } = hands();
    const e = key('keydown', 'KeyW');
    key('keydown', 'KeyM');
    fire(canvas, 'pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fire(canvas, 'pointermove', { pointerId: 1, clientX: 50, clientY: 0 });
    assert.equal(input.y, 0);
    assert.deepEqual(actions, []);
    assert.equal(e.defaultPrevented, false, 'the page keeps its keys');
    assert.deepEqual(input.takeLook(), { dx: 0, dy: 0 });
});

test('on the map only M is heard', () => {
    const { input, actions, key } = hands();
    input.setMode('map');
    key('keydown', 'KeyV');
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    key('keyup', 'Space');
    key('keydown', 'KeyM');
    assert.deepEqual(actions, ['map']);
    assert.equal(input.y, 0);
});

test('blur drops held keys and does not roll', () => {
    const { clock, input, actions, key, target, doc } = hands();
    input.setMode('body');
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    target.dispatchEvent(new Event('blur'));
    clock.t = 100;
    key('keyup', 'Space');
    assert.equal(input.y, 0);
    assert.deepEqual(actions, ['move']);
    key('keydown', 'KeyA');
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(input.x, 0, 'a hidden tab drops them too');
});

test('pointer lock failing falls back to dragging', async () => {
    for (const lock of ['reject', 'throw', undefined]) {
        const { input, fire, canvas, doc } = hands({ lock });
        input.setMode('body');
        assert.doesNotThrow(() => input.lock());
        fire(canvas, 'pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
        fire(canvas, 'pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
        fire(doc, 'pointerup', { button: 0, pointerId: 1 });
        fire(canvas, 'pointermove', { pointerId: 1, clientX: 90, clientY: 0 });
        await new Promise((r) => setTimeout(r, 0)); // (a rejected promise must be caught)
        assert.equal(input.locked, false);
        assert.deepEqual(input.takeLook(), { dx: 30, dy: -10 });
        assert.deepEqual(input.takeLook(), { dx: 0, dy: 0 });
    }
});

test('with the pointer locked, the mouse looks and a click attacks', () => {
    const { clock, input, actions, fire, canvas, doc } = hands({ lock: 'grant' });
    input.setMode('body');
    input.lock();
    assert.equal(input.locked, true);
    fire(doc, 'mousemove', { movementX: 7, movementY: -3 });
    assert.deepEqual(input.takeLook(), { dx: 7, dy: -3 });
    fire(canvas, 'pointerdown', { button: 0, pointerId: 1 });
    fire(doc, 'pointerup', { button: 0, pointerId: 1 });
    fire(canvas, 'pointerdown', { button: 0, pointerId: 1 });
    clock.t = 600;
    fire(doc, 'pointerup', { button: 0, pointerId: 1 });
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1, shiftKey: true });
    assert.deepEqual(actions, [['attack', { heavy: false }], ['attack', { heavy: true }], 'art']);
    input.setMode('off');
    assert.equal(doc.pointerLockElement, null, 'leaving the body frees the pointer');
});

// ---- The body ----

// A body on open ground (or `blocked`), 1000 × 600, a person of top speed 0.7.
function bodyAt(x = 100, y = 100, heading = 0, blocked = null) {
    const body = new Body();
    body.reset(x, y, heading);
    const env = {
        terrain: blocked ? { blocked } : null, W: 1000, H: 600,
        top: 0.7, cruise: 0.6, crouchSpeed: 0.35, rollSpeed: 1.2, rollSteps: 5, paused: false, still: false, face: 'move',
    };
    const run = (seconds, ctl, frame = 0.1) => {
        for (let t = 0; t < seconds - 1e-9; t += frame) body.update(frame, { x: 0, y: 0, sprint: false, ...ctl }, env);
    };
    return { body, env, run };
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('walk, sprint and crouch speeds', () => {
    // One second at 1× is 15 steps.
    let { body, run } = bodyAt();
    run(1, { y: 1 });
    assert.ok(near(body.x - 100, 15 * 0.6 * 0.7), `walked ${body.x - 100}`);
    assert.ok(near(body.y, 100));
    ({ body, run } = bodyAt());
    run(1, { y: 1, sprint: true });
    assert.ok(near(body.x - 100, 15 * 0.7), `sprinted ${body.x - 100}`);
    ({ body, run } = bodyAt());
    body.crouch = true;
    run(1, { y: 1 });
    assert.ok(near(body.x - 100, 15 * 0.35 * 0.7), `crept ${body.x - 100}`);
    ({ body, run } = bodyAt());
    body.yaw = Math.PI / 2; // looking +y: D (right) is −x
    run(1, { x: 1, y: 1 });
    assert.ok(near(Math.hypot(body.x - 100, body.y - 100), 15 * 0.42), 'diagonals are not faster');
    assert.ok(body.x < 100 && body.y > 100);
});

test('sprinting spends stamina, which comes back after half a second', () => {
    const { body, run } = bodyAt();
    run(2, { y: 1, sprint: true });
    assert.ok(near(body.stamina, 100 - 30), `stamina ${body.stamina}`);
    run(0.4, {});
    assert.ok(near(body.stamina, 70), 'nothing back before half a second');
    run(0.6, {});
    assert.ok(body.stamina > 80 && body.stamina < 100, `stamina ${body.stamina}`);
    run(3, {});
    assert.equal(body.stamina, 100);
});

test('a roll bursts six units and costs 20', () => {
    const { body, env, run } = bodyAt(100, 100, Math.PI);
    assert.equal(body.roll({ x: 0, y: 0 }, env), true);
    assert.equal(body.stamina, 80);
    assert.equal(body.roll({ x: 0, y: 0 }, env), false, 'not twice at once');
    assert.ok(body.rolling);
    run(0.5, {});
    assert.ok(near(body.x, 94) && near(body.y, 100), `rolled to ${body.x}, ${body.y}`);
    assert.ok(!body.rolling);
    // With a key held, it rolls that way.
    body.yaw = 0;
    body.roll({ x: 1, y: 0 }, env);
    run(0.5, {});
    assert.ok(near(body.y, 106) && near(body.x, 94), `rolled to ${body.x}, ${body.y}`);
});

test('no sprint or roll at zero stamina', () => {
    const { body, env, run } = bodyAt();
    body.spend(100); // (just spent: none comes back for half a second)
    assert.equal(body.roll({ x: 0, y: 0 }, env), false);
    run(0.2, { y: 1, sprint: true });
    assert.ok(near(body.x - 100, 3 * 0.42), 'walks instead');
    body.stamina = 5;
    assert.equal(body.roll({ x: 0, y: 0 }, env), true, 'any stamina left will do');
    assert.equal(body.stamina, 0);
});

test('the body slides along water instead of entering it', () => {
    const water = (x, y) => y > 110;
    let { body, run } = bodyAt(100, 109.5, 0, water);
    body.yaw = Math.PI / 4; // toward the shore at 45°
    run(2, { y: 1 });
    assert.ok(body.y <= 110, `in the water at ${body.y}`);
    assert.ok(body.x > 105, `slid along the shore to ${body.x}`);
    ({ body, run } = bodyAt(100, 109.5, 0, water));
    body.yaw = Math.PI / 2; // straight at it
    run(2, { y: 1 });
    assert.ok(body.y <= 110 && Math.abs(body.x - 100) < 1, 'stops (give or take a short step aside)');
});

test('paused, the body does not move or spend', () => {
    const { body, env, run } = bodyAt();
    body.stamina = 50;
    env.paused = true;
    run(1, { y: 1, sprint: true });
    assert.equal(body.x, 100);
    assert.equal(body.stamina, 50);
    assert.equal(body.roll({ x: 0, y: 0 }, env), false);
});

test('a long frame moves the body at most a tenth of a second', () => {
    const { body, env } = bodyAt();
    body.update(5, { x: 0, y: 1, sprint: false }, env);
    assert.ok(near(body.x - 100, 1.5 * 0.42), `moved ${body.x - 100}`);
});

test("snap jumps to the simulation's position", () => {
    const { body, env } = bodyAt();
    body.roll({ x: 0, y: 0 }, env);
    body.snap(500, 300);
    assert.equal(body.x, 500);
    assert.equal(body.y, 300);
    assert.ok(!body.rolling);
});

test('one input per frame, only when something changed', () => {
    const { body, run } = bodyAt();
    const first = body.message();
    assert.ok(first && first.seq > 0);
    assert.deepEqual(Object.keys(first).sort(), ['crouch', 'heading', 'seq', 'speed', 'x', 'y']);
    assert.equal(body.message(), null);
    run(0.1, { y: 1 });
    const moving = body.message();
    assert.ok(moving.seq > first.seq && moving.speed > 0 && moving.x > 100);
    run(0.1, {});
    const stopped = body.message();
    assert.equal(stopped.speed, 0, 'stopping is said once');
    assert.equal(body.message(), null);
    body.crouch = true;
    assert.equal(body.message().crouch, true);
    assert.ok(body.nextSeq() > stopped.seq, 'acts share the numbering');
});

test("walking across the world's edge wraps", () => {
    const { body, run } = bodyAt(999.5, 599.8, 0);
    run(0.2, { y: 1 });
    assert.ok(body.x >= 0 && body.x < 1, `x ${body.x}`);
    body.yaw = Math.PI / 2;
    run(0.2, { y: 1 });
    assert.ok(body.y >= 0 && body.y < 2, `y ${body.y}`);
});

// ---- The mirror ----

test('the mirror draws the controlled body where the page has it', async () => {
    const host = localHost();
    const mirror = new Mirror(host);
    const types = [];
    const send = host.send;
    host.send = (msg) => {
        types.push(msg.type);
        send(msg);
    };
    mirror.reset(structuredClone(defaults), 3, 1.6);
    const id = mirror.humans.id[0];
    const at = () => {
        const i = [...mirror.humans.id.subarray(0, mirror.humans.n)].indexOf(id);
        return [mirror.humans.x[i], mirror.humans.y[i], mirror.humans.heading[i]];
    };
    const [x0, y0] = at();
    mirror.pose = { id, x: 5, y: 6, heading: 1 };
    mirror.update(performance.now(), 16);
    assert.deepEqual(at(), [5, 6, 1]);
    mirror.pose = null;
    mirror.update(performance.now(), 16);
    assert.deepEqual(at().slice(0, 2), [x0, y0], 'let go, it is drawn where the snapshot has it');

    assert.equal(mirror.player, null);
    mirror.control(id, 'god');
    mirror.update(performance.now(), 16); // (asks for a snapshot)
    assert.equal(mirror.player.id, id, 'the simulation reports on the person');
    assert.equal(mirror.snapped, false);
    // A teleport: refused, and the page is told to jump back.
    mirror.input({ seq: 1, x: x0 + 200, y: y0, heading: 0, speed: 0.4, crouch: false });
    mirror.act({ seq: 2, action: 'roll' });
    assert.deepEqual(types.filter((t) => ['control', 'input', 'act'].includes(t)), ['control', 'input', 'act']);
    await mirror.run(1);
    mirror.update(performance.now(), 16);
    assert.equal(mirror.player.id, id);
    assert.equal(mirror.snapped, true);

    mirror.reset(structuredClone(defaults), 4, 1.6);
    assert.equal(mirror.player, null, 'a new world forgets the player');
    assert.equal(mirror.pose, null);
    assert.equal(mirror.snapped, false);
});

// ---- Modes ----

// A world with the Mirror's shape: populations of plain arrays, two tribes
// (camps at (100, 100) and (700, 400)), and the messages it was sent.
const COLS = ['x', 'y', 'heading', 'id', 'age', 'energy', 'speedGene', 'generation', 'children', 'kills', 'tribe', 'carry', 'parent'];
function fakeWorld() {
    const pop = () => Object.fromEntries([['n', 0], ...COLS.map((c) => [c, []])]);
    const flag = { pattern: 'bands', colors: ['#4a90e2', '#f2c14e', '#1b1d22'] };
    const w = {
        p: structuredClone(defaults), width: 1000, height: 600, terrain: null, time: 0,
        herbivores: pop(), carnivores: pop(), humans: pop(),
        tribeById: new Map([
            [1, { id: 1, name: 'Kamari', camp: { x: 100, y: 100 }, store: 120, flag, aggression: 0.3, sociality: 0.6 }],
            [2, { id: 2, name: 'Urek', camp: { x: 700, y: 400 }, store: 40, flag, aggression: 0.8, sociality: 0.2 }],
        ]),
        player: null, snapped: false, pose: null, events: [], sent: [],
        control(id, mode) {
            this.sent.push(['control', id, mode]);
        },
        input(msg) {
            this.sent.push(['input', msg.x, msg.y, msg.seq]);
        },
        act(msg) {
            this.sent.push(['act', msg.action, msg.on]);
        },
        find(id) {
            return World.prototype.find.call(this, id);
        },
        // (The Mirror knows this only for the followed one; here, anyone's.)
        descendant(id) {
            const h = this.humans;
            for (let i = 0; i < h.n; i++) if (h.parent[i] === id) return h.id[i];
            return 0;
        },
        add(kind, props) {
            const p = this[kind];
            const row = { x: 0, y: 0, heading: 0, age: 2000, energy: 100, speedGene: 1, generation: 0, children: 0, kills: 0, tribe: 1, carry: 0, parent: 0, ...props };
            for (const c of COLS) p[c][p.n] = row[c];
            p.n++;
            return row.id;
        },
        remove(id) {
            const h = this.humans;
            const i = h.id.indexOf(id);
            for (const c of COLS) h[c].splice(i, 1);
            h.n--;
        },
    };
    return w;
}

function play() {
    const world = fakeWorld();
    const state = { speed: 4, paused: false, view: 'map', followed: 0, inBody: false, picker: 0 };
    const input = {
        mode: 'off', x: 0, y: 0, sprinting: false,
        setMode(m) {
            this.mode = m;
        },
        takeLook: () => ({ dx: 0, dy: 0 }),
        clear() {},
        lock() {},
    };
    const hud = {
        shown: false, banners: [], flashes: 0, story: null, actions: null,
        show(on) {
            this.shown = on;
        },
        banner(kind, text) {
            this.banners.push(text ? [kind, text] : kind);
        },
        flash() {
            this.flashes++;
        },
        summary(story, actions) {
            this.story = story;
            this.actions = actions;
        },
        hideSummary() {
            this.story = null;
        },
        clear() {
            this.banners = [];
            this.story = null;
        },
        update() {},
    };
    const modes = new Modes({
        world, input, hud,
        rig: () => null,
        follow: (id) => {
            state.followed = id;
        },
        followed: () => state.followed,
        setView: (v) => {
            state.view = v;
        },
        setSpeed: (s) => {
            state.speed = s;
        },
        getSpeed: () => state.speed,
        setPaused: (p) => {
            state.paused = p;
        },
        getPaused: () => state.paused,
        inBody: (on) => {
            state.inBody = on;
        },
        openPicker: () => {
            state.picker++;
        },
        changed: () => {},
    });
    // Ana (7), at camp, with a child Tiko (11); Oren (8), an elder of the
    // same tribe; Sefa (20), alone in the other tribe.
    world.add('humans', { id: 7, x: 100, y: 102, generation: 2, kills: 3, age: 3000 });
    world.add('humans', { id: 8, x: 300, y: 300, generation: 1, kills: 1, age: 5000 });
    world.add('humans', { id: 11, x: 400, y: 120, generation: 3, age: 1200, parent: 7 });
    world.add('humans', { id: 20, x: 700, y: 400, tribe: 2, age: 1000 });
    const controls = () => world.sent.filter((m) => m[0] === 'control');
    const frame = (dt = 1 / 60) => {
        modes.move(dt);
        modes.after(dt);
        world.events = [];
    };
    return { world, state, input, hud, modes, controls, frame };
}

test('becoming someone takes control at 1×', () => {
    const { world, state, input, hud, modes, frame } = play();
    assert.equal(modes.become(7), true);
    assert.deepEqual(world.sent, [['control', 7, 'god']]);
    assert.equal(state.speed, 1);
    assert.equal(state.view, 'shoulder');
    assert.equal(state.followed, 7);
    assert.ok(state.inBody && hud.shown && input.mode === 'body');
    input.y = 1;
    frame();
    assert.equal(world.pose.id, 7);
    assert.ok(world.pose.x !== 100 || world.pose.y !== 102, 'the body moves');
    assert.equal(world.sent.at(-1)[0], 'input');
    assert.equal(world.sent.at(-1)[3], 1, 'a new body numbers its inputs from 1');
    assert.equal(modes.become(99), false, 'nobody by that id');
});

test('the map puts your person on autopilot and restores the speed; M comes back', () => {
    const { world, state, input, hud, modes, controls, frame } = play();
    modes.become(7);
    world.player = { id: 7, x: 100, y: 102, heading: 0 };
    frame();
    modes.action('map');
    assert.deepEqual(world.sent.at(-1), ['act', 'auto', true], 'on the map the AI walks it');
    assert.equal(controls().length, 1, 'still yours: not let go');
    assert.equal(state.speed, 4);
    assert.equal(state.view, 'map');
    assert.equal(world.pose, null);
    assert.ok(!state.inBody && !hud.shown && input.mode === 'map');
    assert.equal(modes.self, 7);
    state.speed = 64;
    world.player = { id: 7, x: 150, y: 160, heading: 2, auto: true }; // (it walked on)
    frame();
    assert.equal(world.pose, null, 'drawn where the simulation has it');
    modes.action('map');
    assert.deepEqual(world.sent.at(-1), ['act', 'auto', false]);
    assert.equal(controls().length, 1);
    assert.equal(state.speed, 1);
    assert.equal(state.view, 'shoulder');
    frame();
    assert.deepEqual([world.pose.x, world.pose.y], [150, 160], 'back where the simulation has it');
    modes.action('map');
    assert.equal(state.speed, 64, 'the map keeps the speed it had');
});

test('before the simulation has your person, M takes control again', () => {
    const { modes, controls } = play();
    modes.become(7);
    modes.action('map');
    modes.action('map');
    assert.deepEqual(controls(), [['control', 7, 'god'], ['control', 7, 'god']]);
    modes.stop();
    assert.deepEqual(controls().at(-1), ['control', 0, 'god'], 'quitting lets go');
    assert.equal(modes.self, 0);
});

test('in Play only your tribe can be become', () => {
    const { modes, controls } = play();
    assert.equal(modes.canBecome(20), true, 'God: anyone');
    assert.equal(modes.startPlay(1), true);
    assert.equal(modes.game, 'play');
    assert.deepEqual(controls().at(-1), ['control', 7, 'play']);
    assert.equal(modes.canBecome(20), false);
    assert.equal(modes.become(20), false);
    assert.equal(modes.canBecome(8), true);
    assert.equal(modes.canBecome(7), false, 'yourself: that is Return');
});

test('Play starts as the most experienced adult', () => {
    const world = fakeWorld();
    world.add('humans', { id: 1, kills: 2, age: 2000 });
    world.add('humans', { id: 2, kills: 5, age: 1500 });
    world.add('humans', { id: 3, kills: 5, age: 3000 });
    world.add('humans', { id: 4, kills: 9, age: 400 }); // a child
    world.add('humans', { id: 5, kills: 9, age: 4000, tribe: 2 });
    assert.equal(mostExperienced(world, 1), 3);
    assert.equal(mostExperienced(world, 2), 5);
    assert.equal(mostExperienced(world, 3), 0);
});

test('resting runs 16× until a move key', () => {
    const { world, state, modes, frame } = play();
    modes.become(7);
    modes.action('interact');
    assert.equal(modes.resting, true);
    assert.deepEqual(world.sent.at(-1), ['act', 'rest', true]);
    assert.equal(state.speed, 16);
    frame();
    assert.equal(world.pose.x, 100, 'sitting still');
    modes.action('move');
    assert.equal(modes.resting, false);
    assert.deepEqual(world.sent.at(-1), ['act', 'rest', false]);
    assert.equal(state.speed, 1);
    modes.action('interact');
    modes.action('interact');
    assert.equal(modes.resting, false, 'E stands you up too');
    modes.become(8); // far from camp
    modes.action('interact');
    assert.equal(modes.resting, false);
});

test('a bite stands you up and flashes', () => {
    const { world, state, hud, modes, frame } = play();
    modes.become(7);
    modes.action('interact');
    world.events = [{ type: 'bite', id: 7, by: 500, damage: 60 }];
    modes.after(1 / 60);
    assert.equal(hud.flashes, 1);
    assert.equal(modes.resting, false);
    assert.equal(state.speed, 1);
    world.events = [{ type: 'bite', id: 8, by: 500, damage: 60 }];
    frame();
    assert.equal(hud.flashes, 1, "someone else's bite is not yours");
});

test("the simulation's heir is taken after the banner", () => {
    const { world, hud, modes, controls, frame } = play();
    modes.become(7);
    world.player = { id: 7, spirit: 100 };
    frame();
    world.remove(7);
    world.events = [{ type: 'death', kind: 'human', id: 7, x: 100, y: 102 }, { type: 'heir', from: 7, to: 11 }];
    world.player = { id: 11, snap: true, heir: 11, x: 400, y: 120, heading: 0 };
    frame();
    assert.deepEqual(hud.banners, ['died']);
    assert.equal(modes.self, 7, 'not before the banner');
    frame(DEATH_SECONDS);
    assert.equal(modes.self, 11);
    assert.match(hud.banners[1][1], new RegExp(`^Your line continues — ${personName(11)}`));
    assert.equal(controls().length, 1, 'the simulation already has the heir');
    frame();
    assert.equal(world.pose.id, 11);
    assert.ok(Math.abs(world.pose.x - 400) < 1, 'the body is the heir’s');
    assert.equal(world.sent.filter((m) => m[0] === 'input').at(-1)[3], 1, 'numbered afresh');
});

test('without the simulation, the page picks the heir', () => {
    const { world, hud, modes, controls, frame } = play();
    modes.become(7);
    world.remove(7);
    world.events = [{ type: 'death', kind: 'human', id: 7, x: 100, y: 102 }];
    frame();
    frame(DEATH_SECONDS);
    assert.equal(modes.self, 11);
    assert.deepEqual(controls().at(-1), ['control', 11, 'god']);
    assert.equal(hud.banners[1][1], `Your line continues — ${personName(11)}, child of ${personName(7)}`);
    // No descendants: the tribe's eldest.
    assert.deepEqual(pickHeir(world, { id: 11, tribe: 1, generation: 3 }), { id: 8, gap: 0 });
});

test('a death on the map is carried on there', () => {
    const { world, state, modes, controls, frame } = play();
    modes.become(7);
    modes.action('map');
    world.remove(7);
    world.events = [{ type: 'death', kind: 'human', id: 7 }];
    frame();
    frame(DEATH_SECONDS);
    assert.equal(modes.self, 11);
    assert.equal(state.view, 'map');
    assert.equal(controls().length, 1, 'nobody is taken over on the map');
    modes.action('map');
    assert.deepEqual(controls().at(-1), ['control', 11, 'god']);
});

test("on the map, the simulation's heir carries on", () => {
    const { world, state, hud, modes, controls, frame } = play();
    modes.become(7);
    world.player = { id: 7, x: 100, y: 102, heading: 0 };
    frame();
    modes.action('map');
    world.remove(7);
    world.events = [{ type: 'death', kind: 'human', id: 7 }, { type: 'heir', from: 7, to: 11 }];
    world.player = { id: 11, auto: true, x: 400, y: 120, heading: 0 };
    frame();
    frame(DEATH_SECONDS);
    assert.equal(modes.self, 11);
    assert.equal(state.view, 'map');
    assert.equal(hud.banners[0], 'died');
    modes.action('map');
    assert.deepEqual(world.sent.at(-1), ['act', 'auto', false], 'it is ours already, on autopilot');
    assert.equal(controls().length, 1);
});

test('God mode with nobody left returns to the map', () => {
    const { world, state, modes, frame } = play();
    modes.become(20);
    world.player = { id: 20 };
    frame();
    world.remove(20);
    world.events = [{ type: 'death', kind: 'human', id: 20 }, { type: 'released', reason: 'no heir' }];
    frame();
    frame(DEATH_SECONDS);
    assert.equal(modes.self, 0);
    assert.equal(modes.inBody, false);
    assert.equal(state.view, 'map');
    assert.equal(state.speed, 4);
});

test('Play with nobody left is over, with the story', () => {
    const { world, state, hud, modes, frame } = play();
    modes.startPlay(2);
    frame();
    world.remove(20);
    world.events = [{ type: 'death', kind: 'human', id: 20 }, { type: 'over' }];
    frame();
    frame(DEATH_SECONDS);
    assert.ok(hud.story, 'the summary card');
    const { people, generations, years: lived, kills, children, line } = hud.story;
    assert.deepEqual({ people, generations, lived, kills, children, line }, { people: 1, generations: 1, lived: 6, kills: 0, children: 0, line: [personName(20)] });
    assert.equal(hud.banners.at(-1), 'ended');
    assert.equal(modes.self, 0);
    assert.equal(state.inBody, false);
    assert.equal(state.speed, 4);
    hud.actions.again();
    assert.equal(state.picker, 1, 'Play again opens the tribes');
    assert.equal(modes.game, 'god');
});

test('a new world forgets the body', () => {
    const { world, state, input, hud, modes } = play();
    modes.become(7);
    modes.action('interact');
    modes.reset();
    assert.equal(modes.self, 0);
    assert.equal(modes.inBody, false);
    assert.equal(modes.resting, false);
    assert.equal(state.speed, 4, 'the map speed is back');
    assert.ok(!state.inBody && !hud.shown && input.mode === 'off');
    assert.equal(world.pose, null);
    assert.equal(modes.game, 'god');
});

test('starting and snapping back where the simulation has the body; no input while paused', () => {
    const { world, state, input, modes, frame } = play();
    modes.become(7);
    frame();
    world.player = { id: 7, x: 103, y: 104, heading: 1 };
    frame();
    assert.deepEqual([world.pose.x, world.pose.y, world.pose.heading], [103, 104, 1], 'its first report places the body');
    frame();
    assert.deepEqual([world.pose.x, world.pose.y], [103, 104], 'only once');
    world.snapped = true;
    world.player = { id: 7, x: 130, y: 140, heading: 1 };
    frame();
    assert.equal(world.snapped, false);
    assert.deepEqual([world.pose.x, world.pose.y], [130, 140]);
    modes.action('pause');
    assert.equal(state.paused, true);
    input.y = 1;
    const n = world.sent.length;
    frame();
    assert.equal(world.sent.length, n, 'paused, nothing moves');
});

test('lock-on picks the nearest creature in view', () => {
    const world = fakeWorld();
    world.add('herbivores', { id: 1, x: 130, y: 100 });            // ahead, 30
    world.add('herbivores', { id: 2, x: 80, y: 100 });             // behind, 20
    world.add('carnivores', { id: 3, x: 115, y: 125 });            // 59° off, 29
    world.add('humans', { id: 4, x: 200, y: 100 });                // ahead, 100: too far
    world.add('humans', { id: 5, x: 125, y: 110 });                // 22° off, 27: nearest in view
    assert.equal(lockTarget(world, 100, 100, 0, 9), 5);
    assert.equal(lockTarget(world, 100, 100, 0, 5), 1, 'never yourself');
    assert.equal(lockTarget(world, 100, 100, -Math.PI / 2, 9), 0, 'nothing that way');
    const { modes } = play();
    modes.become(7);
    modes.world.add('herbivores', { id: 50, x: 100, y: 120 });
    modes.body.yaw = Math.PI / 2;
    modes.action('lock');
    assert.equal(modes.lock, 50);
    modes.action('lock');
    assert.equal(modes.lock, 0);
});

// ---- With the simulation (player.js), as the page runs it ----

// The page's modes over a real simulation on this thread (as ?noworker, the
// Sim within reach): 60 frames a second, a step every fourth, as at 1×.
function together(seed = 5) {
    const host = { local: true, onmessage: null, send: (msg) => sim.handle(msg) };
    const sim = new Sim((msg) => host.onmessage(msg));
    const world = new Mirror(host);
    world.reset(structuredClone(defaults), seed, 1.6);
    const state = { speed: 4 };
    const input = {
        mode: 'off', x: 0, y: 0, sprinting: false,
        setMode(m) {
            this.mode = m;
        },
        takeLook: () => ({ dx: 0, dy: 0 }),
        clear() {},
    };
    const hud = {
        banners: [],
        banner(kind, text) {
            this.banners.push(text ?? kind);
        },
        show() {}, flash() {}, summary() {}, hideSummary() {}, clear() {}, update() {},
    };
    const modes = new Modes({
        world, input, hud,
        rig: () => null,
        follow: (id) => world.follow(id),
        followed: () => world.watch,
        setView() {},
        setSpeed: (s) => {
            state.speed = s;
        },
        getSpeed: () => state.speed,
        setPaused() {},
        getPaused: () => false,
        inBody() {},
        openPicker() {},
        changed() {},
    });
    let now = performance.now();
    let k = 0;
    const frames = async (n) => {
        for (let j = 0; j < n; j++, k++) {
            now += 1000 / 60;
            modes.move(1 / 60);
            if (k % 4 === 3) await world.run(1);
            world.update(now, 1000 / 60);
            modes.after(1 / 60);
        }
    };
    world.update(now, 16);
    return { sim, world, input, hud, modes, frames };
}

test('dying in a body: YOU DIED, then the heir the simulation chose', async () => {
    const { sim, world, input, hud, modes, frames } = together(5);
    modes.startPlay(world.tribes[0].id);
    await frames(8);
    const first = modes.self;
    // Starve them: no food at hand, none in store (tribe-mates bring some
    // home within a step now and then: again until it takes).
    for (let tries = 0; tries < 10 && !hud.banners.length; tries++) {
        const f = sim.world.find(first);
        if (f) {
            sim.world.tribeById.get(f.pop.tribe[f.i]).store = 0;
            f.pop.carry[f.i] = 0;
            f.pop.energy[f.i] = 1e-6;
        }
        await frames(4);
    }
    await frames(4);
    assert.deepEqual(hud.banners, ['died']);
    assert.equal(modes.self, first, 'the banner first');
    const heir = sim.world.player?.id;
    assert.ok(heir && heir !== first, 'the simulation has an heir');
    await frames(Math.ceil(DEATH_SECONDS * 60) + 8);
    assert.equal(modes.self, heir);
    assert.match(hud.banners[1], /^Your line continues — /);
    assert.equal(world.player.id, heir);
    input.y = 1;
    await frames(240);
    assert.equal(modes.stats.snaps, 0, 'the heir walks, every move taken');
    assert.ok(Math.hypot(world.player.x - modes.body.x, world.player.y - modes.body.y) < 2);
});

test('a minute in a body at 1×: the simulation takes every move', async () => {
    const { world, input, modes, frames } = together();
    assert.equal(modes.startPlay(world.tribes[0].id), true);
    await frames(4);
    assert.equal(world.player.id, modes.self, 'the simulation has the person');
    const start = [modes.body.x, modes.body.y];
    input.y = 1;
    for (let s = 0; s < 60; s++) {
        input.sprinting = s < 5;          // a sprint, until the stamina is gone
        if (s === 20) modes.action('roll');
        if (s % 10 === 0) modes.body.yaw += 1.3; // (turning now and then)
        await frames(60);
    }
    assert.equal(modes.stats.snaps, 0, 'no move turned down');
    const p = world.player;
    assert.ok(Math.hypot(p.x - modes.body.x, p.y - modes.body.y) < 2, 'the simulation has the body where the page has it');
    assert.ok(Math.hypot(start[0] - modes.body.x, start[1] - modes.body.y) > 20, 'and it went somewhere');
});

test('on the map the person walks on under the AI; coming back jumps to it', async () => {
    const { world, input, modes, frames } = together(6);
    modes.startPlay(world.tribes[0].id);
    await frames(8);
    input.y = 1;
    await frames(240);
    input.y = 0;
    const self = modes.self;
    modes.action('map');
    await frames(4);
    assert.equal(world.player.auto, true);
    assert.equal(world.pose, null, 'drawn where the simulation has it');
    const left = [world.player.x, world.player.y];
    await frames(1200); // (300 steps)
    assert.equal(modes.self, self);
    const p = world.player;
    assert.ok(Math.hypot(p.x - left[0], p.y - left[1]) > 1, 'the AI walked it');
    modes.action('map');
    await frames(8);
    assert.equal(world.player.auto, false);
    assert.ok(Math.hypot(world.player.x - modes.body.x, world.player.y - modes.body.y) < 0.5, 'the body is where the person is');
    assert.ok(modes.stats.snaps <= 1, 'one jump back at most (autopilot off)');
    const snaps = modes.stats.snaps;
    input.y = 1;
    await frames(240);
    assert.equal(modes.stats.snaps, snaps, 'then every move is taken again');
});
