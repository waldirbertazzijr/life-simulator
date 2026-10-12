// People: hunter-gatherers living in tribes.
//
// Individuals live in a Population like the animals (world.humans), with two
// extra columns: `tribe` (the tribe's id) and `carry` (food in hand). A tribe
// is a small plain object: its camp, its shared food store, its flag, and its
// culture — two numbers that shape how its members behave:
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

const TAU = Math.PI * 2;
const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
const wrapPos = (v, size) => ((v % size) + size) % size;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
    };
    world.tribes.push(tribe);
    world.tribeById.set(tribe.id, tribe);
    return tribe;
}

// The way to a tribe's camp, (ddx, ddy) away at distance d: straight there on
// a flat world; around lakes and cliffs with terrain. Left in wayX, wayY.
let wayX = 0;
let wayY = 0;
function toward(world, tribe, x, y, ddx, ddy, d) {
    if (world.terrain === null) {
        wayX = ddx / d;
        wayY = ddy / d;
        return;
    }
    world.terrain.way(tribe.paths, x, y, ddx, ddy, d);
    wayX = world.terrain.ux;
    wayY = world.terrain.uy;
}

// Average grass within `r` of a point (sampled on the grass grid).
function grassAround(world, x, y, r) {
    const { grass, width: W, height: H } = world;
    let sum = 0;
    let count = 0;
    for (let dy = -r; dy <= r; dy += grass.cellH) {
        for (let dx = -r; dx <= r; dx += grass.cellW) {
            sum += grass.g[grass.index(wrapPos(x + dx, W), wrapPos(y + dy, H))];
            count++;
        }
    }
    return sum / count;
}

// How good a spot is for a camp: flat, fertile ground near water but not in
// it. -Infinity where no camp can go: water, a cliff or cut-off land at the
// spot, or water or a cliff inside the camp itself.
function campSite(world, x, y) {
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

function spawnPerson(world, tribe, x, y, energy, age, parent = -1) {
    const P = world.p.human;
    const pop = world.humans;
    const spread = world.p.evolution.initialSpread;
    const speed = parent >= 0 ? world.mutate(pop.speedGene[parent]) : P.genes.speed * Math.exp(spread * world.rng.gauss());
    const sense = parent >= 0 ? world.mutate(pop.senseGene[parent]) : P.genes.sense * Math.exp(spread * world.rng.gauss());
    const i = world.spawn(pop, P, wrapPos(x, world.width), wrapPos(y, world.height), energy, speed, sense, age, parent);
    pop.tribe[i] = tribe.id;
    pop.carry[i] = 0;
    pop.goal[i] = 0;
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
        for (let m = 0; m < P.perTribe; m++) {
            const adult = m < P.perTribe * 0.8;
            const age = adult ? P.maturity + rng.next() * (P.lifespan * 0.5 - P.maturity) : rng.next() * P.maturity;
            const spot = nearCamp(world, tribe);
            spawnPerson(world, tribe, spot.x, spot.y, P.maxEnergy * 0.7, age);
        }
    }
}

// Chance a spear throw kills: better with tribe-mates nearby, if they cooperate.
const hitChance = (P, tribe, mates) => Math.min(0.95, P.hit * (1 + P.teamwork * mates * tribe.sociality));

// The nearest other tribe whose camp is within `range` of this tribe's camp
// and holds at least `minStore` food: a raid is only worth a full haul.
function raidTarget(world, tribe, range, minStore) {
    let best = null;
    let bestD2 = range * range;
    for (const other of world.tribes) {
        if (other === tribe || other.store < minStore) continue;
        const dx = wrapDelta(other.camp.x - tribe.camp.x, world.width);
        const dy = wrapDelta(other.camp.y - tribe.camp.y, world.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = other;
        }
    }
    return best;
}

// Would tribe-mates near person j drive off a predator?
export function driveOff(world, j) {
    const P = world.p.human;
    const pop = world.humans;
    const defenders = world.humanHash.count(pop.x[j], pop.y[j], P.defendRadius, j, pop.tribe, pop.tribe[j], true);
    return world.rng.next() < 1 - Math.exp(-P.defend * defenders);
}

export function stepHumans(world) {
    const P = world.p.human;
    const pop = world.humans;
    const n = pop.n;
    const { x, y, heading, energy, age, lifespan, speedGene, senseGene, upkeep, timer, state, focus, kills, carry, goal, id } = pop;
    const tribeOf = pop.tribe;
    const { rng, width: W, height: H, grass, herbivores, carnivores, tribeById, terrain } = world;
    const predators = world.carnivoreHash;
    const prey = world.herbivoreHash;
    const people = world.humanHash;
    const g = grass.g;
    const throw2 = P.throwRange * P.throwRange;
    const home2 = P.homeRange * P.homeRange;

    for (let i = 0; i < n; i++) {
        if (energy[i] <= 0) continue; // killed earlier this step
        if (++age[i] > lifespan[i]) {
            world.die(pop, i, 'old age');
            continue;
        }
        const tribe = tribeById.get(tribeOf[i]);
        const adult = age[i] >= P.maturity;
        const top = P.speed * speedGene[i];
        const sense = P.sense * senseGene[i];
        const campDx = wrapDelta(tribe.camp.x - x[i], W);
        const campDy = wrapDelta(tribe.camp.y - y[i], H);
        const campD = Math.hypot(campDx, campDy) || 1;
        const atCamp = campD < P.campRadius;
        let e = energy[i];
        let c = carry[i];
        let dx = 0;
        let dy = 0;
        let v = 0;
        let s = STATE.AT_CAMP;
        let victim = null; // a camp to raid
        focus[i] = 0;
        if (timer[i] > 0) timer[i]--; // spear "reload"

        const threat = predators.nearest(x[i], y[i], sense);
        const stranger = threat < 0 && adult ? people.nearest(x[i], y[i], P.meetRadius, i, tribeOf, tribeOf[i], false) : -1;

        if (threat >= 0) {
            focus[i] = carnivores.id[threat];
            const mates = people.count(x[i], y[i], P.groupRadius, i, tribeOf, tribeOf[i], true);
            if (adult && mates > 0 && rng.next() < tribe.aggression) {
                // Stand together and fight.
                s = STATE.FIGHTING;
                if (timer[i] === 0 && predators.d2 <= throw2) {
                    timer[i] = P.reload;
                    if (rng.next() < hitChance(P, tribe, mates)) {
                        c += carnivores.energy[threat] * P.efficiency;
                        world.die(carnivores, threat, 'killed', id[i]);
                        kills[i]++;
                    }
                }
            } else {
                s = STATE.FLEEING;
                const d = Math.sqrt(predators.d2) || 1;
                dx = -predators.dx / d;
                dy = -predators.dy / d;
                v = top;
            }
        } else if (stranger >= 0) {
            focus[i] = id[stranger];
            if (rng.next() < tribe.aggression) {
                // Hawk: attack and rob. The stranger may fight back.
                s = STATE.FIGHTING;
                const other = tribeById.get(tribeOf[stranger]);
                energy[stranger] -= P.fightDamage;
                c += carry[stranger];
                carry[stranger] = 0;
                if (rng.next() < other.aggression) e -= P.fightDamage;
                if (energy[stranger] <= 0) {
                    world.die(pop, stranger, 'killed', id[i]);
                    kills[i]++;
                }
            } else {
                // Dove: walk away.
                s = STATE.AVOIDING;
                const d = Math.sqrt(people.d2) || 1;
                dx = -people.dx / d;
                dy = -people.dy / d;
                v = top * P.cruise;
            }
        } else if (goal[i] && c < P.tripLoad) {
            // On a raid: walk to the other tribe's camp and take food from its
            // store, if its defenders let you.
            const target = tribeById.get(goal[i]);
            if (!target) {
                goal[i] = 0; // that tribe is gone
            } else {
                s = STATE.RAIDING;
                const rdx = wrapDelta(target.camp.x - x[i], W);
                const rdy = wrapDelta(target.camp.y - y[i], H);
                const rd = Math.hypot(rdx, rdy) || 1;
                if (rd < P.campRadius) {
                    const defenders = people.count(x[i], y[i], P.defendRadius, i, tribeOf, target.id, true);
                    for (let k = 0; k < defenders; k++) {
                        if (rng.next() < P.guard * (0.5 + 0.5 * target.sociality)) e -= P.fightDamage;
                    }
                    if (e <= 0) {
                        energy[i] = 0;
                        world.die(pop, i, 'killed');
                        continue;
                    }
                    const loot = Math.min(target.store, P.raidLoad);
                    target.store -= loot;
                    c += loot;
                    goal[i] = 0;
                } else {
                    toward(world, target, x[i], y[i], rdx, rdy, rd);
                    dx = wayX;
                    dy = wayY;
                    v = top * P.cruise;
                }
            }
        } else if (!adult) {
            // Children stay around camp.
            s = STATE.PLAYING;
            if (campD > P.campRadius * 0.6) {
                toward(world, tribe, x[i], y[i], campDx, campDy, campD);
                dx = wayX;
                dy = wayY;
                v = top * P.cruise;
            }
        } else if (c >= P.tripLoad) {
            s = STATE.HOMEWARD;
            toward(world, tribe, x[i], y[i], campDx, campDy, campD);
            dx = wayX;
            dy = wayY;
            v = top * P.cruise;
        } else if (tribe.store >= P.storeTarget * tribe.members && e >= P.hunger * P.maxEnergy) {
            // Enough food at home: rest.
            s = STATE.AT_CAMP;
            if (campD > P.campRadius * 0.6) {
                toward(world, tribe, x[i], y[i], campDx, campDy, campD);
                dx = wayX;
                dy = wayY;
                v = top * P.cruise;
            }
        } else if (tribe.store < P.storeTarget * tribe.members * 0.5 && rng.next() < tribe.aggression * P.raidRate
                && (victim = raidTarget(world, tribe, P.raidRange, P.raidLoad))) {
            // A hungry, aggressive tribe sends someone to rob a neighbour.
            goal[i] = victim.id;
            s = STATE.RAIDING;
        } else {
            // Forage: hunt a grazer in sight near home, otherwise gather plants.
            let hunting = false;
            const target = prey.nearest(x[i], y[i], sense);
            if (target >= 0) {
                const fx = wrapDelta(herbivores.x[target] - tribe.camp.x, W);
                const fy = wrapDelta(herbivores.y[target] - tribe.camp.y, H);
                if (fx * fx + fy * fy < home2) {
                    hunting = true;
                    s = STATE.HUNTING;
                    focus[i] = herbivores.id[target];
                    if (prey.d2 <= throw2) {
                        if (timer[i] === 0) {
                            timer[i] = P.reload;
                            const mates = people.count(x[i], y[i], P.groupRadius, i, tribeOf, tribeOf[i], true);
                            if (rng.next() < hitChance(P, tribe, mates)) {
                                const food = herbivores.energy[target] * P.efficiency;
                                world.die(herbivores, target, 'hunted', id[i]);
                                kills[i]++;
                                // Eat a share now; the rest goes home to the camp.
                                let eat = food * (1 - tribe.sociality);
                                if (eat > P.maxEnergy - e) eat = P.maxEnergy - e;
                                e += eat;
                                c += food - eat;
                            }
                        }
                    } else {
                        const d = Math.sqrt(prey.d2);
                        dx = prey.dx / d;
                        dy = prey.dy / d;
                        v = top * P.cruise;
                    }
                }
            }
            if (!hunting) {
                s = STATE.GATHERING;
                const gi = grass.index(x[i], y[i]);
                if (campD >= P.homeRange) {
                    toward(world, tribe, x[i], y[i], campDx, campDy, campD);
                    dx = wayX;
                    dy = wayY;
                    v = top * P.cruise;
                } else if (g[gi] >= P.gatherMin) {
                    let take = P.gatherRate;
                    if (take > g[gi]) take = g[gi];
                    g[gi] -= take;
                    c += take * P.plantEnergy;
                } else if (rng.next() < tribe.sociality
                    && people.nearest(x[i], y[i], P.groupRadius, i, tribeOf, tribeOf[i], true) >= 0
                    && people.d2 > P.partySpacing * P.partySpacing) {
                    // Social foragers keep up with their party instead of wandering off alone.
                    const d = Math.sqrt(people.d2);
                    dx = people.dx / d;
                    dy = people.dy / d;
                    v = top * P.cruise;
                } else {
                    // Peek ahead and to the sides for a greener patch.
                    let h = heading[i];
                    let best = g[gi];
                    let turn = 2;
                    const look = sense * 0.5;
                    for (let k = -1; k <= 1; k++) {
                        const a = h + k * 0.8;
                        const gv = g[grass.index(wrapPos(x[i] + Math.cos(a) * look, W), wrapPos(y[i] + Math.sin(a) * look, H))];
                        if (gv > best) {
                            best = gv;
                            turn = k;
                        }
                    }
                    h = turn === 2 ? h + (rng.next() - 0.5) * 2 : h + turn * 0.8;
                    dx = Math.cos(h);
                    dy = Math.sin(h);
                    v = top * P.cruise;
                }
            }
        }

        if (c > P.carryMax) c = P.carryMax; // hands are full; the rest is left behind

        if (v > 0) {
            let nx = wrapPos(x[i] + dx * v, W);
            let ny = wrapPos(y[i] + dy * v, H);
            if (terrain !== null && terrain.blocked(nx, ny)) {
                // Water or a cliff ahead: veer along it.
                terrain.move(x[i], y[i], dx, dy, v, terrain.side(dx, dy, heading[i], rng));
                nx = terrain.x;
                ny = terrain.y;
                dx = terrain.ux;
                dy = terrain.uy;
            }
            x[i] = nx;
            y[i] = ny;
            heading[i] = Math.atan2(dy, dx);
        }

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

        e -= P.baseCost * upkeep[i] + P.moveCost * v * v;
        if (e > P.maxEnergy) e = P.maxEnergy;
        carry[i] = c;
        state[i] = s;
        if (e <= 0) {
            world.die(pop, i, 'starvation');
            continue;
        }
        energy[i] = e;
    }
}

// Tribe bookkeeping, once per step after the dead are removed: count members,
// spoil the store, births at camp, splits, and the end of tribes.
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
        t.store *= 1 - P.spoil;
        if (t.birthCooldown > 0) t.birthCooldown--;
        if (t.adults >= 2 && t.birthCooldown === 0 && t.store >= P.birthCost + P.reserve * t.members) {
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
    t.alive = false;
    t.ended = world.time;
    world.tribes.splice(world.tribes.indexOf(t), 1);
    world.tribeById.delete(t.id);
    world.fallen.unshift(t);
    if (world.fallen.length > 12) world.fallen.pop();
}

// A tribe too large to hold together splits: half its people walk off to found
// a new camp at the greenest of a few nearby sites, under a new flag, taking
// half the store and a slightly changed culture.
function split(world, t) {
    const P = world.p.human;
    const pop = world.humans;
    const { rng } = world;
    let site = null;
    let bestGrass = -Infinity;
    for (let k = 0; k < 6; k++) {
        const a = rng.next() * TAU;
        const d = P.splitDistance * (0.8 + 0.4 * rng.next());
        const sx = wrapPos(t.camp.x + Math.cos(a) * d, world.width);
        const sy = wrapPos(t.camp.y + Math.sin(a) * d, world.height);
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
}
