// People: hunter-gatherers living in tribes (tribes.js), and what each does
// from step to step.
//
// Individuals live in a Population like the animals (world.humans), with
// extra columns: `tribe` (the tribe's id), `carry` (food in hand), `goal` (a
// camp it is raiding), and with items the weapon and tool in hand and a task
// for the tribe (population.js). How they behave follows their tribe's
// culture: aggression and sociality (tribes.js).
//
// With items (items.js, world.itemsOn), people hunt and fight with what they
// hold, butcher their kills, and take up tasks for the tribe (wood, flint,
// crafting at camp: tasks.js). Those branches all check world.itemsOn first;
// with items off, everyone hunts as with a plain spear that never breaks,
// and the world runs exactly as before items.
import { STATE } from './population.js';
import { stepPlayer } from './player.js';
import { fighting, heeded, lead, follow, led, errand } from './orders.js';
import {
    KIND, TASK, arm, armOf, hitWith, efficiencyOf, carryOf, blowOf, killed, credit, wearItem, butcherable,
    guards, raided, raiderKilled,
} from './items.js';
import { stepTask, job, campItems, wildPickup, fetch } from './tasks.js';
import { feel, COLD, coldCost, deathBy, wearCloak, tooCold, FIRE_CLEAR, WARM_NEAR, WARM_FAR } from './cold.js';
import { ripeFor, pick, TO } from './plants.js';
import { wrapDelta, wrapMod } from './util.js';

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

// Chance a spear throw kills: better with tribe-mates nearby, if they cooperate.
export const hitChance = (P, tribe, mates) => Math.min(0.95, P.hit * (1 + P.teamwork * mates * tribe.sociality));

// Person i of `tribe`, its spear back and `mates` tribe-mates near, throws
// at individual j of `prey` within its reach (or, with items, uses the
// weapon in hand, `arm`, filled: a club swings). It kills by hitChance (×
// the weapon's: hitWith), `cause` 'hunted' (a grazer) or 'killed' (a
// predator), and the weapon wears. With items the meat waits in a carcass
// to be cut up (items.js killed); without, it is returned, for the thrower
// to eat or carry. -1: no meat to take now (a miss, or with items). The
// AI's throws all come here (humans.js, and the rallied: orders.js).
export function throwAt(world, i, tribe, mates, prey, j, cause) {
    const P = world.p.human;
    const pop = world.humans;
    const itemsOn = world.itemsOn;
    pop.timer[i] = itemsOn ? arm.reload : P.reload;
    const hit = world.rng.next() < (itemsOn ? hitWith(P, tribe, mates, arm.hit) : hitChance(P, tribe, mates));
    // (For the page, which draws the spear: nothing reads it here.)
    world.events.push({
        type: itemsOn && arm.kind === KIND.CLUB ? 'swing' : 'throw', id: pop.id[i], x: pop.x[i], y: pop.y[i],
        tx: prey.x[j], ty: prey.y[j], hit, time: world.time, weapon: itemsOn ? arm.kind : KIND.SPEAR,
    });
    const weapon = itemsOn ? arm.item : null;
    let meat = -1;
    if (hit && itemsOn) {
        killed(world, i, prey, j, efficiencyOf(world, pop, i));
        credit(world, weapon, prey, j);
        world.die(prey, j, cause, pop.id[i]);
        pop.kills[i]++;
    } else if (hit) {
        meat = world.meatOf(prey, j) * P.efficiency;
        world.die(prey, j, cause, pop.id[i]);
        pop.kills[i]++;
    }
    if (itemsOn) wearItem(world, i, weapon);
    return meat;
}

// The nearest other tribe whose camp is within `range` of this tribe's camp,
// holds at least `minStore` food (a raid is only worth a full haul), and
// more a member than this tribe has: envy, not only hunger, sends raiders.
function raidTarget(world, tribe, range, minStore) {
    let best = null;
    let bestD2 = range * range;
    for (const other of world.tribes) {
        if (other === tribe || other.store < minStore || other.store * tribe.members <= tribe.store * other.members) continue;
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

// The person being stepped (stepHumans), as its branch works out what it
// does: its state (s), its way (dx, dy) and pace (v), and its energy and
// food in hand after it (e, c). And what the branches need to know of it:
// whether it is an adult, and armed (with items off, everyone is), its top
// speed, how far it sees, and the way home (campDx, campDy), campD long.
const me = {
    s: 0, e: 0, c: 0, dx: 0, dy: 0, v: 0,
    adult: false, armed: true, top: 0, sense: 0, campDx: 0, campDy: 0, campD: 0, bag: 1,
};

// One step of every person: the controlled one as the page has it
// (player.js), everyone else by the AI below. Each person's step sizes it
// up (into `me`), takes the first branch that applies, in this order, and
// then moves it, settles what it carries at camp or away, and pays the
// step's energy:
//
//   a predator in sight         facePredator: fight with mates, or flee
//   a stranger near (adults)    meetStranger: hawk or dove, by culture
//   cutting up a kill (items)   doTask, before anything but danger
//   rallied (orders.js)         rallied: with the player
//   Defend camp (adults)        keepToCamp, on guard
//   dusk and night              bedtime: home, and asleep at night (but
//                               a craft at camp goes on)
//   a cold spell                warmUp: home to the fire (cold.js: too
//                               cold out there for what it wears, the
//                               fire lit, and food at home or a full belly)
//   on a raid                   raid
//   a child                     keepToCamp, playing
//   a task for the tribe        doTask: wood, flint, or crafting (items)
//   hands full                  homeward
//   an aggressive tribe         sets out on a raid on a richer neighbour
//                               (raidTarget)
//   enough food at home         keepToCamp, resting (the hungry eat there;
//                               at camp, a full camp's chores: tasks.js)
//   otherwise                   forage: pick a ripe berry bush or fruit
//                               tree, hunt, or gather plants
//
// The cold (cold.js): as its step begins, each feels the chill where it
// stands, less what keeps it off (its cloak, its camp's fire, a torch); that
// exposure costs energy (cold.cost a step at 1), wears its cloak, and one
// who dies of it froze.
export function stepHumans(world) {
    const P = world.p.human;
    const pop = world.humans;
    const n = pop.n;
    const { x, y, energy, age, lifespan, speedGene, senseGene, upkeep, timer, state, focus, carry, goal, id } = pop;
    const tribeOf = pop.tribe;
    const { rng, width: W, height: H, tribeById } = world;
    const predators = world.carnivoreHash;
    const people = world.humanHash;
    const player = world.player; // the person the page controls, or null (player.js)
    const rally = player !== null ? lead(world) : null; // its calls heard, and a rally under way (orders.js)
    const itemsOn = world.itemsOn; // items (items.js): what people hold, and their tasks
    const { gear, task } = pop;
    const evening = world.night || world.dusk; // home at dusk, asleep at night (bedtime)
    const C = world.p.cold;
    const coldOn = C.enabled;

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
        const campDx = wrapDelta(tribe.camp.x - x[i], W);
        const campDy = wrapDelta(tribe.camp.y - y[i], H);
        const campD = Math.hypot(campDx, campDy) || 1;
        const atCamp = campD < P.campRadius;
        let victim = null; // a camp to raid
        focus[i] = 0;
        if (timer[i] > 0) timer[i]--; // spear "reload"
        // Items: the unarmed cannot throw or hunt (they still stand with
        // their mates against a predator); a basket carries more (bag: 1
        // without one); a butchering that cannot go on is let go.
        const bag = itemsOn && (gear[i] & 7) === KIND.BASKET ? carryOf(world, pop, i) : 1;
        const trip = P.tripLoad * bag;
        if (itemsOn && task[i] === TASK.BUTCHER && !butcherable(world, i)) {
            task[i] = TASK.NONE;
            pop.work[i] = 0;
        }
        me.s = STATE.AT_CAMP;
        me.e = energy[i];
        me.c = carry[i];
        me.dx = 0;
        me.dy = 0;
        me.v = 0;
        me.adult = adult;
        me.armed = !itemsOn || gear[i] >= 8;
        me.top = P.speed * speedGene[i];
        me.sense = P.sense * senseGene[i];
        me.campDx = campDx;
        me.campDy = campDy;
        me.campD = campD;
        me.bag = bag;
        feel(world, i, tribe); // the cold where it stands (into COLD: cold.js)

        const threat = predators.nearest(x[i], y[i], me.sense);
        const stranger = threat < 0 && adult ? people.strangerNear(x[i], y[i], P.meetRadius, i, tribeOf, tribeOf[i]) : -1;

        if (threat >= 0) facePredator(world, i, tribe, threat);
        else if (stranger >= 0) meetStranger(world, i, tribe, stranger);
        else if (itemsOn && task[i] === TASK.BUTCHER) doTask(world, i, tribe);
        else if (rally !== null && rally.ids.has(id[i])) rallied(world, rally, i, tribe);
        else if (adult && order !== null && order.kind === 'defend') keepToCamp(world, i, tribe, STATE.GUARDING);
        else if (evening && !(itemsOn && task[i] === TASK.CRAFT)) bedtime(world, i, tribe);
        else if (coldOn && tooCold(world, tribe) && (tribe.store > 0 || me.e >= P.hunger * P.maxEnergy)) warmUp(world, i, tribe);
        else if (goal[i] && me.c < trip) {
            if (!raid(world, i)) continue; // (struck down by the camp's defenders)
        } else if (!adult) keepToCamp(world, i, tribe, STATE.PLAYING);
        else if (itemsOn && task[i] !== TASK.NONE) doTask(world, i, tribe);
        else if (me.c >= trip) homeward(world, i, tribe);
        else if (rng.next() < tribe.aggression * P.raidRate && (victim = raidTarget(world, tribe, P.raidRange, P.raidLoad))) {
            // An aggressive tribe sends someone to rob a richer neighbour.
            goal[i] = victim.id;
            me.s = STATE.RAIDING;
        } else if (tribe.store >= P.storeTarget * tribe.members) keepToCamp(world, i, tribe, STATE.AT_CAMP); // (the hungry eat at home)
        else forage(world, i, tribe, order);

        if (me.c > P.carryMax * bag) me.c = P.carryMax * bag; // hands are full; the rest is left behind
        if (me.v > 0) move(world, i);
        if (atCamp) atHome(world, i, tribe, order);
        else awayFromHome(world, i);

        const v = me.v;
        let e = me.e - (P.baseCost * upkeep[i] + P.moveCost * v * v);
        if (COLD.exposure > C.comfort) e -= coldCost(world); // (the cold)
        if (e < P.starving * P.maxEnergy) lifespan[i]--; // (hunger ages)
        if (e > P.maxEnergy) e = P.maxEnergy;
        carry[i] = me.c;
        state[i] = me.s;
        if (e <= 0) {
            world.die(pop, i, deathBy(world)); // (starvation, or it froze)
            continue;
        }
        energy[i] = e;
        if (itemsOn && COLD.chill > 0 && pop.cloak[i]) wearCloak(world, i);
    }
}

// ---- A person's step, branch by branch -------------------------------------------------

// A predator in sight (carnivore j, the nearest: the hash keeps the offset
// to it). With tribe-mates near, an adult may stand and fight, as readily
// as its tribe's culture says (or a Defend camp order), throwing when it is
// in reach; otherwise it flees.
function facePredator(world, i, tribe, j) {
    const P = world.p.human;
    const pop = world.humans;
    const predators = world.carnivoreHash;
    const { carnivores } = world;
    const itemsOn = world.itemsOn;
    pop.focus[i] = carnivores.id[j];
    const mates = world.humanHash.count(pop.x[i], pop.y[i], P.groupRadius, i, pop.tribe, pop.tribe[i], true);
    if (me.adult && mates > 0 && world.rng.next() < fighting(tribe)) {
        // Stand together and fight.
        me.s = STATE.FIGHTING;
        if (itemsOn) armOf(world, i); // (its weapon: reach, chance, reload)
        if (me.armed && pop.timer[i] === 0 && predators.d2 <= (itemsOn ? arm.range2 : P.throwRange * P.throwRange)) {
            const meat = throwAt(world, i, tribe, mates, carnivores, j, 'killed');
            if (meat >= 0) me.c += meat; // (all of it carried)
        }
    } else {
        me.s = STATE.FLEEING;
        const d = Math.sqrt(predators.d2) || 1;
        me.dx = -predators.dx / d;
        me.dy = -predators.dy / d;
        me.v = me.top;
    }
}

// A stranger near (person j, of another tribe, the nearest: the hash keeps
// the offset). Hawk, as often as the tribe is aggressive: attack and rob;
// the stranger may fight back. A blow takes human.reload to ready again,
// as a throw does. (Items: a club hits harder; each blow wears
// what struck it.) Otherwise dove: walk away. Hurt (below human.beaten of
// its energy), it runs: most fights end so, not in a death.
function meetStranger(world, i, tribe, j) {
    const P = world.p.human;
    const pop = world.humans;
    const { energy, carry, id } = pop;
    const { rng } = world;
    const itemsOn = world.itemsOn;
    pop.focus[i] = id[j];
    if (me.e < P.beaten * P.maxEnergy) {
        // Hurt: it runs from the fight (most fights end so, not in a death).
        me.s = STATE.FLEEING;
        const people = world.humanHash;
        const d = Math.sqrt(people.d2) || 1;
        me.dx = -people.dx / d;
        me.dy = -people.dy / d;
        me.v = me.top;
    } else if (rng.next() < tribe.aggression) {
        me.s = STATE.FIGHTING;
        if (pop.timer[i] > 0) return; // (between blows: a blow, like a throw, takes human.reload to ready again)
        pop.timer[i] = P.reload;
        const other = world.tribeById.get(pop.tribe[j]);
        energy[j] -= itemsOn ? P.fightDamage * blowOf(world, pop, i) : P.fightDamage;
        me.c += carry[j];
        carry[j] = 0;
        const back = pop.timer[j] === 0 && rng.next() < other.aggression; // (a blow back, if it has one ready)
        if (back) pop.timer[j] = P.reload;
        if (back) me.e -= itemsOn ? P.fightDamage * blowOf(world, pop, j) : P.fightDamage;
        const weapon = itemsOn && pop.weapon[i] ? world.items.get(pop.weapon[i]) : null;
        if (energy[j] <= 0) {
            if (itemsOn) credit(world, weapon, pop, j);
            world.die(pop, j, 'killed', id[i]);
            pop.kills[i]++;
        } else if (itemsOn && back && pop.weapon[j]) wearItem(world, j, world.items.get(pop.weapon[j]));
        if (itemsOn) wearItem(world, i, weapon);
    } else {
        me.s = STATE.AVOIDING;
        const people = world.humanHash;
        const d = Math.sqrt(people.d2) || 1;
        me.dx = -people.dx / d;
        me.dy = -people.dy / d;
        me.v = me.top * P.cruise;
    }
}

// A task for the tribe (tasks.js stepTask): cutting up a kill, an errand
// for wood or flint, or making an item at camp.
function doTask(world, i, tribe) {
    stepTask(world, i, tribe, me.e, me.c, me.campDx, me.campDy, me.campD);
    me.s = job.s;
    me.e = job.e;
    me.c = job.c;
    me.dx = job.dx;
    me.dy = job.dy;
    me.v = job.v;
}

// Rallied (orders.js follow): with the player, going for what they go for.
function rallied(world, rally, i, tribe) {
    me.s = follow(world, rally, i, tribe, me.e, me.c);
    me.e = led.e;
    me.c = led.c;
    me.dx = led.dx;
    me.dy = led.dy;
    me.v = led.v;
}

// Around camp, in state s (children playing, guards under a Defend camp
// order, adults resting with food enough at home): back within six tenths
// of its radius when farther out.
function keepToCamp(world, i, tribe, s) {
    me.s = s;
    if (me.campD > world.p.human.campRadius * 0.6) headHome(world, i, tribe);
    else ring(world, i, FIRE_CLEAR, Infinity);
}

// The fire pit at the camp's centre (package 2; the page draws it, radius
// 1.6): nobody stands in it. At camp, one nearer than FIRE_CLEAR steps out
// of it; one warming by it keeps to a ring from WARM_NEAR to WARM_FAR
// (cold.js).
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// Person i at camp (me.campDx, campDy: the way to its centre), between
// `near` and `far` of the centre: if it is not, a step that way (a walk,
// no farther than it needs).
function ring(world, i, near, far) {
    const dx = me.campDx;
    const dy = me.campDy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= near && d <= far) return;
    const pace = me.top * world.p.human.cruise;
    if (d < near) {
        // Out of the fire: away from the centre (from the very centre, on a bearing of its own).
        if (d > 1e-9) {
            me.dx = -dx / d;
            me.dy = -dy / d;
        } else {
            const a = world.humans.id[i] * GOLDEN;
            me.dx = Math.cos(a);
            me.dy = Math.sin(a);
        }
        const need = near - d + 0.25;
        me.v = need < pace ? need : pace;
    } else {
        // In to the ring: toward the centre, to its middle.
        me.dx = dx / d;
        me.dy = dy / d;
        const need = d - (near + far) / 2;
        me.v = need < pace ? need : pace;
    }
}

// Dusk and night: home (a raid is called off, an errand brings home what it
// has), and at camp rest at dusk, asleep at night, until dawn.
function bedtime(world, i, tribe) {
    const pop = world.humans;
    pop.goal[i] = 0;
    if (world.itemsOn && pop.task[i] !== TASK.NONE) {
        pop.work[i] = world.p.items.errand; // (an errand: done for the day)
        doTask(world, i, tribe);
        return;
    }
    if (me.campD > world.p.human.campRadius * 0.6) {
        me.s = STATE.HOMEWARD;
        headHome(world, i, tribe);
    } else {
        me.s = world.night ? STATE.SLEEPING : STATE.AT_CAMP;
        ring(world, i, FIRE_CLEAR, Infinity); // (not in the fire)
    }
}

// A cold spell (cold.js: too cold out there for what it wears): home to the
// fire, and by it until the spell is over. A raid is called off, an errand
// brings home what it has; a craft at camp goes on.
function warmUp(world, i, tribe) {
    const pop = world.humans;
    pop.goal[i] = 0;
    if (world.itemsOn && pop.task[i] !== TASK.NONE) {
        if (pop.task[i] !== TASK.CRAFT) pop.work[i] = world.p.items.errand; // (an errand: done)
        doTask(world, i, tribe);
        return;
    }
    if (me.campD > world.p.human.campRadius * 0.6) {
        me.s = STATE.HOMEWARD;
        headHome(world, i, tribe);
    } else {
        me.s = STATE.WARMING;
        ring(world, i, WARM_NEAR, WARM_FAR); // (in a ring around the fire)
    }
}

// Hands full: home with it.
function homeward(world, i, tribe) {
    me.s = STATE.HOMEWARD;
    headHome(world, i, tribe);
}

// The way home, at a walk.
function headHome(world, i, tribe) {
    const pop = world.humans;
    toward(world, tribe, pop.x[i], pop.y[i], me.campDx, me.campDy, me.campD);
    me.dx = wayX;
    me.dy = wayY;
    me.v = me.top * world.p.human.cruise;
}

// On a raid: walk to the other tribe's camp and take food from its store,
// if its defenders let you (beaten, it goes home empty-handed). False if
// they struck the raider down (it is dead: nothing more of its step).
function raid(world, i) {
    const P = world.p.human;
    const pop = world.humans;
    const { x, y, goal } = pop;
    const target = world.tribeById.get(goal[i]);
    if (!target) {
        goal[i] = 0; // that tribe is gone
        return true;
    }
    me.s = STATE.RAIDING;
    const rdx = wrapDelta(target.camp.x - x[i], world.width);
    const rdy = wrapDelta(target.camp.y - y[i], world.height);
    const rd = Math.hypot(rdx, rdy) || 1;
    if (rd < P.campRadius) {
        let defenders = world.humanHash.count(x[i], y[i], P.defendRadius, i, pop.tribe, target.id, true);
        // (A camp under orders to defend is met by every adult: orders.js.)
        if (target.order !== null && target.order.kind === 'defend' && defenders < target.adults) defenders = target.adults;
        // Each defender may strike it, until it is beaten (below
        // human.beaten of its energy): then it is driven off empty-handed.
        let beaten = false;
        for (let k = 0; k < defenders; k++) {
            if (world.rng.next() < P.guard * (0.5 + 0.5 * target.sociality)) {
                me.e -= P.fightDamage;
                if (me.e < P.beaten * P.maxEnergy) {
                    beaten = true;
                    break;
                }
            }
        }
        if (me.e <= 0) {
            pop.energy[i] = 0;
            if (world.itemsOn) raiderKilled(world, i, target); // (a defender's weapon struck it down: items.js)
            world.die(pop, i, 'killed');
            return false;
        }
        if (beaten) {
            goal[i] = 0;
            me.s = STATE.FLEEING;
            return true;
        }
        const loot = Math.min(target.store, P.raidLoad);
        target.store -= loot;
        me.c += loot;
        goal[i] = 0;
        if (world.itemsOn) raided(world, i, target); // (and what lies in the camp)
    } else {
        toward(world, target, x[i], y[i], rdx, rdy, rd);
        me.dx = wayX;
        me.dy = wayY;
        me.v = me.top * P.cruise;
    }
    return true;
}

// Forage: hunt a grazer in sight near home, otherwise gather plants.
// (Orders, orders.js: under Hunt here, "near home" is near its marker;
// under Gather food, nobody hunts. Items: the unarmed do not hunt.)
function forage(world, i, tribe, order) {
    // (Items: what is left of a kill comes before a new one: tasks.js fetch.)
    if (order === null && world.itemsOn && world.carcasses.size !== 0 && fetch(world, i, tribe)) {
        doTask(world, i, tribe);
        return;
    }
    const ground = order !== null && order.kind === 'hunt' ? order : null;
    // (A ripe berry bush or fruit tree in sight: fast food, before a hunt. Not under Hunt here.)
    if (world.plants !== null && ground === null && pickPlant(world, i, tribe)) return;
    if ((order !== null && order.kind === 'gather') || !me.armed || !hunt(world, i, tribe, ground)) gatherPlants(world, i, tribe, ground);
}

// The nearest ripe berry bush or fruit tree within plants.sight (plants.js
// ripeFor): to it, and pick (plants.pick a step, more with a basket). False
// if there is none.
const PICK_REACH = 2;
function pickPlant(world, i, tribe) {
    const j = ripeFor(world, i, tribe);
    if (j < 0) return false;
    me.s = STATE.GATHERING;
    if (TO.d > PICK_REACH) {
        me.dx = TO.dx / TO.d;
        me.dy = TO.dy / TO.d;
        const pace = me.top * world.p.human.cruise;
        me.v = pace < TO.d - 1 ? pace : TO.d - 1;
    } else me.c += pick(world, j, world.p.plants.pick * me.bag);
    return true;
}

// The nearest grazer in sight, if it is on the hunting ground (near home,
// or within range of a Hunt here marker): after it, and a throw (a club's
// swing) once it is within reach and the spear is back. False if there is
// none to hunt. (In forest, with biomes.cover, a grazer is seen only from
// closer.)
function hunt(world, i, tribe, ground) {
    const P = world.p.human;
    const pop = world.humans;
    const { x, y } = pop;
    const prey = world.herbivoreHash;
    const { herbivores } = world;
    const itemsOn = world.itemsOn;
    const target = world.hidden === null ? prey.nearest(x[i], y[i], me.sense) : world.spot(prey, x[i], y[i], me.sense);
    if (target < 0) return false;
    const fx = wrapDelta(herbivores.x[target] - (ground === null ? tribe.camp.x : ground.x), world.width);
    const fy = wrapDelta(herbivores.y[target] - (ground === null ? tribe.camp.y : ground.y), world.height);
    // (Items: its weapon's reach; with a club, only a grazer already within
    // it: walking up to one only frightens it off.)
    if (!(fx * fx + fy * fy < (ground === null ? P.homeRange * P.homeRange : ground.range2)
        && (!itemsOn || armOf(world, i) !== KIND.CLUB || prey.d2 <= arm.range2))) return false;
    me.s = STATE.HUNTING;
    pop.focus[i] = herbivores.id[target];
    if (prey.d2 <= (itemsOn ? arm.range2 : P.throwRange * P.throwRange)) {
        if (pop.timer[i] === 0) {
            const mates = world.humanHash.count(x[i], y[i], P.groupRadius, i, pop.tribe, pop.tribe[i], true);
            const food = throwAt(world, i, tribe, mates, herbivores, target, 'hunted');
            if (food >= 0) {
                // Eat a share now; the rest goes home to the camp, carried
                // by the hunter and the tribe-mates near (what none can
                // carry is left).
                let eat = food * (1 - tribe.sociality);
                if (eat > P.maxEnergy - me.e) eat = P.maxEnergy - me.e;
                me.e += eat;
                let rest = food - eat;
                const room = P.carryMax - me.c;
                if (rest > room) rest = room + shareMeat(world, i, rest - room);
                me.c += rest;
            }
        }
    } else {
        const d = Math.sqrt(prey.d2);
        me.dx = prey.dx / d;
        me.dy = prey.dy / d;
        me.v = me.top * P.cruise;
    }
    return true;
}

// Meat from person i's kill (items off: no carcass waits) that its hands
// cannot hold: the adult tribe-mates within human.groupRadius take what they
// can carry. What they took.
function shareMeat(world, i, meat) {
    const P = world.p.human;
    const pop = world.humans;
    const r2 = P.groupRadius * P.groupRadius;
    let given = 0;
    for (let k = 0; k < pop.n && given < meat; k++) {
        if (k === i || pop.tribe[k] !== pop.tribe[i] || pop.energy[k] <= 0 || pop.age[k] < P.maturity) continue;
        if (world.player !== null && pop.id[k] === world.player.id && !world.player.auto) continue; // (its pouch is its own)
        const dx = wrapDelta(pop.x[k] - pop.x[i], world.width);
        const dy = wrapDelta(pop.y[k] - pop.y[i], world.height);
        if (dx * dx + dy * dy > r2) continue;
        let take = P.carryMax - pop.carry[k];
        if (take <= 0) continue;
        if (take > meat - given) take = meat - given;
        pop.carry[k] += take;
        given += take;
    }
    return given;
}

// Gathering plants: back toward home (or the Hunt here marker) from beyond
// it; else from the patch underfoot while it is worth it; else a social
// forager keeps up with its party, and the rest peek ahead and to the
// sides for a greener patch.
function gatherPlants(world, i, tribe, ground) {
    const P = world.p.human;
    const pop = world.humans;
    const { x, y } = pop;
    const { grass, rng, width: W, height: H } = world;
    const g = grass.g;
    const people = world.humanHash;
    me.s = STATE.GATHERING;
    const gi = grass.index(x[i], y[i]);
    if (ground !== null ? beyond(world, ground, x[i], y[i]) : me.campD >= P.homeRange) {
        if (ground === null) toward(world, tribe, x[i], y[i], me.campDx, me.campDy, me.campD);
        me.dx = wayX;
        me.dy = wayY;
        me.v = me.top * P.cruise;
    } else if (g[gi] >= P.gatherMin) {
        let take = P.gatherRate;
        if (take > g[gi]) take = g[gi];
        g[gi] -= take;
        me.c += take * P.plantEnergy;
    } else if (rng.next() < tribe.sociality
        && people.nearest(x[i], y[i], P.groupRadius, i, pop.tribe, pop.tribe[i], true) >= 0
        && people.d2 > P.partySpacing * P.partySpacing) {
        // Social foragers keep up with their party instead of wandering off alone.
        const d = Math.sqrt(people.d2);
        me.dx = people.dx / d;
        me.dy = people.dy / d;
        me.v = me.top * P.cruise;
    } else {
        // Peek ahead and to the sides for a greener patch.
        let h = pop.heading[i];
        let best = g[gi];
        let turn = 2;
        const look = me.sense * 0.5;
        for (let k = -1; k <= 1; k++) {
            const a = h + k * 0.8;
            const gv = g[grass.index(wrapMod(x[i] + Math.cos(a) * look, W), wrapMod(y[i] + Math.sin(a) * look, H))];
            if (gv > best) {
                best = gv;
                turn = k;
            }
        }
        h = turn === 2 ? h + (rng.next() - 0.5) * 2 : h + turn * 0.8;
        me.dx = Math.cos(h);
        me.dy = Math.sin(h);
        me.v = me.top * P.cruise;
    }
}

// The move: on its way (me.dx, dy) at its pace (me.v), slower in deep snow
// (cold.js snowPace; the effort is the same). Water or a cliff ahead, it
// veers along it.
function move(world, i) {
    const { x, y, heading } = world.humans;
    const { terrain } = world;
    const snow = world.snowPace;
    const v = snow === null ? me.v : me.v * snow[world.grass.index(x[i], y[i])];
    let dx = me.dx;
    let dy = me.dy;
    let nx = wrapMod(x[i] + dx * v, world.width);
    let ny = wrapMod(y[i] + dy * v, world.height);
    if (terrain !== null && terrain.blocked(nx, ny)) {
        terrain.move(x[i], y[i], dx, dy, v, terrain.side(dx, dy, heading[i], world.rng));
        nx = terrain.x;
        ny = terrain.y;
        dx = terrain.ux;
        dy = terrain.uy;
    }
    x[i] = nx;
    y[i] = ny;
    heading[i] = Math.atan2(dy, dx);
}

// Home: put the food in the store, and eat if hungry. (Items: a basket
// wears with each load more than hands could carry; hides and wood or
// flint go in too, something better is taken from the camp's goods, and a
// task for the tribe taken up: items.js. And Gather wood, flint: orders.js.)
function atHome(world, i, tribe, order) {
    const P = world.p.human;
    const pop = world.humans;
    const itemsOn = world.itemsOn;
    let e = me.e;
    // (One cutting up a kill in camp keeps what it cuts until its hands are
    // full, as anywhere: a kill is so many loads, wherever it lies.)
    const cutting = itemsOn && pop.task[i] === TASK.BUTCHER;
    if (!cutting) {
        if (itemsOn && me.c > P.tripLoad && (pop.gear[i] & 7) === KIND.BASKET) wearItem(world, i, world.items.get(pop.tool[i]));
        tribe.store += me.c;
        me.c = 0;
    }
    if (e < P.hunger * P.maxEnergy && tribe.store > 0) {
        let take = P.maxEnergy * 0.9 - e;
        if (take > tribe.store) take = tribe.store;
        tribe.store -= take;
        e += take;
    }
    me.e = e;
    if (cutting) return;
    if (itemsOn) campItems(world, i, tribe);
    if (order !== null && itemsOn && !world.night && !world.dusk) errand(world, i, tribe, order); // (not after dusk)
}

// Away from home: starving, it eats what it carries. (Items: now and then,
// an adult looks for anything better lying near.)
function awayFromHome(world, i) {
    const P = world.p.human;
    let e = me.e;
    let c = me.c;
    if (e < P.starving * P.maxEnergy && c > 0) {
        let take = P.maxEnergy * 0.5 - e;
        if (take > c) take = c;
        c -= take;
        e += take;
    }
    me.e = e;
    me.c = c;
    if (world.itemsOn && me.adult && world.wild.length !== 0 && (world.time + world.humans.id[i]) % 8 === 0) wildPickup(world, i);
}
