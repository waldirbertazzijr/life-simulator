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
//
// With items (items.js, world.itemsOn), people hunt and fight with what they
// hold, butcher their kills, and take up tasks for the tribe (wood, flint,
// crafting at camp). Those branches all check world.itemsOn first; with items
// off, everyone hunts as with a plain spear that never breaks, and the world
// runs exactly as before items.
import { STATE } from './population.js';
import { tribeIdentity } from './identity.js';
import { stepPlayer } from './player.js';
import { fighting, heeded, lead, follow, led } from './orders.js';
import {
    KIND, TASK, arm, armOf, hitWith, efficiencyOf, carryOf, blowOf, killed, credit, wearItem, butcherable,
    stepTask, job, campItems, wildPickup, guards, raided, raiderKilled, foundItems, splitItems, tribeEnded,
    newItem, hold,
} from './items.js';

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

// Hunt here (orders.js): is (x, y) beyond the range of the order's marker?
// If so, the way back to it (by land) is left in wayX, wayY.
function beyond(world, order, x, y) {
    const ddx = wrapDelta(order.x - x, world.width);
    const ddy = wrapDelta(order.y - y, world.height);
    const d = Math.hypot(ddx, ddy) || 1;
    if (d < order.range) return false;
    toward(world, order, x, y, ddx, ddy, d);
    return true;
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
    const i = world.spawn(pop, P, wrapPos(x, world.width), wrapPos(y, world.height), energy, speed, sense, age, parent);
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

// Chance a spear throw kills: better with tribe-mates nearby, if they cooperate.
export const hitChance = (P, tribe, mates) => Math.min(0.95, P.hit * (1 + P.teamwork * mates * tribe.sociality));

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

// Would tribe-mates near person j drive off a predator? (With items, a club
// counts double and a bow not at all: items.js guards.)
export function driveOff(world, j) {
    const P = world.p.human;
    const pop = world.humans;
    const defenders = world.itemsOn ? guards(world, j) : world.humanHash.count(pop.x[j], pop.y[j], P.defendRadius, j, pop.tribe, pop.tribe[j], true);
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
    const player = world.player; // the person the page controls, or null (player.js)
    const rally = player !== null ? lead(world) : null; // its calls heard, and a rally under way (orders.js)
    const itemsOn = world.itemsOn; // items (items.js): what people hold, and their tasks
    const { gear, task } = pop;

    for (let i = 0; i < n; i++) {
        if (energy[i] <= 0) continue; // killed earlier this step
        if (player !== null && id[i] === player.id && !player.auto) {
            stepPlayer(world, i); // the page decides where it goes (on autopilot, the AI below)
            continue;
        }
        if (++age[i] > lifespan[i]) {
            world.die(pop, i, 'old age');
            continue;
        }
        const tribe = tribeById.get(tribeOf[i]);
        const order = heeded(world.p, tribe); // the player's standing order, unless the tribe is hungry (orders.js); or null
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
        // Items: the unarmed cannot throw or hunt (they still stand with
        // their mates against a predator); a basket carries more (bag: 1
        // without one); a butchering that cannot go on is let go.
        const armed = !itemsOn || gear[i] >= 8;
        const bag = itemsOn && (gear[i] & 7) === KIND.BASKET ? carryOf(world, pop, i) : 1;
        const trip = P.tripLoad * bag;
        if (itemsOn && task[i] === TASK.BUTCHER && !butcherable(world, i)) {
            task[i] = TASK.NONE;
            pop.work[i] = 0;
        }

        const threat = predators.nearest(x[i], y[i], sense);
        const stranger = threat < 0 && adult ? people.nearest(x[i], y[i], P.meetRadius, i, tribeOf, tribeOf[i], false) : -1;

        if (threat >= 0) {
            focus[i] = carnivores.id[threat];
            const mates = people.count(x[i], y[i], P.groupRadius, i, tribeOf, tribeOf[i], true);
            if (adult && mates > 0 && rng.next() < fighting(tribe)) {
                // Stand together and fight.
                s = STATE.FIGHTING;
                if (itemsOn) armOf(world, i); // (its weapon: reach, chance, reload)
                if (armed && timer[i] === 0 && predators.d2 <= (itemsOn ? arm.range2 : throw2)) {
                    timer[i] = itemsOn ? arm.reload : P.reload;
                    const hit = rng.next() < (itemsOn ? hitWith(P, tribe, mates, arm.hit) : hitChance(P, tribe, mates));
                    // (For the page, which draws the spear: nothing reads it here.)
                    world.events.push({
                        type: itemsOn && arm.kind === KIND.CLUB ? 'swing' : 'throw', id: id[i], x: x[i], y: y[i],
                        tx: carnivores.x[threat], ty: carnivores.y[threat], hit, time: world.time, weapon: itemsOn ? arm.kind : KIND.SPEAR,
                    });
                    const weapon = itemsOn ? arm.item : null;
                    if (hit && itemsOn) {
                        // Its meat waits in a carcass to be cut up (items.js).
                        killed(world, i, carnivores, threat, efficiencyOf(world, pop, i));
                        credit(world, weapon, carnivores, threat);
                        world.die(carnivores, threat, 'killed', id[i]);
                        kills[i]++;
                    } else if (hit) {
                        c += carnivores.energy[threat] * P.efficiency;
                        world.die(carnivores, threat, 'killed', id[i]);
                        kills[i]++;
                    }
                    if (itemsOn) wearItem(world, i, weapon);
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
                // Hawk: attack and rob. The stranger may fight back. (Items:
                // a club hits harder; each blow wears what struck it.)
                s = STATE.FIGHTING;
                const other = tribeById.get(tribeOf[stranger]);
                energy[stranger] -= itemsOn ? P.fightDamage * blowOf(world, pop, i) : P.fightDamage;
                c += carry[stranger];
                carry[stranger] = 0;
                const back = rng.next() < other.aggression;
                if (back) e -= itemsOn ? P.fightDamage * blowOf(world, pop, stranger) : P.fightDamage;
                const weapon = itemsOn && pop.weapon[i] ? world.items.get(pop.weapon[i]) : null;
                if (energy[stranger] <= 0) {
                    if (itemsOn) credit(world, weapon, pop, stranger);
                    world.die(pop, stranger, 'killed', id[i]);
                    kills[i]++;
                } else if (itemsOn && back && pop.weapon[stranger]) wearItem(world, stranger, world.items.get(pop.weapon[stranger]));
                if (itemsOn) wearItem(world, i, weapon);
            } else {
                // Dove: walk away.
                s = STATE.AVOIDING;
                const d = Math.sqrt(people.d2) || 1;
                dx = -people.dx / d;
                dy = -people.dy / d;
                v = top * P.cruise;
            }
        } else if (itemsOn && task[i] === TASK.BUTCHER) {
            // Cutting up a kill (items.js), before anything but danger.
            stepTask(world, i, tribe, e, c, campDx, campDy, campD);
            s = job.s;
            e = job.e;
            c = job.c;
            dx = job.dx;
            dy = job.dy;
            v = job.v;
        } else if (rally !== null && rally.ids.has(id[i])) {
            // Rallied (orders.js): with the player, going for what they go for.
            s = follow(world, rally, i, tribe, e, c);
            e = led.e;
            c = led.c;
            dx = led.dx;
            dy = led.dy;
            v = led.v;
        } else if (adult && order !== null && order.kind === 'defend') {
            // Defend camp (orders.js): in camp, on guard.
            s = STATE.GUARDING;
            if (campD > P.campRadius * 0.6) {
                toward(world, tribe, x[i], y[i], campDx, campDy, campD);
                dx = wayX;
                dy = wayY;
                v = top * P.cruise;
            }
        } else if (goal[i] && c < trip) {
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
                    let defenders = people.count(x[i], y[i], P.defendRadius, i, tribeOf, target.id, true);
                    // (A camp under orders to defend is met by every adult: orders.js.)
                    if (target.order !== null && target.order.kind === 'defend' && defenders < target.adults) defenders = target.adults;
                    for (let k = 0; k < defenders; k++) {
                        if (rng.next() < P.guard * (0.5 + 0.5 * target.sociality)) e -= P.fightDamage;
                    }
                    if (e <= 0) {
                        energy[i] = 0;
                        if (itemsOn) raiderKilled(world, i, target); // (a defender's weapon struck it down: items.js)
                        world.die(pop, i, 'killed');
                        continue;
                    }
                    const loot = Math.min(target.store, P.raidLoad);
                    target.store -= loot;
                    c += loot;
                    goal[i] = 0;
                    if (itemsOn) raided(world, i, target); // (and what lies in the camp)
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
        } else if (itemsOn && task[i] !== TASK.NONE) {
            // Something for the tribe (items.js): wood, flint, or making an item at camp.
            stepTask(world, i, tribe, e, c, campDx, campDy, campD);
            s = job.s;
            dx = job.dx;
            dy = job.dy;
            v = job.v;
        } else if (c >= trip) {
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
            // (Orders, orders.js: under Hunt here, "near home" is near its
            // marker; under Gather food, nobody hunts.)
            let hunting = false;
            const ground = order !== null && order.kind === 'hunt' ? order : null;
            // (In forest, with biomes.cover, a grazer is seen only from closer.
            // Items: the unarmed do not hunt.)
            const target = (order !== null && order.kind === 'gather') || !armed ? -1
                : world.hidden === null ? prey.nearest(x[i], y[i], sense) : world.spot(prey, x[i], y[i], sense);
            if (target >= 0) {
                const fx = wrapDelta(herbivores.x[target] - (ground === null ? tribe.camp.x : ground.x), W);
                const fy = wrapDelta(herbivores.y[target] - (ground === null ? tribe.camp.y : ground.y), H);
                // (Items: its weapon's reach; with a club, only a grazer already
                // within it: walking up to one only frightens it off.)
                if (fx * fx + fy * fy < (ground === null ? home2 : ground.range2)
                    && (!itemsOn || armOf(world, i) !== KIND.CLUB || prey.d2 <= arm.range2)) {
                    hunting = true;
                    s = STATE.HUNTING;
                    focus[i] = herbivores.id[target];
                    if (prey.d2 <= (itemsOn ? arm.range2 : throw2)) {
                        if (timer[i] === 0) {
                            timer[i] = itemsOn ? arm.reload : P.reload;
                            const mates = people.count(x[i], y[i], P.groupRadius, i, tribeOf, tribeOf[i], true);
                            const hit = rng.next() < (itemsOn ? hitWith(P, tribe, mates, arm.hit) : hitChance(P, tribe, mates));
                            world.events.push({
                                type: itemsOn && arm.kind === KIND.CLUB ? 'swing' : 'throw', id: id[i], x: x[i], y: y[i],
                                tx: herbivores.x[target], ty: herbivores.y[target], hit, time: world.time, weapon: itemsOn ? arm.kind : KIND.SPEAR,
                            });
                            const weapon = itemsOn ? arm.item : null;
                            if (hit && itemsOn) {
                                // The kill waits to be cut up (items.js): the
                                // hunter eats its share as it butchers.
                                killed(world, i, herbivores, target, efficiencyOf(world, pop, i));
                                credit(world, weapon, herbivores, target);
                                world.die(herbivores, target, 'hunted', id[i]);
                                kills[i]++;
                            } else if (hit) {
                                const food = herbivores.energy[target] * P.efficiency;
                                world.die(herbivores, target, 'hunted', id[i]);
                                kills[i]++;
                                // Eat a share now; the rest goes home to the camp.
                                let eat = food * (1 - tribe.sociality);
                                if (eat > P.maxEnergy - e) eat = P.maxEnergy - e;
                                e += eat;
                                c += food - eat;
                            }
                            if (itemsOn) wearItem(world, i, weapon);
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
                if (ground !== null ? beyond(world, ground, x[i], y[i]) : campD >= P.homeRange) {
                    if (ground === null) toward(world, tribe, x[i], y[i], campDx, campDy, campD);
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

        if (c > P.carryMax * bag) c = P.carryMax * bag; // hands are full; the rest is left behind

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
            // Home: put the food in the store, and eat if hungry. (Items: a
            // basket wears with each load more than hands could carry; hides
            // and wood or flint go in too, something better is taken from
            // the camp's goods, and a task for the tribe taken up: items.js.)
            if (itemsOn && c > P.tripLoad && (gear[i] & 7) === KIND.BASKET) wearItem(world, i, world.items.get(pop.tool[i]));
            tribe.store += c;
            c = 0;
            if (e < P.hunger * P.maxEnergy && tribe.store > 0) {
                let take = P.maxEnergy * 0.9 - e;
                if (take > tribe.store) take = tribe.store;
                tribe.store -= take;
                e += take;
            }
            if (itemsOn) campItems(world, i, tribe);
        } else {
            if (e < P.starving * P.maxEnergy && c > 0) {
                // Far from home and starving: eat what you carry.
                let take = P.maxEnergy * 0.5 - e;
                if (take > c) take = c;
                c -= take;
                e += take;
            }
            // (Items: now and then, a look for anything better lying near.)
            if (itemsOn && adult && world.wild.length !== 0 && (world.time + id[i]) % 8 === 0) wildPickup(world, i);
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
    if (world.itemsOn) tribeEnded(world, t); // what lay in its camp, and what outlived it (items.js)
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
    if (world.itemsOn) splitItems(world, t, daughter); // half the materials, and of what lies in camp
}
