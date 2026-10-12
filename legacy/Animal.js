// Animal classes and factory
import { config } from './config.js';
import { randomInt, randomHexColor, getRandomName } from './utils.js';
import { Circle } from './Quadtree.js';

// Animal array - shared state
export let animals = [];

export const setAnimals = (newAnimals) => {
    animals = newAnimals;
};

// Soil nutrient pool — dead biomass decomposes into this, and it fuels tree
// regrowth, closing the energy/matter loop (see config.ecology.soil).
export let soilNutrients = 0;
export const setSoilNutrients = (v) => { soilNutrients = v; };
export const decaySoil = () => { soilNutrients *= config.ecology.soil.decay; };

export const removeDead = () => {
    const survivors = [];
    for (const animal of animals) {
        if (animal.energy > 0) {
            survivors.push(animal);
        } else if (!animal.eaten) {
            // Non-predation death (starvation / old age): the corpse decomposes.
            // (Predation already returned the un-eaten remainder to soil in consume().)
            soilNutrients += config.ecology.soil.corpseYield * animal.maxEnergy;
        }
    }
    animals = survivors;
};

// Cached per-kind population counts, refreshed once per frame by the engine so
// hot paths (like the carrying-capacity check in procriate) don't rescan the
// whole array for every single animal.
export const speciesCounts = { tree: 0, herbivore: 0, carnivore: 0 };

export const refreshCounts = () => {
    speciesCounts.tree = 0;
    speciesCounts.herbivore = 0;
    speciesCounts.carnivore = 0;
    for (const animal of animals) {
        if (speciesCounts[animal.kind] !== undefined) speciesCounts[animal.kind]++;
    }
};

// Rescue effect (metapopulation immigration): a patch this small drifts to
// extinction on its own; real ecosystems persist because individuals immigrate
// from neighbouring patches (Levins; Brown & Kodric-Brown "rescue effect").
// While a species is PRESENT but below its floor, it occasionally gains one
// immigrant — enough to prevent permanent collapse, rare enough not to prop up
// a healthy population. (The immigrant's energy is legitimate external input,
// like the sun for trees.)
export const maybeRescue = () => {
    const cfg = config.ecology;
    if (!cfg.rescueBelow) return;
    for (const kind in cfg.rescueBelow) {
        if (speciesCounts[kind] >= cfg.rescueBelow[kind]) continue;
        // (Re)colonise from off-map — but only if there's food to sustain the
        // immigrant (herbivores need trees, carnivores need herbivores). This lets
        // a patch recover even from a total local extinction, as real metapopulations do.
        const foodKind = kind === 'herbivore' ? 'tree' : 'herbivore';
        if (speciesCounts[foodKind] < 1) continue;
        if (Math.random() < cfg.rescueChance) {
            const g = {
                speedMultiplier: 0.7 + Math.random() * 0.6,
                maxEnergyMultiplier: 0.7 + Math.random() * 0.6,
                sizeMultiplier: 0.7 + Math.random() * 0.6,
                visionRange: 0.7 + Math.random() * 0.6,
                aggression: 0.7 + Math.random() * 0.6,
                intelligence: 0.7 + Math.random() * 0.6,
            };
            const cfgS = kind === 'herbivore' ? config.herbivores : config.carnivores;
            const age = Math.floor(cfgS.maxAge * (0.3 + Math.random() * 0.3)); // a breeding-age adult
            animals.push(AnimalFactory.getAnimal(kind, g, age));
        }
    }
};

// Load images (guarded so the module can also load headlessly in Node, where
// there is no `Image`. Images are only ever touched by draw(), never in a headless run).
const loadImage = (src) => {
    if (typeof Image === 'undefined') return null;
    const img = new Image();
    img.src = src;
    return img;
};

const treeImage = loadImage(config.images.tree);
const herbivoreImage = loadImage(config.images.herbivore);
const carnivoreImage = loadImage(config.images.carnivore);

// Widest neighbour-query radius any behaviour needs (analyze/seekFood = 200,
// flee = 150, herd = 100). We query this once per mobile animal per frame and
// each behaviour filters the result to its own range.
const SENSE_RADIUS = 200;

export class Animal {
    constructor(kind, energyGain, procriationChance, walkStrategy = 'static', image, initialEnergy, maxEnergy, clockAction, maxAge, genetics = null, initialAge = null) {
        this.kind = kind;
        this.positionX = randomInt(0, config.world.width);
        this.positionY = randomInt(0, config.world.height);
        this.clockAction = clockAction;
        this.clock = 0;

        // Genetics system - if no genetics provided, use defaults
        if (genetics) {
            this.genetics = genetics;
        } else {
            this.genetics = {
                speedMultiplier: 1.0,
                maxEnergyMultiplier: 1.0,
                sizeMultiplier: 1.0,
                visionRange: 1.0,
                aggression: 1.0,
                intelligence: 1.0
            };
        }

        this.energy = Array.isArray(initialEnergy) ? randomInt(...initialEnergy) : initialEnergy;

        // Max energy is affected by BOTH maxEnergyMultiplier AND sizeMultiplier
        // Bigger animals can store more energy (benefit of being large)
        this.maxEnergy = maxEnergy * this.genetics.maxEnergyMultiplier * (0.8 + this.genetics.sizeMultiplier * 0.4);

        this.energyGain = energyGain;
        this.procriationChance = procriationChance;
        this.walkStrategy = walkStrategy;
        this.currentTarget = null;
        this.consumes = [];
        this.family = randomHexColor();
        this.image = image;
        this.name = getRandomName();

        // Set age - if initialAge provided, use it, otherwise start at 0 (newborn)
        this.age = initialAge !== null ? initialAge : 0;
        // Per-individual lifespan variation so age cohorts don't die all at once.
        const jitter = config.ecology.maxAgeJitter;
        this.maxAge = maxAge * (1 - jitter + Math.random() * 2 * jitter);
        this.eaten = false; // set true when killed by a predator (vs starvation/old age)

        // New behavioral states
        this.isSleeping = false;
        this.sleepTimer = 0;
        this.parent = null; // Reference to parent (for babies)

        // Intelligence system - memory of locations and experiences
        this.memory = {
            dangerZones: [], // {x, y, threat, timestamp}
            goodHuntingSpots: [], // {x, y, success, timestamp}
            maxMemories: 10 // Limit memory size
        };

        // Aggression system
        this.territory = { x: this.positionX, y: this.positionY }; // Territorial center
        this.chaseTarget = null; // Who we're chasing away from territory

        // Vision system
        this.direction = Math.random() * Math.PI * 2; // Random initial direction (radians)

        // Rare genetic mutations
        this.mutations = []; // Array of active mutation names

        // Exploration behavior (for when seeking food but can't find any)
        this.explorationDirection = Math.random() * Math.PI * 2;
        this.explorationTimer = 0;
    }

    // Get current life stage
    getLifeStage() {
        const f = this.maxAge > 0 ? this.age / this.maxAge : 1; // fraction of lifespan lived
        const stages = config.behavior.lifeStages;
        if (f < stages.baby.maxFraction) return 'baby';
        if (f < stages.juvenile.maxFraction) return 'juvenile';
        if (f < stages.adult.maxFraction) return 'adult';
        return 'elderly';
    }

    // Get stage-specific multipliers
    getStageMultipliers() {
        const stage = this.getLifeStage();
        return config.behavior.lifeStages[stage];
    }

    // Check if can reproduce
    canReproduce() {
        const stage = this.getLifeStage();
        return stage === 'adult' || stage === 'elderly';
    }

    // Intelligence: Remember dangerous locations
    rememberDanger(x, y, threat) {
        if (this.genetics.intelligence < 0.8) return; // Low intelligence animals don't remember well

        this.memory.dangerZones.push({ x, y, threat, timestamp: Date.now() });

        // Limit memory size (smarter animals remember more)
        const memoryCapacity = Math.floor(this.memory.maxMemories * this.genetics.intelligence);
        if (this.memory.dangerZones.length > memoryCapacity) {
            this.memory.dangerZones.shift(); // Remove oldest memory
        }
    }

    // Intelligence: Remember successful hunting spots
    rememberSuccess(x, y) {
        if (this.genetics.intelligence < 0.8) return;

        this.memory.goodHuntingSpots.push({ x, y, success: true, timestamp: Date.now() });

        const memoryCapacity = Math.floor(this.memory.maxMemories * this.genetics.intelligence);
        if (this.memory.goodHuntingSpots.length > memoryCapacity) {
            this.memory.goodHuntingSpots.shift();
        }
    }

    // Intelligence: Check if location is dangerous
    isDangerZone(x, y) {
        const dangerRadius = 50;
        return this.memory.dangerZones.some(zone => {
            const dx = Math.abs(x - zone.x);
            const dy = Math.abs(y - zone.y);
            return Math.hypot(dx, dy) < dangerRadius;
        });
    }

    // Intelligence: Get distance bonus if near remembered good spot
    getMemoryBonus(x, y) {
        if (this.memory.goodHuntingSpots.length === 0) return 0;

        const successRadius = 80;
        const nearSuccess = this.memory.goodHuntingSpots.some(spot => {
            const dx = Math.abs(x - spot.x);
            const dy = Math.abs(y - spot.y);
            return Math.hypot(dx, dy) < successRadius;
        });

        return nearSuccess ? -30 : 0; // Negative = prioritize (makes "distance" shorter)
    }

    // Aggression: Check for territory intruders
    checkTerritoryIntruders(quadtree) {
        const territoryRadius = 80 * this.genetics.aggression; // More aggressive = larger territory
        const range = new Circle(this.territory.x, this.territory.y, territoryRadius);
        const nearbyAnimals = quadtree ? quadtree.query(range) : animals;

        for (const intruder of nearbyAnimals) {
            if (intruder === this || intruder.family === this.family) continue;
            if (intruder.kind !== this.kind) continue; // Only territorial toward same species

            const distToTerritory = Math.hypot(
                intruder.positionX - this.territory.x,
                intruder.positionY - this.territory.y
            );

            if (distToTerritory < territoryRadius) {
                this.chaseTarget = intruder;
                return true; // Found an intruder!
            }
        }

        this.chaseTarget = null;
        return false;
    }

    // Aggression: Chase away territory intruder
    chaseIntruder() {
        if (this.chaseTarget && this.chaseTarget.energy > 0) {
            this.moveToTarget(this.chaseTarget);
        } else {
            this.chaseTarget = null;
        }
    }

    // Rare Mutations: Apply a random mutation
    applyRandomMutation() {
        const mutationTypes = [
            'albinism',
            'gigantism',
            'dwarfism',
            'enhanced_fertility',
            'disease_resistance',
            'weak_constitution',
            'efficient_metabolism',
            'enhanced_longevity'
        ];

        // Don't apply same mutation twice
        const availableMutations = mutationTypes.filter(m => !this.mutations.includes(m));
        if (availableMutations.length === 0) return;

        const mutation = availableMutations[Math.floor(Math.random() * availableMutations.length)];
        this.mutations.push(mutation);

        // Apply mutation effects immediately
        this.applyMutationEffects(mutation);
    }

    // Apply effects of a specific mutation
    applyMutationEffects(mutation) {
        switch (mutation) {
            case 'albinism':
                // White appearance, -10% vision
                this.genetics.visionRange *= 0.9;
                this.family = '#FFFFFF'; // White color
                break;

            case 'gigantism':
                // 1.4x size, +20% max energy, +15% energy drain
                this.genetics.sizeMultiplier *= 1.4;
                this.genetics.maxEnergyMultiplier *= 1.2;
                this.maxEnergy *= 1.2;
                // Energy drain is handled in walk() method
                break;

            case 'dwarfism':
                // 0.7x size, -20% max energy, -10% energy drain
                this.genetics.sizeMultiplier *= 0.7;
                this.genetics.maxEnergyMultiplier *= 0.8;
                this.maxEnergy *= 0.8;
                // Energy drain reduction is handled in getMutationEnergyModifier()
                break;

            case 'enhanced_fertility':
                // 50% faster reproduction (handled in procreate)
                break;

            case 'disease_resistance':
                // 50% slower aging (handled in walk)
                break;

            case 'weak_constitution':
                // 30% faster aging (handled in walk)
                break;

            case 'efficient_metabolism':
                // +25% energy from food (handled in consume)
                break;

            case 'enhanced_longevity':
                // +40% lifespan
                this.maxAge *= 1.4;
                break;
        }
    }

    // Get energy drain modifier based on mutations
    getMutationEnergyModifier() {
        let modifier = 0;

        if (this.mutations.includes('gigantism')) {
            modifier -= 0.15; // 15% more energy drain
        }
        if (this.mutations.includes('dwarfism')) {
            modifier += 0.10; // 10% less energy drain
        }

        return modifier;
    }

    // Check if has a specific mutation
    hasMutation(mutationName) {
        return this.mutations.includes(mutationName);
    }

    getDistanceTo(animal) {
        const dx = Math.abs(this.positionX - animal.positionX);
        const dy = Math.abs(this.positionY - animal.positionY);
        const wrappedDx = Math.min(dx, config.world.width - dx);
        const wrappedDy = Math.min(dy, config.world.height - dy);
        return Math.hypot(wrappedDx, wrappedDy);
    }

    // Vision system: Check if target is within FOV cone
    isInVisionCone(target) {
        // Calculate vision range based on genetics
        const visionDistance = config.genetics.baselineVisionRange * this.genetics.visionRange;
        const distance = this.getDistanceTo(target);

        // First check: Is it within vision distance?
        if (distance > visionDistance) return false;

        // Second check: Is it within field of view?
        const fovAngle = Math.PI * 0.66; // ~120 degrees FOV
        const dx = target.positionX - this.positionX;
        const dy = target.positionY - this.positionY;

        // Handle toroidal wrapping for angle calculation
        const wrappedDx = (dx > config.world.width / 2) ? dx - config.world.width :
                         (dx < -config.world.width / 2) ? dx + config.world.width : dx;
        const wrappedDy = (dy > config.world.height / 2) ? dy - config.world.height :
                         (dy < -config.world.height / 2) ? dy + config.world.height : dy;

        const angleToTarget = Math.atan2(wrappedDy, wrappedDx);

        // Calculate angle difference (normalize to -PI to PI)
        let angleDiff = angleToTarget - this.direction;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // Check if target is within FOV cone
        return Math.abs(angleDiff) <= fovAngle / 2;
    }

    walk(quadtree, nearby = null) {
        this.clock++;
        if (this.clock < this.clockAction) return;

        // Age the animal with mutation effects
        let ageIncrement = 1;
        if (this.hasMutation('disease_resistance')) {
            ageIncrement *= 0.5; // Age 50% slower
        }
        if (this.hasMutation('weak_constitution')) {
            ageIncrement *= 1.3; // Age 30% faster
        }
        this.age += ageIncrement;

        // Senescence — die of old age. (maxAge is per-individual, jittered at birth,
        // so cohorts don't all die on the same frame.) Previously maxAge was dead
        // config: nothing ever died of age.
        if (this.age >= this.maxAge) {
            this.energy = 0;
            return;
        }

        // Handle sleeping
        if (this.isSleeping) {
            // Restore energy while sleeping
            this.energy += config.behavior.sleepEnergyGainRate;
            this.energy = Math.min(this.energy, this.maxEnergy);

            // Wake up when energy is restored or danger is near
            if (this.energy / this.maxEnergy > 0.7) {
                this.isSleeping = false;
            }
            return; // Don't move while sleeping
        }

        // GENETIC TRADE-OFFS — MULTIPLICATIVE so they scale with the base
        // metabolism and can NEVER flip a drain into a passive GAIN. (The old code
        // used FLAT amounts like dwarfism "+0.10"; once the search shrank carnivore
        // metabolism to ~-0.03 those flat bonuses made resting animals net-positive
        // — the "eternal hibernation" exploit where carnivores get immortal and
        // never hunt.) Each trait now multiplies the metabolic COST, matching the
        // tracker's stated intent ("Speed: fast but burns energy", etc.). Producers
        // (trees) have energyGain > 0 and are left untouched.
        let energyDrain = this.energyGain;
        if (this.energyGain < 0) {
            let drainMultiplier = 1.0;
            if (this.genetics.speedMultiplier > 1.0) drainMultiplier += (this.genetics.speedMultiplier - 1.0) * 0.5;  // ⚡ fast metabolism
            if (this.genetics.sizeMultiplier > 1.0) drainMultiplier += (this.genetics.sizeMultiplier - 1.0) * 0.3;   // 📏 bigger body to fuel
            drainMultiplier += Math.abs(this.genetics.intelligence - 1.0) * 0.4;                                     // 🧠 brain cost (either direction)
            if (this.genetics.aggression > 1.0) drainMultiplier += (this.genetics.aggression - 1.0) * 0.3;           // 😠 stress / alertness
            if (this.genetics.visionRange > 1.0) drainMultiplier += (this.genetics.visionRange - 1.0) * 0.25;        // 👁️ visual processing
            if (this.hasMutation('gigantism')) drainMultiplier *= 1.15; // documented: +15% drain
            if (this.hasMutation('dwarfism')) drainMultiplier *= 0.90;  // documented: −10% drain (a discount, never a gain)
            energyDrain = this.energyGain * drainMultiplier;
        }

        this.energy += energyDrain;
        this.energy = Math.min(this.energy, this.maxEnergy);

        // Trees don't move or sleep
        if (this.walkStrategy === 'static') return;

        // Check if should sleep (but NOT while hunting or fleeing!)
        const isActivelyHunting = this.walkStrategy === 'seekFood' || this.walkStrategy === 'fleeing';
        if (config.behavior.sleepEnabled &&
            this.energy / this.maxEnergy < config.behavior.sleepEnergyThreshold &&
            !isActivelyHunting) {
            this.isSleeping = true;
            return;
        }

        if (this.walkStrategy === 'random') {
            this.positionX += randomInt(-1, 2);
            this.positionY += randomInt(-1, 2);
        } else if (this.walkStrategy === 'seekFood') {
            this.seekFood(quadtree, nearby);
        } else if (this.walkStrategy === 'fleeing') {
            this.flee(quadtree, nearby);
        } else if (this.walkStrategy === 'chasing') {
            // Chase away territory intruders
            this.chaseIntruder();
        } else if (this.walkStrategy === 'relax') {
            // When relaxing, move toward herd
            this.moveTowardHerd(quadtree, nearby);
        }

        // Wrap around logic for toroidal space
        if (this.positionX < 0) {
            this.positionX += config.world.width;
        } else if (this.positionX >= config.world.width) {
            this.positionX -= config.world.width;
        }

        if (this.positionY < 0) {
            this.positionY += config.world.height;
        } else if (this.positionY >= config.world.height) {
            this.positionY -= config.world.height;
        }

        this.clock = 0;
    }

    seekFood(quadtree, nearby = null) {
        let bestScore = Infinity;
        let bestTarget = null;
        let preyCount = 0; // edible prey perceived nearby (for the Type III response)

        // Use the shared neighbour list (or fall back to a fresh query). When we
        // reuse the shared list we re-check `range` inline instead of building a
        // filtered copy — same subsequence, so behaviour is byte-identical.
        const searchRadius = 200;
        const range = new Circle(this.positionX, this.positionY, searchRadius);
        const useShared = nearby !== null;
        const nearbyAnimals = useShared ? nearby : (quadtree ? quadtree.query(range) : animals);

        // Intelligence: Look for family members to coordinate with
        let familyNearby = [];
        if (this.genetics.intelligence > 1.1) {
            for (const a of nearbyAnimals) {
                if (useShared && !range.contains(a)) continue;
                if (a.kind === this.kind && a.family === this.family && a !== this && this.getDistanceTo(a) < 100) {
                    familyNearby.push(a);
                }
            }
        }

        for (const animal of nearbyAnimals) {
            if (useShared && !range.contains(animal)) continue;
            if (this.consumes.includes(animal.kind) && this !== animal && this.family !== animal.family) {
                // Vision system: Can only see animals in FOV cone
                if (!this.isInVisionCone(animal)) {
                    continue; // Can't see this animal
                }
                preyCount++; // a perceivable prey item nearby

                // DOMINANCE SYSTEM: Carnivores only hunt weaker carnivores
                if (this.kind === 'carnivore' && animal.kind === 'carnivore') {
                    if (animal.energy >= this.energy) {
                        continue; // Skip stronger/equal carnivores
                    }
                }

                const distance = this.getDistanceTo(animal);
                let effectiveDistance = distance;

                // Sleeping animals are easier targets
                if (animal.isSleeping) effectiveDistance *= 0.5;

                // Weaker carnivores are prioritized (easier targets)
                if (this.kind === 'carnivore' && animal.kind === 'carnivore') {
                    effectiveDistance *= 0.7;
                }

                // INTELLIGENCE: Better decision making
                if (this.genetics.intelligence > 1.0) {
                    // Avoid remembered danger zones
                    if (this.isDangerZone(animal.positionX, animal.positionY)) {
                        effectiveDistance *= 1.5; // Deprioritize dangerous areas
                    }

                    // Prefer remembered good hunting spots
                    effectiveDistance += this.getMemoryBonus(animal.positionX, animal.positionY);

                    // Consider target's energy (easier to catch weak prey)
                    const targetWeakness = 1 - (animal.energy / animal.maxEnergy);
                    effectiveDistance *= (1 - targetWeakness * 0.3); // Up to 30% bonus for weak targets

                    // Social strategy: Coordinate with family
                    if (familyNearby.length > 0) {
                        // Check if family members are also targeting this animal
                        const familyTargeting = familyNearby.filter(f =>
                            f.currentTarget === animal
                        ).length;

                        if (familyTargeting > 0) {
                            effectiveDistance *= 0.8; // Prioritize shared targets (pack hunting)
                        }
                    }
                }

                if (effectiveDistance < bestScore) {
                    bestScore = effectiveDistance;
                    bestTarget = animal;
                }
            }
        }

        this.currentTarget = bestTarget;

        if (this.currentTarget) {
            // TYPE III FUNCTIONAL RESPONSE — commit to the hunt only with a
            // probability that rises with local prey density (a Hill function).
            // When prey are scarce the predator usually gives up and wanders off,
            // giving rare prey a low-density REFUGE. Classic stabiliser (Holling).
            // ONLY applies to hunting MOBILE prey (carnivores). Herbivores graze
            // static, abundant trees — there's no "give up when scarce" there, and
            // applying it just starves them, which collapses the whole web.
            let commit = 1;
            if (this.kind === 'carnivore') {
                const refuge = config.ecology.typeIIIRefuge;
                commit = (preyCount * preyCount) / (preyCount * preyCount + refuge * refuge);
            }
            if (Math.random() < commit) {
                this.moveToTarget(this.currentTarget);
                this.explorationTimer = 0; // Reset exploration when we commit to food
            } else {
                this.currentTarget = null; // give up — prey too scarce to be worth it
                this.explore();
            }
        } else {
            // No food found - explore to search for prey
            this.explore();
        }
    }

    // Exploration behavior - wander around when seeking food but can't find any
    explore() {
        this.explorationTimer++;

        // Change direction every 30-60 frames (randomized to avoid synchronization)
        const changeDirectionInterval = 30 + Math.random() * 30;
        if (this.explorationTimer > changeDirectionInterval) {
            this.explorationDirection = Math.random() * Math.PI * 2;
            this.explorationTimer = 0;
        }

        // Move in exploration direction
        const stageMultiplier = this.getStageMultipliers().speedMultiplier;
        const speed = 0.5 * this.genetics.speedMultiplier * stageMultiplier;
        this.positionX += speed * Math.cos(this.explorationDirection);
        this.positionY += speed * Math.sin(this.explorationDirection);
        this.direction = this.explorationDirection; // Update facing direction

        // Wrap around logic for toroidal space
        if (this.positionX < 0) {
            this.positionX += config.world.width;
        } else if (this.positionX >= config.world.width) {
            this.positionX -= config.world.width;
        }

        if (this.positionY < 0) {
            this.positionY += config.world.height;
        } else if (this.positionY >= config.world.height) {
            this.positionY -= config.world.height;
        }
    }

    // New: Herding behavior - move toward center of nearby family members
    moveTowardHerd(quadtree, nearby = null) {
        if (!config.behavior.herdingEnabled) return;

        const range = new Circle(this.positionX, this.positionY, config.behavior.herdingRadius);
        const useShared = nearby !== null;
        const nearbyAnimals = useShared ? nearby : (quadtree ? quadtree.query(range) : animals);

        let herdCenterX = 0;
        let herdCenterY = 0;
        let herdCount = 0;
        let familyCount = 0;

        for (const animal of nearbyAnimals) {
            if (useShared && !range.contains(animal)) continue;
            if (animal.kind === this.kind && this !== animal) {
                herdCenterX += animal.positionX;
                herdCenterY += animal.positionY;
                herdCount++;

                if (animal.family === this.family) {
                    familyCount++;
                }
            }
        }

        if (herdCount > 0) {
            herdCenterX /= herdCount;
            herdCenterY /= herdCount;

            // Calculate direction to herd center
            const dx = herdCenterX - this.positionX;
            const dy = herdCenterY - this.positionY;
            const distance = Math.hypot(dx, dy);

            if (distance > 10) { // Don't move if already at center
                const strength = familyCount > 0 ? config.behavior.familyBondStrength : config.behavior.herdingStrength;
                this.positionX += (dx / distance) * strength;
                this.positionY += (dy / distance) * strength;
            }
        }
    }

    flee(quadtree, nearby = null) {
        this.currentTarget = null;

        let closestHunter = null;
        let closestHunterDistance = Infinity;

        // Shared neighbour list, re-checked against `range` inline (no filtered copy).
        const searchRadius = 150;
        const range = new Circle(this.positionX, this.positionY, searchRadius);
        const useShared = nearby !== null;
        const nearbyAnimals = useShared ? nearby : (quadtree ? quadtree.query(range) : animals);

        for (const hunter of nearbyAnimals) {
            if (useShared && !range.contains(hunter)) continue;
            if (this !== hunter && hunter.consumes.includes(this.kind) && this.family !== hunter.family) {
                const distance = this.getDistanceTo(hunter);
                if (distance < closestHunterDistance) {
                    closestHunterDistance = distance;
                    closestHunter = hunter;
                }
            }
        }

        if (closestHunter) {
            this.moveAwayFromTarget(closestHunter);
        }
    }

    moveToTarget(target) {
        const dx = target.positionX - this.positionX;
        const dy = target.positionY - this.positionY;
        const wrappedDx = (dx > config.world.width / 2) ? dx - config.world.width : (dx < -config.world.width / 2) ? dx + config.world.width : dx;
        const wrappedDy = (dy > config.world.height / 2) ? dy - config.world.height : (dy < -config.world.height / 2) ? dy + config.world.height : dy;

        const angle = Math.atan2(wrappedDy, wrappedDx);
        this.direction = angle; // Update direction for vision system

        const stageMultiplier = this.getStageMultipliers().speedMultiplier;
        const speed = 0.5 * this.genetics.speedMultiplier * stageMultiplier;
        this.positionX += speed * Math.cos(angle);
        this.positionY += speed * Math.sin(angle);

        // Wrap around logic for toroidal space
        if (this.positionX < 0) {
            this.positionX += config.world.width;
        } else if (this.positionX >= config.world.width) {
            this.positionX -= config.world.width;
        }

        if (this.positionY < 0) {
            this.positionY += config.world.height;
        } else if (this.positionY >= config.world.height) {
            this.positionY -= config.world.height;
        }
    }

    moveAwayFromTarget(target) {
        const dx = this.positionX - target.positionX;
        const dy = this.positionY - target.positionY;
        const wrappedDx = (dx > config.world.width / 2) ? dx - config.world.width : (dx < -config.world.width / 2) ? dx + config.world.width : dx;
        const wrappedDy = (dy > config.world.height / 2) ? dy - config.world.height : (dy < -config.world.height / 2) ? dy + config.world.height : dy;

        const angle = Math.atan2(wrappedDy, wrappedDx);
        this.direction = angle; // Update direction for vision system

        const stageMultiplier = this.getStageMultipliers().speedMultiplier;
        const speed = 0.5 * this.genetics.speedMultiplier * stageMultiplier;
        this.positionX += speed * Math.cos(angle);
        this.positionY += speed * Math.sin(angle);

        // Wrap around logic for toroidal space
        if (this.positionX < 0) {
            this.positionX += config.world.width;
        } else if (this.positionX >= config.world.width) {
            this.positionX -= config.world.width;
        }

        if (this.positionY < 0) {
            this.positionY += config.world.height;
        } else if (this.positionY >= config.world.height) {
            this.positionY -= config.world.height;
        }
    }

    procriate(createProcreationAnimation, dayNightCycle) {
        // Only adults and elderly can reproduce
        if (!this.canReproduce()) return;

        // Carrying capacity: the environment can only support so many of each
        // species (logistic cap K). This is the key stabilizer from population
        // ecology — without it, births compound until the food web crashes.
        const speciesCfg = this.kind === 'tree' ? config.trees
            : this.kind === 'herbivore' ? config.herbivores
            : this.kind === 'carnivore' ? config.carnivores : null;
        const areaScale = config.world.areaScale || 1; // scale the cap to the actual world size
        let densityFactor = 1;
        if (speciesCfg && speciesCfg.carryingCapacity) {
            const K = speciesCfg.carryingCapacity * areaScale;
            if (speciesCounts[this.kind] >= K) return;
            // SOFT logistic cap: reproduction slows smoothly as N → K, the real
            // (1 − N/K) growth term — NOT a hard cutoff. A hard cutoff freezes
            // reproduction the instant the population hits K, so the whole cohort
            // ages together and mass-dies at senescence (a boom-bust crash, seen
            // ~every 50k frames). The smooth term keeps young animals trickling in,
            // so the age structure stays healthy and the population is steady.
            densityFactor = 1 - speciesCounts[this.kind] / K;
        }

        // Adjust procreation chance based on time of day and species
        let adjustedChance = this.procriationChance * densityFactor;

        // Enhanced fertility mutation: 50% faster reproduction
        if (this.hasMutation('enhanced_fertility')) {
            adjustedChance *= 1.5;
        }

        if (dayNightCycle) {
            if (this.kind === 'carnivore') {
                adjustedChance *= dayNightCycle.getCarnivoreActivityMultiplier();
            } else if (this.kind === 'herbivore') {
                adjustedChance *= dayNightCycle.getHerbivoreActivityMultiplier();
            }
        }

        // Decomposition loop: rich soil (from decayed corpses) accelerates forest
        // regrowth, so more animal deaths → more trees → more herbivore food.
        if (this.kind === 'tree' && soilNutrients > 0) {
            const s = config.ecology.soil;
            adjustedChance *= 1 + Math.min(soilNutrients / s.fertilityScale, s.maxFertilityBoost);
        }

        // FOOD-GATED, ENERGY-CONSERVING reproduction: only a WELL-FED animal breeds,
        // and the newborn's energy comes FROM the parent (nothing is created — this is
        // what stopped carnivores self-funding by breeding + cannibalism). Gating on
        // food self-limits the population and stops a starving animal from splitting
        // into two doomed weaklings, which damps boom-bust overshoot collapse.
        const offspringEnergy = this.maxEnergy * config.ecology.offspringEnergyFraction;
        if (this.energy < offspringEnergy + this.maxEnergy * config.ecology.breedingReserve) return;

        if (Math.random() <= adjustedChance) {
            this.energy -= offspringEnergy;

            // A new tree draws nutrients out of the soil as it grows.
            if (this.kind === 'tree') {
                soilNutrients = Math.max(0, soilNutrients - config.ecology.soil.nutrientPerTree);
            }

            // Create child genetics with mutations (±10% variation)
            const mutate = (value) => {
                const mutationRate = 0.1;
                const mutation = 1 + (Math.random() * 2 - 1) * mutationRate;
                return Math.max(0.5, Math.min(1.5, value * mutation)); // Clamp between 0.5x and 1.5x
            };

            const childGenetics = {
                speedMultiplier: mutate(this.genetics.speedMultiplier),
                maxEnergyMultiplier: mutate(this.genetics.maxEnergyMultiplier),
                sizeMultiplier: mutate(this.genetics.sizeMultiplier),
                visionRange: mutate(this.genetics.visionRange),
                aggression: mutate(this.genetics.aggression),
                intelligence: mutate(this.genetics.intelligence)
            };

            const child = AnimalFactory.getAnimal(this.kind, childGenetics);
            child.energy = offspringEnergy; // viable start, paid from the parent (conserved, not created)
            child.positionX = this.positionX + randomInt(-10, 10);
            child.positionY = this.positionY + randomInt(-10, 10);
            child.family = this.family;
            child.parent = this; // Set parent reference for babies

            // Inherit mutations from parent (50% chance for each)
            for (const mutation of this.mutations) {
                if (Math.random() < 0.5) {
                    child.mutations.push(mutation);
                    child.applyMutationEffects(mutation);
                }
            }

            // Rare random mutation chance (3%)
            if (Math.random() < config.genetics.rareMutationChance) {
                child.applyRandomMutation();
            }

            animals.push(child);

            // Trigger the procreation animation
            if (config.visuals.procreationAnimations.enabled) createProcreationAnimation(child.positionX, child.positionY);
        }
    }

    feed(quadtree, nearby = null) {
        if (this.consumes.length === 0) return; // producers (trees) never eat — skip the query entirely
        if (this.isSleeping) return; // Can't feed while sleeping

        // The shared SENSE_RADIUS list is a superset of this tiny feed radius, so
        // filter it inline rather than firing a second spatial query. Quadtree query
        // order is "global tree order filtered by the circle", so the filtered
        // subsequence matches a fresh feed-radius query exactly — byte-identical.
        const feedRadius = 10;
        const range = new Circle(this.positionX, this.positionY, feedRadius);
        const useShared = nearby !== null;
        const nearbyAnimals = useShared ? nearby : (quadtree ? quadtree.query(range) : animals);

        for (const target of nearbyAnimals) {
            if (useShared && !range.contains(target)) continue;
            if (this.consumes.includes(target.kind) && this !== target && this.family !== target.family) {
                const catchDistance = target.isSleeping ? 10 : 5; // Easier to catch sleeping prey
                if (this.getDistanceTo(target) < catchDistance) {
                    this.consume(target);

                    // Wake up if being eaten!
                    if (target.isSleeping) {
                        target.isSleeping = false;
                    }
                }
            }
        }
    }

    analyze(quadtree, nearby = null) {
        const stage = this.getLifeStage();

        // Babies stay near parent UNLESS they're hungry or in danger
        if (stage === 'baby' && this.parent && this.parent.energy > 0) {
            const energyPercent = this.energy / this.maxEnergy;

            // If baby is hungry (below 40%), prioritize hunting over following parent
            if (energyPercent > 0.4) {
                const distToParent = this.getDistanceTo(this.parent);
                if (distToParent > 30) {
                    this.moveToTarget(this.parent);
                }
                return; // Follow parent when not hungry
            }
            // If hungry, fall through to normal decision making
        }

        let closestHunterDistance = Infinity;
        let closestHunter = null;

        // Shared neighbour list, re-checked against `range` inline (no filtered copy).
        const searchRadius = stage === 'elderly' ? 200 : 150; // Elderly are more cautious
        const range = new Circle(this.positionX, this.positionY, searchRadius);
        const useShared = nearby !== null;
        const nearbyAnimals = useShared ? nearby : (quadtree ? quadtree.query(range) : animals);

        for (const hunter of nearbyAnimals) {
            if (useShared && !range.contains(hunter)) continue;
            if (this !== hunter && hunter.consumes.includes(this.kind) && this.family !== hunter.family) {
                // Vision system: Can only see predators in FOV cone
                if (!this.isInVisionCone(hunter)) {
                    continue; // Can't see this predator
                }

                // DOMINANCE SYSTEM: If both are carnivores, only flee from stronger ones
                if (this.kind === 'carnivore' && hunter.kind === 'carnivore') {
                    // Only consider this a threat if the hunter has MORE energy (is more powerful)
                    if (hunter.energy <= this.energy) {
                        continue; // Ignore weaker/equal carnivores - we're the dominant one!
                    }
                }

                const distance = this.getDistanceTo(hunter);
                if (distance < closestHunterDistance) {
                    closestHunterDistance = distance;
                    closestHunter = hunter;
                }
            }
        }

        // Elderly flee earlier, juveniles are braver
        const fleeThreshold = stage === 'elderly' ? 150 : stage === 'juvenile' ? 75 : 100;

        if (closestHunterDistance < fleeThreshold) {
            this.walkStrategy = 'fleeing';

            // Intelligence: Remember this location as dangerous
            if (closestHunter) {
                this.rememberDanger(closestHunter.positionX, closestHunter.positionY, closestHunter.kind);
            }
        } else {
            // Carnivores are more aggressive hunters (hunt at 85% energy)
            // Herbivores only seek food when hungry (50% energy)
            let hungerThreshold = this.kind === 'carnivore' ? 0.85 : 0.5;

            // AGGRESSION: More aggressive animals hunt earlier (even when not very hungry)
            // Less aggressive animals only hunt when desperate
            if (this.genetics.aggression > 1.0) {
                hungerThreshold += (this.genetics.aggression - 1.0) * 0.15; // Hunt even earlier
            } else if (this.genetics.aggression < 1.0) {
                hungerThreshold -= (1.0 - this.genetics.aggression) * 0.2; // Wait until hungrier
            }

            if (this.energy / this.maxEnergy <= hungerThreshold) {
                this.walkStrategy = 'seekFood';
            } else {
                // When relaxed, check for territory intruders (if aggressive)
                if (this.genetics.aggression > 1.2 && this.checkTerritoryIntruders(quadtree)) {
                    this.walkStrategy = 'chasing'; // New behavior: chase intruders
                } else {
                    this.walkStrategy = 'relax';
                }
            }
        }
    }

    consume(animal) {
        // Honest energy pyramid: a consumer assimilates only a FRACTION of the
        // prey's energy (Lindeman); the remainder decomposes into soil. Energy is
        // conserved, never created. (The old code gave carnivores 2x — manufacturing
        // energy and letting them freeload; see the "eternal hibernation" saga.)
        const eff = config.ecology.energyTransferEfficiency;
        let assimilated = animal.energy * eff;
        if (this.hasMutation('efficient_metabolism')) {
            assimilated *= 1.25; // mutation: better at extracting energy from food
        }
        assimilated = Math.min(assimilated, animal.energy); // can't extract more than exists

        this.energy = Math.min(this.energy + assimilated, this.maxEnergy); // cap at max
        soilNutrients += animal.energy - assimilated; // un-eaten remains → soil
        animal.energy = 0;
        animal.eaten = true; // so removeDead() doesn't also count this as a corpse

        // Intelligence: Remember this as a successful hunting spot
        this.rememberSuccess(animal.positionX, animal.positionY);
    }

    live(createProcreationAnimation, quadtree, dayNightCycle) {
        if (!config.run) return;

        // One shared neighbour query per mobile animal per frame. analyze(),
        // seekFood()/flee() and moveTowardHerd() all sense from the same pre-move
        // position, so we query once and each filters to its own radius.
        let nearby = null;
        if (this.walkStrategy !== 'static' && quadtree) {
            nearby = quadtree.query(new Circle(this.positionX, this.positionY, SENSE_RADIUS));
        }

        if (this.walkStrategy !== 'static') {
            const px = this.positionX, py = this.positionY;
            this.analyze(quadtree, nearby);
            // If analyze() moved us (a baby following its parent), the shared query
            // is stale — force walk() to do a fresh one so behaviour is unchanged.
            if (this.positionX !== px || this.positionY !== py) nearby = null;
        }

        this.walk(quadtree, nearby);
        this.feed(quadtree, nearby);
        this.procriate(createProcreationAnimation, dayNightCycle);
    }

    draw(ctx) {
        // Apply sleeping transparency
        const sleepOpacity = this.isSleeping ? 0.6 : 1.0;
        ctx.globalAlpha = sleepOpacity;

        // Draw the animal image with size based on genetics and life stage
        const stageMultiplier = this.getStageMultipliers().sizeMultiplier;
        const size = 32 * this.genetics.sizeMultiplier * stageMultiplier;
        const halfSize = size / 2;
        ctx.drawImage(this.image, this.positionX - halfSize, this.positionY - halfSize, size, size);

        ctx.globalAlpha = 1; // Reset opacity

        // Draw "Zzz" if sleeping
        if (this.isSleeping) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#000';
            ctx.font = '12px Arial';
            ctx.lineWidth = 2;
            ctx.strokeText('Zzz', this.positionX + 15, this.positionY - 15);
            ctx.fillText('Zzz', this.positionX + 15, this.positionY - 15);
        }

        // Draw baby indicator
        if (this.getLifeStage() === 'baby') {
            ctx.fillStyle = '#FFD700';
            ctx.strokeStyle = '#000';
            ctx.font = 'bold 10px Arial';
            ctx.lineWidth = 2;
            ctx.strokeText('👶', this.positionX - 5, this.positionY - 20);
            ctx.fillText('👶', this.positionX - 5, this.positionY - 20);
        }

        // Draw mutation indicator
        if (this.mutations.length > 0) {
            ctx.fillStyle = '#FF00FF';
            ctx.strokeStyle = '#000';
            ctx.font = 'bold 10px Arial';
            ctx.lineWidth = 2;
            ctx.strokeText('✨', this.positionX + 10, this.positionY - 20);
            ctx.fillText('✨', this.positionX + 10, this.positionY - 20);
        }

        if (this.walkStrategy !== 'static') {
            // Draw the family circle
            ctx.fillStyle = this.family;
            ctx.beginPath();
            ctx.arc(this.positionX - 20, this.positionY - 19, 2, 0, 2 * Math.PI);
            ctx.strokeStyle = "#000";
            ctx.stroke();
            ctx.fill();

            if (config.visuals.energyBar.enabled) {
                const energyPercentage = this.energy / this.maxEnergy;
                const barColor = energyPercentage > 0.2 ? 'green' : 'red';
                ctx.fillStyle = barColor;
                ctx.fillRect(this.positionX - config.visuals.energyBar.width / 2, this.positionY - 20, config.visuals.energyBar.width * energyPercentage, config.visuals.energyBar.height);
                ctx.strokeStyle = '#000';
                ctx.strokeRect(this.positionX - config.visuals.energyBar.width / 2, this.positionY - 20, config.visuals.energyBar.width, config.visuals.energyBar.height);
            }

            if (config.visuals.drawTargets && this.currentTarget) {
                this.drawWrappedLine(ctx, this.positionX, this.positionY, this.currentTarget.positionX, this.currentTarget.positionY);
            }
        }
    }

    drawWrappedLine(ctx, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;

        const wrappedDx = (dx > config.world.width / 2) ? dx - config.world.width : (dx < -config.world.width / 2) ? dx + config.world.width : dx;
        const wrappedDy = (dy > config.world.height / 2) ? dy - config.world.height : (dy < -config.world.height / 2) ? dy + config.world.height : dy;

        const endX = x1 + wrappedDx;
        const endY = y1 + wrappedDy;

        // Draw subtle dashed line
        ctx.strokeStyle = this.kind === 'carnivore' ? 'rgba(220, 20, 60, 0.3)' : 'rgba(255, 140, 0, 0.3)'; // Semi-transparent red/orange
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]); // Dashed line

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        ctx.setLineDash([]); // Reset to solid

        // Draw arrow at the end
        const angle = Math.atan2(wrappedDy, wrappedDx);
        const arrowLength = 8;
        const arrowAngle = Math.PI / 6; // 30 degrees

        ctx.strokeStyle = this.kind === 'carnivore' ? 'rgba(220, 20, 60, 0.5)' : 'rgba(255, 140, 0, 0.5)';
        ctx.lineWidth = 1.5;

        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
            endX - arrowLength * Math.cos(angle - arrowAngle),
            endY - arrowLength * Math.sin(angle - arrowAngle)
        );
        ctx.moveTo(endX, endY);
        ctx.lineTo(
            endX - arrowLength * Math.cos(angle + arrowAngle),
            endY - arrowLength * Math.sin(angle + arrowAngle)
        );
        ctx.stroke();
    }

    // Draw vision cone (used for visual debugging / hover indication)
    drawVisionCone(ctx) {
        if (this.walkStrategy === 'static') return; // Trees don't have vision

        const visionDistance = config.genetics.baselineVisionRange * this.genetics.visionRange;
        const fovAngle = Math.PI * 0.66; // ~120 degrees

        // Draw the vision cone
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = this.kind === 'carnivore' ? 'rgba(220, 20, 60, 0.5)' :
                        this.kind === 'herbivore' ? 'rgba(100, 200, 100, 0.5)' : 'rgba(200, 200, 200, 0.5)';

        ctx.beginPath();
        ctx.moveTo(this.positionX, this.positionY);
        ctx.arc(
            this.positionX,
            this.positionY,
            visionDistance,
            this.direction - fovAngle / 2,
            this.direction + fovAngle / 2
        );
        ctx.closePath();
        ctx.fill();

        // Draw cone outline
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = this.kind === 'carnivore' ? 'rgba(220, 20, 60, 0.8)' : 'rgba(100, 200, 100, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    }

    // Draw territory boundary (for aggressive animals)
    drawTerritory(ctx) {
        if (this.walkStrategy === 'static' || this.genetics.aggression < 1.2) return;

        const territoryRadius = 80 * this.genetics.aggression;

        ctx.save();
        ctx.strokeStyle = this.kind === 'carnivore' ? 'rgba(220, 20, 60, 0.4)' : 'rgba(255, 140, 0, 0.4)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]); // Dashed circle

        ctx.beginPath();
        ctx.arc(this.territory.x, this.territory.y, territoryRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.setLineDash([]); // Reset
        ctx.restore();
    }
}

export class Tree extends Animal {
    constructor(genetics = null, initialAge = null) {
        super('tree', config.trees.energyGain, config.trees.procreatingChance, 'static', treeImage, config.trees.energy.initial, config.trees.energy.max, 1, config.trees.maxAge, genetics, initialAge);
    }
}

export class Herbivore extends Animal {
    constructor(genetics = null, initialAge = null) {
        super('herbivore', config.herbivores.energyGain, config.herbivores.procreatingChance, 'seekFood', herbivoreImage, config.herbivores.energy.initial, config.herbivores.energy.max, config.herbivores.clockAction, config.herbivores.maxAge, genetics, initialAge);
        this.consumes = ['tree'];
    }
}

export class Carnivore extends Animal {
    constructor(genetics = null, initialAge = null) {
        super('carnivore', config.carnivores.energyGain, config.carnivores.procreatingChance, 'seekFood', carnivoreImage, config.carnivores.energy.initial, config.carnivores.energy.max, config.carnivores.clockAction, config.carnivores.maxAge, genetics, initialAge);
        this.consumes = ['herbivore', 'carnivore'];
    }
}

export class AnimalFactory {
    static getAnimal(kind, genetics = null, initialAge = null) {
        switch (kind) {
            case 'tree':
                return new Tree(genetics, initialAge);
            case 'herbivore':
                return new Herbivore(genetics, initialAge);
            case 'carnivore':
                return new Carnivore(genetics, initialAge);
        }
    }
}

// Population initialization
export const populate = (kind, range) => {
    const [min, max] = range;
    // Scale the starting population to the actual world size (constant density).
    const scale = config.world.areaScale || 1;
    const count = Math.max(1, Math.round(randomInt(min, max) * scale));

    // Initial ages must be spread BELOW this species' lifespan, or senescence
    // would kill the older half of the starting population on frame 1.
    const speciesCfg = kind === 'tree' ? config.trees : kind === 'herbivore' ? config.herbivores : config.carnivores;
    const maxInitialAge = Math.floor(speciesCfg.maxAge * 0.7);

    // Randomize initial ages AND genetics for starting population
    for (let i = 0; i < count; i++) {
        const randomAge = randomInt(0, maxInitialAge);

        // Random genetics (0.7 to 1.3 range for diversity)
        const randomGenetics = {
            speedMultiplier: 0.7 + Math.random() * 0.6,
            maxEnergyMultiplier: 0.7 + Math.random() * 0.6,
            sizeMultiplier: 0.7 + Math.random() * 0.6,
            visionRange: 0.7 + Math.random() * 0.6,
            aggression: 0.7 + Math.random() * 0.6,
            intelligence: 0.7 + Math.random() * 0.6
        };

        animals.push(AnimalFactory.getAnimal(kind, randomGenetics, randomAge));
    }
};
