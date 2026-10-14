// The cold, in the simulation (stage 4, package 2): what it costs people,
// the camp fires that keep it off, the cloaks worn against it and wearing
// out in it, and the snow underfoot. The numbers of how cold it is and how
// warm things keep are warmth.js's and snow.js's, shared with the page.
//
// Once a step (World.clock: clockCold): the moment's cold (warmth.js
// coldNow: the air's, and what high ground adds), and every SNOW_EVERY
// steps the snow underfoot, as a pace for each grass patch
// (world.snowPace: × 1 bare, × snow.slow in the deepest).
//
// Each person, as its step begins (humans.js, player.js: feel): the chill
// where it stands, and what keeps it off: its cloak, a burning torch in
// hand, a shelter (inShelter: package 4's huts), and its camp's fire if it
// stands within items.fireReach of the camp's centre (× how well the fire
// burns). Left in COLD (read at once: not re-entrant):
//   chill     how cold it is there (0..1)
//   away      the exposure without the fire: what it would feel out there
//   exposure  chill × (1 − warmth): what the cold costs it, cold.cost a step
//             at 1, and the cause of its death ('froze') at cold.froze or more
//   near      how well the fire it stands by burns (0: none near, or out)
//
// The fire (stepFire, from tribes.js): each tribe's `fire` (0 out, else
// 0..1, how well it burns) is lit at night, and by day when the chill at
// its camp is at least items.fireDay, while there is wood: it burns
// items.fire wood a member a night (by day × fireDayBurn), and burns low
// below items.fireLow wood a member. Items off, there is no wood: a fire
// that needs none.
//
// Cloaks wear by the cold they keep off (wearCloak), and one that comes
// through items.winters hard winters on one bearer's back is a legend
// ('winters': cloakSeasons, at the turns of winter and spring).
import { winterOf } from './calendar.js';
import { coldNow, chillAt, cloakWarmth } from './warmth.js';
import { snowLineAt, depthAt, snowPace } from './snow.js';
import { BIOME } from './terrain.js';
import { KIND, breakItem, forge, note, shielded } from './items.js';
import { wrapDelta } from './util.js';

export const SNOW_EVERY = 50; // steps between looks at the snow line (the snow underfoot changes slowly)

// The fire pit at the camp's centre (the page draws it, radius 1.6): nobody
// at camp stands nearer it than FIRE_CLEAR, and one warming by it keeps to
// a ring from WARM_NEAR to WARM_FAR (humans.js ring, tasks.js craftStep).
export const FIRE_CLEAR = 2.5;
export const WARM_NEAR = 3;
export const WARM_FAR = 5;

// ---- Once a step ----------------------------------------------------------------------------

// The moment's cold (World.clock), and the snow underfoot.
export function clockCold(world) {
    if (world.p.cold.enabled) {
        const k = coldNow(world.p.calendar, world.seed, world.time);
        world.chillAir = k.air;
        world.chillHigh = k.high;
    } else {
        world.chillAir = 0;
        world.chillHigh = 0;
    }
    if (world.lowland === null) return; // (a flat world: no snow lies)
    const at = world.time - (world.time % SNOW_EVERY);
    if (at !== world.snowAt) snowGrid(world, at);
}

// The pace in the snow on every grass patch, at step `at` (a multiple of
// SNOW_EVERY): a pure function of it, so a loaded world builds the same.
// Only worked out again when the snow line has moved.
function snowGrid(world, at) {
    world.snowAt = at;
    const line = snowLineAt(world.p.calendar, world.seed, at);
    if (line === world.snowLine && world.snowPace !== null) return;
    world.snowLine = line;
    const { lowland } = world;
    const field = world.terrain.biomeGrid;
    const slow = world.p.snow.slow;
    const n = lowland.length;
    if (world.snowPace === null || world.snowPace.length !== n) world.snowPace = new Float32Array(n);
    const pace = world.snowPace;
    for (let k = 0; k < n; k++) pace[k] = snowPace(slow, depthAt(line, lowland[k], field !== null && field[k] === BIOME.SNOW));
}

// ---- A person's cold -----------------------------------------------------------------------

export const COLD = { chill: 0, away: 0, exposure: 0, near: 0 };

// Is person i under a roof? (Package 4's huts; today nobody is.)
export function inShelter(world, i) {
    return false;
}

// The cold person i of `tribe` feels where it stands (into COLD; returns
// the exposure). Changes nothing.
export function feel(world, i, tribe) {
    COLD.chill = 0;
    COLD.away = 0;
    COLD.exposure = 0;
    COLD.near = 0;
    const air = world.chillAir;
    const high = world.chillHigh;
    if (air === 0 && high === 0) return 0;
    const pop = world.humans;
    const C = world.p.cold;
    const x = pop.x[i];
    const y = pop.y[i];
    let h = 0;
    let biome = -1;
    if (world.lowland !== null) {
        const gi = world.grass.index(x, y);
        h = world.lowland[gi];
        if (world.terrain.biomeGrid !== null) biome = world.terrain.biomeGrid[gi];
    }
    const chill = chillAt(air, high, h, biome);
    if (chill === 0) return 0;
    let left = 1;
    if (pop.cloak[i]) left *= 1 - cloakWarmth(world.items.get(pop.cloak[i]), C);
    if (world.itemsOn && shielded(world, i)) left *= 1 - C.torch; // (a burning torch in hand)
    if (inShelter(world, i)) left *= 1 - C.shelter;
    const near = byFire(world, i, tribe);
    COLD.chill = chill;
    COLD.away = chill * left;
    COLD.near = near;
    COLD.exposure = COLD.away * (1 - C.fire * near);
    return COLD.exposure;
}

// A cold spell for the person COLD is about (feel): too cold out there for
// what it wears (cold.seek), with its tribe's fire lit to warm up by. Such a
// one comes home to the fire (humans.js warmUp) and takes up no errand.
export const tooCold = (world, tribe) => world.p.cold.enabled && COLD.away >= world.p.cold.seek && tribe.fire > 0;

// How well the fire person i of `tribe` stands by burns (0..1): its camp's,
// within items.fireReach of the centre; 0 if it is out or far.
export function byFire(world, i, tribe) {
    const fire = tribe ? tribe.fire : 0;
    if (!(fire > 0)) return 0;
    const pop = world.humans;
    const R = world.p.items.fireReach;
    const dx = wrapDelta(tribe.camp.x - pop.x[i], world.width);
    const dy = wrapDelta(tribe.camp.y - pop.y[i], world.height);
    return dx * dx + dy * dy < R * R ? fire : 0;
}

// How hard the cold bites a person this step (as COLD has it: feel), 0..1:
// not at all up to cold.comfort of exposure (a cool spring dawn), then
// rising to 1 at full exposure.
export function bite(world) {
    const C = world.p.cold;
    const over = COLD.exposure - C.comfort;
    return over > 0 ? over / (1 - C.comfort) : 0;
}

// The energy the cold costs a person this step: cold.cost × bite.
export const coldCost = (world) => world.p.cold.cost * bite(world);

// Why person i, starved of energy, died: the cold, or hunger (as COLD has it).
export const deathBy = (world) => (COLD.exposure >= world.p.cold.froze ? 'froze' : 'starvation');

// Person i's cloak wears by the cold it keeps off this step (COLD: feel):
// the chill, less what the fire keeps off. Worn through, it breaks.
export function wearCloak(world, i) {
    const id = world.humans.cloak[i];
    if (!id || COLD.chill === 0) return;
    const item = world.items.get(id);
    if (item === undefined || item.rarity === 2) return;
    item.wear -=COLD.chill * (1 - world.p.cold.fire * COLD.near);
    if (item.wear <= 0) breakItem(world, item, i);
}

// ---- The fire -----------------------------------------------------------------------------

// Tribe t's fire this step (tribes.js stepTribes): lit at night, and by day
// in the cold, while there is wood; burning it, and burning low as it runs
// out. With items off, a fire that needs no wood.
export function stepFire(world, t) {
    const chill = world.p.cold.enabled ? campChill(world, t) : 0;
    const lit = world.night || chill >= world.p.items.fireDay;
    if (!lit) {
        t.fire = 0;
        return;
    }
    if (!world.itemsOn) {
        t.fire = 1;
        return;
    }
    const I = world.p.items;
    const C = world.p.calendar;
    if (t.wood > 0) {
        // (In the cold it is fed more: × 1 + items.fireCold × the chill at camp.)
        let burn = ((I.fire / (C.day - C.dawn - C.light - C.dusk)) * t.members) * (world.night ? 1 : I.fireDayBurn);
        if (chill > 0 && I.fireCold > 0) burn *= 1 + I.fireCold * chill;
        t.wood = t.wood > burn ? t.wood - burn : 0;
    }
    const low = I.fireLow * t.members;
    t.fire = t.wood <= 0 ? 0 : t.wood >= low ? 1 : t.wood / low;
}

// The chill at tribe t's camp now.
export function campChill(world, t) {
    const air = world.chillAir;
    const high = world.chillHigh;
    if (air === 0 && high === 0) return 0;
    if (world.lowland === null) return chillAt(air, high, 0, -1);
    const gi = world.grass.index(t.camp.x, t.camp.y);
    return chillAt(air, high, world.lowland[gi], world.terrain.biomeGrid !== null ? world.terrain.biomeGrid[gi] : -1);
}

// ---- Cloaks through the winters -----------------------------------------------------------

// At the first step of a winter, every cloak notes who wears it; at the
// first step of the spring after a hard winter, every cloak still on the
// same back has come through one more, and at items.winters it is a legend.
// (tasks.js stepItems, with items on.)
export function cloakSeasons(world) {
    const c = world.p.calendar;
    if (world.time % (c.day * c.seasonDays) !== 0) return;
    const season = world.now.season;
    if (season !== 3 && season !== 0) return;
    const hard = season === 0 && world.now.year > 1 && winterOf(c, world.seed, world.now.year - 1) === 2;
    for (const item of world.items.values()) {
        if (item.kind !== KIND.CLOAK) continue;
        if (season === 3) {
            item.wintered = item.bearer;
            continue;
        }
        if (hard && item.bearer !== 0 && item.wintered === item.bearer) {
            item.winters++;
            const text = `Came through ${item.winters === 1 ? 'a hard winter' : `${item.winters} hard winters`} on one back`;
            if (item.rarity === 2) note(world, item, text, item.bearer);
            else if (item.winters >= world.p.items.winters) forge(world, item, 'winters', text, item.bearer);
            else note(world, item, text, item.bearer);
        }
        item.wintered = 0;
    }
}
