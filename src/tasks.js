// The work people do with items (spec §8, §15), for themselves and their
// tribe. Items themselves (what they are, holding and losing them, legends)
// are items.js; this is what people do about them. Like everything about
// items, none of it runs with items off (world.itemsOn).
//
// A person's task is pop.task[i] (TASK in items.js): cutting up a kill, an
// errand for wood or flint, or crafting at camp. humans.js steps it with
// stepTask, which leaves the result in `job`. At camp (campItems) a person
// takes up a better item from the camp's goods and a task if the tribe
// needs one (assign); out in the wild, now and then, a better item lying
// near (wildPickup). Every TALLY steps each tribe reckons what it needs
// (tallyTribes); every SWEEP steps, items.js sweeps away burnt-out torches
// and items lost too long (stepItems, from World.step).
import { STATE } from './population.js';
import {
    KIND, TASK, ITEM_KINDS, TOOLS, isWeapon, costOf, traitsOf, newItem, fraction, better, heldLike, hold, unhold, lay,
    campSpot, wearItem, yieldAt, affords, spend, sweep, carryOf,
} from './items.js';
import { wrapDelta } from './util.js';

const TALLY = 10;  // steps between a tribe's reckonings of what it needs
const SWEEP = 50;  // steps between sweeps for burnt-out torches and items left too long
const STROKE = 30; // a chop or a knap event at most this often, per worker

// ---- Tasks -------------------------------------------------------------------------------

// What a task step comes to (stepTask): the state, the way (dx, dy) and pace
// (v), and the energy and food in hand after it.
export const job = { s: 0, dx: 0, dy: 0, v: 0, e: 0, c: 0 };

// One step of person i's task (pop.task[i], not NONE), for `tribe`; e and c
// its energy and food in hand; (campDx, campDy) the way home, campD long.
export function stepTask(world, i, tribe, e, c, campDx, campDy, campD) {
    const pop = world.humans;
    job.s = STATE.AT_CAMP;
    job.dx = 0;
    job.dy = 0;
    job.v = 0;
    job.e = e;
    job.c = c;
    const task = pop.task[i];
    if (task === TASK.BUTCHER) butcherStep(world, i, tribe, e, c);
    else if (task === TASK.CRAFT) craftStep(world, i, tribe, campDx, campDy, campD);
    else errandStep(world, i, tribe, task, campDx, campDy, campD);
}

// Walk the way to `place` (a camp or a spot: {x, y, paths}), (ddx, ddy) away
// at distance d: by land with terrain, straight on a flat world. Into job.dx, dy.
function wayTo(world, place, x, y, ddx, ddy, d) {
    if (world.terrain === null || !place.paths) {
        job.dx = ddx / d;
        job.dy = ddy / d;
        return;
    }
    world.terrain.way(place.paths, x, y, ddx, ddy, d);
    job.dx = world.terrain.ux;
    job.dy = world.terrain.uy;
}

// Cutting up a kill: to it, then cutting at items.butcher steps for the whole
// carcass (twice as fast with a knife), eating a share as it goes (1 −
// sociality, as a hunter always has) and carrying the rest, as much as its
// hands hold; a stroke for the page every play.butcherEvery. A big kill is
// more than one can carry: as it starts, tribe-mates near come to help, and
// what is left when the hands are full waits for others from the camp
// (fetch), while the store could use it (both below human.fetchBelow ×
// storeTarget a member); what nobody comes for is the predators'. Whoever
// first stops takes the hides home; whoever cuts the last of it is done.
function butcherStep(world, i, tribe, e, c) {
    const P = world.p.human;
    const Q = world.p.play;
    const pop = world.humans;
    const cc = world.carcasses.get(pop.work[i]);
    const dx = wrapDelta(cc.x - pop.x[i], world.width);
    const dy = wrapDelta(cc.y - pop.y[i], world.height);
    const d2 = dx * dx + dy * dy;
    pop.focus[i] = cc.id;
    if (d2 > Q.butcherReach * Q.butcherReach) {
        const d = Math.sqrt(d2);
        job.s = STATE.HUNTING;
        job.dx = dx / d;
        job.dy = dy / d;
        job.v = Math.min(P.speed * pop.speedGene[i] * P.cruise, d - 1);
        return;
    }
    if (cc.done === 0 && tribe.store < P.storeTarget * tribe.members * P.fetchBelow) helpers(world, i, tribe, cc);
    const room = P.carryMax * ((pop.gear[i] & 7) === KIND.BASKET ? carryOf(world, pop, i) : 1) - c;
    const fast = (pop.gear[i] & 7) === KIND.KNIFE;
    if (room <= 0) {
        stopButchering(world, i, cc, fast);
        return;
    }
    job.s = STATE.BUTCHERING;
    const before = cc.done;
    cc.done += fast ? 2 : 1;
    const share = ((fast ? 2 : 1) * cc.total) / cc.steps;
    let meat = share > cc.meat ? cc.meat : share;
    let eat = meat * (1 - tribe.sociality);
    if (eat > P.maxEnergy - e) eat = P.maxEnergy - e;
    if (eat < 0) eat = 0;
    if (meat - eat > room) meat = eat + room;
    cc.meat -= meat;
    cc.cut = 1 - cc.meat / cc.total;
    job.e = e + eat;
    job.c = c + meat - eat;
    const { time } = world;
    if (before % Q.butcherEvery === 0) world.events.push({ type: 'butcher', id: pop.id[i], carcass: cc.id, x: cc.x, y: cc.y, time });
    if (cc.meat > 1e-6) return;
    world.carcasses.delete(cc.id);
    world.events.push({ type: 'butchered', id: pop.id[i], carcass: cc.id, time });
    world.itemStats.butchered++;
    stopButchering(world, i, cc, fast);
}

// Person i is done at carcass cc (its hands are full, or it is all cut):
// the hides, if nobody has taken them, and on its way.
function stopButchering(world, i, cc, fast) {
    const pop = world.humans;
    pop.hides[i] += cc.hide;
    cc.hide = 0;
    pop.task[i] = TASK.NONE;
    pop.work[i] = 0;
    if (fast) wearItem(world, i, world.items.get(pop.tool[i]));
}

// Tribe-mates of person i within human.groupRadius, adults with nothing to do
// for the tribe and their hands not full, come to help cut up carcass cc: as
// many as the meat needs, besides i.
function helpers(world, i, tribe, cc) {
    const P = world.p.human;
    const pop = world.humans;
    const r2 = P.groupRadius * P.groupRadius;
    let need = cc.meat - P.carryMax;
    for (let k = 0; k < pop.n && need > 0; k++) {
        if (k === i || pop.tribe[k] !== tribe.id || pop.energy[k] <= 0 || pop.task[k] !== TASK.NONE || pop.goal[k] !== 0
            || pop.age[k] < P.maturity || pop.carry[k] >= P.tripLoad) continue;
        if (world.player !== null && pop.id[k] === world.player.id) continue;
        const dx = wrapDelta(pop.x[k] - cc.x, world.width);
        const dy = wrapDelta(pop.y[k] - cc.y, world.height);
        if (dx * dx + dy * dy > r2) continue;
        pop.task[k] = TASK.BUTCHER;
        pop.work[k] = cc.id;
        need -= P.carryMax - pop.carry[k];
    }
}

// An adult with nothing to do (at camp, or a forager out: humans.js) goes
// to cut what is left of a kill (the nearest to camp with meat more than
// those already at it or on their way can carry), while the store could use
// it (below human.fetchBelow × storeTarget a member): its tribe's kills, and
// those of tribes gone (not the player's). What nobody comes for is the
// predators' (spears.js carrion). True if it goes.
const near = new Map(); // (fetch: a carcass's id → its meat nobody is coming for)
export function fetch(world, i, tribe) {
    const P = world.p.human;
    const pop = world.humans;
    if (tribe.store >= P.storeTarget * tribe.members * P.fetchBelow) return false;
    const reach2 = (P.homeRange * 1.4) ** 2; // (butcherable: 1.5)
    const mine = world.player !== null ? world.player.id : 0;
    near.clear();
    for (const cc of world.carcasses.values()) {
        if (cc.tribe !== tribe.id && (cc.tribe === undefined || world.tribeById.has(cc.tribe) || (mine !== 0 && cc.by === mine))) continue;
        const dx = wrapDelta(cc.x - tribe.camp.x, world.width);
        const dy = wrapDelta(cc.y - tribe.camp.y, world.height);
        if (dx * dx + dy * dy < reach2) near.set(cc.id, cc.meat);
    }
    if (near.size === 0) return false;
    for (let k = 0; k < pop.n; k++) {
        if (pop.task[k] !== TASK.BUTCHER || !near.has(pop.work[k])) continue;
        near.set(pop.work[k], near.get(pop.work[k]) - (P.carryMax - pop.carry[k]));
    }
    let best = null;
    let bestD2 = Infinity;
    for (const [id, left] of near) {
        if (left <= 0) continue;
        const cc = world.carcasses.get(id);
        const dx = wrapDelta(cc.x - tribe.camp.x, world.width);
        const dy = wrapDelta(cc.y - tribe.camp.y, world.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = cc;
        }
    }
    if (best === null) return false;
    pop.task[i] = TASK.BUTCHER;
    pop.work[i] = best.id;
    return true;
}

// An errand for wood or flint: to the tribe's spot, gather there until the
// load is full (or the errand has lasted long enough), and home with it. The
// camp takes it in (campItems).
function errandStep(world, i, tribe, task, campDx, campDy, campD) {
    const P = world.p.human;
    const I = world.p.items;
    const pop = world.humans;
    const x = pop.x[i];
    const y = pop.y[i];
    const pace = P.speed * pop.speedGene[i] * P.cruise;
    const wood = task === TASK.WOOD;
    const spot = wood ? tribe.woodSpot : tribe.flintSpot;
    if (spot === null || pop.load[i] >= I.load || pop.work[i] >= I.errand) {
        if (spot === null) pop.work[i] = I.errand;
        job.s = STATE.HOMEWARD;
        wayTo(world, tribe, x, y, campDx, campDy, campD);
        job.v = pace;
        return;
    }
    job.s = wood ? STATE.CHOPPING : STATE.QUARRYING;
    const dx = wrapDelta(spot.x - x, world.width);
    const dy = wrapDelta(spot.y - y, world.height);
    const d = Math.hypot(dx, dy);
    if (d > 4) {
        wayTo(world, spot, x, y, dx, dy, d);
        job.v = pace < d ? pace : d;
        return;
    }
    pop.work[i]++;
    const load = pop.load[i] + yieldAt(world, x, y, task);
    pop.load[i] = load > I.load ? I.load : load;
    if (pop.work[i] % STROKE === 1) world.events.push({ type: wood ? 'chop' : 'knap', id: pop.id[i], x, y, time: world.time });
}

// Making an item at camp: into the camp, then items.craftSteps of work.
function craftStep(world, i, tribe, campDx, campDy, campD) {
    const P = world.p.human;
    const pop = world.humans;
    job.s = STATE.CRAFTING;
    if (campD > P.campRadius * 0.6) {
        wayTo(world, tribe, pop.x[i], pop.y[i], campDx, campDy, campD);
        job.v = P.speed * pop.speedGene[i] * P.cruise;
        return;
    }
    if (--pop.work[i] <= 0) finishCraft(world, i, tribe);
}

// The chance a crafter who has made `made` items makes a rare one, with a
// flint more.
export const rareChance = (I, made) => Math.min(I.rareMax, I.rareChance + I.rareGain * made);

// Done: the item, rare by chance if a flint more went in. It goes to the
// crafter's hand if that is empty (or holds worse), else among the camp's goods.
function finishCraft(world, i, tribe) {
    const pop = world.humans;
    const make = pop.make[i];
    const item = craft(world, i, make % 8, make >= 8, tribe);
    pop.task[i] = TASK.NONE;
    pop.work[i] = 0;
    pop.make[i] = 0;
    const held = heldLike(world, i, item.kind);
    if (better(world, item, held, true)) {
        if (held) {
            unhold(world, i, held);
            const at = campSpot(tribe, held);
            lay(world, held, at.x, at.y, tribe);
        }
        hold(world, i, item);
    } else {
        const at = campSpot(tribe, item);
        lay(world, item, at.x, at.y, tribe);
    }
}

// Person i of `tribe` makes an item of `kind` (the materials are already
// spent): rare by chance with a flint more (`flint`). Not yet anywhere.
export function craft(world, i, kind, flint, tribe) {
    const I = world.p.items;
    const pop = world.humans;
    let rarity = 0;
    let trait = '';
    if (flint && world.rng.next() < rareChance(I, pop.crafted[i])) {
        const traits = traitsOf(kind);
        rarity = 1;
        trait = traits[Math.floor(world.rng.next() * traits.length)];
    }
    const item = newItem(world, kind, rarity, trait, pop.id[i], tribe.id);
    pop.crafted[i]++;
    const stats = world.itemStats;
    stats.crafted[kind]++;
    if (rarity === 1) stats.rare++;
    world.events.push({ type: 'crafted', id: pop.id[i], item: item.id, kind, rarity, tribe: tribe.id, by: pop.id[i], time: world.time });
    return item;
}

// ---- At camp, and out in the wild ------------------------------------------------------

// Person i is at its tribe's camp (humans.js, after the food is in): hides
// and a finished errand's load go into the store; an adult takes up
// something better from the camp's goods, and a task if the tribe needs one.
export function campItems(world, i, tribe) {
    const I = world.p.items;
    const pop = world.humans;
    if (pop.hides[i] > 0) {
        tribe.hide += pop.hides[i];
        pop.hides[i] = 0;
    }
    const task = pop.task[i];
    if ((task === TASK.WOOD || task === TASK.FLINT) && (pop.load[i] >= I.load || pop.work[i] >= I.errand)) {
        if (task === TASK.WOOD) tribe.wood += pop.load[i];
        else tribe.flint += pop.load[i];
        pop.load[i] = 0;
        pop.task[i] = TASK.NONE;
        pop.work[i] = 0;
    }
    if (pop.age[i] < world.p.human.maturity) return;
    if (tribe.goods.length) campPickup(world, i, tribe);
    if (pop.task[i] !== TASK.NONE || pop.goal[i] !== 0 || world.night || world.dusk) return; // (no new task after dusk)
    if (world.carcasses.size) fetch(world, i, tribe);
    if (pop.task[i] === TASK.NONE && tribe.want !== 0) assign(world, i, tribe);
    if (pop.task[i] === TASK.NONE && tribe.store >= world.p.human.storeTarget * tribe.members) chore(world, i, tribe);
}

// Chores: an adult at camp with nothing the tribe needs done, its store
// full, works rather than rest. Today: wood for the camp fire (items.woodpile
// nights of it, items.fire a member a night: tribes.js), and flint for the
// stock (items.flintStock a member), up to two thirds of the adults at once.
// (The hook for later work: building, gardens.)
function chore(world, i, tribe) {
    const I = world.p.items;
    const A = tribe.adults;
    if (tribe.wood < I.fire * I.woodpile * tribe.members && tribe.woodSpot !== null && tribe.chopping < 1 + Math.floor((A * 2) / 3)) {
        startErrand(world, i, tribe, TASK.WOOD);
    } else if (tribe.flint < I.flintStock * tribe.members && tribe.flintSpot !== null && tribe.quarrying < 1 + Math.floor(A / 6)) {
        startErrand(world, i, tribe, TASK.FLINT);
    }
}

// From the camp's goods, the first thing better than what person i holds.
function campPickup(world, i, tribe) {
    const goods = tribe.goods;
    for (let k = 0; k < goods.length; k++) {
        const item = world.items.get(goods[k]);
        const held = heldLike(world, i, item.kind);
        if (!better(world, item, held, true)) continue;
        if (held) {
            unhold(world, i, held);
            lay(world, held, item.x, item.y, tribe);
        }
        hold(world, i, item);
        world.events.push({ type: 'picked', item: item.id, by: world.humans.id[i], time: world.time });
        world.itemStats.picked++;
        return;
    }
}

// Out in the wild (every few steps): an item lying within items.pickReach that
// is better than what person i holds, taken up; its own left in its place.
export function wildPickup(world, i) {
    const pop = world.humans;
    const R = world.p.items.pickReach;
    const { wild, wildX, wildY, width: W, height: H } = world;
    const px = pop.x[i];
    const py = pop.y[i];
    for (let k = 0; k < wild.length; k++) {
        const dx = wrapDelta(wildX[k] - px, W);
        if (dx > R || dx < -R) continue;
        const dy = wrapDelta(wildY[k] - py, H);
        if (dx * dx + dy * dy > R * R) continue;
        const item = world.items.get(wild[k]);
        const held = heldLike(world, i, item.kind);
        if (!better(world, item, held, true)) continue;
        if (held) {
            unhold(world, i, held);
            lay(world, held, pop.x[i], pop.y[i], null);
        }
        hold(world, i, item);
        world.events.push({ type: 'picked', item: item.id, by: pop.id[i], time: world.time });
        world.itemStats.picked++;
        return;
    }
}

// A task for person i, an adult at camp with none, if its tribe needs one:
// make what it wants if the store has the materials (taken now, a flint more
// for a chance of rare while items.spare are kept back); otherwise go for the wood
// or flint it lacks. A few at a time.
function assign(world, i, tribe) {
    const I = world.p.items;
    const pop = world.humans;
    const kind = tribe.want;
    const adults = tribe.adults;
    if (affords(world.p, tribe, kind) && tribe.crafting < 1 + Math.floor(adults / 12)) {
        spend(world.p, tribe, kind);
        let make = kind;
        if (tribe.flint >= 1 + I.spare) {
            tribe.flint -= 1;
            make += 8;
        }
        pop.task[i] = TASK.CRAFT;
        pop.work[i] = I.craftSteps;
        pop.make[i] = make;
        tribe.crafting++;
        if (--tribe.wanted <= 0) tribe.want = 0;
    } else if (tribe.needWood && tribe.woodSpot !== null && tribe.chopping < 1 + Math.floor(adults / 8)) {
        startErrand(world, i, tribe, TASK.WOOD);
    } else if (tribe.needFlint && tribe.flintSpot !== null && tribe.quarrying < 1) {
        startErrand(world, i, tribe, TASK.FLINT);
    }
}

// Send person i of `tribe` for wood or flint (TASK.WOOD or FLINT; the tribe
// has a spot for it): what the tribe needs (assign), or an order (orders.js).
export function startErrand(world, i, tribe, task) {
    const pop = world.humans;
    pop.task[i] = task;
    pop.work[i] = 0;
    pop.load[i] = 0;
    if (task === TASK.WOOD) {
        tribe.chopping++;
        world.itemStats.errands.wood++;
    } else {
        tribe.quarrying++;
        world.itemStats.errands.flint++;
    }
}

// ---- Every few steps -------------------------------------------------------------------

// Once a step, after the tribes' bookkeeping (World.step): every SWEEP steps,
// burnt-out torches go out and items left lying too long are gone; every
// TALLY, each tribe reckons what it needs.
export function stepItems(world) {
    if (world.time % SWEEP === 0) sweep(world);
    if (world.time % TALLY === 0) tallyTribes(world);
}

// What each tribe needs: its adults without a weapon fit to use (none, or
// worn below items.worn), less the fit ones lying in its camp; the same for
// tools. It wants a weapon first (its culture choosing the kind), else a tool;
// and the wood or flint that takes, if it lacks them. A hungry camp wants
// only weapons for the empty-handed (they cannot hunt), then knives (more
// from each kill, cut up sooner). Its people at each task are counted again
// too.
export function tallyTribes(world) {
    const P = world.p.human;
    const I = world.p.items;
    const pop = world.humans;
    const { items } = world;
    for (const t of world.tribes) {
        if (!t.kinds) t.kinds = new Int32Array(ITEM_KINDS.length);
        t.kinds.fill(0);
        t.armed = 0;
        t.unarmed = 0;
        t.tooled = 0;
        t.crafting = 0;
        t.chopping = 0;
        t.quarrying = 0;
    }
    const pl = world.player;
    for (let i = 0; i < pop.n; i++) {
        if (pop.energy[i] <= 0) continue;
        const t = world.tribeById.get(pop.tribe[i]);
        const task = pop.task[i];
        if (task === TASK.CRAFT) t.crafting++;
        else if (task === TASK.WOOD) t.chopping++;
        else if (task === TASK.FLINT) t.quarrying++;
        if (pop.age[i] < P.maturity) continue;
        if (pl !== null && pl.crafting && pl.id === pop.id[i]) t.kinds[pl.crafting.kind]++; // (what the player is making)
        const w = pop.weapon[i] ? items.get(pop.weapon[i]) : undefined;
        if (w === undefined) t.unarmed++;
        else if (fraction(world, w) >= I.worn) {
            t.kinds[w.kind]++;
            t.armed++;
        }
        const u = pop.tool[i] ? items.get(pop.tool[i]) : undefined;
        if (u !== undefined && fraction(world, u) >= I.worn) {
            t.kinds[u.kind]++;
            t.tooled++;
        }
    }
    for (const t of world.tribes) {
        let weapons = 0;
        let tools = 0;
        for (const id of t.goods) {
            const item = items.get(id);
            if (fraction(world, item) < I.worn) continue;
            t.kinds[item.kind]++;
            if (isWeapon(item.kind)) weapons++;
            else tools++;
        }
        // (A hungry camp, one whose store could not pay for a birth, makes
        // only weapons for those with none, and knives: food comes first.)
        const A = t.adults;
        const fed = t.store >= P.birthCost + P.reserve * t.members;
        const needW = (fed ? A - t.armed : t.unarmed) - weapons;
        const needT = A - t.tooled - tools;
        let want = 0;
        let wanted = 0;
        if (needW > 0) {
            want = weaponFor(world.p, t, A);
            wanted = needW;
        } else if (needT > 0 && t.store >= I.tools * (P.birthCost + P.reserve * t.members)) {
            want = toolFor(t, A);
            wanted = needT;
        } else if (needT > 0 && (t.flintSpot !== null || t.flint >= 1)) {
            want = KIND.KNIFE;
            wanted = needT;
        }
        t.want = want;
        t.wanted = wanted;
        const cost = want ? costOf(world.p, want) : null;
        t.needWood = cost !== null && t.wood < cost.wood;
        t.needFlint = cost !== null && t.flint < cost.flint;
    }
}

// The weapon a tribe makes next: clubs up to a share of its adults that
// grows with its aggression, bows up to one that grows with its sociality
// (the more, the less aggressive it is; and if it has a hide for one), else
// spears.
function weaponFor(p, t, A) {
    if (t.kinds[KIND.CLUB] < Math.round(0.15 * t.aggression * A)) return KIND.CLUB;
    if (t.kinds[KIND.BOW] < Math.round(0.6 * t.sociality * (1 - 0.5 * t.aggression) * A) && t.hide >= p.items.costs.bow.hide) return KIND.BOW;
    return KIND.SPEAR;
}

// The tool a tribe makes next: the kind furthest below its share of the
// adults (knives grow with aggression, baskets with sociality; torches a
// small, steady share); knives only where it can find flint.
function toolFor(t, A) {
    const shares = [0, 0, 0, 0, 0.3 + 0.5 * t.aggression, 0.2 + 0.6 * t.sociality, 0.1];
    let best = 0;
    let most = -Infinity;
    for (const k of TOOLS) {
        if (k === KIND.KNIFE && t.flintSpot === null && t.flint < 1) continue;
        const gap = shares[k] * A - t.kinds[k];
        if (gap > most) {
            most = gap;
            best = k;
        }
    }
    return best;
}
