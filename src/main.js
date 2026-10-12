// Entry point: the frame loop, speed/pause, who is followed, and which view
// draws it all (3D, or the flat canvas with `?2d`).
//
// The simulation runs in a Web Worker (sim-worker.js), so drawing never waits
// for stepping. What the views and the panel read here as `world` is a Mirror
// (mirror.js): the world as of the simulation's latest snapshots, with
// positions blended for the moment being drawn. `?noworker` (or a browser
// without module workers) runs the very same simulation code on this thread.
import { params } from './config.js';
import { Renderer } from './render.js';
import { Panel } from './ui.js';
import { Mirror } from './mirror.js';
import { localHost } from './sim.js';

const VIEWS = ['map', 'follow', 'first'];

const query = new URLSearchParams(location.search);
const { renderer, canvas } = await createRenderer(document.getElementById('world'));
const world = new Mirror(createHost());
let frameMs = 0; // JavaScript time per frame spent drawing (smoothed)
let mainMs = 0;  // all JavaScript time per frame on this thread (smoothed)
let speed = 1;
let paused = false;
let followId = 0;
let followKind = 'herbivore';

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

function follow(id) {
    const found = world.find(id);
    if (!found) return;
    followId = id;
    followKind = found.kind;
    world.follow(id);
    if (renderer.mode === 'map') setView('follow');
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

const panel = new Panel({
    togglePause() {
        setPaused(!paused);
    },
    setSpeed,
    reset() {
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
});

// Sparkline samples, every 50 steps, come with the snapshots.
world.onSamples = (s) => {
    for (let k = 0; k < s.length; k += 4) panel.record(s[k], s[k + 1], s[k + 2], s[k + 3]);
};

function start(seed) {
    world.reset(params, seed, window.innerWidth / window.innerHeight);
    renderer.attach(world);
    panel.reset(world);
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

// Click (or tap) anyone to follow them.
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const id = renderer.pick(world, e.clientX - rect.left, e.clientY - rect.top);
    if (id) follow(id);
});

// Each frame: (with ?noworker, step the simulation here, by real elapsed time
// as before), bring the mirror up to this moment, draw. The worker keeps its
// own fixed-timestep clock (sim.js), so a given speed looks the same at any
// frame rate.
let last = performance.now();
let lastUi = 0;
function frame(now) {
    const t0 = performance.now();
    const dt = Math.min(now - last, 100);
    last = now;
    world.host.tick?.(now);
    world.update(now, dt);

    const target = followId ? world.find(followId) : null;
    const focusId = target ? target.pop.focus[target.i] : 0;
    const focus = focusId ? world.find(focusId) : null;
    const sense = target ? world.p[target.kind].sense * target.pop.senseGene[target.i] : 0;
    const t1 = performance.now();
    renderer.updateCamera(world, target, dt / 1000);
    renderer.draw(world, target, focus, sense);
    frameMs += (performance.now() - t1 - frameMs) * 0.05;

    if (now - lastUi > 250) {
        panel.update(world);
        panel.showFollow(world, followId, target);
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
