// Items (spec §8): what people make from the land, use, wear out, hand down,
// lose and find; the few that become legends; and butchering for everyone
// (§15). With params.items.enabled off, `world.itemsOn` is false, nothing
// here is ever called, and the world is the one of before items, to the bit.
//
// Materials. A tribe's store holds wood, flint and hide besides its food
// (numbers on the tribe; nothing spoils). Wood is chopped in forest, and a
// little anywhere grass grows; flint is quarried on bare rock, and a little on
// tundra (on a flat world, a little anywhere); hides come with kills. Each
// tribe finds its nearest good spots when it is founded (findSpots), each with
// a way there by land, as its camp has (tribe.paths). The player gathers them
// by hand where it stands (handWork, yieldAt: acts/hands.js), at the same rates.
//
// Items. world.items maps an item's id to a plain object:
//
//   id, kind      KIND code (an index into ITEM_KINDS)
//   rarity        0 normal, 1 rare, 2 legendary; `trait` the boosted one ('' if
//                 none) and `mult` its factor (1, rare, legendary)
//   wear, max     uses left, of how many (Infinity for a legend); a torch
//                 burns until `expires` (a world time), and `wear` is the
//                 steps left
//   uses, kills   how often it has been used, and killed with
//   maker, tribe, made    who made it (an id, 0 for the first spears), the
//                 tribe it was made in, when
//   bearer        who holds it (an id), or 0: then it lies at x, y since
//                 `dropped`, in a camp's goods (`camp`, the tribe's id) or out
//                 in the wild (world.wild)
//   gens, line    generations of one line that have borne it, and the first
//                 of them; `last` the bearer before
//   legend        {name, skill, deed, time, history: [{time, text, by}]} or null
//   log           its story so far (made, bearers, great kills): a legend's
//                 history starts from it
//   rev           counts changes to what the page is told once (sim.js)
//
// A person holds one weapon and one tool (the population's `weapon` and
// `tool` columns, item ids, and `gear`, their two kinds as weapon × 8 + tool,
// for the hot loops); the player also keeps a few spares (player.kit). And
// one worn item (package 2): a cloak, in the `cloak` column (not in `gear`,
// no spares), its trait warmth; it wears by the cold it keeps off, and its
// legend deed is 'winters' (cold.js).
//
// What people do with items lives in humans.js, in guarded branches; the
// work itself is in tasks.js: tasks (TASK: butchering a kill, an errand for
// wood or flint, crafting at camp) are stepped by stepTask, which leaves the
// result in `job`; tribes decide what they need every few steps
// (tallyTribes). The player's own acts with items are acts/gear.js.
import { BIOME } from './terrain.js';
import { ripeNear } from './plants.js';
import { wrapDelta, wrapPos, indexOf } from './util.js';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const FAR = 0x3fffffff; // terrain.js: a cell no land path reaches
const LOG = 8;          // entries an item's story keeps (the first, and the latest)

export const ITEM_KINDS = ['', 'spear', 'bow', 'club', 'knife', 'basket', 'torch', 'cloak'];
export const KIND = { SPEAR: 1, BOW: 2, CLUB: 3, KNIFE: 4, BASKET: 5, TORCH: 6, CLOAK: 7 };
export const WEAPONS = [KIND.SPEAR, KIND.BOW, KIND.CLUB];
export const TOOLS = [KIND.KNIFE, KIND.BASKET, KIND.TORCH];
export const isWeapon = (kind) => kind >= KIND.SPEAR && kind <= KIND.CLUB;
// A worn item (package 2: the cloak), in a slot of its own: the
// population's `cloak` column (an item id), not in `gear`.
export const isWorn = (kind) => kind === KIND.CLOAK;
export const TASK = { NONE: 0, BUTCHER: 1, WOOD: 2, FLINT: 3, CRAFT: 4 };

// What a kind (a KIND code) costs to make: {wood, flint, hide}, from
// params.items.costs (by name). `p` is the parameters (world.p).
export const costOf = (p, kind) => p.items.costs[ITEM_KINDS[kind]];

// Has the tribe the materials for `kind`? (`p`: the parameters.)
export const affords = (p, tribe, kind) => {
    const c = costOf(p, kind);
    return tribe.wood >= c.wood && tribe.flint >= c.flint && tribe.hide >= c.hide;
};

// Spend them (sign −1: give them back).
export function spend(p, tribe, kind, sign = 1) {
    const c = costOf(p, kind);
    tribe.wood -= sign * c.wood;
    tribe.flint -= sign * c.flint;
    tribe.hide -= sign * c.hide;
}

// The traits a rare item can have boosted, by kind.
const WEAPON_TRAITS = ['range', 'accuracy', 'reload', 'durability'];
const TOOL_TRAITS = ['effect', 'durability'];
const WORN_TRAITS = ['warmth']; // (a cloak: rare ones are warmer; warmth.js cloakWarmth)
export const traitsOf = (kind) => (isWeapon(kind) ? WEAPON_TRAITS : isWorn(kind) ? WORN_TRAITS : TOOL_TRAITS);

// The player's weapon skills (§8.6): a legend's is its kind's, stronger, under
// a name of its own (`word` of the legend's name).
export const SKILLS = [
    null,
    { name: 'Piercing throw', cost: 30, word: 'Flight' },
    { name: 'Volley', cost: 30, word: 'Rain' },
    { name: 'Ground slam', cost: 40, word: 'Quake' },
    null, null, null, null,
];

// ---- Setting up ------------------------------------------------------------------------

// The world's items, before anything is made (World's constructor).
export function initItems(world) {
    world.itemsOn = world.p.items.enabled === true;
    world.items = new Map();
    world.nextItemId = 1;
    world.wild = [];          // ids of items lying out in the wild...
    world.wildX = [];         // ...and where
    world.wildY = [];
    world.legendNames = new Set();
    // What items did, for the checks (headless/check.mjs).
    world.itemStats = world.itemsOn ? {
        crafted: [0, 0, 0, 0, 0, 0, 0, 0], rare: 0, broke: [0, 0, 0, 0, 0, 0, 0, 0], vanished: 0,
        legends: { famous: 0, kills: 0, generations: 0, defender: 0, outlived: 0, winters: 0 },
        picked: 0, inherited: 0, raided: 0, butchered: 0, butcherDeaths: {}, errands: { wood: 0, flint: 0 },
        eatenAt: [0, 0, 0, 0, 0], // people eaten, by the task they were at (TASK)...
        eatenArm: [0, 0, 0, 0],   // ...and the weapon they held (KIND; 0: none)
    } : null;
}

// A new tribe's share of items: its goods (items lying in camp), its spots,
// and what it needs (foundTribe, with items on).
export function foundItems(world, tribe) {
    tribe.goods = [];
    tribe.want = 0;          // the kind it would make next (0: nothing)...
    tribe.wanted = 0;        // ...how many of them
    tribe.needWood = false;  // and whether it lacks the wood or flint for it
    tribe.needFlint = false;
    tribe.crafting = 0;      // its people at each task
    tribe.chopping = 0;
    tribe.quarrying = 0;
    findSpots(world, tribe);
}

// The nearest good spots for wood and flint, by land from the camp (and again
// when the camp moves).
export function findSpots(world, tribe) {
    tribe.woodSpot = spotFor(world, tribe, TASK.WOOD);
    tribe.flintSpot = spotFor(world, tribe, TASK.FLINT);
}

// How rich the ground at (x, y) is in a material (TASK.WOOD or TASK.FLINT):
// 1 where it is plentiful, items.poor where there is a little, 0 where there
// is none.
export function richness(world, x, y, mat) {
    const T = world.terrain;
    const poor = world.p.items.poor;
    if (T === null) return poor; // a flat world: a little of each, anywhere
    if (T.biomeGrid !== null) {
        const b = T.biomeGrid[world.grass.index(x, y)];
        return biomeRichness(b, mat, poor);
    }
    // Terrain without biomes: no forests; flint up the mountains.
    if (mat === TASK.WOOD) return T.fertility(x, y) > 0 ? poor : 0;
    if (T.blocked(x, y)) return 0;
    const r = T.rockiness(x, y);
    return r >= 0.6 ? 1 : r >= 0.3 ? poor : 0;
}

function biomeRichness(b, mat, poor) {
    if (mat === TASK.WOOD) {
        if (b === BIOME.FOREST) return 1;
        return b === BIOME.WETLAND || b === BIOME.MEADOW || b === BIOME.STEPPE || b === BIOME.TUNDRA ? poor : 0;
    }
    return b === BIOME.ROCK ? 1 : b === BIOME.TUNDRA ? poor : 0;
}

// Where a tribe goes for a material: the ground outside camp where a load
// comes soonest, there and back by land (at a walk) and the gathering
// (quicker on rich ground); with a way there (its own path field). Null if
// there is none within items.spotReach. On a flat world: poor ground
// anywhere, so a spot a little outside camp, on a bearing of the tribe's own.
function spotFor(world, tribe, mat) {
    const T = world.terrain;
    const H = world.p.human;
    const I = world.p.items;
    if (T === null) return flatSpot(world, tribe, mat);
    const { grass } = world;
    const field = tribe.paths;
    const unit = T.wayW / 2; // a path field counts 2 a cell straight on
    const poor = I.poor;
    const minD = H.campRadius * 2;
    const pace = H.speed * H.cruise;
    const work = I.load / (mat === TASK.WOOD ? I.wood : I.flint); // steps to gather a load on rich ground
    let best = -1;
    let bestT = Infinity;
    let bestYld = 0;
    for (let r = 0; r < grass.rows; r++) {
        for (let c = 0; c < grass.cols; c++) {
            const k = c + r * grass.cols;
            const x = (c + 0.5) * grass.cellW;
            const y = (r + 0.5) * grass.cellH;
            const yld = T.biomeGrid !== null ? biomeRichness(T.biomeGrid[k], mat, poor) : richness(world, x, y, mat);
            if (yld === 0) continue;
            const f = field[T.wayIndex(x, y)];
            if (f >= FAR) continue;
            const d = f * unit;
            if (d < minD || d > I.spotReach) continue;
            const t = (2 * d) / pace + work / yld;
            if (t < bestT && !T.blocked(x, y)) {
                bestT = t;
                best = k;
                bestYld = yld;
            }
        }
    }
    if (best < 0) return null;
    const x = ((best % grass.cols) + 0.5) * grass.cellW;
    const y = (Math.floor(best / grass.cols) + 0.5) * grass.cellH;
    return { x, y, rich: bestYld === 1, paths: T.pathField(x, y) };
}

// A tribe's spot for a material on a flat world: a little outside its camp,
// on a bearing of its own (flint's opposite wood's). A pure function of the
// tribe's id and camp, so the page can find it too (handWork).
export function flatSpot(world, tribe, mat) {
    const { camp } = tribe;
    const a = tribe.id * GOLDEN + (mat === TASK.FLINT ? Math.PI : 0);
    const d = world.p.human.campRadius * 2.5;
    return { x: wrapPos(camp.x + Math.cos(a) * d, world.width), y: wrapPos(camp.y + Math.sin(a) * d, world.height), rich: false, paths: null };
}

// What a pair of hands gets from the ground at (x, y) (the player's E): wood
// in forest (where it is plentiful), flint on bare rock and, a little, on
// tundra (without biomes: on rocky ground); TASK.NONE elsewhere, where E
// gathers food. A flat world has no ground to tell by (wood and flint are a
// little anywhere), so, as for its errands, at `tribe`'s own spots: within
// materials.patch of one. Items off: always NONE. But first, by a ripe berry
// bush or fruit tree (within items.pickReach, items on or off): 'fruit',
// and E picks it (package 2: plants.js). The simulation decides with
// this (acts/hands.js), and the page shows what E will do with it, on the
// Mirror's copy of the land (play/context.js): both have terrain, grass, p,
// width, height, and tribes with an id and a camp.
export function handWork(world, x, y, tribe) {
    // (A ripe berry bush or fruit tree within items.pickReach comes first,
    // items or none: plants.js. The page's Mirror keeps the plants too.)
    if (world.plants && ripeNear(world, x, y, world.p.items.pickReach) >= 0) return 'fruit';
    if (world.p.items.enabled !== true) return TASK.NONE;
    if (world.terrain !== null) {
        if (richness(world, x, y, TASK.WOOD) === 1) return TASK.WOOD;
        return richness(world, x, y, TASK.FLINT) > 0 ? TASK.FLINT : TASK.NONE;
    }
    if (!tribe) return TASK.NONE;
    const R = world.p.materials.patch;
    for (const mat of [TASK.WOOD, TASK.FLINT]) {
        const s = flatSpot(world, tribe, mat);
        const dx = wrapDelta(s.x - x, world.width);
        const dy = wrapDelta(s.y - y, world.height);
        if (dx * dx + dy * dy <= R * R) return mat;
    }
    return TASK.NONE;
}

// What a step of work at (x, y) gathers of a material (TASK.WOOD or FLINT):
// items.wood or items.flint where the ground is rich, less where it is poor.
export const yieldAt = (world, x, y, mat) => (mat === TASK.WOOD ? world.p.items.wood : world.p.items.flint) * richness(world, x, y, mat);

// How much use a new item of `kind` has in it: uses (a rare one more; a
// durable one × its mult), a torch's steps of burning, a cloak's steps of
// full chill (items.cloakDays days; a rare one × rareUses / uses); a
// legend's never ends. (`p`: the parameters.)
export function wearMax(p, kind, rarity, trait) {
    const I = p.items;
    if (rarity === 2) return Infinity;
    let max = kind === KIND.TORCH ? I.torch
        : kind === KIND.CLOAK ? I.cloakDays * p.calendar.day * (rarity === 1 ? I.rareUses / I.uses : 1)
        : rarity === 1 ? I.rareUses : I.uses;
    if (trait === 'durability') max *= I.rare;
    return max;
}

// A new item of `kind`, made by `maker` (an id, 0: nobody in particular) in
// `tribe` (its id). Rare items come with a trait already rolled. (A cloak
// also counts the hard winters it has come through on one bearer's back,
// `winters`, and who wore it as the latest began, `wintered`: cold.js.)
export function newItem(world, kind, rarity, trait, maker, tribe) {
    const I = world.p.items;
    const mult = rarity === 0 ? 1 : rarity === 1 ? I.rare : I.legendary;
    const max = wearMax(world.p, kind, rarity, trait);
    const { time } = world;
    const t = world.tribeById.get(tribe);
    const item = {
        id: world.nextItemId++, kind, rarity, trait, mult, wear: max, max, uses: 0, kills: 0,
        maker, tribe, made: time, bearer: 0, x: 0, y: 0, dropped: time, gens: 0, line: 0, legend: null,
        camp: 0, last: 0, raiders: 0, expires: kind === KIND.TORCH && rarity < 2 ? time + max : 0, rev: 0,
        log: [{ time, text: t ? `Made among the ${t.name}` : 'Made', by: maker }],
    };
    if (kind === KIND.CLOAK) {
        item.winters = 0;
        item.wintered = 0;
    }
    world.items.set(item.id, item);
    return item;
}

// ---- Holding, laying down, losing ------------------------------------------------------

// How much use is left in an item, 0..1 (a legend: 1).
export function fraction(world, item) {
    if (item.rarity === 2) return 1;
    if (item.kind === KIND.TORCH) return item.expires > world.time ? (item.expires - world.time) / item.max : 0;
    return item.wear / item.max;
}

// Is `a` better than `b` (null: nothing)? Rarity first, then the use left in
// it. `npc`: as someone who lets the tribe's needs decide its kind: never a
// club for a spear or a bow (a club cannot hunt), and another kind only in
// place of a worn one.
export function better(world, a, b, npc) {
    if (!b) return true;
    if (a.rarity !== b.rarity) return a.rarity > b.rarity;
    const fa = fraction(world, a);
    const fb = fraction(world, b);
    if (npc && a.kind !== b.kind) {
        if (a.kind === KIND.CLUB) return false;
        return fb < world.p.items.worn && fa > fb;
    }
    return fa > fb + 0.05;
}

// Person i's held item in the slot `item` would go to (or null).
export function heldLike(world, i, kind) {
    const pop = world.humans;
    const id = isWeapon(kind) ? pop.weapon[i] : isWorn(kind) ? pop.cloak[i] : pop.tool[i];
    return id ? world.items.get(id) ?? null : null;
}

// Put `item` into person i's hand. The hand must be empty (put the old one
// down first). From the ground, it is taken off the ground. `inherited`: the
// dying bearer's child takes it (bequeath), carrying its line on.
export function hold(world, i, item, inherited = false) {
    const pop = world.humans;
    if (item.bearer === 0) unlay(world, item);
    if (isWeapon(item.kind)) {
        pop.weapon[i] = item.id;
        pop.gear[i] = item.kind * 8 + (pop.gear[i] & 7);
    } else if (isWorn(item.kind)) {
        pop.cloak[i] = item.id; // (worn: not in `gear`)
    } else {
        pop.tool[i] = item.id;
        pop.gear[i] = (pop.gear[i] >> 3) * 8 + item.kind;
    }
    bear(world, item, i, inherited);
}

// Person i is the item's bearer now. Handed down to a child at its parent's
// death, it carries the line on; anyone else taking it up starts a new one.
function bear(world, item, i, inherited) {
    const pop = world.humans;
    const id = pop.id[i];
    item.bearer = id;
    item.camp = 0;
    if (item.last === id) return;
    const gens = item.gens;
    if (inherited && pop.parent[i] === item.last) item.gens++;
    else {
        item.gens = 1;
        item.line = id;
    }
    if (item.gens !== gens) item.rev++; // (the page is told: its description says it)
    item.last = id;
    note(world, item, item.gens > 1 ? `Handed down to a child, the ${ordinal(item.gens)} of its line to bear it` : 'Taken up', id);
    if (item.gens >= world.p.items.generations) forge(world, item, 'generations', `Borne by ${item.gens} generations of one line`, id);
}

// Take `item` out of person i's hand (if it is there).
export function unhold(world, i, item) {
    const pop = world.humans;
    if (pop.weapon[i] === item.id) {
        pop.weapon[i] = 0;
        pop.gear[i] = pop.gear[i] & 7;
    } else if (pop.tool[i] === item.id) {
        pop.tool[i] = 0;
        pop.gear[i] = (pop.gear[i] >> 3) * 8;
    } else if (pop.cloak[i] === item.id) {
        pop.cloak[i] = 0;
    }
}

// Lay `item` down at (x, y): among `tribe`'s goods (in its camp), or out in
// the wild (tribe null).
export function lay(world, item, x, y, tribe) {
    item.bearer = 0;
    item.x = wrapPos(x, world.width);
    item.y = wrapPos(y, world.height);
    item.dropped = world.time;
    if (tribe) {
        item.camp = tribe.id;
        tribe.goods.push(item.id);
    } else toWild(world, item);
    world.events.push({ type: 'dropped', item: item.id, x: item.x, y: item.y, time: world.time });
}

// Into the wild: its id and where it lies (world.wildX, wildY, kept beside
// world.wild, so a look around needs no lookups).
function toWild(world, item) {
    item.camp = 0;
    world.wild.push(item.id);
    world.wildX.push(item.x);
    world.wildY.push(item.y);
}

// Off the ground: out of the camp's goods or the wild.
function unlay(world, item) {
    if (item.camp !== 0) {
        const goods = world.tribeById.get(item.camp)?.goods;
        const k = goods ? goods.indexOf(item.id) : -1;
        if (k >= 0) goods.splice(k, 1);
        return;
    }
    const k = world.wild.indexOf(item.id);
    if (k < 0) return;
    world.wild.splice(k, 1);
    world.wildX.splice(k, 1);
    world.wildY.splice(k, 1);
}

// Where in a camp its goods lie: around the centre, each on a bearing of its own.
export function campSpot(tribe, item) {
    const a = item.id * GOLDEN;
    const r = 5 + (item.id % 5);
    return { x: tribe.camp.x + Math.cos(a) * r, y: tribe.camp.y + Math.sin(a) * r };
}

// Is (x, y) inside the tribe's camp?
function inCamp(world, tribe, x, y) {
    const dx = wrapDelta(tribe.camp.x - x, world.width);
    const dy = wrapDelta(tribe.camp.y - y, world.height);
    const R = world.p.human.campRadius;
    return dx * dx + dy * dy < R * R;
}

// Person i puts `item` (held, or the player's spare) down where it stands:
// in its camp, among the goods; elsewhere, in the wild.
export function putDown(world, i, item) {
    const pop = world.humans;
    unhold(world, i, item);
    const tribe = world.tribeById.get(pop.tribe[i]);
    const home = tribe && inCamp(world, tribe, pop.x[i], pop.y[i]);
    lay(world, item, pop.x[i], pop.y[i], home ? tribe : null);
}

// Gone for good: off the ground and out of the world.
function removeItem(world, item) {
    if (item.bearer === 0) unlay(world, item);
    world.items.delete(item.id);
}

// An item worn out (or burnt down): it breaks in its bearer's hand. `i`:
// the bearer's index if known.
export function breakItem(world, item, i = -1) {
    const pop = world.humans;
    if (item.bearer !== 0) {
        if (i < 0 || pop.id[i] !== item.bearer) i = indexOf(pop, item.bearer);
        const inHand = i >= 0 && (pop.weapon[i] === item.id || pop.tool[i] === item.id);
        if (inHand || (i >= 0 && pop.cloak[i] === item.id)) unhold(world, i, item);
        const pl = world.player;
        if (pl !== null && pl.id === item.bearer) unkit(pl, item.id);
        world.events.push({
            type: 'broke', item: item.id, kind: item.kind, bearer: item.bearer,
            x: i >= 0 ? pop.x[i] : item.x, y: i >= 0 ? pop.y[i] : item.y, time: world.time,
        });
        // The player takes up a spare at once (if it broke in hand).
        if (pl !== null && pl.id === item.bearer && inHand && pl.kit && !isWorn(item.kind)) {
            const spares = isWeapon(item.kind) ? pl.kit.weapons : pl.kit.tools;
            if (spares.length) hold(world, i, world.items.get(spares.shift()));
        }
    } else {
        world.events.push({ type: 'broke', item: item.id, kind: item.kind, bearer: 0, x: item.x, y: item.y, time: world.time });
    }
    world.itemStats.broke[item.kind]++;
    removeItem(world, item);
}

// A spare out of the player's kit.
function unkit(pl, id) {
    if (!pl.kit) return;
    for (const list of [pl.kit.weapons, pl.kit.tools]) {
        const k = list.indexOf(id);
        if (k >= 0) list.splice(k, 1);
    }
}

// One use of person i's `item` (a throw, a swing, a fight, a kill cut up, a
// load home): it wears, and may break. Legends never wear; torches burn
// with time instead.
export function wearItem(world, i, item) {
    if (!item) return;
    item.uses++;
    if (item.rarity === 2 || item.kind === KIND.TORCH) return;
    item.wear--;
    if (item.wear <= 0) breakItem(world, item, i);
}

// Every few steps (tasks.js stepItems): burnt-out torches go out, and items
// left lying longer than items.vanish are gone.
export function sweep(world) {
    const I = world.p.items;
    const { time } = world;
    for (const item of world.items.values()) {
        if (item.rarity === 2) continue;
        if (item.kind === KIND.TORCH) {
            item.wear = item.expires > time ? item.expires - time : 0;
            if (item.wear <= 0) {
                breakItem(world, item);
                continue;
            }
        }
        if (item.bearer === 0 && time - item.dropped >= I.vanish) {
            world.events.push({ type: 'vanished', item: item.id, time });
            world.itemStats.vanished++;
            removeItem(world, item);
        }
    }
}

// ---- What an item does ----------------------------------------------------------------

// The weapon in person i's hand, as the AI uses it: its item, kind, reach
// (and its square), chance (× the spear's) and reload. armOf fills it and
// returns the kind (0: unarmed).
export const arm = { item: null, kind: 0, range: 0, range2: 0, hit: 1, reload: 0 };
export function armOf(world, i) {
    const id = world.humans.weapon[i];
    const item = id ? world.items.get(id) : undefined;
    if (item === undefined) {
        arm.item = null;
        arm.kind = 0;
        arm.range = 0;
        arm.range2 = 0;
        return 0;
    }
    weaponStats(world, item, arm);
    return item.kind;
}

// What a weapon does, into `out` (as `arm`).
export function weaponStats(world, item, out) {
    const P = world.p.human;
    const I = world.p.items;
    const k = item.kind;
    let range = k === KIND.CLUB ? I.clubReach : k === KIND.BOW ? P.throwRange * I.arrowRange : P.throwRange;
    let hit = k === KIND.BOW ? I.bowHit : 1;
    let reload = k === KIND.BOW ? P.reload * I.bowReload : P.reload;
    if (item.trait === 'range') range *= item.mult;
    else if (item.trait === 'accuracy') hit *= item.mult;
    else if (item.trait === 'reload') reload /= item.mult;
    out.item = item;
    out.kind = k;
    out.range = range;
    out.range2 = range * range;
    out.hit = hit;
    out.reload = Math.max(1, Math.round(reload));
    return out;
}

// The chance a throw kills (humans.js hitChance), × the weapon's.
export const hitWith = (P, tribe, mates, mult) => Math.min(0.95, P.hit * mult * (1 + P.teamwork * mates * tribe.sociality));

// A tool's effect × its trait.
const effect = (item) => (item && item.trait === 'effect' ? item.mult : 1);

// Food a kill gives person i of pop: human.efficiency, more with a knife.
export function efficiencyOf(world, pop, i) {
    const P = world.p.human;
    if ((pop.gear[i] & 7) !== KIND.KNIFE) return P.efficiency;
    return P.efficiency + (world.p.items.knife - P.efficiency) * effect(world.items.get(pop.tool[i]));
}

// × what person i can carry: more with a basket.
export function carryOf(world, pop, i) {
    if ((pop.gear[i] & 7) !== KIND.BASKET) return 1;
    return 1 + (world.p.items.basket - 1) * effect(world.items.get(pop.tool[i]));
}

// The damage person i does to a stranger, × the fight's usual: more with a club.
export function blowOf(world, pop, i) {
    return (pop.gear[i] >> 3) === KIND.CLUB ? world.p.items.clubDamage : 1;
}

// Does person j bear a burning torch? A predator will not take it.
export function shielded(world, j) {
    const pop = world.humans;
    if ((pop.gear[j] & 7) !== KIND.TORCH) return false;
    const item = world.items.get(pop.tool[j]);
    return item !== undefined && (item.rarity === 2 || item.expires > world.time);
}

// How many defenders stand by person j against a predator (humans.js
// driveOff): tribe-mates within defendRadius, a club counting double and a
// bow not at all.
export function guards(world, j) {
    const P = world.p.human;
    const I = world.p.items;
    const pop = world.humans;
    const { x, y, energy, gear } = pop;
    const tribe = pop.tribe[j];
    const r2 = P.defendRadius * P.defendRadius;
    let w = 0;
    for (let k = 0; k < pop.n; k++) {
        if (k === j || energy[k] <= 0 || pop.tribe[k] !== tribe) continue;
        const dx = wrapDelta(x[k] - x[j], world.width);
        const dy = wrapDelta(y[k] - y[j], world.height);
        if (dx * dx + dy * dy >= r2) continue;
        const kind = gear[k] >> 3;
        w += kind === KIND.BOW ? 0 : kind === KIND.CLUB ? I.clubGuard : 1;
    }
    return w;
}

// ---- Kills, butchering ------------------------------------------------------------------

// Person i has killed individual j of `prey` (before world.die): its meat
// (`eff` of what it is worth: World.meatOf) and hide wait in a carcass, of
// its tribe, which i will butcher if it has nothing else to do.
export function killed(world, i, prey, j, eff) {
    const pop = world.humans;
    const meat = world.meatOf(prey, j) * eff;
    const id = prey.id[j];
    world.carcasses.set(id, {
        id, kind: world.kindOf(prey), x: prey.x[j], y: prey.y[j], meat, total: meat, done: 0, cut: 0,
        by: pop.id[i], born: world.time, hide: prey === world.carnivores ? 2 : 1, steps: world.p.items.butcher,
        tribe: pop.tribe[i], // (the tribe that may fetch it: tasks.js)
    });
    if (pop.task[i] === TASK.NONE) {
        pop.task[i] = TASK.BUTCHER;
        pop.work[i] = id;
    }
}

// A kill made with `item`: it counts, and a famous predator's (items.famous
// kills), or its items.kills-th, makes a legend.
export function credit(world, item, prey, j) {
    if (!item) return;
    const I = world.p.items;
    item.kills++;
    if (prey === world.carnivores && prey.kills[j] >= I.famous) {
        const text = `Killed a famous predator, with ${prey.kills[j]} kills to its name`;
        if (item.rarity === 2) note(world, item, text, item.bearer);
        else forge(world, item, 'famous', text, item.bearer);
    }
    if (item.rarity < 2 && item.kills >= I.kills) forge(world, item, 'kills', `Its ${ordinal(item.kills)} kill`, item.bearer);
    else if (item.rarity === 2 && item.kills % 25 === 0) note(world, item, `Its ${ordinal(item.kills)} kill`, item.bearer);
}

// The weapon in person j's hand made a kill (as defenders drive a predator
// off and kill it: the one it went for gets the kill).
export function creditHolder(world, j, prey, k) {
    const id = world.humans.weapon[j];
    if (id) credit(world, world.items.get(id), prey, k);
}

// A raider (person i) dies at `target`'s camp: the nearest armed defender's
// weapon struck it down. At its own camp (made by that tribe), that is a deed.
export function raiderKilled(world, i, target) {
    const P = world.p.human;
    const I = world.p.items;
    const pop = world.humans;
    let best = -1;
    let bestD2 = P.defendRadius * P.defendRadius;
    for (let k = 0; k < pop.n; k++) {
        if (pop.tribe[k] !== target.id || pop.energy[k] <= 0 || !pop.weapon[k]) continue;
        const dx = wrapDelta(pop.x[k] - pop.x[i], world.width);
        const dy = wrapDelta(pop.y[k] - pop.y[i], world.height);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = k;
        }
    }
    if (best < 0) return;
    const item = world.items.get(pop.weapon[best]);
    if (!item) return;
    item.kills++;
    if (item.tribe !== target.id) return;
    item.raiders++;
    const text = `Struck down a raider in the camp of the ${target.name}`;
    if (item.rarity === 2) note(world, item, text, pop.id[best]);
    else if (item.raiders >= I.defender) forge(world, item, 'defender', text, pop.id[best]);
}

// Can person i still butcher the carcass it is at, or going to (it lasts,
// and it is no farther than a forager goes from camp)?
export function butcherable(world, i) {
    const pop = world.humans;
    const c = world.carcasses.get(pop.work[i]);
    if (!c) return false;
    const dx = wrapDelta(c.x - pop.x[i], world.width);
    const dy = wrapDelta(c.y - pop.y[i], world.height);
    const far = world.p.human.homeRange * 1.5;
    return dx * dx + dy * dy < far * far;
}

// ---- Tribes coming and going -------------------------------------------------------------

// A daughter tribe takes half the materials and every other item lying in
// the camp (people keep what they hold).
export function splitItems(world, t, daughter) {
    for (const m of ['wood', 'flint', 'hide']) {
        daughter[m] = t[m] / 2;
        t[m] -= daughter[m];
    }
    const keep = [];
    for (let k = 0; k < t.goods.length; k++) {
        const item = world.items.get(t.goods[k]);
        if (k % 2 === 0) {
            keep.push(item.id);
            continue;
        }
        const at = campSpot(daughter, item);
        item.camp = daughter.id;
        item.x = wrapPos(at.x, world.width);
        item.y = wrapPos(at.y, world.height);
        daughter.goods.push(item.id);
    }
    t.goods = keep;
}

// A camp has moved (orders.js): its goods go with it, and it finds new spots.
export function campMoved(world, tribe) {
    for (const id of tribe.goods) {
        const item = world.items.get(id);
        const at = campSpot(tribe, item);
        item.x = wrapPos(at.x, world.width);
        item.y = wrapPos(at.y, world.height);
    }
    findSpots(world, tribe);
}

// A tribe has died out: what lay in its camp lies on, in the wild; and its
// most storied item still in someone's hands (most kills, at least
// items.outlived; then the oldest) has outlived it, a legend.
export function tribeEnded(world, t) {
    for (const id of t.goods) toWild(world, world.items.get(id));
    t.goods.length = 0;
    let best = null;
    for (const item of world.items.values()) {
        if (item.tribe !== t.id || item.bearer === 0 || item.rarity === 2 || item.kills < world.p.items.outlived) continue;
        if (best === null || item.kills > best.kills || (item.kills === best.kills && item.made < best.made)) best = item;
    }
    if (best !== null) forge(world, best, 'outlived', `Outlived the ${t.name}, who made it`, best.bearer);
}

// A raider (person i) has robbed `target`'s camp: it takes what lies there,
// whatever is better than its own into its hands, the rest home to its own
// camp's goods.
export function raided(world, i, target) {
    if (!target.goods.length) return;
    const pop = world.humans;
    const own = world.tribeById.get(pop.tribe[i]);
    const haul = [];
    for (const id of target.goods.slice()) {
        const item = world.items.get(id);
        unlay(world, item);
        const held = heldLike(world, i, item.kind);
        if (pop.age[i] >= world.p.human.maturity && better(world, item, held, true)) {
            if (held) {
                unhold(world, i, held);
                haul.push(held);
            }
            hold(world, i, item);
            world.events.push({ type: 'picked', item: item.id, by: pop.id[i], time: world.time });
        } else haul.push(item);
        world.itemStats.raided++;
    }
    for (const item of haul) {
        item.bearer = 0;
        const at = campSpot(own, item);
        lay(world, item, at.x, at.y, own);
    }
}

// Person i is dying (World.die): what it holds (and the player's spares) goes
// to its eldest living child in the tribe if it dies at camp and the child
// holds nothing better; otherwise it lies in camp, or where it fell.
export function bequeath(world, i) {
    const pop = world.humans;
    const pl = world.player;
    const id = pop.id[i];
    const list = [];
    if (pop.weapon[i]) list.push(world.items.get(pop.weapon[i]));
    if (pop.tool[i]) list.push(world.items.get(pop.tool[i]));
    if (pop.cloak[i]) list.push(world.items.get(pop.cloak[i]));
    if (pl !== null && pl.id === id && pl.kit) {
        for (const k of [...pl.kit.weapons, ...pl.kit.tools]) list.push(world.items.get(k));
        pl.kit.weapons.length = 0;
        pl.kit.tools.length = 0;
    }
    pop.weapon[i] = 0;
    pop.tool[i] = 0;
    pop.gear[i] = 0;
    pop.cloak[i] = 0;
    if (list.length === 0) return;
    const tribe = world.tribeById.get(pop.tribe[i]);
    const x = pop.x[i];
    const y = pop.y[i];
    const home = tribe !== undefined && inCamp(world, tribe, x, y);
    let heir = -1;
    if (home) {
        for (let k = 0; k < pop.n; k++) {
            if (k === i || pop.parent[k] !== id || pop.energy[k] <= 0 || pop.tribe[k] !== pop.tribe[i]) continue;
            if (heir < 0 || pop.age[k] > pop.age[heir]) heir = k;
        }
    }
    for (const item of list) {
        if (!item) continue;
        if (heir >= 0) {
            const held = heldLike(world, heir, item.kind);
            if (better(world, item, held, false)) {
                if (held) {
                    unhold(world, heir, held);
                    const at = campSpot(tribe, held);
                    lay(world, held, at.x, at.y, tribe);
                }
                hold(world, heir, item, true);
                world.events.push({ type: 'picked', item: item.id, by: pop.id[heir], from: id, time: world.time });
                world.itemStats.inherited++;
                continue;
            }
        }
        lay(world, item, x, y, home ? tribe : null);
    }
}

// ---- Legends -----------------------------------------------------------------------------

const ADJECTIVES = [
    'Grey', 'Red', 'Black', 'White', 'Old', 'Swift', 'Silent', 'Bright', 'Bitter', 'Pale', 'Wild', 'Hollow',
    'Long', 'Dusk', 'Ash', 'Storm', 'Frost', 'Stone', 'Bone', 'Thorn', 'Night', 'Morning', 'Rain', 'River',
];
const BEASTS = [
    'Heron', 'Wolf', 'Bear', 'Elk', 'Hawk', 'Owl', 'Raven', 'Lynx', 'Boar', 'Crane', 'Fox', 'Stag', 'Otter',
    'Badger', 'Eagle', 'Viper', 'Bison', 'Moth',
];
const NOUNS = [
    [],
    ['Fang', 'Reach', 'Thorn', 'Sting', 'Tooth', 'Talon', 'Point'],
    ['Reach', 'Song', 'Wing', 'Whisper', 'Sight', 'Gaze', 'Call'],
    ['Maul', 'Fist', 'Thunder', 'Root', 'Knot', 'Stone', 'Hoof'],
    ['Tooth', 'Edge', 'Claw', 'Fang', 'Shard', 'Sliver'],
    ['Bounty', 'Nest', 'Cradle', 'Plenty', 'Hoard', 'Harvest'],
    ['Ember', 'Flame', 'Dawn', 'Glow', 'Spark', 'Blaze', 'Eye'],
    ['Mantle', 'Pelt', 'Hearth', 'Shroud', 'Fleece', 'Embrace', 'Winter'],
];
const pick = (rng, list) => list[Math.floor(rng.next() * list.length)];
const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => (n < ORDINALS.length ? ORDINALS[n] : `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`);

// A name for a legend of `kind`, from the word tables (like tribe names,
// identity.js): "Grey Fang", "Heron's Reach". Not one already taken, if it
// can help it.
function legendName(world, kind) {
    const { rng } = world;
    let name = '';
    for (let tries = 0; tries < 8; tries++) {
        name = rng.next() < 0.5 ? `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS[kind])}` : `${pick(rng, BEASTS)}'s ${pick(rng, NOUNS[kind])}`;
        if (!world.legendNames.has(name)) break;
    }
    world.legendNames.add(name);
    return name;
}

// Add to an item's story (and a legend's history, which the page is told again).
export function note(world, item, text, by) {
    const entry = { time: world.time, text, by };
    if (item.legend !== null) {
        const h = item.legend.history;
        h.push(entry);
        if (h.length > 24) h.splice(1, 1);
        item.rev++;
        return;
    }
    item.log.push(entry);
    if (item.log.length > LOG) item.log.splice(1, 1); // the first (its making), and the latest
}

// An item becomes a legend by a deed: its trait (a rare one's, unless that
// was durability: a legend never wears) × items.legendary, a name, its
// weapon skill's name, and a history from its story so far.
export function forge(world, item, deed, text, by) {
    if (item.rarity === 2) return;
    const I = world.p.items;
    if (!item.trait || item.trait === 'durability') {
        const traits = traitsOf(item.kind).filter((t) => t !== 'durability');
        item.trait = pick(world.rng, traits);
    }
    item.rarity = 2;
    item.mult = I.legendary;
    item.wear = Infinity;
    item.max = Infinity;
    item.expires = 0;
    const name = legendName(world, item.kind);
    const skill = SKILLS[item.kind];
    const { time } = world;
    item.legend = { name, skill: skill ? `${skill.word} of ${name}` : '', deed, time, history: [...item.log, { time, text, by }] };
    item.log = [];
    item.rev++;
    let tribe = item.tribe;
    if (item.bearer !== 0) {
        const k = indexOf(world.humans, item.bearer);
        if (k >= 0) tribe = world.humans.tribe[k];
    }
    world.events.push({ type: 'legend', item: item.id, name, kind: item.kind, bearer: item.bearer, tribe, deed, time });
    world.itemStats.legends[deed]++;
}

// ---- For the page ------------------------------------------------------------------------

// What the page is told once about an item (and again when it changes: it
// becomes a legend, its legend's history grows, or another generation of one
// line takes it up).
export function describe(item) {
    const L = item.legend;
    return {
        id: item.id, kind: item.kind, rarity: item.rarity, trait: item.trait, mult: item.mult,
        maker: item.maker, tribe: item.tribe, made: item.made, gens: item.gens,
        legend: L === null ? null : { name: L.name, skill: L.skill, deed: L.deed, time: L.time, history: L.history.map((h) => ({ ...h })) },
    };
}


