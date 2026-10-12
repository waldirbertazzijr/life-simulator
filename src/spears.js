// Spears in flight, what they strike, and the kills they leave to butcher.
//
// Only the player's spears fly (player.js throws them): everyone else's
// throws are decided where they are thrown (humans.js) and only drawn. A
// spear goes straight, a fixed distance each step, until it has flown its
// range. Each step it strikes the first creature its path passes close to
// (play.hitRadius; a predator, bigger, play.hitPredator), never one of the
// thrower's own tribe; otherwise it comes down where its range ends.
//
// What a hit does (strike, also used by the jab): a grazer dies, hunted; a
// predator dies, killed; a person of another tribe loses play.spearDamage,
// and dies of it at 0. The player's kills do not go straight into the hands
// as a hunter's do: the meat waits in a carcass (world.carcasses, by the
// dead creature's id) to be butchered (player.js), and spoils if left.
//
// world.spears holds the spears in flight; World.step calls stepSpears and
// spoilCarcasses only while there is one, so a world nobody plays in never
// runs any of this, and none of it draws a random number.
import { STATE } from './population.js';

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const wrapPos = (v, size) => (v >= 0 && v < size ? v : ((v % size) + size) % size);

// The spears in flight, as parallel arrays (a handful at most).
const FIELDS = ['x', 'y', 'vx', 'vy', 'left', 'range', 'by', 'tribe'];
export class Spears {
    constructor(capacity = 8) {
        this.n = 0;
        this.capacity = 0;
        this.grow(capacity);
    }

    grow(capacity) {
        for (const f of FIELDS) {
            const next = new Float64Array(capacity);
            if (this[f]) next.set(this[f].subarray(0, this.n));
            this[f] = next;
        }
        this.capacity = capacity;
    }

    // A spear from (x, y) at (vx, vy) a step, to fly `range` at most; thrown
    // by the person `by` of `tribe`.
    add(x, y, vx, vy, range, by, tribe) {
        if (this.n === this.capacity) this.grow(this.capacity * 2);
        const k = this.n++;
        this.x[k] = x;
        this.y[k] = y;
        this.vx[k] = vx;
        this.vy[k] = vy;
        this.left[k] = range;
        this.range[k] = range;
        this.by[k] = by;
        this.tribe[k] = tribe;
        return k;
    }

    // Down: the last one takes its place.
    remove(k) {
        const last = --this.n;
        if (k !== last) for (const f of FIELDS) this[f][k] = this[f][last];
    }

    // For the page (snapshot.spears): x, y, vx, vy and how far through its
    // range, five numbers a spear.
    pack() {
        const out = [];
        for (let k = 0; k < this.n; k++) out.push(this.x[k], this.y[k], this.vx[k], this.vy[k], 1 - this.left[k] / this.range[k]);
        return out;
    }
}

// Each spear in flight moves on one step, and strikes the first creature in
// its way, or comes down at the end of its range.
export function stepSpears(world) {
    const S = world.spears;
    const Q = world.p.play;
    const { width: W, height: H, time } = world;
    const pops = [world.herbivores, world.carnivores, world.humans];
    for (let k = 0; k < S.n; ) {
        const speed = Math.hypot(S.vx[k], S.vy[k]);
        const ux = S.vx[k] / speed;
        const uy = S.vy[k] / speed;
        const d = speed < S.left[k] ? speed : S.left[k];
        const sx = S.x[k];
        const sy = S.y[k];
        // The first creature (least far along) within reach of this step's
        // path; only what lies ahead of where the spear was (behind, it would
        // have been struck the step before).
        let hitPop = null;
        let hit = -1;
        let first = Infinity;
        for (const pop of pops) {
            const r = pop === world.carnivores ? Q.hitPredator : Q.hitRadius;
            const people = pop === world.humans;
            const { x, y, energy } = pop;
            const reach = d + r;
            for (let i = 0; i < pop.n; i++) {
                if (energy[i] <= 0) continue;
                if (people && pop.tribe[i] === S.tribe[k]) continue; // the thrower's own (and the thrower)
                const dx = wrapDelta(x[i] - sx, W);
                if (dx > reach || dx < -reach) continue;
                const dy = wrapDelta(y[i] - sy, H);
                if (dy > reach || dy < -reach) continue;
                const along = dx * ux + dy * uy;
                if (along < 0 || along >= first) continue;
                const a = along < d ? along : d; // the nearest point of the path
                const ex = dx - ux * a;
                const ey = dy - uy * a;
                if (ex * ex + ey * ey > r * r) continue;
                first = along;
                hitPop = pop;
                hit = i;
            }
        }
        if (hitPop !== null) {
            strike(world, hitPop, hit, S.by[k], ux, uy);
            S.remove(k);
            continue;
        }
        S.x[k] = wrapPos(sx + ux * d, W);
        S.y[k] = wrapPos(sy + uy * d, H);
        S.left[k] -= d;
        if (S.left[k] <= 1e-9) {
            world.events.push({ type: 'miss', x: S.x[k], y: S.y[k], by: S.by[k], dx: ux, dy: uy, time });
            S.remove(k);
            continue;
        }
        k++;
    }
}

// The player's blow (a spear, or a jab) strikes individual i of pop: `by`
// struck it, along (ux, uy). A grazer dies, hunted; a predator, killed;
// either leaves its meat in a carcass. A person loses play.spearDamage and
// dies of it at 0. True if it died.
export function strike(world, pop, i, by, ux, uy) {
    const { time } = world;
    const kind = world.kindOf(pop);
    world.events.push({ type: 'hit', id: pop.id[i], by, kind, x: pop.x[i], y: pop.y[i], dx: ux, dy: uy, time });
    if (pop === world.humans) {
        pop.energy[i] -= world.p.play.spearDamage;
        if (pop.energy[i] > 0) return false;
        world.die(pop, i, 'killed', by);
    } else {
        const meat = pop.energy[i] * world.p.human.efficiency;
        // (meat: what is left; total: what it held; done: steps of
        // butchering so far, of play.butcherSteps; cut: done as a fraction)
        world.carcasses.set(pop.id[i], {
            id: pop.id[i], kind, x: pop.x[i], y: pop.y[i], meat, total: meat, done: 0, cut: 0, by, born: time,
        });
        world.die(pop, i, pop === world.herbivores ? 'hunted' : 'killed', by);
    }
    // The kill is the thrower's, if it still lives.
    const people = world.humans;
    for (let k = 0; k < people.n; k++) {
        if (people.id[k] === by) {
            if (people.energy[k] > 0) people.kills[k]++;
            break;
        }
    }
    return true;
}

// Carcasses left untouched for play.spoil steps rot away.
export function spoilCarcasses(world) {
    const { time } = world;
    const spoil = world.p.play.spoil;
    for (const [id, c] of world.carcasses) {
        if (time - c.born < spoil) continue;
        world.carcasses.delete(id);
        world.events.push({ type: 'spoiled', carcass: id, time });
    }
}

// For the page (snapshot.carcasses): the player's kills still lying there.
export function packCarcasses(world) {
    const out = [];
    for (const c of world.carcasses.values()) out.push({ id: c.id, kind: c.kind, x: c.x, y: c.y, meat: c.meat, cut: c.cut });
    return out;
}

// ---- Aiming ----

// How individual i of pop moves this step, as the model moves it in its
// state (a grazer at full speed when fleeing, half while searching, not at
// all while grazing...): its heading at that pace. Left in VX, VY.
let VX = 0;
let VY = 0;
function velocityOf(world, pop, i) {
    const P = world.p[world.kindOf(pop)];
    const top = P.speed * pop.speedGene[i];
    const s = pop.state[i];
    let v;
    if (pop === world.herbivores) v = s === STATE.FLEEING ? top : s === STATE.SEARCHING ? top * P.cruise : 0;
    else if (pop === world.carnivores) {
        v = s === STATE.CHASING ? top : s === STATE.ROAMING ? top * P.cruise : s === STATE.SATED ? top * P.cruise * 0.5 : 0;
    } else {
        v = s === STATE.FLEEING || s === STATE.RUNNING ? top
            : s === STATE.FIGHTING || s === STATE.AT_CAMP || s === STATE.GATHERING || s === STATE.BUTCHERING ? 0
            : top * P.cruise;
    }
    VX = Math.cos(pop.heading[i]) * v;
    VY = Math.sin(pop.heading[i]) * v;
}

// The way to throw from (x, y), at `speed` a step, to meet the creature
// `target` (an id) where it will be, its heading and pace held: a unit
// vector, left in out.x, out.y. False if there is no such creature alive.
//
// The spear flies its first stretch in the step it is thrown, after the
// creature has made this step's move: so after k steps the spear is k·speed
// out and the creature k − 1 moves on. With r the offset to the creature
// now and v its move a step, that is |r − v + k·v| = k·speed: the usual
// interception, from r − v.
export function aimAt(world, x, y, speed, target, out) {
    const found = target ? world.find(target) : null;
    if (!found || found.pop.energy[found.i] <= 0) return false;
    const { pop, i } = found;
    velocityOf(world, pop, i);
    const rx = wrapDelta(pop.x[i] - x, world.width) - VX;
    const ry = wrapDelta(pop.y[i] - y, world.height) - VY;
    // (v·v − s²) k² + 2 (r·v) k + r·r = 0, with v slower than s: one root > 0.
    const a = VX * VX + VY * VY - speed * speed;
    const b = 2 * (rx * VX + ry * VY);
    const c = rx * rx + ry * ry;
    const disc = b * b - 4 * a * c;
    const k = a < 0 && disc >= 0 ? (-b - Math.sqrt(disc)) / (2 * a) : 0;
    let ax = rx + VX * k;
    let ay = ry + VY * k;
    let len = Math.hypot(ax, ay);
    if (!(len > 1e-9)) {
        ax = rx + VX;
        ay = ry + VY;
        len = Math.hypot(ax, ay);
        if (!(len > 1e-9)) return false;
    }
    out.x = ax / len;
    out.y = ay / len;
    return true;
}
