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
//
// On autopilot the person lives exactly as if nobody controlled it: no input,
// no wounds instead of death, no rolls, no crouching (wounds exist because
// you steer by hand). Only the heir rules (afterStep) still apply.
//
// The page moves the body (src/play/body.js); here it is only checked, and
// everything that is not a decision still happens to it as to anyone.
import { STATE } from './population.js';

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
        world.player = null;
        return true;
    }
    const pop = world.humans;
    const i = indexOf(pop, id);
    if (i < 0) return false;
    const before = world.player;
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
        lastStep: world.time,
        // Where it was last seen alive (all that is left to report once over).
        x: pop.x[i],
        y: pop.y[i],
        heading: pop.heading[i],
    };
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
// or get up; 'auto' {on}, autopilot on or off. Others are ignored, so the
// page can be ahead of the simulation. On autopilot, only 'auto' counts.
export function applyAct(world, msg) {
    const pl = world.player;
    if (pl === null || pl.id === 0) return;
    if (msg.action === 'auto') {
        const on = msg.on === true;
        if (on === pl.auto) return;
        pl.auto = on;
        pl.input = null;
        pl.crouch = false;
        pl.speed = 0;
        pl.resting = false;
        pl.rollUntil = 0;
        if (!on) {
            // Back by hand: the page jumps its body to where the AI left it,
            // and numbers its inputs afresh, as for an heir.
            pl.snap = true;
            pl.seq = 0;
            pl.lastStep = world.time;
        }
    } else if (pl.auto) {
        // The AI decides.
    } else if (msg.action === 'roll') {
        pl.rollUntil = world.time + world.p.play.rollSteps;
        pl.resting = false;
    } else if (msg.action === 'rest') {
        pl.resting = msg.on === true && inCamp(world, pl.id);
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
    world.events.push({ type: 'bite', id: pop.id[j], by: predators.id[i], x: pop.x[j], y: pop.y[j], damage, time });
    if (pop.energy[j] <= damage) return false;
    pop.energy[j] -= damage;
    predators.timer[i] = world.p.carnivore.rest;
    predators.state[i] = STATE.RESTING;
    return true;
}

// One step of the controlled person, in place of the AI (stepHumans hands it
// over). Where it goes is the page's decision; everything else happens as it
// does to anyone: ageing, dropping food off and eating at camp, eating what
// it carries when starving, metabolism, starving to death. And Spirit.
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
            pl.speed = input.speed;
            pl.seq = input.seq;
            pl.lastStep = time;
        } else {
            pl.speed = 0;
            pl.snap = true;
        }
    }

    const campDx = wrapDelta(tribe.camp.x - x[i], W);
    const campDy = wrapDelta(tribe.camp.y - y[i], H);
    const atCamp = campDx * campDx + campDy * campDy < P.campRadius * P.campRadius;
    if (!atCamp) pl.resting = false; // walked off
    let e = energy[i];
    let c = carry[i];
    if (atCamp) {
        // Home: put the food in the store, and eat if hungry.
        tribe.store += c;
        c = 0;
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
    if (next < 0) {
        if (pl.mode === 'play') {
            pl.over = true;
            pl.id = 0;
            pl.input = null;
            pl.crouch = false;
            pl.speed = 0;
            pl.resting = false;
            pl.rollUntil = 0;
            world.events.push({ type: 'over', time });
        } else {
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
    };
    pl.snap = false;
    pl.heir = 0;
    return out;
}
