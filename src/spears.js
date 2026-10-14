// Spears in flight, what they strike, and the kills they leave to butcher.
//
// Only the player's spears fly (acts/hands.js throws them): everyone else's
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
// dead creature's id) to be butchered (acts/hands.js), as long as it takes.
//
// world.spears holds the spears in flight; World.step calls stepSpears only
// while there is one, so a world nobody plays in never runs any of this, and
// none of it draws a random number. Carcasses (below) never rot: they are
// cut up, or eaten by predators (carrion).
//
// With items (items.js) a projectile is a spear or an arrow (`kind`, a KIND
// code: an arrow flies farther and faster, and its reach for a hit is a
// little smaller: `reach`, × play.hitRadius), knows the weapon that loosed
// it (`item`, whose kills it counts), and may pass through a few creatures
// before it stops (`pierce`, the Piercing throw). With items off, every one is
// a plain spear. And every hunter's kills wait in world.carcasses to be cut
// up, not only the player's.
import { STATE } from './population.js';
import { KIND, credit, efficiencyOf } from './items.js';
import { wrapDelta, wrapPos, livingIndexOf } from './util.js';

// The spears in flight, as parallel arrays (a handful at most).
const FIELDS = ['x', 'y', 'vx', 'vy', 'left', 'range', 'by', 'tribe', 'kind', 'item', 'pierce', 'reach'];
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
    // by the person `by` of `tribe`. With items: its kind (KIND.SPEAR or
    // KIND.BOW: an arrow), the weapon's item id, how many it may pass
    // through, and its reach for a hit (× play.hitRadius).
    add(x, y, vx, vy, range, by, tribe, kind = KIND.SPEAR, item = 0, pierce = 0, reach = 1) {
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
        this.kind[k] = kind;
        this.item[k] = item;
        this.pierce[k] = pierce;
        this.reach[k] = reach;
        return k;
    }


    // Down: the last one takes its place.
    remove(k) {
        const last = --this.n;
        if (k !== last) for (const f of FIELDS) this[f][k] = this[f][last];
    }

    // For the page (snapshot.spears): x, y, vx, vy, how far through its
    // range, and its kind (a KIND code: 1 a spear, 2 an arrow), SPEAR_STRIDE
    // numbers a projectile.
    pack() {
        const out = [];
        for (let k = 0; k < this.n; k++) out.push(this.x[k], this.y[k], this.vx[k], this.vy[k], 1 - this.left[k] / this.range[k], this.kind[k]);
        return out;
    }
}
export const SPEAR_STRIDE = 6;

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
        // have been struck the step before). A piercing one goes on to the
        // next beyond it, as long as it may pass through.
        let past = -1; // how far along the last one struck this step was
        let stopped = false;
        for (;;) {
            let hitPop = null;
            let hit = -1;
            let first = Infinity;
            for (const pop of pops) {
                const r = (pop === world.carnivores ? Q.hitPredator : Q.hitRadius) * S.reach[k];
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
                    if (along < 0 || along <= past || along >= first) continue;
                    const a = along < d ? along : d; // the nearest point of the path
                    const ex = dx - ux * a;
                    const ey = dy - uy * a;
                    if (ex * ex + ey * ey > r * r) continue;
                    first = along;
                    hitPop = pop;
                    hit = i;
                }
            }
            if (hitPop === null) break;
            strike(world, hitPop, hit, S.by[k], ux, uy, S.kind[k], S.item[k]);
            if (S.pierce[k] <= 0) {
                stopped = true;
                break;
            }
            S.pierce[k]--;
            past = first;
        }
        if (stopped) {
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

// The player's blow (a spear, an arrow, a jab or a swing) strikes individual
// i of pop: `by` struck it, along (ux, uy), with a `weapon` (a KIND code;
// with items, `item` is its id, and it counts the kill). A grazer dies,
// hunted; a predator, killed; either leaves its meat (and hide) in a
// carcass. A person loses `damage` (play.spearDamage) and dies of it at 0.
// True if it died.
export function strike(world, pop, i, by, ux, uy, weapon = KIND.SPEAR, item = 0, damage = world.p.play.spearDamage) {
    const { time } = world;
    const kind = world.kindOf(pop);
    world.events.push({ type: 'hit', id: pop.id[i], by, kind, x: pop.x[i], y: pop.y[i], dx: ux, dy: uy, time, weapon });
    // The thrower, if it still lives: the kill is its.
    const people = world.humans;
    const thrower = livingIndexOf(people, by);
    const items = world.itemsOn;
    const weaponItem = items && item ? world.items.get(item) : undefined;
    if (pop === world.humans) {
        pop.energy[i] -= damage;
        if (pop.energy[i] > 0) return false;
        if (weaponItem) credit(world, weaponItem, pop, i);
        world.die(pop, i, 'killed', by);
    } else {
        // (With items, a knife in the thrower's hands gets more of it.)
        const meat = world.meatOf(pop, i) * (items && thrower >= 0 ? efficiencyOf(world, people, thrower) : world.p.human.efficiency);
        // (meat: what is left; total: what it held; done: steps of
        // butchering so far, of play.butcherSteps; cut: done as a fraction)
        const c = { id: pop.id[i], kind, x: pop.x[i], y: pop.y[i], meat, total: meat, done: 0, cut: 0, by, born: time };
        // (With items, the thrower's tribe may come for what the thrower
        // cannot carry: tasks.js fetch. A big kill is several loads.)
        if (items && thrower >= 0) c.tribe = people.tribe[thrower];
        if (items) c.hide = pop === world.carnivores ? 2 : 1;
        world.carcasses.set(pop.id[i], c);
        if (weaponItem) credit(world, weaponItem, pop, i);
        world.die(pop, i, pop === world.herbivores ? 'hunted' : 'killed', by);
    }
    if (thrower >= 0) people.kills[thrower]++;
    return true;
}

// ---- Carcasses ----
//
// Nothing rots: a carcass lies until its meat is gone. People cut it up (its
// hunter and tribe-mates, and the camp fetching the rest: tasks.js; the
// player: acts/hands.js), and predators eat from it: a hungry one with a
// carcass in sight goes to it instead of hunting (World.stepCarnivores).
// Emptied, it is used up and goes ('used', or 'butchered' by a person). The
// player's own kills are no predator's while it plays: they wait as long
// as it takes.

// Where the carcass carrion() found lies from where it looked. Read at once.
export const CARRION = { dx: 0, dy: 0, d2: 0 };

// The nearest carcass with meat within r of (x, y), if a predator there may
// take it (not the player's own kill, and nobody within `wary` of it) and
// can walk straight to it (no water or cliff between); else null. Its
// offset is left in CARRION.
export function carrion(world, x, y, r, wary) {
    const { width: W, height: H } = world;
    const mine = world.player !== null ? world.player.id : 0;
    const people = world.humans.n !== 0 ? world.humanHash : null;
    let best = null;
    let bestD2 = r * r;
    let bx = 0;
    let by = 0;
    for (const c of world.carcasses.values()) {
        if (mine !== 0 && c.by === mine) continue;
        const dx = wrapDelta(c.x - x, W);
        if (dx > r || dx < -r) continue;
        const dy = wrapDelta(c.y - y, H);
        if (dy > r || dy < -r) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestD2) continue;
        if (people !== null && people.nearest(c.x, c.y, wary) >= 0) continue; // (people at it: it waits)
        best = c;
        bestD2 = d2;
        bx = dx;
        by = dy;
    }
    if (best === null || (world.terrain !== null && !straight(world.terrain, x, y, bx, by, bestD2))) return null;
    CARRION.dx = bx;
    CARRION.dy = by;
    CARRION.d2 = bestD2;
    return best;
}

// Is the ground open all the way from (x, y) along (dx, dy), d2 long
// (squared)? Looked at every 2 units.
function straight(terrain, x, y, dx, dy, d2) {
    const n = Math.ceil(Math.sqrt(d2) / 2);
    for (let k = 1; k <= n; k++) if (terrain.blocked(x + (dx * k) / n, y + (dy * k) / n)) return false;
    return true;
}

// The predator `by` eats from carcass c, up to `room` of its meat. What it
// took. Emptied, the carcass is used up and goes.
export function eatCarcass(world, c, room, by) {
    const take = room < c.meat ? room : c.meat;
    c.meat -= take;
    c.cut = 1 - c.meat / c.total;
    if (c.meat <= 1e-6) {
        world.carcasses.delete(c.id);
        world.events.push({ type: 'used', carcass: c.id, by, time: world.time });
    }
    return take;
}

// For the page (snapshot.carcasses): the kills still lying there, the
// player's and (with items) everyone's; `by` is who made the kill.
export function packCarcasses(world) {
    const out = [];
    for (const c of world.carcasses.values()) out.push({ id: c.id, kind: c.kind, x: c.x, y: c.y, meat: c.meat, cut: c.cut, by: c.by });
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
            : s === STATE.FIGHTING || s === STATE.AT_CAMP || s === STATE.GATHERING || s === STATE.BUTCHERING || s === STATE.CRAFTING ? 0
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
