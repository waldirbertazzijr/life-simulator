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
// who you are and what happens to you. play/env.js wires play to this page
// (and makes window.play).
//
// Saving (panel/saves.js; the simulation's side is save.js): the panel's
// save button or P in a body opens the save menu; the autosave comes at
// dawn, when the tab is hidden or closed, and after a succession; "continue"
// is offered when an autosave waits. A save keeps the page's own state too
// (record), and loading one puts it back (resume).
import { params } from './config.js';
import { Renderer } from './render.js';
import { Panel } from './ui.js';
import { Mirror } from './mirror.js';
import { localHost } from './sim.js';
import { Input } from './play/input.js';
import { Hud } from './play/hud.js';
import { Modes } from './play/modes.js';
import { modesEnv, windowPlay } from './play/env.js';
import { SIGHT_PX } from './play/aim.js';
import { CraftMenu } from './play/craft.js';
import { Console } from './play/console.js';
import { Editor } from './play/editor.js';
import { setAside } from './orders.js';
import { SaveStore } from './save-store.js';
import { Saves, looksOf, putLooks } from './panel/saves.js';
import { Home } from './home/home.js';
import { HintStore, Hints } from './home/hints.js';
import { Cinema } from './view3d/cinema.js';
import { personName } from './play/names.js';

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
// Which game this is: each new world is a new one; a loaded save carries on
// its own (the autosave keeps another game's one game back: panel/saves.js).
let run = '';
const newRun = () => `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
// You can play in the 3D view, on anything but a touch-only device (desktop
// first: touch controls are for later). (A headless browser has no pointer
// at all, and may play.)
const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
const canPlay = !!renderer.rig && !touchOnly;
// The home screen (home/home.js) greets the page, unless `?oversee` (straight
// to the God view, as automation wants) or `?poses` (a dev aid).
const skipHome = query.has('oversee') || query.has('poses');
// First steps in a body (home/hints.js), remembered by this browser.
const hintStore = new HintStore(storage());
const hints = new Hints(hintStore);

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

// Who a loaded world follows (its own `watch`): on the page only, since the
// simulation follows it already.
function adopt(id) {
    const found = id ? world.find(id) : null;
    followId = id;
    followKind = found?.kind ?? 'herbivore';
    panel.showFollow(world, followId, found);
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
    // How your person looks (the character editor).
    look() {
        page.editLook(modes.self);
    },
    // A call to your tribe from the map (play/calls.js): ready it, then click.
    armCall(kind) {
        modes.armCall(kind);
    },
    setBlood,
    saves() {
        saves.toggle(false);
    },
});
panel.setBlood(blood);
renderer.setBlood?.(blood);

const input = new Input({ target: window, canvas, doc: document });
const hud = new Hud(document);
hud.menu = new CraftMenu(document);
// The page as play sees it (play/env.js turns it into modes.js's env, and
// window.play).
const page = {
    world, renderer, canvas, panel, input, hud,
    follow,
    followed: () => followId,
    setView,
    setSpeed,
    getSpeed: () => speed,
    setPaused,
    getPaused: () => paused,
    changed: () => showPlay(),
    editLook(id, heir = false) {
        if (!editor) return;
        if (editor.isOpen && editor.id === id && !heir) editor.close();
        else editor.open(id, heir);
    },
    pauseMenu: () => saves.toggle(true),
    succession: () => saves.succession(),
    hints,
    beginLife: () => home.beginLife(),
};
const modes = new Modes(modesEnv(page));

// The character editor (play/editor.js; the 3D view only): L, the panel's
// "look", or your heir's line. Its choices are kept per person (view3d/looks.js).
const editor = renderer.looks ? new Editor({
    doc: document, win: window, input, world, looks: renderer.looks,
    preview: (canvas) => renderer.preview(canvas),
}) : null;
page.editor = editor;

// The admin console (play/console.js; the commands run in the simulation,
// admin.js): ` or F2, or the panel's button. A kill goes for the lock-on, or
// whoever is under the crosshair in a body.
const terminal = new Console({
    doc: document, win: window, input, modes,
    send: (msg) => world.host.send(msg),
    start,
    target: () => modes.lock || (modes.inBody ? modes.env.aimed(SIGHT_PX, (id) => id === modes.self) : 0),
    params: () => world.p,
    events: () => world.events,
    save: (slot) => saves.save(slot),
    load: (slot) => saves.load(slot),
});

// Saving and loading (panel/saves.js; the simulation's side is save.js): the
// menu (the panel's save button, P in a body), the autosave, and "continue".
const saves = new Saves({
    world, store: new SaveStore(), input, doc: document, win: window,
    record,
    resume,
    playing: () => !!modes.self,
    getPaused: () => paused,
    setPaused,
    quiet: () => home.isOpen, // (the world behind the title is nobody's game)
    closed: () => home.refresh(),
});

// The home screen (home/home.js): the title over the living world, Begin a
// life, Oversee, Load, Settings and Credits; and the mark that comes back
// to it. Its camera (view3d/cinema.js) steers the map's.
const cinema = renderer.rig ? new Cinema(renderer.rig) : null;
const home = new Home({
    doc: document, win: window, world, saves, editor, cinema, input,
    canPlay,
    why: renderer.rig ? 'it needs a keyboard and a mouse' : 'it needs the 3D view',
    settings: [
        {
            id: 'hints', label: 'Hints', options: [['on', 'On'], ['off', 'Off']],
            get: () => (hintStore.on ? 'on' : 'off'), set: (v) => hintStore.setOn(v === 'on'),
            again: () => hintStore.again(), againShown: () => hintStore.seen.size > 0, againLabel: 'show them all again',
        },
        { id: 'blood', label: 'Blood', options: [['on', 'On'], ['off', 'Off']], get: () => (blood ? 'on' : 'off'), set: (v) => setBlood(v === 'on') },
        // GRAPHICS (connect at merge): the High/Medium/Low setting (view3d/graphics.js) goes here, e.g.
        // { id: 'graphics', label: 'Graphics', options: QUALITIES.map((q) => [q, q[0].toUpperCase() + q.slice(1)]), get: getQuality, set: setQuality },
    ],
    // Into the chosen person's body, in Play mode.
    life(tribeId, id) {
        if (!modes.startPlay(tribeId, id)) return false;
        input.lock(); // (the click or key that began it lets the pointer be locked)
        return true;
    },
    oversee() {
        setView('map');
    },
    // Home from a life: let go of it, and a fresh world dawns behind the title.
    leave(hadLife) {
        modes.stop();
        if (hadLife) start(Math.floor(Math.random() * 1e6));
    },
    playing: () => !!modes.self && !modes.over,
    name: () => personName(modes.self),
    // On the home screen: no panel, nobody followed, the map's camera, the world at 1×.
    shown(on) {
        document.body.classList.toggle('home', on);
        panel.suspend(on);
        if (!on) return;
        unfollow();
        setSpeed(1);
        setPaused(false);
    },
    setPaused,
    getPaused: () => paused,
});

// What the page keeps with a save, besides the world: which game it is,
// the speed, the view (who is followed is the world's own `watch`), who you
// are (modes.js), the map camera, the looks chosen in this world (the
// character editor) and the sparklines.
function record() {
    const rig = renderer.rig;
    return {
        run, speed, view: renderer.mode,
        modes: modes.snapshot(),
        admin: terminal.marked !== null && terminal.marked === modes.story,
        camera: rig?.map ? { ...rig.map } : null,
        looks: looksOf(storage(), world.seed),
        sparks: panel.sparks(),
    };
}

// Carry on from a kept save ({data, page}, panel/saves.js): the world is
// built (here and in the simulation: mirror.js load), then the page is put
// back as it was. Throws a SaveError, changing nothing, if it cannot be.
function resume(kept) {
    const page = kept.page ?? {};
    world.load(kept.data);
    home.resumed();
    run = typeof page.run === 'string' ? page.run : newRun();
    putLooks(storage(), world.seed, page.looks);
    if (renderer.looks) renderer.looks.kept = renderer.looks.load(); // (attach lets go of the looks drawn so far)
    editor?.close();
    renderer.attach(world);
    panel.reset(world);
    panel.restoreSparks(page.sparks);
    modes.reset();
    adopt(world.watch);
    modes.resume(page.modes, world.player);
    if (page.admin) terminal.marked = modes.story;
    if (!modes.inBody) setView(['map', 'follow', 'first'].includes(page.view) ? page.view : 'map');
    if (page.camera && renderer.rig?.map) Object.assign(renderer.rig.map, page.camera);
    setSpeed(Number.isFinite(page.speed) && page.speed > 0 ? page.speed : 1);
    setPaused(false);
    showPlay();
    keepSeed(world.seed);
}

function storage() {
    try {
        return localStorage;
    } catch {
        return null;
    }
}

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
        materials: world.p?.items?.enabled === true,
    });
}

// Sparkline samples, every 50 steps, come with the snapshots.
world.onSamples = (s) => {
    for (let k = 0; k < s.length; k += 4) panel.record(s[k], s[k + 1], s[k + 2], s[k + 3]);
};

function start(seed, p = params) {
    world.reset(p, seed, window.innerWidth / window.innerHeight);
    run = newRun();
    saves.newWorld();
    editor?.close();
    renderer.attach(world);
    panel.reset(world);
    modes.reset();
    unfollow();
    keepSeed(seed);
    home.newWorld();
}

// Keep ?seed= in the address, so reloading or sharing it gives this world
// (other flags, such as ?2d, stay as they were typed).
function keepSeed(seed) {
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
    terminal.frame();

    const target = followId ? world.find(followId) : null;
    home.frame(dt / 1000); // (the home screen's dawn and camera, before the camera moves)
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
        saves.tick(now); // (the dawn's autosave)
        lastUi = now;
    }
    mainMs += (performance.now() - t0 - mainMs) * 0.05;
    requestAnimationFrame(frame);
}

const seedParam = Number(query.get('seed'));
start(Number.isInteger(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e6));
setSpeed(speed);
setPaused(paused);
if (!skipHome) home.open('title', { cut: true });
window.addEventListener('resize', () => renderer.resize(world));
saves.start().then(() => home.refresh()); // (what is kept; "continue" if there is an autosave)
requestAnimationFrame(frame);

// For tinkering from the browser console:
//   sim.world        the world as drawn (a Mirror: the simulation's latest
//                    snapshot, positions blended; see mirror.js)
//   sim.follow(id)   follow anyone; sim.reset(seed), sim.pause(on), sim.speed(s)
//   sim.set('herbivore.speed', 0.7)   change a parameter in the running simulation
//   sim.params       the parameters a new world starts with (edits apply on reset;
//                    e.g. sim.params.world.area = 1600000, then sim.reset())
//   sim.frameMs      JavaScript time per frame spent drawing; sim.mainMs, all of it
//   sim.worker       whether the simulation runs in a Web Worker
//   sim.timing       how the snapshots flow (interpolation delay, size)
//   sim.run(steps)   test hook: step now; resolves to {time, counts, digest}
//   sim.console      the admin console: sim.console.run('give bow legendary'), .lines (its log)
//   sim.saves        saving and loading (panel/saves.js): sim.saves.save(1), .load(1), .open(), .last (timings)
//   sim.home         the home screen (home/home.js): sim.home.open('people'), .go('oversee'), .setFocus(k), .choose(), .back(), .begin()
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
    console: terminal,
    saves,
    home,
    renderer,
};

// And for playing from the console, or a headless browser: window.play
// (play/env.js lists what it offers).
window.play = windowPlay(page, modes);
