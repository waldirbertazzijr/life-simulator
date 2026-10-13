// The person the page controls: everything the simulation knows about it.
//
// `world.player` is null while nobody is controlled, and every hook in the
// engine (world.js, humans.js) checks that first. So a world nobody controls
// runs exactly as it always did, drawing the same random numbers.
//
// When someone is controlled, it is a small plain object:
//
//   id        the person (0: a Play game that has ended)
//   mode      'god' (a sandbox: anyone, any time) or 'play' (lead one tribe)
//   tribe     the tribe of the person controlled
//   input     the latest position the page proposed, not yet checked
//   seq       the last input accepted for this body (the page numbers them)
//   lastStep  when it was accepted
//   crouch    the posture the page says the body is in
//   speed     the pace the page says it moves at (units/step): walking or running
//   rollUntil a dodge roll lasts until this world time
//   resting   sitting at camp
//   spirit    the player's own reserve (weapon skills, calls: later packages)
//   snap      the simulation moved the body itself: the page must jump to it
//   heir      the id taken over at the latest hand-off, until it is reported
//   over      Play mode: the line and the tribe are gone
//   auto      autopilot: the page is on the map, and the AI runs the person
//   x, y, heading  where the body was last seen alive
//   lastTarget, calls, rally  what the latest attack went for, calls not yet
//             heard, and a rally under way (orders.js adds them when needed)
//
// On autopilot the person lives exactly as if nobody controlled it: no input,
// no wounds instead of death, no rolls, no crouching (wounds exist because
// you steer by hand). Only the heir rules (afterStep) still apply.
//
// With items (items.js, package 3) the player also has
//
//   kit       {weapons, tools}: up to items.kit spares of each (item ids),
//             besides the weapon and the tool in hand (the person's columns)
//   crafting  {kind, flint, until, tribe}: an item being made at camp, or null
//   wood, flint  the load of materials it carries (gathered by hand: E in
//             forest or on rock), until it stores it at the rack; at most
//             items.load in all (× a basket's carry). The body's: lost when
//             it dies, taken home by the AI when the page leaves it (and an
//             AI errand's load is the player's when the page takes over).
//   work      what the hands gathered at the last step (TASK: NONE is food)
//
// The page moves the body (src/play/body.js); here it is only checked, and
// everything that is not a decision still happens to it as to anyone.
import { STATE } from './population.js';
import { strike, aimAt } from './spears.js';
import { giveCall } from './orders.js';
import {
    ITEM_KINDS, KIND, SKILLS, TASK, isWeapon, weaponStats, hold, unhold, lay, putDown, wearItem, heldLike,
    affords, spend, craft, carryOf, handWork, yieldAt,
} from './items.js';

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
// (A position already on the world is kept exactly as the page sent it.)
const wrapPos = (v, size) => (v >= 0 && v < size ? v : ((v % size) + size) % size);

// The index of the living person with this id, or -1.
function indexOf(pop, id) {
    const ids = pop.id;
    for (let i = 0; i < pop.n; i++) if (ids[i] === id) return pop.energy[i] > 0 ? i : -1;
    return -1;
}

// Take over the person `id` in `mode` ('god' or 'play'), or let go with id 0.
// False, with nothing changed, if there is no such person alive.
export function takeControl(world, id, mode) {
    if (!id) {
        if (world.player !== null) leaveBody(world, world.player);
        world.player = null;
        return true;
    }
    const pop = world.humans;
    const i = indexOf(pop, id);
    if (i < 0) return false;
    const before = world.player;
    if (before !== null && before.id !== id) leaveBody(world, before);
    const same = before !== null && before.id === id;
    world.player = {
        id,
        mode: mode === 'play' ? 'play' : 'god',
        tribe: pop.tribe[i],
        input: null,
        seq: 0, // the page may number a new body's inputs from scratch
        crouch: false,
        speed: 0,
        rollUntil: 0,
        resting: false,
        // Spirit is the player's, not the body's: it carries over to the next one.
        spirit: before !== null && !before.over ? before.spirit : world.p.play.spiritMax,
        snap: false,
        heir: 0,
        over: false,
        auto: false,
        acts: [],    // the hands' one-off acts, carried out at the next step (useHands)
        gather: false, // gathering, until it stops
        butcher: 0,  // the carcass being butchered (its id), or 0
        // Spares, an item being made, and wood and flint carried (items.js):
        // kept if it is the same body again.
        kit: same && before.kit ? before.kit : { weapons: [], tools: [] },
        crafting: same ? before.crafting ?? null : null,
        wood: same ? before.wood ?? 0 : 0,
        flint: same ? before.flint ?? 0 : 0,
        work: TASK.NONE,
        strokes: 0,
        lastStep: world.time,
        // Where it was last seen alive (all that is left to report once over).
        x: pop.x[i],
        y: pop.y[i],
        heading: pop.heading[i],
    };
    if (world.itemsOn) clearTask(world, i); // (the AI's task for the tribe, if it had one)
    world.follow(id);
    return true;
}

// The page's latest proposal for the body {seq, x, y, heading, speed, crouch}.
// Only the newest counts, and its position is checked at the next step. The
// posture is the page's to say, so it counts at once. (Copied: with
// ?noworker the message is the page's own object, which it may reuse.)
export function applyInput(world, msg) {
    const pl = world.player;
    if (pl === null || pl.id === 0 || pl.auto) return;
    const seq = Number(msg.seq);
    if (!(seq > pl.seq) || (pl.input !== null && seq <= pl.input.seq)) return;
    pl.input = { seq, x: Number(msg.x), y: Number(msg.y), heading: Number(msg.heading), speed: Number(msg.speed) || 0 };
    pl.crouch = msg.crouch === true;
}

// A one-off action {seq, action, ...}: 'roll', a dodge roll (bites miss for
// play.rollSteps steps); 'rest' {on}, to sit down at camp (only inside it)
// or get up; 'auto' {on}, autopilot on or off; 'call' {kind, x, y}, a call
// to your tribe (orders.js); and the hands' (HANDS, see handAct). Others are
// ignored, so the page can be ahead of the simulation. On autopilot, only
// 'auto' and 'call' count (orders can be given from the map).
export function applyAct(world, msg) {
    const pl = world.player;
    if (pl === null || pl.id === 0) return;
    // What you attack, your followers go for too (orders.js).
    if (msg.action === 'attack' && msg.target > 0) pl.lastTarget = Number(msg.target);
    if (msg.action === 'auto') {
        const on = msg.on === true;
        if (on === pl.auto) return;
        pl.auto = on;
        pl.input = null;
        pl.crouch = false;
        pl.speed = 0;
        pl.resting = false;
        pl.rollUntil = 0;
        idleHands(pl);
        stopCrafting(world, pl);
        if (!on) {
            // Back by hand: the page jumps its body to where the AI left it,
            // and numbers its inputs afresh, as for an heir. (Whatever the AI
            // was doing for the tribe is let go.)
            pl.snap = true;
            pl.seq = 0;
            pl.lastStep = world.time;
            if (world.itemsOn) {
                const i = indexOf(world.humans, pl.id);
                if (i >= 0) clearTask(world, i);
            }
        }
    } else if (msg.action === 'call') {
        giveCall(world, msg);
    } else if (pl.auto) {
        // The AI decides.
    } else if (msg.action === 'roll') {
        pl.rollUntil = world.time + world.p.play.rollSteps;
        pl.resting = false;
    } else if (msg.action === 'rest') {
        pl.resting = msg.on === true && inCamp(world, pl.id);
        if (pl.resting) {
            idleHands(pl);
            stopCrafting(world, pl);
        }
    } else if (HANDS.has(msg.action)) {
        handAct(pl, msg);
    }
}

function inCamp(world, id) {
    const pop = world.humans;
    const i = indexOf(pop, id);
    if (i < 0) return false;
    const camp = world.tribeById.get(pop.tribe[i]).camp;
    const dx = wrapDelta(camp.x - pop.x[i], world.width);
    const dy = wrapDelta(camp.y - pop.y[i], world.height);
    const R = world.p.human.campRadius;
    return dx * dx + dy * dy < R * R;
}

// A predator (carnivore i) has caught the controlled person (person j), and
// no tribe-mate drove it off. Anyone else would be eaten; the player is
// bitten for play.bite and the predator backs off to rest, as if driven off.
// Mid-roll, the bite misses and the chase goes on. True if the person lives
// through it; false if this bite kills, and the predator eats as usual.
export function caught(world, i, j) {
    const pl = world.player;
    const pop = world.humans;
    const predators = world.carnivores;
    const { time } = world;
    if (time < pl.rollUntil) {
        world.events.push({ type: 'dodge', id: pop.id[j], by: predators.id[i], time });
        return true;
    }
    const damage = world.p.play.bite;
    pl.resting = false;
    pl.gather = false; // (whatever the hands were at)
    pl.butcher = 0;
    world.events.push({ type: 'bite', id: pop.id[j], by: predators.id[i], x: pop.x[j], y: pop.y[j], damage, time });
    if (pop.energy[j] <= damage) return false;
    pop.energy[j] -= damage;
    predators.timer[i] = world.p.carnivore.rest;
    predators.state[i] = STATE.RESTING;
    return true;
}

// One step of the controlled person, in place of the AI (stepHumans hands it
// over). Where it goes, and what its hands do, are the page's decisions
// (dropping food off at camp too: E at the rack); everything else happens as
// it does to anyone: ageing, eating at camp, eating what it carries when
// starving, metabolism, starving to death. And Spirit.
export function stepPlayer(world, i) {
    const P = world.p.human;
    const Q = world.p.play;
    const pl = world.player;
    const pop = world.humans;
    const { x, y, heading, energy, age, lifespan, speedGene, upkeep, timer, state, focus, carry } = pop;
    const { width: W, height: H, terrain, time } = world;
    if (++age[i] > lifespan[i]) {
        world.die(pop, i, 'old age');
        return;
    }
    const tribe = world.tribeById.get(pop.tribe[i]);
    const top = P.speed * speedGene[i];
    const rolling = time < pl.rollUntil;
    focus[i] = 0;
    if (timer[i] > 0) timer[i]--; // spear "reload"

    // Move to where the page has the body, if it could have got there: no
    // farther than top speed allows in the steps since the last accepted move
    // (at most maxCatchUp of them, so a pause or a hidden page earns no
    // teleport), plus some slack for the page's uneven frames; measured across
    // the world's edges; and not onto water or a cliff. Otherwise it stays put
    // and the page is told to jump back to it.
    let moveCost = 0;
    let moved = 0;
    const input = pl.input;
    if (input !== null) {
        pl.input = null;
        let steps = time - pl.lastStep;
        if (steps < 1) steps = 1;
        else if (steps > Q.maxCatchUp) steps = Q.maxCatchUp;
        const reach = (rolling && Q.rollSpeed > top ? Q.rollSpeed : top) * steps + Q.slack;
        const nx = wrapPos(input.x, W);
        const ny = wrapPos(input.y, H);
        const dx = wrapDelta(nx - x[i], W);
        const dy = wrapDelta(ny - y[i], H);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= reach && (terrain === null || !terrain.blocked(nx, ny))) { // (NaN fails the first test)
            x[i] = nx;
            y[i] = ny;
            if (Number.isFinite(input.heading)) heading[i] = input.heading;
            // Moving d in one go over `steps` steps costs what moving d/steps
            // in each of them would have (P.moveCost × v² a step).
            moveCost = (P.moveCost * d * d) / steps;
            moved = d;
            pl.speed = input.speed;
            pl.seq = input.seq;
            pl.lastStep = time;
        } else {
            pl.speed = 0;
            pl.snap = true;
        }
    }

    // What the hands do, from where the body now is (packages 2 and 3, below).
    if (pl.acts.length !== 0 || pl.gather || pl.butcher !== 0 || pl.crafting !== null) useHands(world, i, moved);

    const campDx = wrapDelta(tribe.camp.x - x[i], W);
    const campDy = wrapDelta(tribe.camp.y - y[i], H);
    const atCamp = campDx * campDx + campDy * campDy < P.campRadius * P.campRadius;
    if (!atCamp) pl.resting = false; // walked off
    let e = energy[i];
    let c = carry[i];
    if (atCamp) {
        // Home: eat from the store if hungry. (What it carries stays in its
        // hands until it puts it in the store itself, at the rack: store.)
        if (e < P.hunger * P.maxEnergy && tribe.store > 0) {
            let take = P.maxEnergy * 0.9 - e;
            if (take > tribe.store) take = tribe.store;
            tribe.store -= take;
            e += take;
        }
    } else if (e < P.starving * P.maxEnergy && c > 0) {
        // Far from home and starving: eat what you carry.
        let take = P.maxEnergy * 0.5 - e;
        if (take > c) take = c;
        c -= take;
        e += take;
    }
    e -= P.baseCost * upkeep[i] + moveCost;
    if (e > P.maxEnergy) e = P.maxEnergy;
    carry[i] = c;

    // What it is doing, for the panel and the bodies drawn: the page's gait,
    // a run being nearer a sprint than a walk.
    const speed = pl.speed;
    state[i] = pl.resting ? STATE.AT_CAMP
        : pl.crafting !== null ? STATE.CRAFTING
        : pl.butcher !== 0 ? STATE.BUTCHERING
        : pl.gather ? (pl.work === TASK.WOOD ? STATE.CHOPPING : pl.work === TASK.FLINT ? STATE.QUARRYING : STATE.GATHERING)
        : rolling ? STATE.ROLLING
        : pl.crouch ? STATE.CREEPING
        : speed > (top * (1 + P.cruise)) / 2 ? STATE.RUNNING
        : speed > 0 ? STATE.WALKING
        : atCamp ? STATE.AT_CAMP : STATE.WALKING;

    // Spirit comes back slowly, and fast while resting at camp.
    pl.spirit += Q.spiritRegen + (pl.resting ? Q.spiritRest : 0);
    if (pl.spirit > Q.spiritMax) pl.spirit = Q.spiritMax;

    if (e <= 0) {
        world.die(pop, i, 'starvation');
        return;
    }
    energy[i] = e;
}

// At the end of each step (World.step): if the controlled person has died,
// carry on as its heir. With nobody to carry on, God mode lets go and a Play
// game is over.
export function afterStep(world) {
    const pl = world.player;
    if (pl.over) return;
    const pop = world.humans;
    const i = indexOf(pop, pl.id);
    if (i >= 0) {
        // Alive: note its tribe (it may have split off) and where it is.
        pl.tribe = pop.tribe[i];
        pl.x = pop.x[i];
        pl.y = pop.y[i];
        pl.heading = pop.heading[i];
        return;
    }
    const from = pl.id;
    const { time } = world;
    const next = heirOf(world, from, pl.tribe);
    pl.wood = 0; // (what the dead carried is lost with them)
    pl.flint = 0;
    if (next < 0) {
        if (pl.mode === 'play') {
            pl.over = true;
            pl.id = 0;
            pl.input = null;
            pl.crouch = false;
            pl.speed = 0;
            pl.resting = false;
            pl.rollUntil = 0;
            idleHands(pl);
            stopCrafting(world, pl);
            world.events.push({ type: 'over', time });
        } else {
            stopCrafting(world, pl);
            world.player = null;
            world.events.push({ type: 'released', reason: 'no heir', time });
        }
        return;
    }
    // The page must jump to the new body; its inputs for the old one will be
    // turned down (and it told to jump again) until it does.
    pl.id = pop.id[next];
    pl.tribe = pop.tribe[next]; // a descendant in another tribe: lead that tribe now
    pl.heir = pl.id;
    pl.snap = true;
    pl.input = null;
    pl.seq = 0; // as for any new body
    pl.lastStep = time;
    pl.crouch = false;
    pl.speed = 0;
    pl.resting = false;
    pl.rollUntil = 0;
    idleHands(pl);
    stopCrafting(world, pl);
    if (world.itemsOn) clearTask(world, next);
    pl.x = pop.x[next];
    pl.y = pop.y[next];
    pl.heading = pop.heading[next];
    world.events.push({ type: 'heir', from, to: pl.id, parent: pop.parent[next], time }); // parent: the heir's (an id, 0 if none)
    world.follow(pl.id);
}

// Who carries on when the person `id` of `tribe` dies (its index, or -1):
// (1) its eldest living child; (2) another living descendant
// (World.descendant: they are tagged since control began, World.follow);
// (3) the eldest of its tribe, an adult if there are any (any adult is
// older than any child); (4) nobody. Run after the dead are removed.
function heirOf(world, id, tribe) {
    const pop = world.humans;
    const { parent, age } = pop;
    let best = -1;
    for (let k = 0; k < pop.n; k++) if (parent[k] === id && (best < 0 || age[k] > age[best])) best = k;
    if (best >= 0) return best;
    best = indexOf(pop, world.descendant(id));
    if (best >= 0) return best;
    for (let k = 0; k < pop.n; k++) if (pop.tribe[k] === tribe && (best < 0 || age[k] > age[best])) best = k;
    return best;
}

// What the hands gather, by TASK (NONE: food), as snapshot.player says it.
const GATHERED = ['food', 'food', 'wood', 'flint', 'food'];

// Is individual i of `pop` the controlled person? (On autopilot too.)
export function isControlled(world, pop, i) {
    return world.player !== null && pop === world.humans && pop.id[i] === world.player.id;
}

// What the page needs to know about the controlled person, or null. Reading
// it reports `snap` and `heir`, so each is sent once.
export function playerSnapshot(world) {
    const pl = world.player;
    if (pl === null) return null;
    const pop = world.humans;
    const i = pl.id ? indexOf(pop, pl.id) : -1;
    const alive = i >= 0;
    const out = {
        id: pl.id,
        mode: pl.mode,
        tribe: alive ? pop.tribe[i] : pl.tribe,
        energy: alive ? pop.energy[i] : 0,
        carry: alive ? pop.carry[i] : 0,
        spirit: pl.spirit,
        crouch: pl.crouch,
        resting: pl.resting,
        dodging: world.time < pl.rollUntil,
        snap: pl.snap,
        heir: pl.heir,
        over: pl.over,
        x: alive ? pop.x[i] : pl.x,
        y: alive ? pop.y[i] : pl.y,
        heading: alive ? pop.heading[i] : pl.heading,
        seq: pl.seq,
        auto: pl.auto,
        // The hands: steps until the spear is back (0: ready), and what they
        // are at: gathering 'food', 'wood' or 'flint' (by the ground
        // underfoot: items.js handWork), or not (false); butchering a carcass
        // (its id, 0: not).
        reload: alive ? pop.timer[i] : 0,
        gathering: pl.gather && alive ? GATHERED[world.itemsOn ? handWork(world, pop.x[i], pop.y[i], world.tribeById.get(pop.tribe[i])) : TASK.NONE] : false,
        butchering: pl.butcher,
        // The wood and flint it carries, and the most it can (items.load, × a basket's carry).
        wood: pl.wood,
        flint: pl.flint,
        loadMax: alive && world.itemsOn ? loadMax(world, i) : 0,
        // Items (package 3): what is in hand (item ids, 0: none), the spares,
        // what is being made ({kind, until}: done at that world time), and
        // the Spirit the weapon's skill costs (0: none).
        weapon: alive ? pop.weapon[i] : 0,
        tool: alive ? pop.tool[i] : 0,
        kit: { weapons: pl.kit.weapons.slice(), tools: pl.kit.tools.slice() },
        crafting: pl.crafting === null ? null : { kind: pl.crafting.kind, until: pl.crafting.until },
        skill: 0,
    };
    if (alive && pop.weapon[i]) {
        const weapon = world.items.get(pop.weapon[i]);
        const skill = weapon ? SKILLS[weapon.kind] : null;
        if (skill) out.skill = skill.cost;
    }
    pl.snap = false;
    pl.heir = 0;
    return out;
}

// ---- The hands (package 2) ---------------------------------------------------
//
// The page asks; here, at the next step, it happens (an act arrives between
// steps, and a kill there would be stepped again, and its events lost):
//
//   attack {heavy, dx, dy, power, target, lock}   a jab at a creature within
//            reach in front, or a spear thrown along (dx, dy), or, if
//            `target` is the lock-on (lock, true unless said otherwise),
//            led onto it; `target` is what the attack goes for, which
//            followers go for too (orders.js); heavy: always a throw,
//            farther and faster with its power (0..1). Not for children, nor
//            before the spear is back (human.reload). spears.js does the rest.
//   butcher {on, id}   cut up the carcass `id`, close by (one of the
//            player's kills), into the pouch
//   gather {on}        take from the ground underfoot, outside camp: with
//            items, in forest chop wood, on rock (a little on tundra) knap
//            flint (items.js handWork: the page's prompt uses it too), into
//            the load (wood, flint) at an errand's rates (yieldAt), until it
//            is full; elsewhere, food from the grass into the pouch, as
//            gatherers do
//   eat                eat from the pouch
//   store, take        at the camp's rack: put everything carried into the
//            tribe's store (food, hides, wood, flint); with empty hands,
//            take food for the road
//
// Butchering and gathering go on from step to step until they are done, the
// page says stop, or the body moves.
//
// And with items (package 3; all ignored with items off):
//
//   craft {kind, flint}   make an item at camp (a KIND code or its name),
//            the materials taken from the store now (and a flint more for a
//            chance of rare); done after items.craftSteps, into the empty
//            hand, else the kit, else the camp's goods. A move stops it, and
//            the materials go back.
//   skill {dx, dy, target, lock}   the weapon's skill, for Spirit (SKILLS)
//   tool {dx, dy, target}   the tool: a knife cuts (or, by a carcass,
//            butchers), a torch drives off predators near, a basket gathers
//   pickup {item}   take up an item lying within items.pickReach: into its
//            hand, what was there into the kit (or down, if the kit is full)
//   cycle {slot}    'weapon' | 'tool': the next spare into the hand
//   drop {item}     put an item in hand or in the kit down

const HANDS = new Set(['attack', 'butcher', 'gather', 'eat', 'store', 'take', 'craft', 'skill', 'tool', 'pickup', 'cycle', 'drop']);
const MOVED = 0.05; // a move longer than this (units) stops butchering, gathering and crafting
const AIM = { x: 0, y: 0 };
const ARM = { item: null, kind: 0, range: 0, range2: 0, hit: 1, reload: 0 }; // the player's weapon (weaponStats)

// An act of the hands, from the page: one-offs wait for the next step;
// butchering and gathering are switched on or off. (Copied: with ?noworker
// the message is the page's own object.)
function handAct(pl, msg) {
    const a = msg.action;
    if (a === 'butcher') {
        pl.butcher = msg.on === true && Number(msg.id) > 0 ? Number(msg.id) : 0;
        if (pl.butcher) pl.gather = false;
    } else if (a === 'gather') {
        pl.gather = msg.on === true;
        if (pl.gather) {
            pl.butcher = 0;
            pl.strokes = 0;
        }
    } else if (pl.acts.length < 8) {
        const power = Number(msg.power);
        pl.acts.push({
            action: a, heavy: msg.heavy === true, dx: Number(msg.dx), dy: Number(msg.dy),
            power: Number.isFinite(power) ? (power < 0 ? 0 : power > 1 ? 1 : power) : 1,
            target: Number(msg.target) || 0, lock: msg.lock !== false,
            // (items)
            kind: typeof msg.kind === 'number' ? msg.kind : ITEM_KINDS.indexOf(String(msg.kind)), flint: msg.flint === true,
            item: Number(msg.item) || 0, slot: msg.slot === 'tool' ? 'tool' : 'weapon',
        });
    }
    if (pl.gather || pl.butcher) pl.resting = false;
}

// The hands put down: nothing waiting, nothing under way.
function idleHands(pl) {
    pl.acts.length = 0;
    pl.gather = false;
    pl.butcher = 0;
}

// One step of the hands (stepPlayer), for person i, whose body moved
// `moved` this step.
function useHands(world, i, moved) {
    const pl = world.player;
    const acts = pl.acts;
    const items = world.itemsOn;
    if (moved > MOVED) stopCrafting(world, pl); // (before this step's acts: a craft asked for now is made where it stands)
    for (let k = 0; k < acts.length; k++) {
        const a = acts[k];
        if (a.action === 'attack') attack(world, i, a);
        else if (a.action === 'eat') eat(world, i);
        else if (a.action === 'store') store(world, i);
        else if (a.action === 'take') take(world, i);
        else if (!items) continue;
        else if (a.action === 'craft') startCrafting(world, i, a);
        else if (a.action === 'skill') useSkill(world, i, a);
        else if (a.action === 'tool') useTool(world, i, a);
        else if (a.action === 'pickup') pickUp(world, i, a.item);
        else if (a.action === 'cycle') cycle(world, i, a.slot);
        else if (a.action === 'drop') drop(world, i, a.item);
    }
    acts.length = 0;
    if (moved > MOVED) {
        pl.gather = false;
        pl.butcher = 0;
    }
    if (pl.crafting !== null && world.time >= pl.crafting.until) finishCrafting(world, i);
    if (pl.butcher !== 0) butcher(world, i);
    else if (pl.gather) gather(world, i);
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

// Eat from the pouch: up to play.eatMax, never past full.
function eat(world, i) {
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
function store(world, i) {
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
function take(world, i) {
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
function gather(world, i) {
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
    const H = world.p.materials;
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
    if (!wood && (pop.gear[i] & 7) === KIND.KNIFE) gain *= H.knifeKnap;
    if (gain > room) gain = room;
    if (wood) pl.wood += gain;
    else pl.flint += gain;
    if (pl.strokes++ % (wood ? H.chopEvery : H.knapEvery) === 0) {
        world.events.push({ type: wood ? 'chop' : 'knap', id: pop.id[i], x, y, time: world.time });
    }
}

// The most wood and flint person i can carry: items.load, more with a basket.
const loadMax = (world, i) => world.p.items.load * carryOf(world, world.humans, i);

// A step's cutting at the carcass pl.butcher: play.butcherSteps of them cut
// it up (with a knife, twice as fast), each putting its share of the meat
// into the pouch (as much as fits; the rest is left), with a stroke for the
// page every play.butcherEvery. Out of reach (or gone), it stops; started
// again, it goes on where it was. With items, the hides come at the end.
function butcher(world, i) {
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

// The aim (dx, dy), as a unit vector (none given: straight ahead). Into AIM.
function aim(world, i, a) {
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
function attack(world, i, a) {
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
function loose(world, i, ux, uy, power, target, lock, weapon, pierce) {
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
function inFront(world, i, ux, uy, range) {
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

// ---- Items in the player's hands (package 3) ----------------------------------------------

// The weapon's skill (SKILLS), for its Spirit: a Piercing throw (a heavy
// throw that passes through items.pierce creatures), a Volley (items.volley
// arrows in a fan), a Ground slam (every predator within items.slam driven
// off). A legend's is stronger: twice the piercing, two more arrows, half
// as far again.
function useSkill(world, i, a) {
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
function useTool(world, i, a) {
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

// Take up the item `id` lying within items.pickReach: into its hand; what was
// there into the kit, or (the kit full) down where it stands.
function pickUp(world, i, id) {
    const I = world.p.items;
    const pl = world.player;
    const pop = world.humans;
    const item = world.items.get(id);
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

// The next spare into the hand; what was there to the back of the kit.
function cycle(world, i, slot) {
    const pl = world.player;
    const pop = world.humans;
    const spares = slot === 'tool' ? pl.kit.tools : pl.kit.weapons;
    if (spares.length === 0) return;
    const next = world.items.get(spares.shift());
    const id = slot === 'tool' ? pop.tool[i] : pop.weapon[i];
    if (id) {
        unhold(world, i, world.items.get(id));
        spares.push(id);
    }
    if (next) hold(world, i, next);
}

// Put down an item from the hand or the kit, where the person stands.
function drop(world, i, id) {
    const pl = world.player;
    const pop = world.humans;
    const item = world.items.get(id);
    if (!item || item.bearer !== pop.id[i]) return;
    for (const list of [pl.kit.weapons, pl.kit.tools]) {
        const k = list.indexOf(id);
        if (k >= 0) list.splice(k, 1);
    }
    putDown(world, i, item);
}

// Start making an item of a.kind at camp, if the store has the materials
// (taken now; and a flint more, if asked for and there, for a chance of rare).
function startCrafting(world, i, a) {
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
function finishCrafting(world, i) {
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
function stopCrafting(world, pl) {
    const c = pl.crafting;
    if (!c) return;
    pl.crafting = null;
    const tribe = world.tribeById.get(c.tribe);
    if (!tribe) return;
    spend(world.p, tribe, c.kind, -1);
    if (c.flint) tribe.flint += 1;
}

// The AI's task for the tribe, let go when the page takes the body over (a
// craft's materials go back to the store; the wood or flint of an errand
// stays in the player's load).
function clearTask(world, i) {
    const pop = world.humans;
    if (pop.task[i] === TASK.CRAFT) {
        const tribe = world.tribeById.get(pop.tribe[i]);
        if (tribe) {
            spend(world.p, tribe, pop.make[i] % 8, -1);
            if (pop.make[i] >= 8) tribe.flint += 1;
        }
    } else if (pop.load[i] > 0 && world.player !== null) {
        if (pop.task[i] === TASK.WOOD) world.player.wood += pop.load[i];
        else if (pop.task[i] === TASK.FLINT) world.player.flint += pop.load[i];
    }
    pop.task[i] = TASK.NONE;
    pop.work[i] = 0;
    pop.make[i] = 0;
    pop.load[i] = 0;
}

// The page leaves a body (to another, or to nobody): what it was making is
// let go, its spares are put down where it stands (the AI holds one of
// each), and the wood or flint it carries the AI takes home, as an errand's
// load (of the one there is more of: an errand carries one material).
function leaveBody(world, pl) {
    stopCrafting(world, pl);
    if (!world.itemsOn || !pl.kit || !pl.id) return;
    const i = indexOf(world.humans, pl.id);
    const pop = world.humans;
    const task = pl.wood >= pl.flint ? TASK.WOOD : TASK.FLINT;
    if (i >= 0 && (pl.wood > 0 || pl.flint > 0) && (pop.task[i] === TASK.NONE || pop.task[i] === task)) {
        // (On autopilot the AI may be on an errand for the same already.)
        pop.load[i] = (pop.task[i] === task ? pop.load[i] : 0) + (task === TASK.WOOD ? pl.wood : pl.flint);
        pop.task[i] = task;
        pop.work[i] = world.p.items.errand; // (done: home with it)
    }
    pl.wood = 0;
    pl.flint = 0;
    for (const list of [pl.kit.weapons, pl.kit.tools]) {
        for (const id of list) {
            const item = world.items.get(id);
            if (item && i >= 0) putDown(world, i, item);
        }
        list.length = 0;
    }
}
