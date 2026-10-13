// Items in the hands of the person the page controls (package 3): what the
// items' acts do. All of them are ignored with items off (player.js's table
// of acts says which need items).
//
//   craft    make an item at camp (startCrafting): the materials are taken
//            from the store now, and it is done after items.craftSteps
//            (finishCrafting), into the empty hand, else the kit, else the
//            camp's goods; a move stops it (stopCrafting) and the materials
//            go back
//   skill    the weapon's skill, for Spirit (SKILLS in items.js)
//   tool     the tool in hand: a knife cuts (or, by a carcass, butchers), a
//            torch drives off predators near, a basket gathers
//   pickup   take up an item lying near; what was in hand into the kit
//   cycle    the next spare into the hand
//   drop     put an item in hand or in the kit down
//
// The kit (player.kit: {weapons, tools}, item ids) holds up to items.kit
// spares of each, besides the weapon and the tool in hand (the person's
// columns, items.js).
import { STATE } from '../population.js';
import { strike, aimAt } from '../spears.js';
import { KIND, SKILLS, isWeapon, weaponStats, hold, unhold, lay, putDown, wearItem, heldLike, affords, spend } from '../items.js';
import { craft } from '../tasks.js';
import { wrapDelta } from '../util.js';
import { AIM, ARM, aim, loose, inFront, inCamp } from './hands.js';

// ---- Weapon skills and tools ------------------------------------------------------------

// The weapon's skill (SKILLS), for its Spirit: a Piercing throw (a heavy
// throw that passes through items.pierce creatures), a Volley (items.volley
// arrows in a fan), a Ground slam (every predator within items.slam driven
// off). A legend's is stronger: twice the piercing, two more arrows, half
// as far again.
export function useSkill(world, i, a) {
    const P = world.p.human;
    const I = world.p.items;
    const pl = world.player;
    const pop = world.humans;
    const weapon = pop.weapon[i] ? world.items.get(pop.weapon[i]) : undefined;
    const skill = weapon ? SKILLS[weapon.kind] : null;
    if (!skill || pop.age[i] < P.maturity || pop.timer[i] > 0 || pl.spirit < skill.cost) return;
    pl.spirit -= skill.cost;
    pl.resting = false;
    pl.gather = false;
    pl.butcher = 0;
    const legend = weapon.rarity === 2;
    weaponStats(world, weapon, ARM);
    pop.timer[i] = ARM.reload;
    aim(world, i, a);
    const ux = AIM.x;
    const uy = AIM.y;
    const x = pop.x[i];
    const y = pop.y[i];
    world.events.push({ type: 'skill', id: pop.id[i], kind: weapon.kind, name: legend ? weapon.legend.skill : '', x, y, dx: ux, dy: uy, time: world.time });
    if (weapon.kind === KIND.SPEAR) {
        loose(world, i, ux, uy, 1, a.target, a.lock, weapon, legend ? 2 * I.pierce : I.pierce);
    } else if (weapon.kind === KIND.BOW) {
        // (Aimed at the lock-on, the middle arrow is led onto it; the fan around that.)
        let cx = ux;
        let cy = uy;
        const speed = world.p.play.heavySpeed * I.arrowSpeed;
        if (a.target && a.lock && aimAt(world, x, y, speed, a.target, AIM)) {
            cx = AIM.x;
            cy = AIM.y;
        }
        const n = legend ? I.volley + 2 : I.volley;
        for (let k = 0; k < n; k++) {
            const t = (k - (n - 1) / 2) * I.volleyFan;
            const c = Math.cos(t);
            const s = Math.sin(t);
            loose(world, i, cx * c - cy * s, cx * s + cy * c, 1, 0, false, weapon, 0);
        }
    } else {
        const R = I.slam * (legend ? 1.5 : 1);
        drive(world, x, y, R, world.p.carnivore.rest * 2);
    }
    wearItem(world, i, weapon);
}

// Every predator within R of (x, y) is driven off: it backs away to rest for
// `steps`.
function drive(world, x, y, R, steps) {
    const c = world.carnivores;
    for (let k = 0; k < c.n; k++) {
        if (c.energy[k] <= 0) continue;
        const dx = wrapDelta(c.x[k] - x, world.width);
        const dy = wrapDelta(c.y[k] - y, world.height);
        if (dx * dx + dy * dy > R * R) continue;
        c.timer[k] = steps;
        c.state[k] = STATE.RESTING;
        c.focus[k] = 0;
        c.heading[k] = Math.atan2(dy, dx); // (facing away)
    }
}

// The tool in hand (right click): a knife cuts what is within items.cutReach
// in front (with chance items.cutHit), or, by a carcass, butchers it (twice
// as fast); a torch is brandished, driving off predators within
// items.torchReach (× its effect) at the cost of a tenth of its burning;
// a basket starts or stops gathering, like E.
export function useTool(world, i, a) {
    const I = world.p.items;
    const Q = world.p.play;
    const pl = world.player;
    const pop = world.humans;
    const tool = pop.tool[i] ? world.items.get(pop.tool[i]) : undefined;
    if (!tool) return;
    aim(world, i, a);
    const ux = AIM.x;
    const uy = AIM.y;
    const x = pop.x[i];
    const y = pop.y[i];
    world.events.push({ type: 'tool', id: pop.id[i], kind: tool.kind, x, y, dx: ux, dy: uy, time: world.time });
    if (tool.kind === KIND.BASKET) {
        pl.gather = !pl.gather;
        if (pl.gather) {
            pl.butcher = 0;
            pl.resting = false;
            pl.strokes = 0;
        }
        return;
    }
    pl.resting = false;
    if (tool.kind === KIND.TORCH) {
        const m = tool.trait === 'effect' ? tool.mult : 1;
        drive(world, x, y, I.torchReach * m, world.p.carnivore.rest);
        if (tool.rarity < 2) tool.expires -= 0.1 * tool.max;
        return;
    }
    // A knife: by a carcass, cut it up; otherwise a quick cut.
    let near = 0;
    let best = Q.butcherReach * Q.butcherReach;
    for (const c of world.carcasses.values()) {
        const dx = wrapDelta(c.x - x, world.width);
        const dy = wrapDelta(c.y - y, world.height);
        if (dx * dx + dy * dy <= best) {
            best = dx * dx + dy * dy;
            near = c.id;
        }
    }
    if (near) {
        pl.butcher = near;
        pl.gather = false;
        return;
    }
    if (pop.age[i] < world.p.human.maturity) return;
    const n = inFront(world, i, ux, uy, I.cutReach);
    if (n === null) return;
    if (world.rng.next() < I.cutHit) {
        const d = n.d || 1;
        strike(world, n.pop, n.j, pop.id[i], n.dx / d, n.dy / d, KIND.KNIFE, tool.id);
    }
    wearItem(world, i, tool);
}

// ---- The hand and the kit ---------------------------------------------------------------

// Take up the item a.item lying within items.pickReach: into its hand; what
// was there into the kit, or (the kit full) down where it stands.
export function pickUp(world, i, a) {
    const I = world.p.items;
    const pl = world.player;
    const pop = world.humans;
    const item = world.items.get(a.item);
    if (!item || item.bearer !== 0) return;
    const dx = wrapDelta(item.x - pop.x[i], world.width);
    const dy = wrapDelta(item.y - pop.y[i], world.height);
    if (dx * dx + dy * dy > I.pickReach * I.pickReach) return;
    const held = heldLike(world, i, item.kind);
    if (held) {
        const spares = isWeapon(held.kind) ? pl.kit.weapons : pl.kit.tools;
        if (spares.length < I.kit) {
            unhold(world, i, held);
            spares.push(held.id);
        } else putDown(world, i, held);
    }
    hold(world, i, item);
    world.events.push({ type: 'picked', item: item.id, by: pop.id[i], time: world.time });
}

// The next spare for the slot a.slot ('weapon' | 'tool') into the hand;
// what was there to the back of the kit.
export function cycle(world, i, a) {
    const pl = world.player;
    const pop = world.humans;
    const tools = a.slot === 'tool';
    const spares = tools ? pl.kit.tools : pl.kit.weapons;
    if (spares.length === 0) return;
    const next = world.items.get(spares.shift());
    const id = tools ? pop.tool[i] : pop.weapon[i];
    if (id) {
        unhold(world, i, world.items.get(id));
        spares.push(id);
    }
    if (next) hold(world, i, next);
}

// Put the item a.item down, from the hand or the kit, where the person stands.
export function drop(world, i, a) {
    const pl = world.player;
    const pop = world.humans;
    const id = a.item;
    const item = world.items.get(id);
    if (!item || item.bearer !== pop.id[i]) return;
    for (const list of [pl.kit.weapons, pl.kit.tools]) {
        const k = list.indexOf(id);
        if (k >= 0) list.splice(k, 1);
    }
    putDown(world, i, item);
}

// ---- Crafting at camp -------------------------------------------------------------------

// Start making an item of a.kind at camp, if the store has the materials
// (taken now; and a flint more, if asked for and there, for a chance of rare).
export function startCrafting(world, i, a) {
    const P = world.p.human;
    const pl = world.player;
    const pop = world.humans;
    const kind = a.kind;
    if (pl.crafting !== null || !(kind >= KIND.SPEAR && kind <= KIND.TORCH) || pop.age[i] < P.maturity || !inCamp(world, pl.id)) return;
    const tribe = world.tribeById.get(pop.tribe[i]);
    if (!affords(world.p, tribe, kind)) return;
    spend(world.p, tribe, kind);
    let flint = false;
    if (a.flint && tribe.flint >= 1) {
        tribe.flint -= 1;
        flint = true;
    }
    pl.crafting = { kind, flint, until: world.time + world.p.items.craftSteps, tribe: tribe.id };
    pl.resting = false;
    pl.gather = false;
    pl.butcher = 0;
}

// Done: into the empty hand, else the kit, else among the camp's goods.
export function finishCrafting(world, i) {
    const pl = world.player;
    const pop = world.humans;
    const c = pl.crafting;
    pl.crafting = null;
    const tribe = world.tribeById.get(pop.tribe[i]);
    const item = craft(world, i, c.kind, c.flint, tribe);
    const spares = isWeapon(item.kind) ? pl.kit.weapons : pl.kit.tools;
    if (heldLike(world, i, item.kind) === null) hold(world, i, item);
    else if (spares.length < world.p.items.kit) {
        spares.push(item.id);
        item.bearer = pop.id[i];
        item.last = pop.id[i];
        item.gens = 1;
        item.line = pop.id[i];
    } else lay(world, item, pop.x[i], pop.y[i], tribe);
}

// Stop making it: the materials go back to the store.
export function stopCrafting(world, pl) {
    const c = pl.crafting;
    if (!c) return;
    pl.crafting = null;
    const tribe = world.tribeById.get(c.tribe);
    if (!tribe) return;
    spend(world.p, tribe, c.kind, -1);
    if (c.flint) tribe.flint += 1;
}
