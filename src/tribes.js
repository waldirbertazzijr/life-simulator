// Tribes: founding them, their camps, births, splits and endings. What a
// person in a tribe does from step to step is humans.js.
//
// A tribe is a small plain object: its camp, its shared food store, its flag,
// and its culture — two numbers that shape how its members behave:
//
//   aggression  0..1  stand and fight predators instead of fleeing; meeting a
//                     stranger, attack and rob ("hawk") rather than walk away ("dove")
//   sociality   0..1  share more of each kill with the camp, hunt better
//                     together
//
// Tribes that grow large split; the daughter inherits the culture with a small
// change. Tribes that fail die out. So culture evolves between groups.
import { STATE } from './population.js';
import { tribeIdentity } from './identity.js';
import { KIND, foundItems, splitItems, tribeEnded, newItem, hold } from './items.js';
import { TAU, wrapDelta, wrapMod, clamp01 } from './util.js';

// A new tribe, its camp at (x, y), of `culture` ({aggression, sociality});
// `parent`: the tribe it split from, if any.
export function foundTribe(world, x, y, culture, parent = null) {
    const used = new Set(world.tribes.map((t) => t.color));
    const { name, color, flag } = tribeIdentity(world.rng, used);
    const tribe = {
        id: world.nextTribeId++,
        name,
        color,
        flag,
        camp: { x, y },
        store: 0,
        aggression: culture.aggression,
        sociality: culture.sociality,
        founded: world.time,
        // With terrain: how far the camp is by land from everywhere (Terrain.pathField).
        paths: world.terrain ? world.terrain.pathField(x, y) : null,
        parent: parent ? parent.id : 0,
        generation: parent ? parent.generation + 1 : 0,
        members: 0,
        adults: 0,
        births: 0,
        birthCooldown: 0,
        alive: true,
        // The player's standing order for the tribe, or null; and the
        // earliest step its camp may move again (orders.js).
        order: null,
        nextMove: 0,
        // Materials in store, beside the food (items.js).
        wood: 0,
        flint: 0,
        hide: 0,
    };
    world.tribes.push(tribe);
    world.tribeById.set(tribe.id, tribe);
    if (world.itemsOn) foundItems(world, tribe); // its goods, spots and needs
    return tribe;
}

// Average grass within `r` of a point (sampled on the grass grid).
function grassAround(world, x, y, r) {
    const { grass, width: W, height: H } = world;
    let sum = 0;
    let count = 0;
    for (let dy = -r; dy <= r; dy += grass.cellH) {
        for (let dx = -r; dx <= r; dx += grass.cellW) {
            sum += grass.g[grass.index(wrapMod(x + dx, W), wrapMod(y + dy, H))];
            count++;
        }
    }
    return sum / count;
}

// How good a spot is for a camp: flat, fertile ground near water but not in
// it. -Infinity where no camp can go: water, a cliff or cut-off land at the
// spot, or water or a cliff inside the camp itself. (Also where a camp may
// move to: orders.js.)
export function campSite(world, x, y) {
    const T = world.terrain;
    const R = world.p.human.campRadius;
    if (!T.spawnable(x, y)) return -Infinity;
    let fertile = 0;
    let water = false;
    for (let k = 0; k < 8; k++) {
        const c = Math.cos((k * TAU) / 8);
        const s = Math.sin((k * TAU) / 8);
        if (T.blocked(x + c * R, y + s * R)) return -Infinity;
        fertile += T.fertility(x + c * 50, y + s * 50) + T.fertility(x + c * 100, y + s * 100);
        if (T.isWater(x + c * 45, y + s * 45) || T.isWater(x + c * 90, y + s * 90)) water = true;
    }
    return fertile / 16 + (water ? 0.3 : 0) - T.slopeAt(x, y);
}

// Where a newborn or a founding member appears: a random spot in camp (on dry
// ground, with terrain). Not wrapped here: spawnPerson does that.
function nearCamp(world, tribe) {
    const R = world.p.human.campRadius;
    const { rng, terrain } = world;
    for (let tries = 0; ; tries++) {
        const x = tribe.camp.x + (rng.next() - 0.5) * R;
        const y = tribe.camp.y + (rng.next() - 0.5) * R;
        if (!terrain || terrain.spawnable(x, y)) return { x, y };
        if (tries >= 20) return { x: tribe.camp.x, y: tribe.camp.y };
    }
}

export function spawnPerson(world, tribe, x, y, energy, age, parent = -1) {
    const P = world.p.human;
    const pop = world.humans;
    const spread = world.p.evolution.initialSpread;
    const speed = parent >= 0 ? world.mutate(pop.speedGene[parent]) : P.genes.speed * Math.exp(spread * world.rng.gauss());
    const sense = parent >= 0 ? world.mutate(pop.senseGene[parent]) : P.genes.sense * Math.exp(spread * world.rng.gauss());
    const i = world.spawn(pop, P, wrapMod(x, world.width), wrapMod(y, world.height), energy, speed, sense, age, parent);
    if (pop.upkeep[i] > 1) pop.lifespan[i] /= Math.sqrt(pop.upkeep[i]); // (costly genes, a shorter life)
    pop.tribe[i] = tribe.id;
    pop.carry[i] = 0;
    pop.goal[i] = 0;
    // Empty-handed, with nothing to do for the tribe yet (items.js).
    pop.weapon[i] = 0;
    pop.tool[i] = 0;
    pop.gear[i] = 0;
    pop.task[i] = 0;
    pop.work[i] = 0;
    pop.make[i] = 0;
    pop.load[i] = 0;
    pop.hides[i] = 0;
    pop.crafted[i] = 0;
    pop.state[i] = age >= P.maturity ? STATE.AT_CAMP : STATE.PLAYING;
    return i;
}

// With terrain, the first camps go to the best of a few dozen random spots,
// keeping clear of camps already placed.
function firstCampSite(world) {
    const { rng, width: W, height: H } = world;
    let best = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 40; k++) {
        const x = rng.next() * W;
        const y = rng.next() * H;
        let score = campSite(world, x, y);
        for (const t of world.tribes) {
            if (Math.hypot(wrapDelta(t.camp.x - x, W), wrapDelta(t.camp.y - y, H)) < world.p.human.splitDistance) score -= 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = { x, y };
        }
    }
    return best ?? world.terrain.randomSpot(rng);
}

export function seedTribes(world) {
    const P = world.p.human;
    const { rng } = world;
    for (let k = 0; k < P.tribes; k++) {
        const site = world.terrain ? firstCampSite(world) : { x: rng.next() * world.width, y: rng.next() * world.height };
        const tribe = foundTribe(world, site.x, site.y, {
            aggression: rng.next(),
            sociality: rng.next(),
        });
        tribe.store = P.initialStore;
        if (world.itemsOn) tribe.wood = world.p.items.initialWood;
        for (let m = 0; m < P.perTribe; m++) {
            const adult = m < P.perTribe * 0.8;
            const age = adult ? P.maturity + rng.next() * (P.lifespan * 0.5 - P.maturity) : rng.next() * P.maturity;
            const spot = nearCamp(world, tribe);
            const i = spawnPerson(world, tribe, spot.x, spot.y, P.maxEnergy * 0.7, age);
            // (Items: every adult starts with a plain spear.)
            if (adult && world.itemsOn) hold(world, i, newItem(world, KIND.SPEAR, 0, '', 0, tribe.id));
        }
    }
}

// Tribe bookkeeping, once per step after the dead are removed: count members,
// spoil the store, births at camp, splits, and the end of tribes. (Wood, flint
// and hide do not spoil.)
export function stepTribes(world) {
    const P = world.p.human;
    const pop = world.humans;
    for (const t of world.tribes) {
        t.members = 0;
        t.adults = 0;
    }
    for (let i = 0; i < pop.n; i++) {
        const t = world.tribeById.get(pop.tribe[i]);
        t.members++;
        if (pop.age[i] >= P.maturity) t.adults++;
    }

    for (const t of world.tribes.slice()) {
        if (t.members === 0) {
            endTribe(world, t);
            continue;
        }
        if (t.order !== null && world.time + 1 >= t.order.until) t.order = null; // its last step: the order lapses (orders.js)
        t.store *= 1 - P.spoil;
        if (t.birthCooldown > 0) t.birthCooldown--;
        // A birth: in its season (world.breedP), with two adults, the store
        // able to spare it, and not too soon after the last.
        if (t.adults >= 2 && t.birthCooldown === 0 && t.store >= P.birthCost + P.reserve * t.members
            && world.breedP > 0 && world.rng.next() < world.breedP) {
            const parent = randomMember(world, t, true);
            t.store -= P.birthCost;
            const spot = nearCamp(world, t);
            spawnPerson(world, t, spot.x, spot.y, P.childEnergy, 0, parent);
            t.members++;
            t.births++;
            t.birthCooldown = P.birthInterval;
        }
        if (t.members >= P.splitSize) split(world, t);
    }
}

function randomMember(world, t, adultOnly) {
    const P = world.p.human;
    const pop = world.humans;
    let chosen = -1;
    let seen = 0;
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] !== t.id || (adultOnly && pop.age[i] < P.maturity)) continue;
        if (world.rng.next() * ++seen < 1) chosen = i; // reservoir sampling
    }
    return chosen;
}

function endTribe(world, t) {
    if (world.itemsOn) tribeEnded(world, t); // what lay in its camp, and what outlived it (items.js)
    t.alive = false;
    t.ended = world.time;
    world.tribes.splice(world.tribes.indexOf(t), 1);
    world.tribeById.delete(t.id);
    world.fallen.unshift(t);
    if (world.fallen.length > 12) world.fallen.pop();
}

// Is (x, y) within human.room of any camp but tribe t's own? A daughter
// tribe needs land of its own: the world holds only so many tribes.
function crowded(world, t, x, y) {
    const r2 = world.p.human.room * world.p.human.room;
    for (const o of world.tribes) {
        if (o === t) continue;
        const dx = wrapDelta(o.camp.x - x, world.width);
        const dy = wrapDelta(o.camp.y - y, world.height);
        if (dx * dx + dy * dy < r2) return true;
    }
    return false;
}

// A tribe too large to hold together splits: half its people walk off to found
// a new camp at the greenest of a few nearby sites (on land no other tribe
// holds: crowded), under a new flag, taking half the store and a slightly
// changed culture.
function split(world, t) {
    const P = world.p.human;
    const pop = world.humans;
    const { rng } = world;
    let site = null;
    let bestGrass = -Infinity;
    for (let k = 0; k < 6; k++) {
        const a = rng.next() * TAU;
        const d = P.splitDistance * (0.8 + 0.4 * rng.next());
        const sx = wrapMod(t.camp.x + Math.cos(a) * d, world.width);
        const sy = wrapMod(t.camp.y + Math.sin(a) * d, world.height);
        if (crowded(world, t, sx, sy)) continue; // (another tribe's land)
        let gv = grassAround(world, sx, sy, 40);
        if (world.terrain) {
            const score = campSite(world, sx, sy);
            if (score === -Infinity) continue; // in a lake, on a cliff, or cut off
            gv += score;
        }
        if (gv > bestGrass) {
            bestGrass = gv;
            site = { x: sx, y: sy };
        }
    }
    if (!site) return; // nowhere to settle this time; try again next step
    const daughter = foundTribe(world, site.x, site.y, {
        aggression: clamp01(t.aggression + P.cultureDrift * rng.gauss()),
        sociality: clamp01(t.sociality + P.cultureDrift * rng.gauss()),
    }, t);
    let k = 0;
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] !== t.id) continue;
        if (k++ % 2 === 1) {
            pop.tribe[i] = daughter.id;
            daughter.members++;
            if (pop.age[i] >= P.maturity) daughter.adults++;
        }
    }
    t.members -= daughter.members;
    t.adults -= daughter.adults;
    daughter.store = t.store / 2;
    t.store -= daughter.store;
    if (world.itemsOn) splitItems(world, t, daughter); // half the materials, and of what lies in camp
}
