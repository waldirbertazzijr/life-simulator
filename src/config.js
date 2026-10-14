// Every tunable number in the simulation lives here, as the world reads it
// (world.p is a copy). Units:
//   distance — world units (the world is ~2263 × 1414 of them)
//   time     — steps (the browser runs 15 steps per second at 1×)
//   energy   — arbitrary; 1 unit of grass is worth `grassEnergy`
//
// planning/THEORY.md explains which knobs stabilise the system and why.
//
// Daily needs (hunger, eating, metabolism, a hunter's reload, crafting) are
// in plain steps. Lives (growing up, old age, births) follow the calendar:
// a day of DAY steps (5 minutes at 1×), a year of YEAR (about 2 hours).
const DAY = 4500;
const YEAR = DAY * 6 * 4;

export const params = {
    // The calendar (src/calendar.js): a day of 5 minutes at 1×, seasons of 6
    // days, years of 4 seasons (about 2 hours). Read by stage 4's day and
    // night, seasons and lifetimes, and by the page's sky.
    calendar: {
        day: DAY,      // steps in a day: dawn + light + dusk + night
        dawn: 450,     // 30 s
        light: 2250,   // 2.5 min of daylight
        dusk: 450,     // 30 s (the night is the rest: 1.5 min)
        seasonDays: 6,
        moonDays: 7,   // a moon's cycle, new to new (not a divisor of the year, so full moons wander through the seasons)
        noon: 47,      // the sun's noon height at the equinoxes (degrees)...
        tilt: 23,      // ...± this between midsummer and midwinter
        winterOdds: [0.3, 0.45], // a year's winter: mild, normal (the rest hard)
    },

    world: {
        // The world always has this AREA; its aspect ratio follows the screen.
        // Densities — and so the balance — are identical on any display.
        area: 3200 * 1000, // about 2263 × 1414 at the usual aspect (1.6)
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
        // prey growth does. This is the base of the whole food web. (More grass
        // feeds more of everyone, and is calmer still: THEORY.md §7.)
        regrowth: 0.00075,
        initial: 0.25,       // start near the level herbivores graze it down to
        // The seasons: regrowth × these in spring, summer, autumn and winter
        // (eased from one into the next), the winter's × its severity, mild,
        // normal or hard (calendar.js winterOf): under the snow, hardly at all.
        seasons: [1.6, 1, 0.5, 0.1],
        winters: [1.5, 1, 0.4],
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
        bite: 0.05,          // grass eaten per step...
        snowBite: 0.5,       // ...this much less in deep winter (grazing under the snow)
        grassEnergy: 5,      // energy per unit of grass
        maxEnergy: 100,      // stomach size; a full one lays on fat...
        fatMax: 1300,        // ...up to this × fatten (spring, summer, autumn, winter)...
        fatten: [0.5, 1, 1, 0],
        draw: 0.5,           // ...and draws on it below this fraction of maxEnergy
        meat: 1500,          // a grown body's meat, besides stomach and fat (a hunter's or predator's meal)
        // Births: a grown, well-fed animal (stomach + fat at least birthReserve)
        // gives birth with this chance a step, × the season's (births: spring,
        // summer, autumn, winter), at most once every birthGap; the young gets
        // childShare of its stomach, and it pays birthCost from its fat.
        birthReserve: 230,
        birthChance: 0.0003,
        births: [1, 0.5, 0.5, 0], // (in autumn only where the herds are few: the pasture lush)
        pasture: [0.3, 0.6], // ...× how much grass the land holds: none below the first, all above the second
        birthGap: 16000,     // (spring, again late in spring or in summer; after a hard year, autumn too)
        birthCost: 150,
        litter: 2,           // twins
        maturity: 0.3 * YEAR, // born in spring, grown by the end of summer
        childShare: 0.5,
        lifespan: 1.5 * YEAR,
        baseCost: 0.025,     // basal metabolism per step (scaled by trait upkeep)
        moveCost: 0.05,      // × speed² — moving fast is expensive
        // The herd: at night and in winter a grazer keeps within `herd` of
        // another (looking as far as herdSight); in winter it looks for grass
        // downhill, where it is warmer (descend: how much lower ground counts).
        herd: 10,
        herdSight: 40,
        descend: 0.5,
    },

    carnivore: {
        initial: 60,
        genes: { speed: 1.55, sense: 0.8 }, // starting genes, as above
        speed: 0.75,
        cruise: 0.6,
        sense: 50,           // how far it spots prey — predators see first, then stalk
        smell: 250,          // how far a hungry one scents a carcass (× its sense gene), and goes to it first
        hunt: 400,           // hunts only with less than this in stomach and fat (at night × bold)
        bold: 1.5,
        catchRadius: 3,
        efficiency: 0.7,     // fraction of the prey's meat assimilated
        handling: 240,       // steps spent eating/digesting after a kill
        stamina: 200,        // average chase length before giving up (at night × bold)...
        rest: 60,            // ...and has to catch its breath
        turn: 0.6,           // random heading change while searching (radians)
        // Roaming wider at night (+roamNight) and in winter (+roamWinter):
        // faster, and turning less, as it looks for prey.
        roamNight: 0.3,
        roamWinter: 0.3,
        wary: 60,            // full, it keeps this far from people (they would see it, and fight)
        crowdRadius: 40,     // a rival closer than this interferes...
        crowdCost: 0.2,      // ...costing this much energy per step
        maxEnergy: 120,      // a small stomach: a big meal goes to fat...
        fatMax: 1500,
        draw: 0.5,           // ...drawn on below this fraction of maxEnergy
        meat: 400,
        // Births as the grazers', a litter at a time, and only with at most
        // `rivals` others within `territory`, and at least `prey` grazers.
        birthReserve: 700,
        birthChance: 0.001,
        births: [1, 0.2, 0, 0],
        birthGap: 81000,     // three seasons: once a year
        birthCost: 400,
        litter: 2,
        territory: 190,
        rivals: 0,
        prey: 20,
        maturity: 0.5 * YEAR,
        childShare: 0.5,
        lifespan: 2 * YEAR,
        baseCost: 0.03,
        moveCost: 0.05,
    },

    // People: hunter-gatherers living in tribes (src/humans.js).
    human: {
        enabled: true,
        tribes: 8,           // tribes at the start...
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
        plantEnergy: 3,      // energy per unit gathered (grazers get 5: people digest it worse)
        tripLoad: 40,        // carry food home once holding this much
        carryMax: 160,
        // Body
        maxEnergy: 150,
        hunger: 0.6,         // eat from the camp store below this fraction
        starving: 0.25,      // eat what they carry below this fraction
        baseCost: 0.015,
        moveCost: 0.05,
        // A life: a child stays at camp until it comes of age (an hour at 1×;
        // the page counts 16 years to it, a year of 3,375 steps), and dies of
        // old age at about `lifespan` (4.7 hours, 75 "years"; old age comes
        // from about 4 hours, 64), give or take lifespanJitter (70 to 80),
        // less for costly genes (÷ √upkeep, when it is over 1), and a step
        // less for every step it goes hungry (below `starving`).
        maturity: 54000,
        lifespan: 253000,
        lifespanJitter: 0.066,
        meat: 300,           // a grown body's meat, to a predator
        // Camp and neighbours
        campRadius: 20,
        homeRange: 260,      // how far from camp they forage
        groupRadius: 40,     // tribe-mates this close count as "together"
        meetRadius: 10,      // strangers this close meet: fight or walk away
        fightDamage: 30,
        beaten: 0.5,         // below this share of its energy, one in a fight runs from it
        partySpacing: 15,    // social foragers close up when a tribe-mate is farther than this
        // Raids (aggressive tribes, on neighbours richer than they are)
        raidRate: 0.0001,    // × aggression: per-step chance an adult with nothing to do for the tribe sets off on a raid
        raidRange: 750,      // only camps this close, holding a full load and more a member, are worth raiding
        raidLoad: 150,       // most a raider can carry off
        guard: 0.3,          // each defender at the camp hurts the raider with this chance (×0.5–1 by sociality)
        defendRadius: 30,    // tribe-mates this close help fend off a predator:
        defend: 0.6,         // chance it is driven off = 1 − e^(−defend × defenders)
        killPredator: 0.3,   // × aggression: chance the defenders kill it
        // The tribe. Its store keeps until it is eaten, spent on births,
        // split with a daughter tribe or raided: food never spoils.
        storeTarget: 30,     // food per member the tribe wants in store before resting
        fetchBelow: 1,       // the camp sends for the rest of its kills (and mates help cut) while its store holds less than this × storeTarget
        birthCost: 120,      // a birth takes this much from the store (90 made tribes too many)...
        childEnergy: 60,     // ...of which the newborn gets this
        reserve: 5,          // food per member kept back when deciding on a birth
        birthInterval: 4000, // steps between births in one tribe, at least...
        birthChance: 0.00032,// ...then this chance a step, × the season's (spring, summer, autumn, winter); 2.5e-4 left too few, with raids
        births: [1, 0.6, 0.2, 0],
        splitSize: 22,       // a tribe this large splits in two...
        splitDistance: 300,  // ...the daughter settling about this far off...
        room: 550,           // ...and no nearer than this to any other camp: a tribe needs land of its own
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
        // The player's kills wait to be butchered (acts/hands.js), as long as
        // it takes: no predator takes them while the player lives (spears.js).
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
        wood: 0.02,
        flint: 0.015,
        poor: 0.25,
        load: 8,
        spotReach: 500,      // a tribe goes no farther than this (by land) for them: where a load comes soonest
        initialWood: 6,      // wood in each starting camp (spears for the children who come of age)
        errand: 3000,        // steps a worker keeps at it before going home with what it has
        // A camp's fire burns wood through the night; a full camp's adults
        // keep its woodpile, and a stock of flint (tasks.js chores).
        fire: 7,             // wood a member the camp fire burns each night
        woodpile: 2,         // nights of it a camp keeps in wood
        flintStock: 0.5,     // flint a member it keeps
        // Kinds (the plain spear is today's hunting: human.throwRange, hit, reload).
        arrowRange: 1.6,     // a bow: × the spear's reach (a hunter's throw; the player's arrows: × play.throwRange, heavyRange)...
        arrowSpeed: 1.6,     // ...its arrows fly × as fast as a thrown spear (play.throwSpeed, heavySpeed)...
        bowReload: 0.6,      // ...× its reload...
        bowHit: 0.9,         // ...× its chance to kill
        clubReach: 4,        // a club strikes only this close...
        clubDamage: 1.5,     // ...hurts strangers this much more...
        clubGuard: 2,        // ...and counts as this many defenders against a predator (a bow, none)
        knife: 0.85,         // a knife: food per kill (human.efficiency without), and butchering at double speed
        butcher: 40,         // steps a hunter takes to cut up a kill (the player: play.butcherSteps)
        basket: 1.5,         // a basket: × what can be carried (tripLoad, carryMax)
        torch: 6000,         // a torch burns this many steps; a predator does not take its bearer
        torchReach: 8,       // the player's brandish drives off predators this close
        // Wear, rarity, crafting.
        uses: 40,            // uses before a normal item breaks...
        rareUses: 60,        // ...a rare one
        rare: 1.25,          // a rare item's trait...
        legendary: 1.5,      // ...a legend's
        craftSteps: 300,
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
        vanish: 6000,        // steps a fallen item lasts (legends: forever)
        // Legends: the deeds, as thresholds. Legends never wear out or vanish,
        // so they must stay rare: at the spec's numbers (a predator with 5
        // kills, 30 kills, one raider) hundreds arose in a long run.
        famous: 12,          // a predator with this many kills is famous (a predator kills ~7 a year)
        kills: 50,           // an item with this many kills
        generations: 4,      // borne by this many generations of one line (lives are long: things outlast their bearers)
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

