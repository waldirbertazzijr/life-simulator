// The world as the main thread sees it: a stand-in for the World with the
// same shape the renderers and the panel read (herbivores, carnivores and
// humans with n, x, y, heading, energy, ...; grass.g; tribes, tribeById,
// fallen; time, seed, watch, fate; width, height, p, terrain; find(),
// meanGenes(), descendant(), kindOf(), follow()), filled from the snapshots
// the simulation sends (sim.js). It never steps.
//
// The one exception is the body you play (play/): the page moves it, so it
// is drawn where the page has it (`pose`), and the simulation, told by
// control(), input() and act(), follows and reports on it (`player`, and its
// spears in flight and kills: `spears`, `carcasses`).
//
// Items (items.js) come like tribes: each described once (and again when it
// changes), then only numbers. The Mirror keeps `items` (id → item), who
// holds what (`byBearer`), and the `legends`, newest first.
//
// The land never changes, so it is not sent at all: it is a pure function of
// the seed and the parameters, and reset() builds the same World here, keeps
// its terrain and grass grid, and checks it against the simulation's own
// (startHash). That World's first moment is also shown until the
// simulation's first snapshot arrives; it is the same moment.
//
// Interpolation. At 1× a step lasts four frames of a 60 Hz screen; at 64× a
// frame holds about 16 steps, give or take, as snapshots never arrive exactly
// on the beat. Drawn as they come, the world stands still and then jumps, or
// judders. So each snapshot carries the moment its state was due on the
// simulation's fixed-timestep clock, and every frame draws the world as it
// was `delay` ms ago, blended between the two snapshots around that moment:
// the same motion for the same time, at any speed. `delay` is just long
// enough that the next snapshot is nearly always in by the time it is needed
// (it adapts, see update()). Interpolation is display-only: positions and
// headings are blended into arrays of our own; the snapshots are untouched.
import { World } from './world.js';
import { Packer, KINDS, COLUMNS, TRIBE_STRIDE, ITEM_STRIDE, startHash, setParam } from './sim.js';
import { ORDER_KINDS } from './orders.js';
import { isWeapon } from './items.js';

const TAU = Math.PI * 2;
const MAX_KEPT = 32;   // snapshots kept at most (normally 2–5: until the moment drawn has passed them)
const SLACK_MS = 2;    // extra delay beyond the longest recent wait for a snapshot
const BLENDED = ['x', 'y', 'heading'];
const NO_EVENTS = Object.freeze([]);

// Shortest signed difference on a ring of size `size`.
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);

function emptyPopulation() {
    const pop = { n: 0 };
    for (const c of COLUMNS) pop[c] = new Float64Array(0);
    return pop;
}

// A tribe's standing order from a snapshot's numbers at `q` (code, x, y):
// {kind, x, y}, or null. The one it had is kept while it says the same.
function orderAt(numbers, q, had) {
    const kind = ORDER_KINDS[numbers[q]];
    if (!kind) return null;
    const x = numbers[q + 1];
    const y = numbers[q + 2];
    return had !== null && had.kind === kind && had.x === x && had.y === y ? had : { kind, x, y };
}

export class Mirror {
    // host: { send(message, transferList), onmessage, local, tick?(now) }:
    // a Web Worker running sim-worker.js, or sim.js's localHost().
    constructor(host) {
        this.rehost(host);

        // The World's shape.
        this.p = null;
        this.seed = 0;
        this.width = 0;
        this.height = 0;
        this.time = 0;
        this.terrain = null;
        this.grass = null;
        this.herbivores = emptyPopulation();
        this.carnivores = emptyPopulation();
        this.humans = emptyPopulation();
        this.tribes = [];
        this.tribeById = new Map();
        this.fallen = [];
        this.watch = 0;
        this.fate = null;
        this.heir = 0;          // a living descendant of the followed animal, once it is dead
        this.startCheck = '';   // 'same' once the simulation's world is known to match ours
        // What happened (World.events) at moments that came into view this
        // frame, oldest first: read it each frame, it is replaced by the next.
        this.events = NO_EVENTS;
        // The person you control (play/): the latest snapshot's `player`
        // (null: nobody), and whether any snapshot since `snapped` was last
        // cleared asked the page to jump its body to the simulation's.
        this.player = null;
        this.snapped = false;
        // The body you are in, as the page has moved it: {id, x, y, heading},
        // drawn there instead of where the snapshots have it. Null: nobody.
        this.pose = null;
        this.posed = false;     // the blended positions hold a pose
        // The player's spears and arrows in flight (six numbers each: x, y,
        // vx, vy, progress, kind: an ITEM_KINDS code), as of step `spearsAt`,
        // and the kills not yet butchered ([{id, kind, x, y, meat, cut, by}]):
        // the latest snapshot's (spears.js).
        this.spears = NO_EVENTS;
        this.spearsAt = 0;
        this.carcasses = NO_EVENTS;
        // Items (items.js), as of the snapshot shown: id → {id, kind, rarity,
        // trait, mult, maker, tribe, made, legend, bearer, x, y, wear (0..1),
        // kills}; who holds what (person id → {weapon, tool}, each an item or
        // undefined; for the player, what is in its hands, not its spares);
        // and the legends, newest first.
        this.items = new Map();
        this.byBearer = new Map();
        this.legends = [];
        this.itemInfo = new Map();  // every item described so far (the same objects as in items)
        this.goneItems = [];        // [time, ids] of snapshots received: descriptions to forget once shown
        this.legendsDirty = false;
        this.hands = [];            // spare {weapon, tool} objects for byBearer

        // Plumbing.
        this.pops = [this.herbivores, this.carnivores, this.humans];
        this.blended = KINDS.map(() => ({ x: new Float64Array(1024), y: new Float64Array(1024), heading: new Float64Array(1024) }));
        this.gen = 0;           // which world (snapshots from an older one are dropped)
        this.asked = 0;         // follow() calls so far: a snapshot's watch and fate count once it has seen the last one
        this.history = [];      // snapshots not yet drawn past, oldest first, each a different moment
        this.pending = [];      // events from snapshots, oldest first, until their moment is drawn
        this.spare = [];        // buffers of dropped snapshots, to hand back
        this.known = new Map(); // tribe id → tribe object (static fields sent once)
        this.base = null;       // the snapshot the populations and tribes currently show
        this.drawn = { a: null, b: null, alpha: -1 };
        this.shown = 0;         // the moment drawn, in steps
        this.delay = 30;        // ms: how far behind the simulation's clock we draw
        this.need = 0;          // ms: the longest a snapshot was recently waited for
        this.resync = true;     // the next gap between snapshots says nothing about timing (pause, new world)
        this.replies = new Map();
        this.nextReply = 1;
        this.onSamples = null;  // (flat [grass, herbivores, carnivores, humans, ...]) => void
        this.stats = { snapshots: 0, bytes: 0 };
    }

    // Talk to this simulation from now on (main.js switches to the main
    // thread if the worker cannot start; a reset() should follow).
    rehost(host) {
        this.host = host;
        host.onmessage = (msg) => this.receive(msg);
        this.waiting = false;   // a snapshot has been asked for and not yet received
        this.offset = host.local ? 0 : NaN; // simulation clock → ours, ms (worker: learnt from messages)
        this.trustOrigin = true;
    }

    // ---- The World's methods, for the panel and the renderers ----

    // Where is the individual with this id now? (The engine's own code.)
    find(id) {
        return World.prototype.find.call(this, id);
    }

    meanGenes(pop) {
        return World.prototype.meanGenes.call(this, pop);
    }

    kindOf(pop) {
        return World.prototype.kindOf.call(this, pop);
    }

    // A living descendant of the animal `id`, or 0. The simulation looks it up
    // (it alone has everyone's lineage) once the followed animal has died.
    descendant(id) {
        return id && id === this.watch ? this.heir : 0;
    }

    // Start following an animal (0: stop). The simulation records its fate
    // and tags its descendants; here, the card can switch at once.
    follow(id) {
        this.asked++;
        this.watch = id;
        this.fate = null;
        this.heir = 0;
        this.host.send({ type: 'follow', id, seq: this.asked });
    }

    // ---- Controls ----

    setSpeed(speed) {
        this.host.send({ type: 'speed', speed });
    }

    setPaused(paused) {
        if (!paused) this.resync = true;
        this.host.send({ type: 'pause', paused });
    }

    // Change a parameter in the running simulation, e.g. set('herbivore.speed', 0.7).
    // (Here too, for the page; a new world starts from sim.params again.)
    set(path, value) {
        setParam(this.p, path, value);
        this.host.send({ type: 'set', path, value });
    }

    // Take over the person `id` ('god' or 'play' mode; 0 lets go), and steer
    // it: the body's position and posture each frame, and one-off acts such
    // as a roll (play/modes.js takes over and moves the body; play/actions.js,
    // hands.js, kit.js and lead.js send the acts; the simulation side is
    // player.js, with acts/hands.js and acts/gear.js).
    control(id, mode) {
        this.host.send({ type: 'control', id, mode });
    }

    input(msg) {
        this.host.send({ type: 'input', ...msg });
    }

    act(msg) {
        this.host.send({ type: 'act', ...msg });
    }

    // Test hook: run `steps` steps at once in the simulation; resolves to
    // { time, counts, digest } (see Sim.run).
    run(steps) {
        const id = this.nextReply++;
        return new Promise((resolve) => {
            this.replies.set(id, resolve);
            this.host.send({ type: 'run', id, steps });
        });
    }

    // A new world. The land and the first moment are built here (the same
    // World the simulation builds); everything after comes in snapshots.
    reset(params, seed, aspect) {
        const world = new World(params, { seed, aspect });
        this.gen++;
        this.p = world.p; // (the numbers the world lives by: config.js)
        this.seed = seed;
        this.width = world.width;
        this.height = world.height;
        this.terrain = world.terrain;
        this.grass = world.grass; // its .g is swapped for each snapshot's grass
        this.hash = startHash(world);
        this.startCheck = 'pending';
        for (const s of this.history) this.spare.push(s.buffer);
        this.history = [];
        this.pending = [];
        this.events = NO_EVENTS;
        this.player = null;
        this.snapped = false;
        this.pose = null;
        this.posed = false;
        this.spears = NO_EVENTS;
        this.spearsAt = 0;
        this.carcasses = NO_EVENTS;
        this.items = new Map();
        this.byBearer = new Map();
        this.legends = [];
        this.itemInfo = new Map();
        this.goneItems = [];
        this.legendsDirty = false;
        this.base = null;
        this.known = new Map();
        this.watch = 0;
        this.fate = null;
        this.heir = 0;
        this.resync = true;
        const first = new Packer().pack(world);
        Object.assign(first, { gen: this.gen, seq: this.asked, due: NaN, watch: 0, fate: null, heir: 0, samples: [] });
        this.accept(first, performance.now());
        this.show(first);
        this.blend(null, first, 1);
        this.shown = 0;
        // (After the above: with ?noworker the answer can come back at once.)
        this.host.send({ type: 'start', gen: this.gen, seed, aspect, params });
    }

    // ---- Snapshots in ----

    receive(msg) {
        if (msg.type === 'reply') {
            this.replies.get(msg.id)?.(msg.value);
            this.replies.delete(msg.id);
            return;
        }
        if (msg.type === 'started') {
            if (msg.gen !== this.gen) return;
            this.startCheck = msg.hash === this.hash ? 'same' : 'DIFFERENT';
            if (msg.hash !== this.hash) console.error(`The simulation's world differs from the one drawn here (start hash ${msg.hash} vs ${this.hash}).`);
            return;
        }
        if (msg.type !== 'snapshot') return;
        const now = performance.now();
        this.waiting = false;
        if (!this.host.local) {
            // The worker's clock started when the worker did. Both clocks say
            // where they started (timeOrigin), so the offset between them is
            // known exactly. Should that ever disagree with the messages (one
            // arriving before it was sent), fall back on the messages: a
            // message takes a moment to arrive, never less than nothing, so
            // the smallest (arrival − sending) seen is the offset.
            const lag = now - msg.sent;
            const exact = msg.origin - performance.timeOrigin;
            if (this.trustOrigin && lag < exact - 1) this.trustOrigin = false;
            if (this.trustOrigin) this.offset = exact;
            else if (!(lag >= this.offset)) this.offset = lag;
        }
        if (msg.gen !== this.gen) {
            this.spare.push(msg.buffer); // from the world before a reset
            return;
        }
        this.accept(msg, now);
    }

    accept(snap, now) {
        this.stats.snapshots++;
        this.stats.bytes = snap.size * 8;
        // Views into the buffer: no copying.
        const f = new Float64Array(snap.buffer, 0, snap.size);
        let o = 0;
        snap.cols = snap.counts.map((n) => {
            const cols = {};
            for (const c of COLUMNS) {
                cols[c] = f.subarray(o, o + n);
                o += n;
            }
            cols.prev = f.subarray(o, o + n);
            o += n;
            return cols;
        });
        snap.g = f.subarray(o, o + snap.grassLength);
        for (const d of snap.newTribes) {
            this.known.set(d.id, { ...d, camp: { ...d.camp }, store: 0, members: 0, adults: 0, births: 0, alive: true, order: null, wood: 0, flint: 0, hide: 0 });
        }
        // Items described (again, when they change: a legend), and those gone.
        if (snap.newItems) {
            for (const d of snap.newItems) {
                const had = this.itemInfo.get(d.id);
                if (had) Object.assign(had, d);
                else this.itemInfo.set(d.id, { ...d, bearer: 0, x: 0, y: 0, wear: 1, kills: 0 });
                if (d.legend) this.legendsDirty = true;
            }
        }
        if (snap.goneItems?.length) this.goneItems.push(snap.time, snap.goneItems);
        if (snap.samples.length && this.onSamples) this.onSamples(snap.samples);
        if (snap.events?.length) {
            // Each comes into view with the step it happened in (World.events
            // are oldest first, and snapshots come in order).
            for (const e of snap.events) {
                if (!(e.time <= snap.time)) e.time = snap.time;
                this.pending.push(e);
            }
        }
        this.player = snap.player ?? null;
        if (this.player?.snap) this.snapped = true;
        this.spears = snap.spears ?? NO_EVENTS;
        this.spearsAt = snap.time;
        this.carcasses = snap.carcasses ?? NO_EVENTS;

        const hist = this.history;
        const latest = hist[hist.length - 1];
        if (snap.fresh) {
            // The simulation's first snapshot of this world: it replaces our own.
            for (const s of hist) this.spare.push(s.buffer);
            hist.length = 0;
            hist.push(snap);
            this.resync = true;
        } else if (latest && snap.time === latest.time) {
            // The same moment again (after follow()): same positions, newer fate.
            this.spare.push(latest.buffer);
            hist[hist.length - 1] = snap;
        } else {
            // How long the newest state had been due when the next one came:
            // to always have the next snapshot in hand, we must draw at least
            // that far behind. (A gap of half a second is not timing but the
            // page coming back from the background.)
            const gap = now - this.offset - latest?.due;
            if (gap < 500 && !this.resync) this.need = Math.max(this.need, gap);
            this.resync = false;
            hist.push(snap);
            if (hist.length > MAX_KEPT) this.spare.push(hist.shift().buffer);
        }
    }

    // ---- Each frame ----

    // Pick the moment to draw, show the snapshot around it with positions
    // blended, and ask for the next snapshot. `now` and `dt` in ms.
    update(now, dt) {
        const hist = this.history;
        if (hist.length) {
            let a = null;
            let b = hist[hist.length - 1];
            let alpha = 1;
            if (hist.length > 1 && this.offset === this.offset) {
                // Let `need` fade (10 ms per second), so a rare late snapshot
                // does not keep us behind for good; move `delay` toward it
                // gently: up by at most a quarter of the frame (time slows to
                // 75%, it never runs backwards), down by at most 5%.
                this.need = Math.max(0, this.need - dt * 0.01);
                const d = this.need + SLACK_MS - this.delay;
                this.delay += d > 0 ? Math.min(d, dt * 0.25) : Math.max(d, -dt * 0.05);
                // The moment to draw, on the simulation's clock; the snapshots
                // a (before it) and b (at or after it). Those older than a are
                // done with.
                const t = now - this.offset - this.delay;
                while (hist.length > 2 && hist[1].due < t) this.spare.push(hist.shift().buffer);
                let j = hist.length - 1;
                while (j > 0 && hist[j - 1].due >= t) j--;
                b = hist[j];
                if (j > 0 && hist[j - 1].due < t && t < b.due) {
                    a = hist[j - 1];
                    alpha = (t - a.due) / (b.due - a.due);
                }
            }
            if (b !== this.base) this.show(b);
            const drawn = this.drawn;
            if (a !== drawn.a || b !== drawn.b || alpha !== drawn.alpha || (this.posed && !this.pose)) this.blend(a, b, alpha);
            this.shown = a ? a.time + (b.time - a.time) * alpha : b.time; // the step being drawn, with its fraction
            this.applyPose();
        }
        this.release();
        // Ask for the next one now, so it is computed while we draw.
        if (!this.waiting) {
            this.waiting = true;
            const recycle = this.spare;
            this.spare = [];
            this.host.send({ type: 'want', recycle }, recycle);
        }
    }

    // Events come into view with the moment they happened at: each at its own
    // step (a death during step t, as the drawing moves past t, which is
    // when the one who died stops being drawn), not when its snapshot came.
    release() {
        const pending = this.pending;
        let k = 0;
        while (k < pending.length && pending[k].time <= this.shown) k++;
        this.events = k ? pending.splice(0, k) : NO_EVENTS;
    }

    // Show snapshot s: its populations (but positions, see blend), grass,
    // tribes, and the followed animal's fate.
    show(s) {
        this.base = s;
        this.time = s.time;
        for (let k = 0; k < KINDS.length; k++) {
            const pop = this.pops[k];
            const cols = s.cols[k];
            const n = s.counts[k];
            pop.n = n;
            for (const c of COLUMNS) pop[c] = cols[c];
            const own = this.blended[k];
            if (own.x.length < n) {
                const cap = Math.max(n, own.x.length * 2);
                for (const c of BLENDED) own[c] = new Float64Array(cap);
            }
            for (const c of BLENDED) pop[c] = own[c];
        }
        this.grass.g = s.g;

        const tribes = [];
        this.tribeById.clear();
        for (let q = 0; q < s.tribes.length; q += TRIBE_STRIDE) {
            const t = this.known.get(s.tribes[q]);
            t.members = s.tribes[q + 1];
            t.adults = s.tribes[q + 2];
            t.store = s.tribes[q + 3];
            t.births = s.tribes[q + 4];
            // The camp can move, and the player can give the tribe an order (orders.js).
            t.camp.x = s.tribes[q + 5];
            t.camp.y = s.tribes[q + 6];
            t.order = orderAt(s.tribes, q + 7, t.order);
            // Materials in store (items.js).
            t.wood = s.tribes[q + 10];
            t.flint = s.tribes[q + 11];
            t.hide = s.tribes[q + 12];
            t.alive = true;
            tribes.push(t);
            this.tribeById.set(t.id, t);
        }
        this.tribes = tribes;
        const fallen = [];
        for (let q = 0; q < s.fallen.length; q += 2) {
            const t = this.known.get(s.fallen[q]);
            t.alive = false;
            t.ended = s.fallen[q + 1];
            t.members = 0;
            t.adults = 0;
            fallen.push(t);
        }
        this.fallen = fallen;
        this.showItems(s);

        // A snapshot taken before our last follow() still has the old one's fate.
        if (s.seq === this.asked) {
            this.watch = s.watch;
            this.fate = s.fate;
            this.heir = s.heir;
        }
    }

    // The items of snapshot s: where each is and who holds it, who holds
    // what, and the legends. Descriptions of items gone by s are forgotten.
    showItems(s) {
        const gone = this.goneItems;
        while (gone.length && gone[0] <= s.time) {
            for (const id of gone[1]) this.itemInfo.delete(id);
            gone.splice(0, 2);
            this.legendsDirty = true;
        }
        const items = this.items;
        const byBearer = this.byBearer;
        for (const h of byBearer.values()) this.hands.push(h);
        byBearer.clear();
        items.clear();
        const nums = s.items;
        if (!nums) return;
        let legends = 0;
        for (let q = 0; q < nums.length; q += ITEM_STRIDE) {
            const item = this.itemInfo.get(nums[q]);
            if (!item) continue;
            item.bearer = nums[q + 1];
            item.x = nums[q + 2];
            item.y = nums[q + 3];
            item.wear = nums[q + 4];
            item.kills = nums[q + 5];
            items.set(item.id, item);
            if (item.legend) legends++;
            if (!item.bearer) continue;
            let h = byBearer.get(item.bearer);
            if (!h) {
                h = this.hands.pop() ?? { weapon: undefined, tool: undefined };
                h.weapon = undefined;
                h.tool = undefined;
                byBearer.set(item.bearer, h);
            }
            if (isWeapon(item.kind)) {
                if (!h.weapon) h.weapon = item;
            } else if (!h.tool) h.tool = item;
        }
        // The player's hands are what it holds, not its spares.
        const p = this.player;
        if (p && p.id && byBearer.has(p.id)) {
            const h = byBearer.get(p.id);
            h.weapon = p.weapon ? items.get(p.weapon) : undefined;
            h.tool = p.tool ? items.get(p.tool) : undefined;
        }
        if (this.legendsDirty || legends !== this.legends.length) {
            this.legendsDirty = false;
            this.legends = [...items.values()].filter((it) => it.legend).sort((a, b) => b.legend.time - a.legend.time);
        }
    }

    // Positions and headings of b's individuals, alpha of the way from where
    // they were in a. Newborns (not in a) stand where they are in b; the dead
    // (in a, not in b) are simply not drawn: no ghosts. Across the world's
    // edge the blend takes the short way round, so nobody streaks across the
    // map; a jump of more than a quarter of the world is not blended at all.
    blend(a, b, alpha) {
        this.drawn.a = a;
        this.drawn.b = b;
        this.drawn.alpha = alpha;
        const W = this.width;
        const H = this.height;
        for (let k = 0; k < KINDS.length; k++) {
            const n = b.counts[k];
            const to = b.cols[k];
            const own = this.blended[k];
            const { x, y, heading } = own;
            if (!a || alpha >= 1) {
                x.set(to.x);
                y.set(to.y);
                heading.set(to.heading);
                continue;
            }
            const from = a.cols[k];
            const prev = to.prev;
            for (let i = 0; i < n; i++) {
                const j = prev[i];
                const dx = j < 0 ? 0 : wrapDelta(to.x[i] - from.x[j], W);
                const dy = j < 0 ? 0 : wrapDelta(to.y[i] - from.y[j], H);
                if (j < 0 || Math.abs(dx) > W / 4 || Math.abs(dy) > H / 4) {
                    x[i] = to.x[i];
                    y[i] = to.y[i];
                    heading[i] = to.heading[i];
                    continue;
                }
                let px = to.x[i] - dx * (1 - alpha);
                let py = to.y[i] - dy * (1 - alpha);
                if (px < 0) px += W;
                else if (px >= W) px -= W;
                if (py < 0) py += H;
                else if (py >= H) py -= H;
                x[i] = px;
                y[i] = py;
                // Headings too take the short way round.
                let dh = (to.heading[i] - from.heading[j]) % TAU;
                if (dh > Math.PI) dh -= TAU;
                else if (dh < -Math.PI) dh += TAU;
                heading[i] = to.heading[i] - dh * (1 - alpha);
            }
        }
    }

    // The body you are in is drawn where the page has moved it, over the
    // blended position (which is a little behind: the simulation follows it).
    applyPose() {
        const pose = this.pose;
        this.posed = false;
        if (!pose) return;
        const pop = this.humans;
        const ids = pop.id;
        for (let i = 0; i < pop.n; i++) {
            if (ids[i] !== pose.id) continue;
            pop.x[i] = pose.x;
            pop.y[i] = pose.y;
            pop.heading[i] = pose.heading;
            this.posed = true;
            return;
        }
    }

    // For the console (sim.timing): how the snapshots are flowing.
    timing() {
        const hist = this.history;
        return {
            delayMs: +this.delay.toFixed(1),     // how far behind the simulation's clock we draw
            offsetMs: this.offset,               // the simulation's clock → ours
            clock: this.host.local ? 'shared' : this.trustOrigin ? 'timeOrigin' : 'estimated',
            shown: this.shown,                   // the moment drawn, in steps (fractional when blending)
            newest: hist.length ? hist[hist.length - 1].time : 0, // the newest step received
            snapshots: this.stats.snapshots,     // received so far
            snapshotKB: +(this.stats.bytes / 1024).toFixed(1),
        };
    }
}
