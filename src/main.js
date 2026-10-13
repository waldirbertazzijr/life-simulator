// Entry point: the frame loop, speed/pause, who is followed, and which view
// draws it all (3D, or the flat canvas with `?2d`).
//
// The simulation runs in a Web Worker (sim-worker.js), so drawing never waits
// for stepping. What the views and the panel read here as `world` is a Mirror
// (mirror.js): the world as of the simulation's latest snapshots, with
// positions blended for the moment being drawn. `?noworker` (or a browser
// without module workers) runs the very same simulation code on this thread.
//
// Playing a person (play/): with a mouse and the 3D view, anyone's card
// offers "become them", and Play leads a tribe. In a body the play keys
// (play/input.js) move it (play/body.js), the camera looks over its shoulder
// or from its eyes, the HUD shows (play/hud.js), and play/modes.js keeps
// who you are and what happens to you.
import { params } from './config.js';
import { Renderer } from './render.js';
import { Panel } from './ui.js';
import { Mirror } from './mirror.js';
import { localHost } from './sim.js';
import { Input } from './play/input.js';
import { Hud } from './play/hud.js';
import { Modes } from './play/modes.js';
import { personName } from './play/names.js';
import { CraftMenu } from './play/craft.js';
import { setAside } from './orders.js';

const VIEWS = ['map', 'follow', 'first'];
const BLOOD_KEY = 'life-simulator.blood';

const query = new URLSearchParams(location.search);
const { renderer, canvas } = await createRenderer(document.getElementById('world'));
const world = new Mirror(createHost());
let frameMs = 0; // JavaScript time per frame spent drawing (smoothed)
let mainMs = 0;  // all JavaScript time per frame on this thread (smoothed)
let speed = 1;
let paused = false;
let followId = 0;
let followKind = 'herbivore';
// You can play in the 3D view, on anything but a touch-only device (desktop
// first: touch controls are for later). (A headless browser has no pointer
// at all, and may play.)
const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
const canPlay = !!renderer.rig && !touchOnly;

// A Web Worker running the simulation, or (?noworker) the same simulation here.
function createHost() {
    if (!query.has('noworker') && typeof Worker !== 'undefined') {
        try {
            const worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
            const host = { local: false, onmessage: null, send: (msg, transfer) => worker.postMessage(msg, transfer) };
            let heard = false;
            worker.onmessage = (e) => {
                heard = true;
                host.onmessage(e.data);
            };
            // A browser that cannot run module workers fails to load it: carry on here.
            worker.onerror = (e) => {
                if (heard) return; // (a later error shows in the console by itself)
                e.preventDefault();
                console.warn('The simulation worker could not start; running the simulation on the main thread.', e.message);
                worker.terminate();
                world.rehost(localHost());
                world.setSpeed(speed);
                world.setPaused(paused);
                start(world.seed);
            };
            return host;
        } catch (err) {
            console.warn('No module workers here; the simulation runs on the main thread.', err);
        }
    }
    return localHost();
}

function setView(view) {
    if (!followId) view = 'map';
    renderer.mode = view;
    panel.setView(view);
}

// Follow anyone (from the map, the camera comes down to them, unless
// `keepView`).
function follow(id, keepView = false) {
    const found = world.find(id);
    if (!found) return;
    followId = id;
    followKind = found.kind;
    world.follow(id);
    if (renderer.mode === 'map' && !keepView) setView('follow');
    panel.showFollow(world, followId, found);
}

function unfollow() {
    followId = 0;
    world.follow(0);
    setView('map');
    panel.showFollow(world, 0, null);
}

// A random living individual, preferably of the kind we were watching.
function randomAnimal(kind) {
    const pops = { herbivore: world.herbivores, carnivore: world.carnivores, human: world.humans };
    const from = pops[kind].n ? pops[kind] : world.herbivores;
    return from.n ? from.id[Math.floor(Math.random() * from.n)] : 0;
}

// A tribe's eldest adult (in stage 3, its leader).
function eldest(tribeId) {
    const pop = world.humans;
    let best = -1;
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] === tribeId && (best < 0 || pop.age[i] > pop.age[best])) best = i;
    }
    return best >= 0 ? pop.id[best] : 0;
}

function setPaused(p) {
    paused = p;
    world.setPaused(p);
    panel.setPaused(p);
}

function setSpeed(s) {
    speed = s;
    world.setSpeed(s);
    panel.setSpeed(s);
}

// Blood sprays and pools (the 3D view draws them): on unless turned off, as
// remembered by this browser, or `?noblood`.
let blood = !query.has('noblood');
if (blood) {
    try {
        blood = localStorage.getItem(BLOOD_KEY) !== 'off';
    } catch {
        // (no storage here: on)
    }
}
function setBlood(on) {
    blood = on;
    try {
        localStorage.setItem(BLOOD_KEY, on ? 'on' : 'off');
    } catch {
        // (no storage here: for this visit only)
    }
    renderer.setBlood?.(on);
    panel.setBlood(on);
}

const panel = new Panel({
    togglePause() {
        setPaused(!paused);
    },
    setSpeed,
    // The R key never starts a new world while you play someone: in a body
    // it means "eat", and a slip would wipe your game.
    reset(byKey = false) {
        if (byKey && modes.self) return;
        start(Math.floor(Math.random() * 1e6));
    },
    start,
    setView,
    cycleView() {
        if (followId) setView(VIEWS[(VIEWS.indexOf(renderer.mode) + 1) % VIEWS.length]);
    },
    unfollow,
    followDescendant() {
        const d = world.descendant(followId);
        if (d) follow(d);
    },
    followAnother() {
        const id = randomAnimal(followKind);
        if (id) follow(id);
    },
    followTribe(tribeId) {
        const id = eldest(tribeId);
        if (id) follow(id);
    },
    follow, // (a legend's bearer)
    // (Your own person's way back is the bar above the card: return.)
    becomeLabel(id) {
        return canPlay && modes.canBecome(id) ? 'become them' : null;
    },
    become(id) {
        if (modes.become(id)) input.lock(); // (this click is a user gesture: the pointer can be locked now)
    },
    openPicker() {
        panel.openPicker(world);
    },
    play(tribeId) {
        if (modes.startPlay(tribeId)) input.lock();
    },
    back() {
        if (modes.back()) input.lock();
    },
    stop() {
        modes.stop();
    },
    // A call to your tribe from the map (play/calls.js): ready it, then click.
    armCall(kind) {
        modes.armCall(kind);
    },
    setBlood,
});
panel.setBlood(blood);
renderer.setBlood?.(blood);

const input = new Input({ target: window, canvas, doc: document });
const hud = new Hud(document);
hud.menu = new CraftMenu(document);
const modes = new Modes({
    world, input, hud,
    rig: () => renderer.rig ?? null,
    follow,
    followed: () => followId,
    setView,
    setSpeed,
    getSpeed: () => speed,
    setPaused,
    getPaused: () => paused,
    inBody(on) {
        document.body.classList.toggle('in-body', on);
        panel.suspend(on);
        // The panel's buttons would otherwise keep the keyboard's focus.
        if (on && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    },
    openPicker: () => panel.openPicker(world),
    changed: () => showPlay(),
    // Poses on bodies (the 3D view's; the flat one has none).
    pose: (id, code, seconds) => renderer.pose?.(id, code, seconds),
    hold: (id, code) => renderer.hold?.(id, code),
    release: (id) => renderer.release?.(id),
    // Where a call goes in a body: the ground under the crosshair (the
    // middle of the view), or null for the sky.
    crosshair: () => renderer.groundAt?.(window.innerWidth / 2, window.innerHeight / 2) ?? null,
});

function showPlay() {
    const tribe = world.tribeById.get(modes.tribe) ?? null;
    panel.showPlay(world, {
        can: canPlay,
        self: modes.self,
        inBody: modes.inBody,
        tribe,
        playing: modes.game === 'play',
    });
    panel.showCalls({
        shown: canPlay && !!modes.self && !modes.inBody && !modes.over,
        armed: modes.calls.armed,
        order: tribe?.order ?? null,
        hungry: !!tribe && setAside(world.p, tribe),
    });
}

// Sparkline samples, every 50 steps, come with the snapshots.
world.onSamples = (s) => {
    for (let k = 0; k < s.length; k += 4) panel.record(s[k], s[k + 1], s[k + 2], s[k + 3]);
};

function start(seed) {
    world.reset(params, seed, window.innerWidth / window.innerHeight);
    renderer.attach(world);
    panel.reset(world);
    modes.reset();
    unfollow();
    // Keep ?seed= in the address, so reloading or sharing it gives this world
    // (other flags, such as ?2d, stay as they were typed).
    const rest = location.search.slice(1).split('&').filter((s) => s && !s.startsWith('seed='));
    history.replaceState(null, '', `${location.pathname}?${[`seed=${seed}`, ...rest].join('&')}${location.hash}`);
}

// The 3D view by default; `?2d` (or a browser without WebGL) gets the canvas
// renderer. Both offer attach / resize / updateCamera / draw / pick / mode.
async function createRenderer(canvas) {
    if (!query.has('2d')) {
        try {
            const { View3D } = await import('./view3d/scene.js');
            return { renderer: new View3D(canvas), canvas };
        } catch (err) {
            console.warn('3D view unavailable, using the 2D one:', err);
            // A canvas keeps the first kind of context it hands out, so start afresh.
            const fresh = canvas.cloneNode();
            canvas.replaceWith(fresh);
            canvas = fresh;
        }
    }
    return { renderer: new Renderer(canvas), canvas };
}

// Click (or tap) anyone to follow them. (In a body a click is the body's:
// it locks the pointer, or attacks.) With a call to your tribe armed on the
// map (play/calls.js), the click gives it there instead.
canvas.addEventListener('click', (e) => {
    if (modes.inBody) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (modes.calls.armed) {
        const at = renderer.groundAt?.(px, py);
        if (at) modes.callAt(at.x, at.y);
        return;
    }
    const id = renderer.pick(world, px, py);
    if (id) follow(id);
});

// Each frame: (with ?noworker, step the simulation here, by real elapsed time
// as before), move your body, bring the mirror up to this moment, see what
// happened to you, draw, and the HUD over it. The worker keeps its own
// fixed-timestep clock (sim.js), so a given speed looks the same at any frame
// rate. (A frame is at most 100 ms: a hidden tab coming back does not jump.)
let last = performance.now();
let lastUi = 0;
function frame(now) {
    const t0 = performance.now();
    const dt = Math.min(now - last, 100);
    last = now;
    world.host.tick?.(now);
    modes.move(dt / 1000);
    world.update(now, dt);
    modes.after(dt / 1000);

    const target = followId ? world.find(followId) : null;
    const t1 = performance.now();
    renderer.updateCamera(world, target, dt / 1000);
    if (modes.inBody) {
        // Your own body: no marker under it; from the eyes, not drawn at all.
        renderer.draw(world, renderer.mode === 'first' ? target : null, null, 0);
        modes.drawHud(dt / 1000);
    } else {
        const focusId = target ? target.pop.focus[target.i] : 0;
        const focus = focusId ? world.find(focusId) : null;
        const sense = target ? world.p[target.kind].sense * target.pop.senseGene[target.i] : 0;
        renderer.draw(world, target, focus, sense);
    }
    frameMs += (performance.now() - t1 - frameMs) * 0.05;

    if (now - lastUi > 250) {
        panel.update(world);
        panel.showFollow(world, followId, target);
        showPlay();
        lastUi = now;
    }
    mainMs += (performance.now() - t0 - mainMs) * 0.05;
    requestAnimationFrame(frame);
}

const seedParam = Number(query.get('seed'));
start(Number.isInteger(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e6));
setSpeed(speed);
setPaused(paused);
window.addEventListener('resize', () => renderer.resize(world));
requestAnimationFrame(frame);

// For tinkering from the browser console:
//   sim.world        the world as drawn (a Mirror: the simulation's latest
//                    snapshot, positions blended; see mirror.js)
//   sim.follow(id)   follow anyone; sim.reset(seed), sim.pause(on), sim.speed(s)
//   sim.set('herbivore.speed', 0.7)   change a parameter in the running simulation
//   sim.params       the parameters a new world starts with (edits apply on reset;
//                    with ?noworker, at once, as they share this object)
//   sim.frameMs      JavaScript time per frame spent drawing; sim.mainMs, all of it
//   sim.worker       whether the simulation runs in a Web Worker
//   sim.timing       how the snapshots flow (interpolation delay, size)
//   sim.run(steps)   test hook: step now; resolves to {time, counts, digest}
//   sim.renderer
window.sim = {
    get world() { return world; },
    follow,
    params,
    reset(seed) { start(seed ?? Math.floor(Math.random() * 1e6)); },
    pause(on = !paused) { setPaused(on); },
    speed: setSpeed,
    set: (path, value) => world.set(path, value),
    run: (steps) => world.run(steps),
    get frameMs() { return frameMs; },
    get mainMs() { return mainMs; },
    get worker() { return !world.host.local; },
    get timing() { return world.timing(); },
    renderer,
};

// And for playing from the console, or a headless browser (which cannot lock
// the pointer: it drags, or sets the look here):
//   play.become(id)      step into a person (default: the first one)
//   play.start(tribeId)  Play: lead a tribe (default: the biggest)
//   play.leave(), play.back(), play.stop()   to the map, back in, let go
//   play.picker()        Play's choice of tribes
//   play.view('first' | 'shoulder'), play.look(yaw, pitch)
//   play.hold(code, ms)  hold a key (e.g. 'KeyW') for ms; resolves when let go
//   play.press(code)     tap a key
//   play.attack({heavy, power})   left click (a headless browser has no pointer lock to click with)
//   play.banner(kind, text), play.over()   show a banner; end the line now
//   play.call(kind)      put a call in the slot (G gives it: play.press('KeyG'))
//   play.arm(kind), play.mapClick(x, y)    on the map: ready a call, and click
//                        the world point (x, y) through the view
//   play.cycle('weapon' | 'tool'), play.tool(), play.skill(), play.craft()
//                        → or ←, right click, Shift + right click, C (keys
//                        in the craft menu: play.press('ArrowDown'), ...)
//   play.state           who, where, stamina, snaps (moves turned down), the hands, the items...
//   play.modes
const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
window.play = {
    // (Only in the 3D view: the flat one has no over-the-shoulder camera.)
    become(id = world.humans.id[0]) {
        return !!renderer.rig && modes.become(id);
    },
    start(tribeId = [...world.tribes].sort((a, b) => b.members - a.members)[0]?.id) {
        return !!renderer.rig && modes.startPlay(tribeId);
    },
    leave: () => modes.leave(),
    back: () => modes.back(),
    stop: () => modes.stop(),
    picker: () => panel.openPicker(world),
    view(v) {
        if (modes.inBody && v !== modes.view) modes.action('view');
    },
    look(yaw, pitch) {
        modes.body.yaw = yaw;
        if (pitch !== undefined) modes.body.pitch = pitch;
    },
    hold(code, ms) {
        key('keydown', code);
        return new Promise((resolve) => setTimeout(() => {
            key('keyup', code);
            resolve();
        }, ms));
    },
    press(code) {
        key('keydown', code);
        key('keyup', code);
    },
    attack: (info = {}) => modes.action('attack', info),
    banner: (kind, text) => hud.banner(kind, text),
    over: () => modes.gameOver(),
    call: (kind) => modes.calls.select(kind),
    arm: (kind) => modes.armCall(kind),
    cycle: (slot = 'weapon') => modes.action(slot === 'tool' ? 'cycle-tool' : 'cycle-weapon'),
    tool: () => modes.action('tool'),
    skill: () => modes.action('skill'),
    craft: () => modes.action('craft'),
    mapClick(x, y) {
        const at = { x: 0, y: 0 };
        if (!renderer.rig?.project(x, y, world.terrain ? world.terrain.heightAt(x, y) : 0, at)) return false;
        const rect = canvas.getBoundingClientRect();
        canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + at.x, clientY: rect.top + at.y, bubbles: true }));
        return true;
    },
    get state() {
        const p = world.player;
        return {
            game: modes.game, self: modes.self, name: modes.self ? personName(modes.self) : null,
            inBody: modes.inBody, view: modes.view, mode: renderer.mode, resting: modes.resting, lock: modes.lock,
            stamina: Math.round(modes.body.stamina), x: +modes.body.x.toFixed(2), y: +modes.body.y.toFixed(2),
            snaps: modes.stats.snaps, placed: modes.stats.placed, speed, paused,
            call: modes.calls.call.kind, armed: modes.calls.armed,
            player: p ? { id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), auto: p.auto, spirit: +p.spirit.toFixed(1), resting: p.resting } : null,
            hands: p ? {
                carry: +p.carry.toFixed(1), energy: +p.energy.toFixed(1), reload: p.reload, gathering: p.gathering, butchering: p.butchering,
                doing: modes.doing?.kind ?? null, can: modes.interaction()?.kind ?? null,
            } : null,
            items: p && world.items ? {
                weapon: p.weapon, tool: p.tool, kit: p.kit, crafting: p.crafting, skill: p.skill,
                menu: modes.menu ? { ...modes.menu } : null, legends: world.legends?.length ?? 0,
            } : null,
        };
    },
    modes,
};
