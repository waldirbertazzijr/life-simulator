// Simulation configuration
export const config = {
    run: true,
    canvas: null,
    simulationSpeed: 1, // New: speed multiplier

    // Frame-rate–independent simulation. At 1x the world advances
    // targetStepsPerSecond sim-steps per REAL second, regardless of FPS. If a
    // frame runs long (e.g. ~1000 animals), up to maxStepsPerFrame catch-up steps
    // run — capped so a slow frame can't trigger a runaway "spiral of death".
    // This keeps a given speed feeling the same whether there are 100 or 1000 animals.
    targetStepsPerSecond: 60,
    maxStepsPerFrame: 40,

    visuals: {
        procreationAnimations: {
            enabled: true,
            radius: 10
        },
        drawTargets: true,
        energyBar: {
            enabled: true,
            width: 30,
            height: 2,
        },
    },

    behavior: {
        herdingEnabled: true,
        herdingRadius: 100, // How far animals look for herd members
        herdingStrength: 0.3, // How strongly they're pulled to herd center
        familyBondStrength: 0.5, // Extra attraction to family members
        separationAnxietyDistance: 200, // Distance before stress kicks in

        sleepEnabled: true,
        sleepEnergyThreshold: 0.3, // Sleep when energy below 30%
        sleepEnergyGainRate: 0.5, // Energy gained per frame while sleeping
        sleepVulnerabilityMultiplier: 2.0, // Easier to catch while sleeping

        // Life stages as a FRACTION of the individual's lifespan (maxAge), so a
        // short-lived and a long-lived animal both pass through baby→adult→elderly.
        // (Absolute frame thresholds broke reproduction once senescence could kill
        // a species before it reached the old fixed "adult" age.)
        lifeStages: {
            baby: { maxFraction: 0.12, sizeMultiplier: 0.5, speedMultiplier: 0.5 },
            juvenile: { maxFraction: 0.30, sizeMultiplier: 0.75, speedMultiplier: 0.85 },
            adult: { maxFraction: 0.85, sizeMultiplier: 1.0, speedMultiplier: 1.0 },
            elderly: { maxFraction: Infinity, sizeMultiplier: 0.9, speedMultiplier: 0.7 }
        }
    },

    world: {
        // Guarded so the module can also load in a headless (Node) environment.
        width: (typeof window !== 'undefined') ? Math.max(window.innerWidth, document.documentElement.clientWidth) : 1920,
        height: (typeof window !== 'undefined') ? Math.max(window.innerHeight, document.documentElement.clientHeight) : 1080,
        // The parameter search tuned everything on this REFERENCE world. Carrying
        // capacities and initial populations are scaled by (actualArea / referenceArea)
        // so the same DENSITY — and therefore the same balance — holds at any window
        // size. areaScale is (re)computed whenever the canvas is sized.
        referenceWidth: 1920,
        referenceHeight: 1080,
        areaScale: 1
    },

    // NOTE: the tuned values below were found by the headless parameter search
    // (headless/search.mjs) on a 1920x1080 world. They define a self-sustaining
    // 3-tier ecosystem. See docs/ECOSYSTEM_BALANCE.md for the "why".
    trees: {
        initialPopulation: [400, 600],
        energyGain: 0.001,
        procreatingChance: 0.00108, // renewable primary production (tuned on the honest model)
        carryingCapacity: 400,      // logistic cap K on the forest (tuned)
        maxAge: 10000, // frames
        energy: {
            initial: 1000,
            max: 1000,
        }
    },
    herbivores: {
        initialPopulation: [100, 200],
        energyGain: -0.126,         // tuned (honest-model resilience search)
        procreatingChance: 0.004,   // tuned — fast breeders (recover from predation + shocks)
        clockAction: 2,
        maxAge: 4820, // frames      (tuned)
        carryingCapacity: 450,      // herbivore cap (tuned)
        energy: {
            initial: [100, 500],
            max: 500,
        }
    },
    carnivores: {
        initialPopulation: [10, 30],
        energyGain: -0.015,         // tuned — slow metabolism (survive between scarce meals)
        procreatingChance: 0.00307, // tuned
        clockAction: 0.1,
        maxAge: 4849, // frames      (tuned — long-lived)
        carryingCapacity: 20,       // carnivore cap (tuned; honest energy pyramid → apex predators are naturally few)
        energy: {
            initial: [50, 150],
            max: 150,
        }
    },

    energy: {
        defaultEnergy: 100,
        defaultMaxEnergy: 500,
    },

    // --- Ecological realism (all tunable by the headless search) --------------
    ecology: {
        // Honest energy pyramid: a consumer assimilates only a FRACTION of what it
        // eats (Lindeman). The rest becomes soil nutrients (energy is conserved, not
        // created — the old code gave carnivores 2x, which manufactured energy).
        energyTransferEfficiency: 0.4, // tuned

        // Type III functional response: a predator only commits to a hunt with
        // probability preyCount^2 / (preyCount^2 + refuge^2). When prey are scarce it
        // usually gives up (explores instead) — a low-density refuge that stabilises.
        typeIIIRefuge: 3.26, // tuned

        // Senescence: individual maxAge is jittered by ±this fraction so age cohorts
        // don't all die on the same frame (which would cause artificial die-off waves).
        maxAgeJitter: 0.2,

        // Decomposition / nutrient cycling: dead biomass returns to a soil pool that
        // fuels tree regrowth, closing the matter loop.
        soil: {
            corpseYield: 0.5,       // fraction of a (non-eaten) corpse's maxEnergy returned to soil
            decay: 0.999,           // per-frame soil-nutrient leaching
            fertilityScale: 2500,   // soil nutrients needed for a full tree-growth boost
            maxFertilityBoost: 2.0, // cap on the tree-reproduction multiplier from rich soil
            nutrientPerTree: 300,   // soil consumed when a new tree sprouts
        },
    },

    genetics: {
        // Baseline values for genetic traits (1.0 = normal)
        baselineVisionRange: 150, // Base detection range in pixels
        baselineAggression: 1.0,
        baselineIntelligence: 1.0,

        // Mutation ranges (traits can vary between 0.5x and 1.5x baseline)
        minMultiplier: 0.5,
        maxMultiplier: 1.5,

        // Rare mutation chance (0.03 = 3%)
        rareMutationChance: 0.03
    },

    images: {
        tree: './tree.png',
        herbivore: './herbivore.png',
        carnivore: './carnivore.png',
        background: './grass.png'
    }
};
