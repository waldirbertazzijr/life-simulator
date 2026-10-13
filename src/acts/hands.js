// The hands of the person the page controls (package 2): what its acts do.
//
// player.js takes the page's acts and carries them out at the next step
// (useHands, through its table of acts); the work itself is here:
//
//   attack    a jab at a creature within reach in front, or a spear thrown
//             (with items, as the weapon in hand does it: a bow's arrow, a
//             club's swing); followers go for its target too (orders.js)
//   butcher   a step's cutting at a carcass, into the pouch
//   gather    a step's gathering from the ground underfoot: food from the
//             grass, or (with items) wood in forest and flint on rock, into
//             the load (material)
//   eat       from the pouch
//   store     at the rack: everything carried into the tribe's store
//   take      at the rack, with empty hands: food for the road
//
// Butchering and gathering go on from step to step (player.js keeps them
// going); the others are one-offs. Also here, for the items' acts too
// (acts/gear.js): the aim (aim, AIM), the weapon in hand (ARM), a projectile
// loosed (loose), what is in front (inFront), and where the body stands
// (inCamp, atRack).
import { STATE } from '../population.js';
import { strike, aimAt } from '../spears.js';
import { KIND, TASK, weaponStats, wearItem, carryOf, handWork, yieldAt } from '../items.js';
import { wrapDelta, wrapPos, livingIndexOf } from '../util.js';

export const AIM = { x: 0, y: 0 };
export const ARM = { item: null, kind: 0, range: 0, range2: 0, hit: 1, reload: 0 }; // the player's weapon (weaponStats)

// ---- Where the body stands ------------------------------------------------------------

// Is the person `id` inside its tribe's camp?
export function inCamp(world, id) {
    const pop = world.humans;
    const i = livingIndexOf(pop, id);
    if (i < 0) return false;
    const camp = world.tribeById.get(pop.tribe[i]).camp;
    const dx = wrapDelta(camp.x - pop.x[i], world.width);
    const dy = wrapDelta(camp.y - pop.y[i], world.height);
    const R = world.p.human.campRadius;
    return dx * dx + dy * dy < R * R;
}

// Within play.rackReach of the camp's centre, by its rack: the store.
function atRack(world, i) {
    const pop = world.humans;
    const camp = world.tribeById.get(pop.tribe[i]).camp;
    const dx = wrapDelta(camp.x - pop.x[i], world.width);
    const dy = wrapDelta(camp.y - pop.y[i], world.height);
    const R = world.p.play.rackReach;
    return dx * dx + dy * dy <= R * R;
}

// ---- Food: eat, store, take, gather ---------------------------------------------------

// Eat from the pouch: up to play.eatMax, never past full.
export function eat(world, i) {
    const P = world.p.human;
    const pop = world.humans;
    let amount = world.p.play.eatMax;
    if (amount > pop.carry[i]) amount = pop.carry[i];
    if (amount > P.maxEnergy - pop.energy[i]) amount = P.maxEnergy - pop.energy[i];
    if (!(amount > 0)) return;
    pop.carry[i] -= amount;
    pop.energy[i] += amount;
    world.events.push({ type: 'eat', id: pop.id[i], amount, time: world.time });
}

// At the rack, everything carried goes into the tribe's store (with items,
// the hides, and the wood and flint gathered by hand, too).
export function store(world, i) {
    const pl = world.player;
    const pop = world.humans;
    const amount = pop.carry[i];
    const hide = world.itemsOn ? pop.hides[i] : 0;
    const { wood, flint } = pl;
    if (!(amount > 0 || hide > 0 || wood > 0 || flint > 0) || !atRack(world, i)) return;
    const tribe = world.tribeById.get(pop.tribe[i]);
    tribe.store += amount;
    pop.carry[i] = 0;
    const e = { type: 'store', id: pop.id[i], amount, time: world.time };
    if (hide > 0) {
        tribe.hide += hide;
        pop.hides[i] = 0;
        e.hide = hide;
    }
    if (wood > 0 || flint > 0) {
        tribe.wood += wood;
        tribe.flint += flint;
        pl.wood = 0;
        pl.flint = 0;
        if (wood > 0) e.wood = wood;
        if (flint > 0) e.flint = flint;
    }
    world.events.push(e);
}

// At the rack with empty hands (less than one in them), food for the road:
// up to play.takeMax from the store.
export function take(world, i) {
    const P = world.p.human;
    const pop = world.humans;
    if (pop.carry[i] >= 1 || !atRack(world, i)) return;
    const tribe = world.tribeById.get(pop.tribe[i]);
    let amount = world.p.play.takeMax;
    const most = P.carryMax * (world.itemsOn ? carryOf(world, pop, i) : 1);
    if (amount > tribe.store) amount = tribe.store;
    if (amount > most - pop.carry[i]) amount = most - pop.carry[i];
    if (!(amount > 0)) return;
    tribe.store -= amount;
    pop.carry[i] += amount;
    world.events.push({ type: 'take', id: pop.id[i], amount, time: world.time });
}

// A step's gathering, from the ground underfoot (items.js handWork): in
// forest wood, on rock or tundra flint (material); elsewhere food, as
// gatherers do (humans.js): human.gatherRate from the patch underfoot into
// the pouch (× plantEnergy). Not in camp; it stops when the patch is too
// thin to bother (gatherMin) or the hands are full (more with a basket).
export function gather(world, i) {
    const P = world.p.human;
    const pl = world.player;
    const pop = world.humans;
    if (inCamp(world, pl.id)) {
        pl.gather = false;
        return;
    }
    pl.work = world.itemsOn ? handWork(world, pop.x[i], pop.y[i], world.tribeById.get(pop.tribe[i])) : TASK.NONE;
    if (pl.work !== TASK.NONE) {
        material(world, i, pl.work);
        return;
    }
    const { grass } = world;
    const g = grass.g;
    const gi = grass.index(pop.x[i], pop.y[i]);
    const most = P.carryMax * (world.itemsOn ? carryOf(world, pop, i) : 1);
    if (g[gi] < P.gatherMin || pop.carry[i] >= most) {
        pl.gather = false;
        return;
    }
    let take = P.gatherRate;
    if (take > g[gi]) take = g[gi];
    g[gi] -= take;
    const c = pop.carry[i] + take * P.plantEnergy;
    pop.carry[i] = c > most ? most : c; // hands are full; the rest is left behind
}

// A step's chopping (mat TASK.WOOD) or knapping (FLINT), as an errand's
// worker does it (items.js yieldAt: items.wood or flint where the ground is
// rich, less where it is poor), into the load; a knife in hand knaps
// materials.knifeKnap faster. It stops when the load (wood and flint together)
// is full: items.load, more with a basket (loadMax). A stroke for the page
// (chips, sparks) every materials.chopEvery or knapEvery steps.
function material(world, i, mat) {
    const M = world.p.materials;
    const pl = world.player;
    const pop = world.humans;
    const room = loadMax(world, i) - pl.wood - pl.flint;
    if (room <= 1e-9) {
        pl.gather = false;
        return;
    }
    const wood = mat === TASK.WOOD;
    const x = pop.x[i];
    const y = pop.y[i];
    let gain = yieldAt(world, x, y, mat);
    if (!wood && (pop.gear[i] & 7) === KIND.KNIFE) gain *= M.knifeKnap;
    if (gain > room) gain = room;
    if (wood) pl.wood += gain;
    else pl.flint += gain;
    if (pl.strokes++ % (wood ? M.chopEvery : M.knapEvery) === 0) {
        world.events.push({ type: wood ? 'chop' : 'knap', id: pop.id[i], x, y, time: world.time });
    }
}

// The most wood and flint person i can carry: items.load, more with a basket.
export const loadMax = (world, i) => world.p.items.load * carryOf(world, world.humans, i);

// ---- Butchering ---------------------------------------------------------------------------

// A step's cutting at the carcass pl.butcher: play.butcherSteps of them cut
// it up (with a knife, twice as fast), each putting its share of the meat
// into the pouch (as much as fits; the rest is left), with a stroke for the
// page every play.butcherEvery. Out of reach (or gone), it stops; started
// again, it goes on where it was. With items, the hides come at the end.
export function butcher(world, i) {
    const P = world.p.human;
    const Q = world.p.play;
    const pl = world.player;
    const pop = world.humans;
    const c = world.carcasses.get(pl.butcher);
    const dx = c ? wrapDelta(c.x - pop.x[i], world.width) : 0;
    const dy = c ? wrapDelta(c.y - pop.y[i], world.height) : 0;
    if (!c || dx * dx + dy * dy > Q.butcherReach * Q.butcherReach) {
        pl.butcher = 0;
        return;
    }
    const fast = world.itemsOn && (pop.gear[i] & 7) === KIND.KNIFE;
    const before = c.done;
    c.done += fast ? 2 : 1;
    const steps = c.steps ?? Q.butcherSteps; // (a hunter's kill: items.butcher)
    const last = c.done >= steps;
    const share = ((fast ? 2 : 1) * c.total) / steps;
    const meat = last || share > c.meat ? c.meat : share;
    c.meat -= meat;
    c.cut = last ? 1 : c.done / steps;
    const room = P.carryMax * (world.itemsOn ? carryOf(world, pop, i) : 1) - pop.carry[i];
    pop.carry[i] += meat < room ? meat : room > 0 ? room : 0;
    const { time } = world;
    if (before % Q.butcherEvery === 0) world.events.push({ type: 'butcher', id: pop.id[i], carcass: c.id, x: c.x, y: c.y, time });
    if (last) {
        world.carcasses.delete(c.id);
        world.events.push({ type: 'butchered', id: pop.id[i], carcass: c.id, time });
        pl.butcher = 0;
        if (world.itemsOn) {
            pop.hides[i] += c.hide ?? 0;
            if (fast) wearItem(world, i, world.items.get(pop.tool[i]));
        }
    }
}

// ---- Attacks -----------------------------------------------------------------------------

// The aim (dx, dy), as a unit vector (none given: straight ahead). Into AIM.
export function aim(world, i, a) {
    let ux = a.dx;
    let uy = a.dy;
    const len = Math.hypot(ux, uy);
    if (!(len > 1e-9)) {
        ux = Math.cos(world.humans.heading[i]);
        uy = Math.sin(world.humans.heading[i]);
    } else {
        ux /= len;
        uy /= len;
    }
    AIM.x = ux;
    AIM.y = uy;
}

// An attack: a jab at whatever is within reach in front (a light one), or
// a spear thrown. With items, with the weapon in hand: a spear as above; a
// bow shoots an arrow; a club swings at what is within its reach, and never
// leaves the hand; with none, nothing. Each wears the weapon.
export function attack(world, i, a) {
    const P = world.p.human;
    const pl = world.player;
    const pop = world.humans;
    if (pop.age[i] < P.maturity || pop.timer[i] > 0) return; // children do not; the spear is not back yet
    const items = world.itemsOn;
    let weapon = null;
    if (items) {
        weapon = pop.weapon[i] ? world.items.get(pop.weapon[i]) ?? null : null;
        if (weapon === null) return; // empty-handed
        weaponStats(world, weapon, ARM);
    }
    pop.timer[i] = items ? ARM.reload : P.reload;
    pl.resting = false;
    pl.gather = false;
    pl.butcher = 0;
    aim(world, i, a);
    const ux = AIM.x;
    const uy = AIM.y;
    if (items && weapon.kind === KIND.CLUB) swing(world, i, ux, uy, a, weapon);
    else if (!a.heavy && (!items || weapon.kind === KIND.SPEAR) && jab(world, i, ux, uy, weapon)) {
        // (jabbed)
    } else loose(world, i, ux, uy, a.heavy ? a.power : 0, a.target, a.lock, weapon, 0);
    if (items) wearItem(world, i, weapon);
}

// A spear thrown, or (a bow) an arrow shot, from person i along (ux, uy):
// farther and faster with `power` (0..1, a heavy throw), led onto `target`
// if it is the lock-on; with items, as its weapon throws (ARM, filled) and
// passing through `pierce` creatures.
export function loose(world, i, ux, uy, power, target, lock, weapon, pierce) {
    const Q = world.p.play;
    const pop = world.humans;
    let speed = Q.throwSpeed + (Q.heavySpeed - Q.throwSpeed) * power;
    let range = Q.throwRange + (Q.heavyRange - Q.throwRange) * power;
    let kind = KIND.SPEAR;
    let reach = 1;
    if (weapon !== null) {
        const I = world.p.items;
        kind = weapon.kind;
        // (Its reach × the spear's, and a bow's arrows fly faster too.)
        range *= ARM.range / world.p.human.throwRange;
        if (kind === KIND.BOW) speed *= I.arrowSpeed;
        reach = kind === KIND.BOW ? I.bowHit : 1;
        if (weapon.trait === 'accuracy') reach *= weapon.mult;
    }
    const x = pop.x[i];
    const y = pop.y[i];
    if (target && lock && aimAt(world, x, y, speed, target, AIM)) {
        ux = AIM.x;
        uy = AIM.y;
    }
    if (weapon === null) world.spears.add(x, y, ux * speed, uy * speed, range, pop.id[i], pop.tribe[i]);
    else world.spears.add(x, y, ux * speed, uy * speed, range, pop.id[i], pop.tribe[i], kind, weapon.id, pierce, reach);
    world.events.push({
        type: 'throw', id: pop.id[i], x, y, tx: wrapPos(x + ux * range, world.width), ty: wrapPos(y + uy * range, world.height), time: world.time,
        weapon: kind,
    });
}

// The nearest creature within `range` of person i and within play.jabArc of
// the aim (ux, uy), never a tribe-mate: its population and index, and the
// offset to it (into NEAR), or null.
const NEAR = { pop: null, j: -1, dx: 0, dy: 0, d: 0 };
export function inFront(world, i, ux, uy, range) {
    const Q = world.p.play;
    const pop = world.humans;
    const { width: W, height: H } = world;
    const px = pop.x[i];
    const py = pop.y[i];
    const tribe = pop.tribe[i];
    const cone = Math.cos(Q.jabArc);
    let victims = null;
    let j = -1;
    let bestD2 = range * range;
    let vdx = 0;
    let vdy = 0;
    for (const p of [world.herbivores, world.carnivores, pop]) {
        for (let k = 0; k < p.n; k++) {
            if (p.energy[k] <= 0 || (p === pop && p.tribe[k] === tribe)) continue;
            const dx = wrapDelta(p.x[k] - px, W);
            const dy = wrapDelta(p.y[k] - py, H);
            const d2 = dx * dx + dy * dy;
            if (d2 > bestD2) continue;
            const d = Math.sqrt(d2);
            if (d > 1e-9 && dx * ux + dy * uy < d * cone) continue;
            victims = p;
            j = k;
            bestD2 = d2;
            vdx = dx;
            vdy = dy;
        }
    }
    if (j < 0) return null;
    NEAR.pop = victims;
    NEAR.j = j;
    NEAR.dx = vdx;
    NEAR.dy = vdy;
    NEAR.d = Math.sqrt(bestD2);
    return NEAR;
}

// An ambush: an animal neither fleeing nor chasing, struck from more than 90°
// off its heading (from behind).
function unaware(world, n) {
    const { pop, j } = n;
    if (pop === world.humans) return false;
    const s = pop.state[j];
    const h = pop.heading[j];
    return s !== STATE.FLEEING && s !== STATE.CHASING && -n.dx * Math.cos(h) - n.dy * Math.sin(h) < 0;
}

// A jab at the nearest creature within play.jabRange, within play.jabArc of
// the aim (ux, uy) (never a tribe-mate). It kills (or, a person, wounds)
// with chance play.jabHit; an ambush always does. False if there was
// nothing to jab. (`weapon`: the spear's item, with items, or null.)
function jab(world, i, ux, uy, weapon = null) {
    const Q = world.p.play;
    const pop = world.humans;
    const n = inFront(world, i, ux, uy, Q.jabRange);
    if (n === null) return false;
    const { pop: victims, j } = n;
    world.events.push({ type: 'jab', id: pop.id[i], x: pop.x[i], y: pop.y[i], tx: victims.x[j], ty: victims.y[j], time: world.time });
    if (unaware(world, n) || world.rng.next() < Q.jabHit) {
        const d = n.d || 1;
        strike(world, victims, j, pop.id[i], n.dx / d, n.dy / d, KIND.SPEAR, weapon ? weapon.id : 0);
    }
    return true;
}

// A club's swing (items): at the nearest creature within its reach in front.
// It kills (a person: hurts, items.clubDamage × a spear's) with chance
// play.jabHit, more with a charged (heavy) swing; an ambush always does.
function swing(world, i, ux, uy, a, weapon) {
    const Q = world.p.play;
    const pop = world.humans;
    const px = pop.x[i];
    const py = pop.y[i];
    const n = inFront(world, i, ux, uy, ARM.range);
    const tx = n ? n.pop.x[n.j] : wrapPos(px + ux * ARM.range, world.width);
    const ty = n ? n.pop.y[n.j] : wrapPos(py + uy * ARM.range, world.height);
    world.events.push({ type: 'swing', id: pop.id[i], x: px, y: py, tx, ty, time: world.time, weapon: KIND.CLUB });
    if (n === null) return;
    const chance = Math.min(0.95, (Q.jabHit + (a.heavy ? 0.3 * a.power : 0)) * ARM.hit);
    if (unaware(world, n) || world.rng.next() < chance) {
        const d = n.d || 1;
        strike(world, n.pop, n.j, pop.id[i], n.dx / d, n.dy / d, KIND.CLUB, weapon.id, Q.spearDamage * world.p.items.clubDamage);
    }
}
