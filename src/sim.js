// The simulation host: it owns the one real World, steps it on a fixed
// timestep, and packs snapshots of it for the main thread to draw. It runs in
// a Web Worker (sim-worker.js), or on the main thread with `?noworker`
// (localHost below). It is the same code either way, so a seed gives the same
// world either way.
//
// It talks in messages (plain objects), whichever thread it is on:
//
//   in   start {gen, seed, aspect, params}   a new world (gen counts worlds)
//        speed {speed}   pause {paused}
//        follow {id, seq}                    world.follow(id); seq counts follows
//        want {recycle}                      send the next snapshot, and here are
//                                            old snapshot buffers to reuse
//        set {path, value}                   change a parameter, e.g. 'herbivore.speed'
//        run {id, steps}                     test hook: step now, reply with a digest
//   out  started {gen, hash}                 the new world's first moment, hashed
//        snapshot {...}                      see pack() below; with `events`, everything that happened
//                                            since the last one (World.events, oldest first)
//        reply {id, value}
//
// Snapshots are pulled, not pushed: the main thread asks for one each frame
// it draws, and gets it as soon as the world has moved on. So they come at the
// display's rate, never pile up, and stop when the page is not drawing.
import { World } from './world.js';

// Steps per second at 1×: a calm pace, at which a person walks about six
// units (a little over a body length) a second and runs at ten. (It used to
// be 60, which is now 4×.)
export const STEPS_PER_SECOND = 15;
export const STEP_MS = 1000 / STEPS_PER_SECOND; // one step at 1×
const SAMPLE_EVERY = 50;          // steps between sparkline samples
export const FRAME_BUDGET_MS = 12; // ?noworker: most stepping per frame (the rest waits for the next)
const MAX_BEHIND_MS = 100;        // a backlog longer than this (real time) is dropped: the world runs slower
const MAX_EVENTS = 2000;          // events kept for the next snapshot at most (the oldest are let go)

export const KINDS = ['herbivore', 'carnivore', 'human'];

// What a snapshot carries of each individual: what is drawn (position,
// heading, id, age, tribe) and what the panel can show about anyone you click.
// Left behind: upkeep, parent, lineage, goal and timer, which only the
// simulation itself uses. After these columns comes `prev`: where the same
// individual was in the previous snapshot (its index there, or -1 for a
// newborn), so the main thread can blend between the two.
export const COLUMNS = [
    'x', 'y', 'heading', 'id', 'age', 'lifespan', 'energy', 'speedGene', 'senseGene',
    'generation', 'children', 'kills', 'focus', 'state', 'tribe', 'carry',
];
export const STRIDE = COLUMNS.length + 1; // values per individual, with prev

export class Sim {
    // post(message, transferList): how messages leave (postMessage in the worker).
    constructor(post) {
        this.post = post;
        this.world = null;
        this.gen = 0;
        this.speed = 1;
        this.paused = false;
        this.acc = 0;    // simulated milliseconds not yet stepped
        this.last = 0;   // when the clock last advanced (performance.now())
        this.due = 0;    // when the current state was due, by the fixed-timestep clock
        this.seq = 0;    // the last follow() seen
        this.wanted = false;
        this.dirty = false; // changed without a step (new world, follow): send it even if paused
        this.samples = [];
        this.events = []; // World.events from every step since the last snapshot
        this.packer = new Packer();
    }

    handle(msg) {
        switch (msg.type) {
            case 'start':
                this.start(msg);
                break;
            case 'speed':
                this.acc *= msg.speed / this.speed; // the same lag in real time, not a burst of steps
                this.speed = msg.speed;
                break;
            case 'pause':
                if (this.paused && !msg.paused) this.last = performance.now(); // no catching up on the pause
                this.paused = msg.paused;
                break;
            case 'follow':
                this.seq = msg.seq;
                if (this.world) this.world.follow(msg.id);
                this.dirty = true;
                break;
            case 'set':
                if (this.world) setParam(this.world.p, msg.path, msg.value);
                break;
            case 'want':
                this.packer.recycle(msg.recycle);
                this.wanted = true;
                break;
            case 'run':
                this.run(msg);
                break;
        }
        this.offer();
    }

    start({ gen, seed, aspect, params }) {
        this.world = new World(params, { seed, aspect });
        this.gen = gen;
        this.acc = 0;
        this.samples = [];
        this.events = [];
        this.packer.reset();
        this.dirty = true;
        this.last = performance.now(); // building the world is not time to catch up on
        this.due = this.last;
        this.post({ type: 'started', gen, hash: startHash(this.world) });
    }

    // Advance the world by the real time since the last tick: the same
    // fixed-timestep loop main.js used to run. A tick steps for at most
    // `budget` ms and leaves the rest for the next one; a backlog of more than
    // MAX_BEHIND_MS of real time is let go, so when the steps cost more than
    // real time allows, the world simply runs slower.
    tick(now, budget) {
        const dt = Math.min(now - this.last, MAX_BEHIND_MS);
        this.last = now;
        if (this.world && !this.paused) {
            this.acc = Math.min(this.acc + dt * this.speed, MAX_BEHIND_MS * this.speed + STEP_MS);
            const deadline = performance.now() + budget;
            let stepped = false;
            while (this.acc >= STEP_MS) {
                this.step();
                this.acc -= STEP_MS;
                stepped = true;
                if (performance.now() > deadline) break;
            }
            // The state now showing was due acc/speed ms ago (acc is how far
            // the clock has run ahead of it). These stamps let the main thread
            // draw each step at its own moment, however unevenly they arrive.
            if (stepped) this.due = Math.max(this.due, now - this.acc / this.speed);
        }
        this.offer();
    }

    // Milliseconds until the next step is due (Infinity: nothing to do).
    wait(now) {
        if (!this.world || this.paused) return Infinity;
        return this.last + (STEP_MS - this.acc) / this.speed - now;
    }

    step() {
        const w = this.world;
        w.step();
        if (w.time % SAMPLE_EVERY === 0) this.samples.push(w.grass.mean(), w.herbivores.n, w.carnivores.n, w.humans.n);
        if (w.events.length) {
            const ev = this.events;
            for (const e of w.events) ev.push(e);
            if (ev.length > MAX_EVENTS) ev.splice(0, ev.length - MAX_EVENTS);
        }
    }

    // Send a snapshot if one is wanted and there is something new in it.
    offer() {
        const w = this.world;
        if (!this.wanted || !w || (!this.dirty && w.time === this.packer.time)) return;
        this.wanted = false;
        this.dirty = false;
        const snap = this.packer.pack(w);
        snap.type = 'snapshot';
        snap.gen = this.gen;
        snap.seq = this.seq;
        snap.due = this.due;
        snap.sent = performance.now();
        snap.origin = performance.timeOrigin; // where this thread's clock starts (see Mirror.receive)
        // The followed animal: how it died, and a descendant to carry on with.
        snap.watch = w.watch;
        snap.fate = w.fate;
        snap.heir = w.fate && w.fate.id === w.watch ? w.descendant(w.watch) : 0;
        snap.samples = this.samples;
        this.samples = [];
        snap.events = this.events;
        this.events = [];
        this.post(snap, [snap.buffer]);
    }

    // Test hook: run `steps` steps right now and hash the result the way
    // tools/fingerprint.mjs does (counts every 100 steps, then everyone's
    // position and energy). From a fresh world with aspect 1.6 it prints the
    // same digest as `make fingerprint` for that seed.
    async run({ id, steps }) {
        const w = this.world;
        const enc = new TextEncoder();
        const parts = [];
        for (let k = 1; k <= steps; k++) {
            this.step();
            if (k % 100 === 0) parts.push(enc.encode(`${w.herbivores.n},${w.carnivores.n},${w.humans.n},${w.tribes.length};`));
        }
        for (const pop of [w.herbivores, w.carnivores, w.humans]) {
            for (const f of ['x', 'y', 'energy']) parts.push(new Uint8Array(pop[f].buffer.slice(0, pop.n * 8)));
        }
        this.acc = 0;
        this.last = performance.now();
        this.due = Math.max(this.due, this.last);
        this.dirty = true;
        this.offer();
        const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) {
            all.set(p, o);
            o += p.length;
        }
        const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const counts = `${w.herbivores.n}/${w.carnivores.n}/${w.humans.n}, ${w.tribes.length} tribes`;
        this.post({ type: 'reply', id, value: { time: w.time, counts, digest: hex.slice(0, 16) } });
    }
}

// Packs a World into a snapshot: one ArrayBuffer of float64, so it moves to
// the main thread without being copied. Layout: for each species in KINDS
// order, its COLUMNS then prev, each n values long; then the grass.
export class Packer {
    constructor() {
        // id → index, per species: in the last snapshot, and in the one before
        // it (a resend of the same moment keeps blending from the same one).
        this.maps = KINDS.map(() => ({ last: new Map(), before: new Map() }));
        this.described = new Set(); // tribes whose name, flag and camp were already sent
        this.free = [];             // buffers handed back, to reuse
        this.time = -1;             // the world time last packed
    }

    reset() {
        for (const m of this.maps) {
            m.last.clear();
            m.before.clear();
        }
        this.described.clear();
        this.time = -1;
    }

    recycle(buffers) {
        if (!buffers) return;
        for (const b of buffers) if (b.byteLength > 0 && this.free.length < 8) this.free.push(b);
    }

    take(bytes) {
        this.free = this.free.filter((b) => b.byteLength >= bytes); // outgrown ones are let go
        if (this.free.length) return this.free.pop();
        return new ArrayBuffer(Math.ceil((bytes * 1.25) / 8) * 8); // room to grow
    }

    pack(world) {
        const pops = [world.herbivores, world.carnivores, world.humans];
        const g = world.grass.g;
        let size = g.length;
        for (const pop of pops) size += pop.n * STRIDE;
        const buffer = this.take(size * 8);
        const f = new Float64Array(buffer, 0, size);
        const fresh = this.time < 0;            // the first of this world: nothing to blend from
        const moved = world.time !== this.time; // a new moment, not a resend of the last one
        const counts = [];
        let o = 0;
        for (let k = 0; k < pops.length; k++) {
            const pop = pops[k];
            const n = pop.n;
            counts.push(n);
            for (const c of COLUMNS) {
                f.set(pop[c].subarray(0, n), o);
                o += n;
            }
            const m = this.maps[k];
            if (moved) {
                const t = m.before;
                m.before = m.last;
                m.last = t;
                t.clear();
            }
            const { before, last } = m;
            const ids = pop.id;
            for (let i = 0; i < n; i++) {
                const j = before.get(ids[i]);
                f[o + i] = j === undefined ? -1 : j;
                if (moved) last.set(ids[i], i);
            }
            o += n;
        }
        f.set(g, o);
        this.time = world.time;

        // Tribes: what changes as numbers (id, members, adults, store, births);
        // the fallen as (id, when it ended); and, once each, the rest.
        const tribes = [];
        for (const t of world.tribes) tribes.push(t.id, t.members, t.adults, t.store, t.births);
        const fallen = [];
        for (const t of world.fallen) fallen.push(t.id, t.ended);
        const newTribes = [];
        for (const list of [world.tribes, world.fallen]) {
            for (const t of list) {
                if (this.described.has(t.id)) continue;
                this.described.add(t.id);
                newTribes.push({
                    id: t.id, name: t.name, color: t.color, flag: t.flag, camp: { x: t.camp.x, y: t.camp.y },
                    aggression: t.aggression, sociality: t.sociality, founded: t.founded,
                    parent: t.parent, generation: t.generation,
                });
            }
        }
        return { buffer, size, counts, grassLength: g.length, time: world.time, fresh, tribes, fallen, newTribes };
    }
}

// A hash of everything a new world starts with: its size, land, biomes,
// grass and first inhabitants. The main thread builds the same world to get
// the land and the grass grid without asking for them, and compares hashes to
// be sure it really is the same.
export function startHash(world) {
    let h = 0x811c9dc5; // FNV-1a, a byte at a time
    const bytes = (a) => {
        const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    };
    const { grass, terrain: T } = world;
    bytes(Float64Array.of(world.width, world.height, grass.cols, grass.rows, grass.land, grass.boost, T ? T.seaLevel : -1));
    if (T) bytes(T.height);
    if (T && T.biomeGrid) bytes(T.biomeGrid);
    if (grass.fertility) bytes(grass.fertility);
    bytes(grass.g);
    for (const pop of [world.herbivores, world.carnivores, world.humans]) {
        for (const f of ['x', 'y', 'energy', 'id']) bytes(pop[f].subarray(0, pop.n));
    }
    for (const t of world.tribes) bytes(Float64Array.of(t.id, t.camp.x, t.camp.y, t.aggression, t.sociality));
    return (h >>> 0).toString(16).padStart(8, '0');
}

// Set a parameter by its path, e.g. setParam(params, 'herbivore.speed', 0.7).
export function setParam(params, path, value) {
    const keys = path.split('.');
    let o = params;
    for (const k of keys.slice(0, -1)) o = o !== null && typeof o === 'object' ? o[k] : undefined;
    if (o === null || typeof o !== 'object' || !(keys.at(-1) in o)) throw new Error(`unknown parameter: ${path}`);
    o[keys.at(-1)] = value;
}

// `?noworker`: the same simulation on the main thread, stepped by the frame
// loop (tick) instead of a timer of its own, with the old 12 ms budget.
export function localHost() {
    const host = {
        local: true,
        onmessage: null,
        send(msg) {
            sim.handle(msg);
        },
        tick(now) {
            sim.tick(now, FRAME_BUDGET_MS);
        },
    };
    const sim = new Sim((msg) => host.onmessage(msg));
    return host;
}
