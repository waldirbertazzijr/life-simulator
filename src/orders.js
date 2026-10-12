// Leading a tribe (spec §9): the calls the person you play can give it.
//
// A rally makes the adults near you follow you for a while. An order is the
// tribe's one standing instruction, until another replaces it or it lapses:
//
//   hunt    Hunt here: foraging centres on the marker instead of the camp
//           (food still goes home to the camp)
//   gather  Gather food: no hunting, only plants
//   defend  Defend camp: adults stay in camp and stand against predators as
//           if fully aggressive; a raider meets every adult
//   move    Move camp: the camp, its store and its way home go to a valid
//           site, and people walk there; not again until a cooldown has passed
//
// (Gathering wood and flint come with items, as more kinds.)
//
// Gather food and Defend camp are heeded with food to spare: a hungry camp,
// one whose store could not pay for a birth, feeds itself first (setAside,
// heeded). How a camp meets raiders and predators follows the order
// regardless.
//
// Only the person the page controls gives calls, and only to its own tribe
// (giveCall, from player.js). Whatever an order or a rally changes in the AI
// (humans.js) sits behind `tribe.order !== null` or an active rally, and
// neither exists until the player makes one: with nobody controlled, the
// world runs exactly as if this file did not exist. issueOrder lets the
// tests and the orders check (headless/orders.mjs) give any tribe an order
// without a player.
import { STATE } from './population.js';
import { campSite, hitChance } from './humans.js';

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
// (A position already on the world is kept exactly as it was given.)
const wrapPos = (v, size) => (v >= 0 && v < size ? v : ((v % size) + size) % size);
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // the golden angle: bearings that never bunch up

// The index of the living member of `pop` with this id, or -1.
function indexOf(pop, id) {
    const ids = pop.id;
    for (let i = 0; i < pop.n; i++) if (ids[i] === id) return pop.energy[i] > 0 ? i : -1;
    return -1;
}

// ---- Calls from the player -------------------------------------------------------

// The page's call {kind, x, y} (an act, player.js). It is heard at the next
// step (lead), so the tribe's answer goes out with that step's events.
// (Copied: with ?noworker the message is the page's own object.)
export function giveCall(world, msg) {
    const pl = world.player;
    if (!pl.calls) pl.calls = [];
    if (pl.calls.length < 8) pl.calls.push({ kind: String(msg.kind), x: Number(msg.x), y: Number(msg.y) });
}

// Once a step, before anyone decides (stepHumans, while someone is
// controlled): hear the calls given since the last step, and say which
// rally is under way, if any (null: none).
export function lead(world) {
    const pl = world.player;
    if (pl.calls && pl.calls.length) {
        for (const c of pl.calls) hear(world, c);
        pl.calls.length = 0;
    }
    return pl.rally ? rallying(world) : null;
}

// A call from the person you play, to its own tribe: a rally, or an order.
// A child cannot lead.
function hear(world, c) {
    const pl = world.player;
    const pop = world.humans;
    const i = pl.id ? indexOf(pop, pl.id) : -1;
    if (i < 0) return; // gone (an heir is on the way)
    const tribe = world.tribeById.get(pop.tribe[i]);
    if (pop.age[i] < world.p.human.maturity) refuse(world, tribe, c.kind, 'child');
    else if (c.kind === 'rally') rally(world, i, tribe);
    else issueOrder(world, tribe, c);
}

// ---- The rally ---------------------------------------------------------------------
//
// For rallySteps, the adults of your tribe who were within rallyRadius when
// you called follow you (rather than their own plans, though they still flee
// or fight predators and meet strangers as their culture says): each makes
// for a place of its own `close` from you, and runs when it falls `keep`
// behind. Near you, they count as together, as anyone near does: for
// teamwork and in fending off predators. And what you attack (lastTarget),
// they go for too, by the usual rules of the hunt. It ends early when you
// die, hand over to an heir, or leave your body to the AI.

function rally(world, i, tribe) {
    const pl = world.player;
    const O = world.p.orders;
    const pop = world.humans;
    if (pl.auto) return refuse(world, tribe, 'rally', 'away');
    if (pl.spirit < O.rallyCost) return refuse(world, tribe, 'rally', 'spirit');
    // A rally under way takes in whoever else is near now.
    const r = pl.rally && pl.rally.leader === pl.id ? pl.rally : { leader: pl.id, tribe: tribe.id, until: 0, ids: new Set(), at: -1, prey: -1 };
    const r2 = O.rallyRadius * O.rallyRadius;
    let count = 0;
    for (let k = 0; k < pop.n; k++) {
        if (k === i || pop.tribe[k] !== tribe.id || pop.age[k] < world.p.human.maturity || pop.energy[k] <= 0) continue;
        const dx = wrapDelta(pop.x[k] - pop.x[i], world.width);
        const dy = wrapDelta(pop.y[k] - pop.y[i], world.height);
        if (dx * dx + dy * dy > r2) continue;
        r.ids.add(pop.id[k]);
        count++;
    }
    if (count === 0) return refuse(world, tribe, 'rally', 'nobody');
    pl.spirit -= O.rallyCost;
    r.until = world.time + O.rallySteps;
    pl.rally = r;
    world.events.push({ type: 'rally', tribe: tribe.id, count, time: world.time });
    return true;
}

// The rally under way, with where its leader is this step (`at`) and the
// grazer the leader last attacked (`prey`, -1 if none, or dead); or null if
// it is over.
function rallying(world) {
    const pl = world.player;
    const r = pl.rally;
    r.at = pl.auto || pl.id !== r.leader || world.time >= r.until ? -1 : indexOf(world.humans, pl.id);
    if (r.at < 0) {
        pl.rally = null;
        return null;
    }
    r.prey = pl.lastTarget ? indexOf(world.herbivores, pl.lastTarget) : -1;
    return r;
}

// One step of a follower (person i, of `tribe`, in the rally r), in place of
// its own plans: the leader's prey, if it can see it, hunted by the usual
// rules (humans.js); otherwise its place beside the leader. What it eats and
// carries (from e and c), and its way (dx, dy) and pace (v), are left in
// `led`; its state is returned.
export const led = { e: 0, c: 0, dx: 0, dy: 0, v: 0 };
export function follow(world, r, i, tribe, e, c) {
    const P = world.p.human;
    const O = world.p.orders;
    const pop = world.humans;
    const { x, y, focus } = pop;
    const { width: W, height: H } = world;
    const top = P.speed * pop.speedGene[i];
    led.dx = 0;
    led.dy = 0;
    led.v = 0;
    let s = STATE.FOLLOWING;
    const j = r.prey;
    const G = world.herbivores;
    const gx = j >= 0 ? wrapDelta(G.x[j] - x[i], W) : 0;
    const gy = j >= 0 ? wrapDelta(G.y[j] - y[i], H) : 0;
    const d2 = gx * gx + gy * gy;
    const sense = P.sense * pop.senseGene[i];
    if (j >= 0 && G.energy[j] > 0 && d2 < sense * sense) {
        s = STATE.HUNTING;
        focus[i] = G.id[j];
        if (d2 > P.throwRange * P.throwRange) {
            const d = Math.sqrt(d2);
            led.dx = gx / d;
            led.dy = gy / d;
            led.v = top * P.cruise;
        } else if (pop.timer[i] === 0) {
            pop.timer[i] = P.reload;
            const mates = world.humanHash.count(x[i], y[i], P.groupRadius, i, pop.tribe, pop.tribe[i], true);
            const hit = world.rng.next() < hitChance(P, tribe, mates);
            // (For the page, which draws the spear: nothing reads it here.)
            world.events.push({ type: 'throw', id: pop.id[i], x: x[i], y: y[i], tx: G.x[j], ty: G.y[j], hit, time: world.time });
            if (hit) {
                const food = G.energy[j] * P.efficiency;
                world.die(G, j, 'hunted', pop.id[i]);
                pop.kills[i]++;
                // Eat a share now; the rest goes home to the camp.
                let eat = food * (1 - tribe.sociality);
                if (eat > P.maxEnergy - e) eat = P.maxEnergy - e;
                e += eat;
                c += food - eat;
            }
        }
    } else {
        // Its place: `close` from the leader, on a bearing of its own.
        const L = r.at;
        const a = pop.id[i] * GOLDEN;
        const px = wrapDelta(x[L] + Math.cos(a) * O.close - x[i], W);
        const py = wrapDelta(y[L] + Math.sin(a) * O.close - y[i], H);
        const d = Math.sqrt(px * px + py * py);
        if (d > 0.5) {
            led.dx = px / d;
            led.dy = py / d;
            led.v = top * Math.min(1, d / (O.keep - O.close));
        }
        focus[i] = pop.id[L];
    }
    led.e = e;
    led.c = c;
    return s;
}

// ---- Standing orders -----------------------------------------------------------

// The kinds of standing order; the snapshots send each as its index here (0: none).
export const ORDER_KINDS = ['', 'hunt', 'gather', 'defend', 'move'];

// The tribe's answer, when it will not.
function refuse(world, tribe, kind, reason) {
    world.events.push({ type: 'refused', tribe: tribe.id, kind, reason, time: world.time });
    return false;
}

// Give `tribe` (the tribe, or its id) the order {kind, x, y}: x, y is the
// marker (Hunt here), or the new camp (Move camp); Gather food and Defend
// camp are about the camp itself. True if the tribe took it; either way its
// answer is in world.events ('call' or 'refused').
export function issueOrder(world, tribe, { kind, x, y }) {
    if (typeof tribe === 'number') tribe = world.tribeById.get(tribe);
    if (!tribe) return false;
    const O = world.p.orders;
    const { terrain, time } = world;
    x = wrapPos(Number(x), world.width);
    y = wrapPos(Number(y), world.height);
    const placed = Number.isFinite(x) && Number.isFinite(y);
    switch (kind) {
        case 'hunt':
            // On the land people can walk to (not in a lake, nor on an island).
            if (!placed || (terrain !== null && !terrain.spawnable(x, y))) return refuse(world, tribe, kind, 'unreachable');
            tribe.order = order(kind, x, y, time + O.lasts, O.huntRange, terrain ? terrain.pathField(x, y) : null);
            break;
        case 'gather':
        case 'defend':
            tribe.order = order(kind, tribe.camp.x, tribe.camp.y, time + O.lasts, 0, null);
            break;
        case 'move':
            if (time < tribe.nextMove) return refuse(world, tribe, kind, 'cooldown');
            if (!placed || (terrain !== null && campSite(world, x, y) === -Infinity)) return refuse(world, tribe, kind, 'site');
            // The store is the tribe's number: it goes too. People make
            // their way there as they come home (humans.js).
            tribe.camp = { x, y };
            tribe.paths = terrain ? terrain.pathField(x, y) : null;
            tribe.nextMove = time + O.moveCooldown;
            tribe.order = null;
            world.events.push({ type: 'call', tribe: tribe.id, kind, x, y, time });
            return true;
        default:
            return refuse(world, tribe, kind, 'unknown');
    }
    world.events.push({ type: 'call', tribe: tribe.id, kind, x: tribe.order.x, y: tribe.order.y, time, hungry: setAside(world.p, tribe) });
    return true;
}

// Is the tribe hungry? It is unless its store could pay for a birth
// (human.birthCost, keeping human.reserve a member back; × orders.surplus).
// `p` is the parameters (world.p).
export const hungry = (p, tribe) => tribe.store < p.orders.surplus * (p.human.birthCost + p.human.reserve * tribe.members);

// Gather food and Defend camp keep people from food outright, so a hungry
// camp sets them aside and feeds itself first, as it would without an
// order: they spend only the camp's surplus. (The model's economy lives on
// hunting and the store, and births on the store: held for long, either
// order stopped the births of every tribe, and random orders to every tribe
// ended the people on every seed: headless/orders.mjs.) Hunt here only moves
// where people forage, and Move camp is done at once: those always stand.
export const setAside = (p, tribe) => tribe.order !== null && (tribe.order.kind === 'gather' || tribe.order.kind === 'defend') && hungry(p, tribe);

// The order a tribe's people follow in what they do (humans.js): its
// standing order, or null when it has none or has set it aside.
export const heeded = (p, tribe) => (tribe.order === null || setAside(p, tribe) ? null : tribe.order);

// How readily the tribe's people stand against a predator: their culture's
// aggression, or all of it while they defend the camp (hungry or not).
export const fighting = (tribe) => (tribe.order !== null && tribe.order.kind === 'defend' ? 1 : tribe.aggression);

// An order: what, where, until when; for Hunt here, how far from the marker
// foragers range (and its square), and the way to the marker by land
// (Terrain.pathField; null on a flat world).
const order = (kind, x, y, until, range, paths) => ({ kind, x, y, until, range, range2: range * range, paths });
