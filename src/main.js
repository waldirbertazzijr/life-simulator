// Entry point: owns the world, the frame loop, speed/pause and who is followed.
import { params } from './config.js';
import { World } from './world.js';
import { Renderer } from './render.js';
import { Panel } from './ui.js';

const STEPS_PER_SECOND = 60; // at 1×
const SAMPLE_EVERY = 50;     // steps between sparkline samples
const FRAME_BUDGET_MS = 12;  // max simulation time per frame before slowing down
const VIEWS = ['map', 'follow', 'first'];

const canvas = document.getElementById('world');
const renderer = new Renderer(canvas);
let world;
let speed = 1;
let paused = false;
let followId = 0;
let followKind = 'herbivore';

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

const panel = new Panel({
    togglePause() {
        paused = !paused;
        panel.setPaused(paused);
    },
    setSpeed(s) {
        speed = s;
        panel.setSpeed(s);
    },
    reset() {
        start(Math.floor(Math.random() * 1e6));
    },
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

function start(seed) {
    world = new World(params, { seed, aspect: window.innerWidth / window.innerHeight });
    renderer.attach(world);
    panel.reset(world);
    unfollow();
}

// Click (or tap) anyone to follow them.
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const p = renderer.screenToWorld(world, e.clientX - rect.left, e.clientY - rect.top);
    const reach = 16 / renderer.cam.scale; // 16 screen pixels
    let best = 0;
    let bestD2 = reach * reach;
    for (const pop of [world.herbivores, world.carnivores, world.humans]) {
        for (let i = 0; i < pop.n; i++) {
            let dx = Math.abs(pop.x[i] - p.x);
            let dy = Math.abs(pop.y[i] - p.y);
            dx = Math.min(dx, world.width - dx);
            dy = Math.min(dy, world.height - dy);
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = pop.id[i];
            }
        }
    }
    if (best) follow(best);
});

// Fixed-timestep loop: the simulation advances by real elapsed time, so a
// given speed looks the same at any frame rate. If a frame cannot keep up, it
// drops the backlog and the world simply runs slower instead of stuttering.
let last = performance.now();
let acc = 0;
let lastUi = 0;
function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (!paused) {
        acc += dt * speed;
        const stepMs = 1000 / STEPS_PER_SECOND;
        const deadline = performance.now() + FRAME_BUDGET_MS;
        while (acc >= stepMs) {
            world.step();
            acc -= stepMs;
            if (world.time % SAMPLE_EVERY === 0) panel.sample(world);
            if (performance.now() > deadline) {
                acc = 0;
                break;
            }
        }
    }

    const target = followId ? world.find(followId) : null;
    const focusId = target ? target.pop.focus[target.i] : 0;
    const focus = focusId ? world.find(focusId) : null;
    const sense = target ? world.p[target.kind].sense * target.pop.senseGene[target.i] : 0;
    renderer.updateCamera(world, target, dt / 1000);
    renderer.draw(world, target, focus, sense);

    if (now - lastUi > 250) {
        panel.update(world);
        panel.showFollow(world, followId, target);
        lastUi = now;
    }
    requestAnimationFrame(frame);
}

const seedParam = Number(new URLSearchParams(location.search).get('seed'));
start(Number.isInteger(seedParam) && seedParam > 0 ? seedParam : Math.floor(Math.random() * 1e6));
panel.setSpeed(speed);
panel.setPaused(paused);
window.addEventListener('resize', () => renderer.resize(world));
requestAnimationFrame(frame);

// For tinkering from the browser console: sim.world, sim.follow(id), sim.params.
window.sim = { get world() { return world; }, follow, params };
