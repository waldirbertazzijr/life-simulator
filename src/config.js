// Every tunable number in the simulation lives here. Units:
//   distance — world units (the world is ~1600 × 1000 of them)
//   time     — steps (the browser runs 60 steps per second at 1×)
//   energy   — arbitrary; 1 unit of grass is worth `grassEnergy`
//
// planning/THEORY.md explains which knobs stabilise the system and why.
export const params = {
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
        // prey growth does. This is the base of the whole food web.
        regrowth: 0.0009,
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
        birthCost: 90,       // a birth takes this much from the store...
        childEnergy: 60,     // ...of which the newborn gets this
        reserve: 5,          // food per member kept back when deciding on a birth
        birthInterval: 200,  // steps between births in one tribe
        splitSize: 30,       // a tribe this large splits in two
        splitDistance: 300,  // how far the daughter tribe settles
        cultureDrift: 0.08,  // how much a daughter tribe's culture differs from its parent's
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
