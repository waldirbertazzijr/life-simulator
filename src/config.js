// Every tunable number in the simulation lives here. Units:
//   distance — world units (the world is ~1600 × 1000 of them)
//   time     — steps (the browser runs 15 steps per second at 1×)
//   energy   — arbitrary; 1 unit of grass is worth `grassEnergy`
//
// planning/THEORY.md explains which knobs stabilise the system and why.
//
// Times and rates of life below are written for pace 1; the simulation reads
// them through paced() (at the end of this file), at `life.pace`.
export const params = {
    // The pace of life: every life takes this many times longer than the
    // numbers below say (paced() lists what it touches). Growing up, ageing,
    // hunger, births, spoiling, crafting and fetching wood all slow down
    // together; walking, running, seeing and throwing do not. Encounters
    // keep their rate in a life only if the world is that much emptier, so
    // the grass feeds that many fewer, too. At 2, the world moves as at 1 but
    // lives half as fast, with about half as many of everyone. Applies to a
    // new world.
    life: {
        pace: 2,
    },

    world: {
        // The world always has this AREA; its aspect ratio follows the screen.
        // Densities — and so the balance — are identical on any display.
        area: 1600 * 1000,
        grassCell: 10, // size of one grass patch
        hashCell: 40,  // spatial-hash bucket size (performance only)
    },

    // Mountains, lakes and valleys (src/terrain.js). Off: a flat world, exactly
    // as before terrain existed.
    terrain: {
        enabled: true,
        spacing: 20,         // distance between height nodes
        wavelength: 520,     // size of the broadest basins and uplands
        octaves: 4,          // finer detail, each octave half the size...
        roughness: 0.5,      // ...and this fraction of the height
        ranges: 0.6,         // how high mountain ranges rise on the uplands
        water: 0.12,         // fraction of the world under water
        seaLevel: 8,         // height of the water surface
        peak: 120,           // height of the highest summit
        relief: 1.8,         // > 1: gentle lowlands, steep summits
        cliff: 0.9,          // slopes steeper than this (rise over run) cannot be climbed
        // Fertility: how much grass the ground can hold (see Grass.regrow).
        fertileBelow: 0.15,  // full up to this fraction of the way to the peak...
        barrenAbove: 0.65,   // ...bare rock above this one
        // Water and rock leave less land to grow food. With this on, grass on the
        // land that is left regrows faster, so the world grows as much food as a
        // flat one (Grass.setFertility). Off, the world is simply smaller.
        compensate: true,
    },

    // Biomes on the terrain (src/terrain.js): a climate from two fields, and the
    // grass each climate grows. Needs terrain. Off: fertility falls with
    // altitude alone, as before biomes.
    biomes: {
        enabled: true,
        // Moisture, 0..1: wet beside water and drying with distance from it,
        // plus broad "weather" that makes whole regions wetter or drier.
        wetReach: 80,        // water's wetness fades over this distance (to 1/e)
        waterShare: 0.55,    // share of moisture that comes from nearby water; the rest is weather
        weatherSize: 900,    // size of the wetter and drier regions
        // Temperature, 0..1: warm in the lowlands, colder with altitude.
        lapse: 1,            // cooling from the shore to the highest summit
        climateSize: 1100,   // size of the warmer and cooler regions...
        climateSpread: 0.3,  // ...and how much cooler the coolest is
        // Classes, from the coldest: snow, rock and tundra by temperature alone;
        // then steppe where it is dry, forest on the cooler (higher) moist
        // ground, and wetland or meadow in the warm lowlands.
        snowBelow: 0.1,      // temperature: snow below this...
        rockBelow: 0.2,      // ...bare rock below this...
        tundraBelow: 0.33,   // ...tundra below this
        forestBelow: 0.66,   // cooler than this but moist enough: forest
        dryBelow: 0.2,       // moisture: steppe below this
        wetAbove: 0.56,      // warm and wetter than this: wetland; otherwise meadow
        // Grass each biome can hold (patch fertility, 0..1). terrain.compensate
        // still keeps the world's total food the same as a flat world's.
        fertility: { water: 0, wetland: 1, meadow: 0.9, forest: 0.6, steppe: 0.4, tundra: 0.3, rock: 0, snow: 0 },
        // Forest as cover: hunters (carnivores and people) see a grazer standing
        // in forest only from this fraction of their usual range.
        cover: true,
        coverSight: 0.5,
    },

    grass: {
        // Each patch regrows toward full (1.0) at this rate: g += regrowth·(1 − g).
        // Supply-driven regrowth (like rain filling a pond) cannot be grazed to
        // extinction, and it does not amplify oscillations the way logistic
        // prey growth does. This is the base of the whole food web. (At pace 2 it
        // regrows half as fast: about 520 grazers and 48 predators; more grass
        // feeds more of both, and is calmer still: THEORY.md §7.)
        regrowth: 0.0012,
        initial: 0.25,       // start near the level herbivores graze it down to
    },

    herbivore: {
        initial: 700,
        // Starting genes: near the optimum evolution settles on with these costs
        // (found by evolving from 1.0 for 400k steps; planning/THEORY.md §9). Set
        // them to 1 to watch evolution from scratch, with a rougher opening.
        genes: { speed: 1.3, sense: 0.55 },
        speed: 0.6,          // top speed (fleeing), units/step at speed gene 1.0
        cruise: 0.5,         // fraction of top speed used while looking for grass
        sense: 20,           // how far it sees: approaching predators, greener patches
        bite: 0.05,          // grass eaten per step
        grassEnergy: 10,     // energy per unit of grass
        maxEnergy: 100,      // stomach size; surplus is never stored
        birthEnergy: 80,     // reproduce once energy reaches this...
        maturity: 300,       // ...and the animal is at least this old
        childShare: 0.5,     // fraction of the parent's energy given to the child
        lifespan: 3000,
        baseCost: 0.05,      // basal metabolism per step (scaled by trait upkeep)
        moveCost: 0.1,       // × speed² — moving fast is expensive
    },

    carnivore: {
        initial: 60,
        genes: { speed: 1.55, sense: 0.8 }, // starting genes, as above
        speed: 0.75,
        cruise: 0.6,
        sense: 50,           // how far it spots prey — predators see first, then stalk
        hunger: 0.9,         // hunts only below this fraction of maxEnergy
        catchRadius: 3,
        efficiency: 0.7,     // fraction of the prey's energy assimilated
        handling: 120,       // steps spent eating/digesting after a kill
        stamina: 200,        // average chase length before giving up...
        rest: 60,            // ...and has to catch its breath
        turn: 0.6,           // random heading change while searching (radians)
        crowdRadius: 40,     // a rival closer than this interferes...
        crowdCost: 0.2,      // ...costing this much energy per step
        maxEnergy: 120,      // small reserves: predators feel a prey shortage quickly
        birthEnergy: 96,
        maturity: 600,
        childShare: 0.5,
        lifespan: 6000,
        baseCost: 0.06,
        moveCost: 0.1,
    },

    // People: hunter-gatherers living in tribes (src/humans.js).
    human: {
        enabled: true,
        tribes: 4,           // tribes at the start...
        perTribe: 10,        // ...with this many people each
        initialStore: 300,   // food in each starting camp
        genes: { speed: 1, sense: 1 },
        speed: 0.7,          // top speed
        cruise: 0.6,         // walking pace, as a fraction of top speed
        sense: 40,           // how far they see prey and predators
        // Hunting with spears
        throwRange: 14,      // a grazer usually notices people at ~11, so a careful hunter throws first
        hit: 0.25,           // chance a throw kills...
        teamwork: 0.5,       // ...+50% per tribe-mate nearby, scaled by the tribe's sociality
        reload: 30,          // steps between throws
        efficiency: 0.7,     // share of a kill's energy that becomes food
        // Gathering plants (from the same grass field the grazers eat)
        gatherRate: 0.02,    // grass collected per step
        gatherMin: 0.1,      // thinner patches are not worth it
        plantEnergy: 6,      // energy per unit gathered (grazers get 10: people digest it worse)
        tripLoad: 40,        // carry food home once holding this much
        carryMax: 160,
        // Body
        maxEnergy: 150,
        hunger: 0.6,         // eat from the camp store below this fraction
        starving: 0.25,      // eat what they carry below this fraction
        baseCost: 0.03,
        moveCost: 0.1,
        maturity: 900,       // children stay at camp until this age
        lifespan: 9000,
        // Camp and neighbours
        campRadius: 20,
        homeRange: 260,      // how far from camp they forage
        groupRadius: 40,     // tribe-mates this close count as "together"
        meetRadius: 10,      // strangers this close meet: fight or walk away
        fightDamage: 30,
        partySpacing: 15,    // social foragers close up when a tribe-mate is farther than this
        // Raids (aggressive tribes, when their own store runs low)
        raidRate: 0.001,     // × aggression: per-step chance a hungry forager sets off on a raid
        raidRange: 450,      // only camps this close, holding a full load, are worth raiding
        raidLoad: 150,       // most a raider can carry off
        guard: 0.3,          // each defender at the camp hurts the raider with this chance (×0.5–1 by sociality)
        defendRadius: 30,    // tribe-mates this close help fend off a predator:
        defend: 0.6,         // chance it is driven off = 1 − e^(−defend × defenders)
        killPredator: 0.3,   // × aggression: chance the defenders kill it
        // The tribe
        storeTarget: 30,     // food per member the tribe wants in store before resting
        spoil: 0.0005,       // the store loses this fraction per step
        birthCost: 120,      // a birth takes this much from the store (90 made tribes too many)...
        childEnergy: 60,     // ...of which the newborn gets this
        reserve: 5,          // food per member kept back when deciding on a birth
        birthInterval: 200,  // steps between births in one tribe
        splitSize: 30,       // a tribe this large splits in two
        splitDistance: 300,  // how far the daughter tribe settles
        cultureDrift: 0.08,  // how much a daughter tribe's culture differs from its parent's
    },

    // The person the page controls (src/player.js). These rules apply to the
    // player alone; with nobody controlled, none of them is ever read.
    play: {
        bite: 60,            // a predator that catches the player bites this much energy off, and backs off
        rollSteps: 5,        // a dodge roll lasts this many steps, and a bite misses during it...
        rollSpeed: 1.2,      // ...covering this much ground a step (about 6 units in all)
        crouchSense: 0.5,    // grazers notice a crouching player only within this fraction of their range
        crouchSpeed: 0.35,   // crouching pace, as a fraction of top speed (the page moves the body)
        // The page moves the body; a move is accepted if it is no farther than
        // top speed × the steps since the last accepted one (at most maxCatchUp
        // of them) + slack, and does not end on water or a cliff.
        slack: 1.5,
        maxCatchUp: 4,
        // Spirit (for weapon skills and calls, in later packages)
        spiritMax: 100,
        spiritRegen: 0.05,   // regained each step...
        spiritRest: 1,       // ...plus this much while resting at camp
        // The spear in the player's hands (spears.js). A throw flies straight
        // until it strikes something or has flown its range.
        throwSpeed: 3,       // a light throw: units a step...
        throwRange: 20,      // ...and how far
        heavySpeed: 4.5,     // a fully charged one (power 1; in between by power)
        heavyRange: 34,
        hitRadius: 2,        // a spear strikes what it passes this close to...
        hitPredator: 2.5,    // ...a predator, bigger, this close
        spearDamage: 60,     // a person struck loses this much, and dies of it at 0
        jabRange: 5,         // a creature this close in front is jabbed instead of thrown at...
        jabArc: Math.PI / 4, // ...this far to either side of the aim
        jabHit: 0.5,         // chance a jab kills; from behind an unwary animal, always (an ambush)
        // The player's kills wait to be butchered (acts/hands.js).
        spoil: 900,          // steps an untouched carcass lasts
        butcherSteps: 60,    // steps to cut one up...
        butcherReach: 4,     // ...standing this close to it
        butcherEvery: 10,    // a stroke (blood, for the page) every this many steps
        rackReach: 8,        // the store is within this of the camp's centre
        takeMax: 40,         // food taken from the store for the road, at most
        eatMax: 40,          // energy eaten from the pouch at one go, at most
    },

    // Leading a tribe (src/orders.js): the player's rallies and a tribe's
    // standing orders. Only the player gives them (and the tests and the
    // orders check, through issueOrder); with nobody controlled, none of this
    // is ever read.
    orders: {
        rallyCost: 40,       // Spirit a rally costs
        rallyRadius: 60,     // adult tribe-mates this close follow you...
        rallySteps: 450,     // ...for this long (30 s at 1×)
        keep: 15,            // followers keep within about this far of you...
        close: 8,            // ...closing in to about this far
        lasts: 3000,         // a standing order holds this long, unless replaced
        // Gather food and Defend camp keep people from food: a tribe heeds them
        // only while its store could pay for a birth (human.birthCost +
        // human.reserve a member, × this), and a hungry camp feeds itself
        // first. How its camp meets raiders and predators follows the order
        // regardless.
        surplus: 1,
        huntRange: 160,      // Hunt here: foragers keep within this of the marker (100 starved the hunt)...
        starving: 7,         // ...unless the store holds less than this a member: then they hunt near home
        moveCooldown: 6000,  // steps before a camp can move again (3000 let random moves end the people of some worlds, with items)
    },

    // Items (src/items.js): materials gathered on the land, things made from
    // them, worn out with use, handed down, and the few that become legends.
    // Off: the world of before items, to the bit (everyone hunts as if with a
    // plain spear that never breaks, and eats a kill on the spot).
    items: {
        enabled: true,
        // Materials. A worker gathers this much a step where the ground is
        // rich (wood: forest; flint: bare rock), and `poor` × as much where it
        // is poor (wood: anywhere grass grows; flint: tundra, or anywhere on a
        // flat world), and carries up to `load` home.
        wood: 0.04,
        flint: 0.03,
        poor: 0.25,
        load: 8,
        spotReach: 500,      // a tribe goes no farther than this (by land) for them: where a load comes soonest
        initialWood: 6,      // wood in each starting camp (spears for the children who come of age)
        errand: 1500,        // steps a worker keeps at it before going home with what it has
        // Kinds (the plain spear is today's hunting: human.throwRange, hit, reload).
        arrowRange: 1.6,     // a bow: × the spear's reach (a hunter's throw; the player's arrows: × play.throwRange, heavyRange)...
        arrowSpeed: 1.6,     // ...its arrows fly × as fast as a thrown spear (play.throwSpeed, heavySpeed)...
        bowReload: 0.6,      // ...× its reload...
        bowHit: 0.9,         // ...× its chance to kill
        clubReach: 4,        // a club strikes only this close...
        clubDamage: 1.5,     // ...hurts strangers this much more...
        clubGuard: 2,        // ...and counts as this many defenders against a predator (a bow, none)
        knife: 0.85,         // a knife: food per kill (human.efficiency without), and butchering at double speed
        butcher: 20,         // steps a hunter takes to cut up a kill (the player: play.butcherSteps)
        basket: 1.5,         // a basket: × what can be carried (tripLoad, carryMax)
        torch: 3000,         // a torch burns this many steps; a predator does not take its bearer
        torchReach: 8,       // the player's brandish drives off predators this close
        // Wear, rarity, crafting.
        uses: 40,            // uses before a normal item breaks...
        rareUses: 60,        // ...a rare one
        rare: 1.25,          // a rare item's trait...
        legendary: 1.5,      // ...a legend's
        craftSteps: 150,
        // What each kind costs to make (from the store).
        costs: {
            spear: { wood: 2, flint: 0, hide: 0 },
            bow: { wood: 3, flint: 0, hide: 1 },
            club: { wood: 2, flint: 0, hide: 0 },
            knife: { wood: 0, flint: 1, hide: 0 },
            basket: { wood: 2, flint: 0, hide: 0 },
            torch: { wood: 1, flint: 0, hide: 0 },
        },
        rareChance: 0.2,     // with a flint more: the chance of rare...
        rareGain: 0.04,      // ...more with each item the crafter has made...
        rareMax: 0.6,        // ...up to this
        spare: 4,            // a tribe puts in a flint more only while it keeps this many back (for knives)
        tools: 1,            // a tribe makes tools (but knives) only with this many births' worth in store
        worn: 0.2,           // below this much wear left, a tribe makes a replacement
        // Lying about.
        pickReach: 6,        // an item this close is picked up, if better
        vanish: 3000,        // steps a fallen item lasts (legends: forever)
        // Legends: the deeds, as thresholds. Legends never wear out or vanish,
        // so they must stay rare: at the spec's numbers (a predator with 5
        // kills, 30 kills, one raider) hundreds arose in a long run.
        famous: 30,          // a predator with this many kills is famous
        kills: 50,           // an item with this many kills
        generations: 3,      // borne by this many generations of one line
        defender: 3,         // raiders an item has killed at its own camp
        outlived: 10,        // kills an item needs to be remembered when its makers are gone
        // Weapon skills (the player's, for Spirit).
        pierce: 2,           // Piercing throw: passes through this many
        volley: 3,           // Volley: arrows in the fan...
        volleyFan: 0.17,     // ...this far apart (radians)
        slam: 8,             // Ground slam: drives off predators this close
        // The player's other tools.
        cutReach: 3,         // a knife's quick cut...
        cutHit: 0.5,         // ...and its chance
        kit: 2,              // spare weapons, and spare tools, the player keeps
    },

    // Wood and flint by the player's own hands (acts/hands.js, items.js
    // handWork): E in forest chops wood, on rock or tundra knaps flint, at
    // the errands' rates (items.wood, flint, × the ground's richness), into
    // a load of up to items.load (× a basket's carry) carried to the rack.
    // And the orders Gather wood and Gather flint (orders.js). With nobody
    // controlled and no order given, none of this is ever read.
    materials: {
        knifeKnap: 1.5,      // a knife in hand knaps flint this much faster
        chopEvery: 15,       // a stroke for the page (wood chips) every this many steps...
        knapEvery: 10,       // ...and sparks from the flint
        patch: 12,           // on a flat world: the ground this near the tribe's spot for a material gives it
        ordered: 0.25,       // Gather wood or flint: at most one more than this share of the adults on its errands at once
    },

    evolution: {
        enabled: true,
        // Children inherit each gene × e^(σ·N(0,1)) — symmetric in log space, so
        // mutation alone has no bias toward bigger or smaller.
        sigma: 0.04,
        initialSpread: 0.08, // variety among the first generation
        min: 0.25,
        max: 4,
        // Genes are not free: basal metabolism scales with
        // (1 − wSpeed − wSense) + wSpeed·speed² + wSense·sense².
        // Multiplicative, so no gene can ever turn a cost into a gain.
        wSpeed: 0.6,
        wSense: 0.3,
    },

    lifespanJitter: 0.2,
};

// The parameters a world runs on (World's constructor applies this): a copy
// of `p` at life.pace = k. Pace 1 gives back the numbers as written.
//
// Each life runs k times slower: it lasts k times longer, burns energy k
// times slower, and so needs k times less food a step and breeds k times
// less often. But everyone still moves as fast. So that encounters (a
// predator finding prey, a hunter a grazer, strangers meeting) come no more
// often in a life than before, a slower world must hold k times fewer of
// everyone: grass regrows k times slower, a bite of grass (or a handful
// gathered) is worth k times less, and the world starts with k times fewer
// animals. Meat is found by encounter, so a kill is worth as much as ever.
// The upshot: the same ecology in a life's terms (the same balance between
// predators and prey, the same genes evolve), at half the bustle per step,
// on half the crowd. Kept as written: speeds, senses, bites, throws, the
// crowding cost (rivals nearby are k times rarer already), everything in
// play.* and orders.*.
const LONGER = [ // × k
    'herbivore.maturity', 'herbivore.lifespan',
    'carnivore.maturity', 'carnivore.lifespan', 'carnivore.handling',
    'human.maturity', 'human.lifespan', 'human.birthInterval',
    'items.craftSteps', 'items.butcher', 'items.errand', 'items.torch', 'items.vanish',
];
const SLOWER = [ // ÷ k
    'grass.regrowth',
    'herbivore.baseCost', 'herbivore.moveCost', 'herbivore.grassEnergy',
    'carnivore.baseCost', 'carnivore.moveCost',
    'human.baseCost', 'human.moveCost', 'human.plantEnergy', 'human.spoil', 'human.raidRate',
    'items.wood', 'items.flint',
];
const FEWER = ['herbivore.initial', 'carnivore.initial']; // ÷ k, whole

export function paced(p) {
    const q = structuredClone(p);
    const k = q.life?.pace ?? 1;
    const each = (paths, f) => {
        for (const path of paths) {
            const [a, b] = path.split('.');
            q[a][b] = f(q[a][b]);
        }
    };
    each(LONGER, (v) => v * k);
    each(SLOWER, (v) => v / k);
    each(FEWER, (v) => Math.round(v / k));
    return q;
}
