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
//   sleeping  resting at camp at night: asleep until dawn, or a move
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
// And for its hands (below): `acts`, the one-off acts waiting for the next
// step; `gather` and `butcher` (a carcass's id), work that goes on from step
// to step; `strokes`, counting the strokes of a chopping or knapping.
//
// The page moves the body (src/play/body.js); here it is only checked, and
// everything that is not a decision still happens to it as to anyone. What
// the hands do is in acts/hands.js (package 2) and acts/gear.js (items,
// package 3); this file takes the page's acts and carries them out (ACTS).
import { STATE } from './population.js';
import { giveCall } from './orders.js';
import { ITEM_KINDS, SKILLS, TASK, putDown, spend, handWork } from './items.js';
import { wrapDelta, wrapPos, livingIndexOf } from './util.js';
import { attack, eat, store, take, gather, butcher, inCamp, loadMax } from './acts/hands.js';
import { useSkill, useTool, pickUp, cycle, drop, startCrafting, finishCrafting, stopCrafting } from './acts/gear.js';

// Take over the person `id` in `mode` ('god' or 'play'), or let go with id 0.
// False, with nothing changed, if there is no such person alive.
export function takeControl(world, id, mode) {
    if (!id) {
        if (world.player !== null) leaveBody(world, world.player);
        world.player = null;
        return true;
    }
    const pop = world.humans;
    const i = livingIndexOf(pop, id);
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
        sleeping: false, // resting at camp at night (stepPlayer), until dawn or a move
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
// or get up (at night that is sleeping, until dawn or a move: stepPlayer);
// 'auto' {on}, autopilot on or off; 'call' {kind, x, y}, a call
// to your tribe (orders.js); and the hands' (ACTS and the work that goes
// on, see handAct). Others are ignored, so the page can be ahead of the
// simulation. On autopilot, only 'auto' and 'call' count (orders can be
// given from the map).
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
        pl.sleeping = false;
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
                const i = livingIndexOf(world.humans, pl.id);
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
    } else if (WORK.has(msg.action) || ACTS.has(msg.action)) {
        handAct(pl, msg);
    }
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
    // Resting at camp at night is sleeping, until dawn or a move; then it is up.
    if (pl.sleeping && (!pl.resting || !world.night || moved > MOVED)) {
        pl.sleeping = false;
        pl.resting = false;
    } else if (pl.resting && world.night) pl.sleeping = true;
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
    if (e < P.starving * P.maxEnergy) lifespan[i]--; // (hunger ages, as anyone)
    if (e > P.maxEnergy) e = P.maxEnergy;
    carry[i] = c;

    // What it is doing, for the panel and the bodies drawn: the page's gait,
    // a run being nearer a sprint than a walk.
    const speed = pl.speed;
    state[i] = pl.sleeping ? STATE.SLEEPING
        : pl.resting ? STATE.AT_CAMP
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
    const i = livingIndexOf(pop, pl.id);
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
            pl.sleeping = false;
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
    pl.sleeping = false;
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
    best = livingIndexOf(pop, world.descendant(id));
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
    const i = pl.id ? livingIndexOf(pop, pl.id) : -1;
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

// ---- The hands --------------------------------------------------------------------------
//
// The page asks; here, at the next step, it happens (an act arrives between
// steps, and a kill there would be stepped again, and its events lost). The
// acts, as the page sends them (what each does: acts/hands.js, acts/gear.js):
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
// page says stop, or the body moves (WORK).
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

// The one-off acts: the name the page sends → what carries it out at the
// next step, run(world, i, act) for person i (act: handAct's copy of the
// message), and whether it needs items. A new act is an entry here and its
// handler (and, if it brings a field of its own, a line in handAct).
const ACTS = new Map([
    ['attack', { run: attack, items: false }],
    ['eat', { run: eat, items: false }],
    ['store', { run: store, items: false }],
    ['take', { run: take, items: false }],
    ['craft', { run: startCrafting, items: true }],
    ['skill', { run: useSkill, items: true }],
    ['tool', { run: useTool, items: true }],
    ['pickup', { run: pickUp, items: true }],
    ['cycle', { run: cycle, items: true }],
    ['drop', { run: drop, items: true }],
]);
// The work that goes on from step to step, switched on or off.
const WORK = new Set(['butcher', 'gather']);
const MOVED = 0.05; // a move longer than this (units) stops butchering, gathering and crafting

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
// `moved` this step: the acts waiting, in the order they came, then the
// work under way.
function useHands(world, i, moved) {
    const pl = world.player;
    const acts = pl.acts;
    const items = world.itemsOn;
    if (moved > MOVED) stopCrafting(world, pl); // (before this step's acts: a craft asked for now is made where it stands)
    for (let k = 0; k < acts.length; k++) {
        const act = ACTS.get(acts[k].action);
        if (items || !act.items) act.run(world, i, acts[k]);
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

// ---- Handing over -----------------------------------------------------------------------

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
    const i = livingIndexOf(world.humans, pl.id);
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
