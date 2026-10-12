# Why this little world stays alive

*A tour of the ecology behind the Life Simulator: what makes a predator–prey
world collapse, what holds it together, and where each idea lives in the code.*

All numbers below come from the headless checks (`make check`), which run the
exact engine you see in the browser.

---

## 0. What "stable" means here

Not a flat line. Real populations wobble. A stable ecosystem is one that:

1. **persists**: no species dies out, on any seed, over a long horizon;
2. **wobbles a little**: fluctuations are small compared with the average (we
   report the coefficient of variation, CV = std / mean);
3. **never gets close to zero**: the *minimum* population stays comfortably
   above the handful of individuals where bad luck alone can finish a species;
4. **recovers**: knock it over and it comes back.

The third point matters more than it looks, as §8 explains.

**Where it ended up** (20 seeds × 300,000 steps each, which is about 28 hours
of simulated time per run at 1×):

| | average | CV | lowest point in any run, opening included |
|---|---|---|---|
| grass | 23% | | |
| herbivores | ~940 | 0.06 | 637 |
| carnivores | ~98 | 0.12 | 52 |

That is with no population caps and no animals spawned from nowhere.

---

## 1. The model on one screen

- **Grass** is not made of agents. It is a grid of patches, each holding 0..1
  units of food that regrows by itself (`Grass.regrow` in `src/world.js`).
- **Herbivores** graze the patch they stand on. When it is grazed out they peek
  at three spots ahead and walk toward the greenest. If a predator comes within
  their `sense` range they run straight away from it.
- **Carnivores** wander until they spot a herbivore within *their* sense range,
  chase it, and either catch it or run out of stamina. After a kill they spend
  `handling` steps eating. Above `hunger` they stop hunting. When another
  carnivore is too close, both lose energy and an idle one moves away.
- **Everyone** pays a metabolic cost every step: a basal cost plus `moveCost·v²`
  for moving at speed `v`. Reaching `birthEnergy` (and being old enough) means
  splitting off a child with half of your energy. Running out of energy, or
  reaching your lifespan, means death.

- **People** live in tribes with a camp, a shared store and a culture. They
  hunt, gather, raise children, defend themselves and sometimes raid each
  other (§11).
- **The land** has lakes and cliffs that nobody can cross, and a climate that
  decides how much grass grows where: lush by the water, sparse on dry steppe,
  none on the snowy peaks (§12).

That is the whole model. Herds, grazing fronts, boom-and-bust and evolution are
not programmed in; they **emerge**. Click any animal in the app to watch one
life play out under these rules.

---

## 2. Rung one: energy must be conserved

Every bug that broke the old version of this project was, at heart, an energy
leak. Carnivores got 2× the energy of their prey. Babies were born with free
energy. A "dwarfism" bonus turned a metabolic cost into a gain. The parameter
search found every one of them and exploited it.

So the rule here is strict: **the only source of energy is the sun**, meaning
grass regrowth. Everything else just moves energy around or loses it:

- grazing turns grass into energy (`bite × grassEnergy`);
- a kill hands over only a *fraction* of the prey's energy (`efficiency`,
  Lindeman's "ten percent law" in spirit);
- a child's energy is taken from the parent (`childShare`);
- a full stomach wastes the surplus (`maxEnergy`);
- genes multiply costs and never subtract them (`World.upkeep`).

If you ever change the model, test this first: remove the grass and everything
must die.

---

## 3. Rung two: the base must regrow, and *how* it regrows matters

A food web without renewable primary production is a tank that only drains.
That was the original bug: trees could not reproduce.

But there are two ways to make food regrow, and they behave very differently:

| | equation | behaviour |
|---|---|---|
| **logistic** (prey that breeds) | `dG/dt = r·G·(1 − G/K)` | the prey's own growth amplifies booms; enriched systems oscillate |
| **supply-driven** (rain fills a pond) | `dG/dt = r·(1 − G)` | regrowth is fastest when grazed *down*; damps oscillations |

This simulator uses the second (`g += regrowth·(1 − g)`). Patches can never be
grazed to extinction, and the grass–herbivore pair settles instead of cycling.

It also makes a striking prediction from resource-competition theory (Tilman's
**R\***): the grazers push the grass down to the lowest level they can live on,
**whatever the regrowth rate**. Faster regrowth does not leave more grass
standing. It feeds more grazers. In the sweeps the grass sat at 21–23% for
every regrowth rate from 0.0006 to 0.0018, while herbivore numbers nearly
tripled (§7).

---

## 4. Rung three: Lotka–Volterra, and why its cycles kill

Couple a prey `H` to a predator `C`:

```
dH/dt = a·H − b·H·C          dC/dt = e·b·H·C − m·C
```

The famous result is endless cycles: prey boom, then predators boom, then prey
crash, then predators crash. The catch is that these cycles are *neutrally*
stable. Nothing pulls the system back to a cycle of a given size, so random
bumps make the swings drift bigger. In a world of whole animals, a trough
eventually hits **zero**, and zero is forever.

---

## 5. Rung four: Rosenzweig–MacArthur and the stable window

Give the prey a ceiling (food limitation) and give the predator a full belly
(it cannot eat infinitely fast: chase time, `handling`, `hunger`). That is the
Rosenzweig–MacArthur model, the workhorse of predator–prey theory. It has a
genuinely stable equilibrium, but only inside a **window**:

- predators too weak, and they cannot sustain themselves, so they die out;
- predators too strong, and they push prey below the "hump" of the prey's
  growth curve. Oscillations then grow until something hits zero. This is
  **the paradox of enrichment** (Rosenzweig 1971). Richer food or better
  hunters can *destroy* a system.

You can see that window directly in this model. With evolution off, sweeping
the predator's **efficiency ÷ basal cost** (how much a meal is worth relative to
the cost of living) gave, over 6 seeds × 80k steps:

| efficiency / cost | outcome |
|---|---|
| ≤ 5.7 | carnivores starve out on every seed |
| ≈ 6.25 | **stable**: CV ≈ 0.09, all seeds persist |
| 7–8 | persistent but swinging (CV 0.3–0.7) |
| ≥ 8.6 | boom, bust, extinction |

Two lessons here:

- **Lean predators are stable predators.** Small reserves (`maxEnergy: 120`)
  mean carnivores feel a prey shortage quickly and decline *before* they have
  eaten the last herbivore. Big reserves create a lag, and lags cause
  overshoot. With 200 reserve energy, carnivores kept multiplying for thousands
  of steps after the prey had already crashed.
- **One stable point is not enough.** A single good ratio is a knife-edge.
  Evolution, or you editing `config.js`, will knock it off.

---

## 6. Rung five: predator interference widens the window

Real predators get in each other's way. Wolves and lions defend territories.
Hunters steal kills and waste time in stand-offs. Beddington (1975) and DeAngelis
(1975) added this to the equations: the more predators there are, the less each
one eats. That gives a self-limiting term (−c·C²), which is strongly stabilising.

Here it is two lines of behaviour (`stepCarnivores`): a carnivore with a rival
within `crowdRadius` pays `crowdCost` energy, and if it is not chasing anything
it moves away. Nothing caps the population. Crowding just makes being one of
many expensive.

The same sweep with interference turned on:

| interference cost | stable range (CV ≤ 0.13, all seeds persist) |
|---|---|
| 0 | only ≈ 6.25 |
| 0.1 | ≈ 7–8 |
| **0.2** (default) | **≈ 8.3–11.7**, still persisting (with swings) at 16 |

The window roughly doubled. The defaults (efficiency 0.7, cost 0.06) sit at
its efficient end, and §10 shows ±25% on either knob still holds.

---

## 7. Rung six: more food, *more* stability (here)

The paradox of enrichment says richer worlds swing harder. This world does the
opposite. Over 12 seeds × 150k steps:

| grass regrowth | herbivores (mean, lowest) | carnivores (mean, lowest) | CV h / c |
|---|---|---|---|
| 0.0006 | 688, 403 | 64, 23 | 0.09 / 0.15 |
| 0.00075 | 811, 553 | 80, 33 | 0.07 / 0.13 |
| **0.0009** (default) | **945, 644** | **98, 52** | **0.07 / 0.12** |
| 0.0012 | 1227, 643 | 133, 73 | 0.05 / 0.10 |
| 0.0018 | 1870, 655 | 211, 71 | 0.04 / 0.08 |

Two reasons:

- **Interference makes predation ratio-dependent.** In classic Lotka–Volterra
  thinking, the predators set the prey level, so extra food only feeds more
  predators and the system swings. With interference, what matters is prey
  *per predator* (Arditi & Ginzburg). Extra food then lifts *every* level
  together, smoothly: grass stays at R\*, and both herbivores and carnivores
  scale up.
- **Bigger populations are less noisy** (next section).

The default sits at 0.0009 rather than higher only because more animals cost
more CPU. 0.0012 is even calmer if your machine can afford it.

---

## 8. Rung seven: small numbers die by bad luck

Even a perfectly stable equilibrium has noise: births and deaths are random
events. For a population of *N*, the expected time until noise alone hits zero
grows roughly **exponentially with N**. Ten carnivores is a coin toss over a
long run. Fifty is safe for practical purposes.

Two design choices follow from this:

- **The world always has the same area** (`params.world.area`); only its shape
  follows your screen. A phone and a 4K monitor hold the same number of
  animals, so the balance is the same everywhere. Phone-shaped (0.46) and
  ultrawide (2.4) worlds were checked too: 8/8 seeds each.
- **The engine is fast enough for big populations** (§14). Around 940
  herbivores and 100 carnivores keep the carnivore minimum at 50+ instead of
  single digits.

---

## 9. Rung eight: evolution, the arms race and honest costs

Each animal carries two genes, `speed` and `sense`. Children inherit them with a
small random change (`mutate`). Nothing tells evolution where to go; animals
that leave more children simply leave more of their genes.

Three things happened while building this, and each is a classic result.

**Free traits run away.** At first, speed was nearly free for herbivores: they
graze standing still, so a big engine cost them little. Prey evolved to 1.8×
speed and predators chased them to 2.1×, until carnivores were so expensive to
run that they almost went extinct. This is the **life-dinner principle**
(Dawkins & Krebs 1979). The rabbit runs for its life, the fox only for its
dinner, so selection on prey is stronger. It is also a **Red Queen** race
(Van Valen 1973): both sides run to stay in place.

**Useless traits collapse.** Herbivore `sense` once only detected predators, and
since chases were decided by speed alone, seeing farther bought nothing. Sense
shrank toward the minimum. A gene pinned at its limit is a red flag that the
model is wrong, not that evolution is clever. Now sense also lets herbivores
spot greener grass, and chases end by chance (`stamina`) rather than at a fixed
step, so detecting a predator early genuinely helps.

**Convex costs give an optimum.** Basal metabolism scales with
`(1 − wSpeed − wSense) + wSpeed·speed² + wSense·sense²` (`World.upkeep`).
Doubling a trait quadruples its upkeep, while its benefits flatten out. So
there is a best value, an **evolutionarily stable strategy** (Maynard Smith),
where the race stops. Starting from 1.0, the genes climbed for the first ~80k
steps and then held steady for the next 320k:

| | speed | sense |
|---|---|---|
| herbivores | ≈ 1.3 | ≈ 0.53 |
| carnivores | ≈ 1.55 | ≈ 0.75 |

Prey got faster but near-sighted, and predators got much faster. It is an honest
outcome of these costs.

There is also a quiet stabiliser here, the **eco-evolutionary feedback**. When
predators are scarce, a fast body is pure cost for a herbivore, so selection
eases off. When predators are common, speed pays. Evolution tracks the ecology
instead of running away from it.

### Starting where evolution ends up

Those first ~80k steps were the most dangerous part of every run. Predators
started with genes of 1.0, much slower than what they would evolve, so they
began out-matched. Their numbers sagged until evolution rescued them
("evolutionary rescue"). In a ±25% sensitivity sweep, 36 of 150 runs died in
that opening.

So each species now **starts with genes near its optimum**
(`params.*.genes`), grass near its R\* level, and populations near their
equilibrium. Evolution keeps running, and if you change a knob it will move the
genes to the new optimum. Result: 155 of 156 runs persisted in the same sweep.
At the defaults, the worst carnivore dip went from 10 to 23, and to 52 once the
richer grass was in. Set the genes back to 1 in `config.js` to watch evolution
from scratch.

---

## 10. How robust is it?

| test | result |
|---|---|
| 20 seeds × 300k steps | 20/20 persisted; carnivores never below 52, herbivores never below 637 |
| shock: kill 60% of herbivores at step 100k (8 seeds × 200k) | 8/8 recovered to the same averages as unshocked runs |
| phone-shaped and ultrawide worlds (8 seeds × 150k each) | 8/8 and 8/8 |
| every key knob at ×0.75 and ×1.25 (13 knobs × 2 × 6 seeds) | 155/156 runs persisted |

The one failure is instructive: carnivores 25% slower die out early on one seed
in six. A predator slower than its prey cannot make a living, and no amount of
interference fixes that.

---

## 11. People: tribes, culture and conflict

People are a third species, but they live differently: in **tribes**, each
with a camp, a flag, a shared food store and a **culture** (`src/humans.js`).

### The economy

- Adults **hunt** grazers with spears and **gather** plants. They gather from
  the same grass field as the grazers, but at 6 energy per unit against the
  grazers' 10, because people digest it worse. They carry food home to the
  camp store.
- **Births come out of the store** (90 food each; the newborn gets 60), the
  same energy rule as the animals. Children stay at camp until grown.
- **Effort follows need.** Once the store holds 30 food per member, people
  rest.

The first version slowly dwindled. Births ran just below deaths, people foraged
70% of the time, and stores sat at 11–15 per member. That is a society with
no surplus. Real hunter-gatherers have one (they famously work fewer hours than
farmers). A better gathering yield, a lower metabolism and cheaper births gave
them that surplus.

### Culture

Each tribe has two numbers:

| | what it changes |
|---|---|
| **aggression** | stand and fight a predator instead of fleeing; meeting a stranger, attack and rob ("hawk") rather than walk away ("dove"); when hungry, raid a neighbour's camp |
| **sociality** | share more of each kill with the camp; forage as a party (spear throws hit more often with tribe-mates near, and a party fends off predators better) |

A tribe that reaches 30 people splits. The daughter founds a camp nearby under
a new flag and inherits the culture with a small random change. Tribes that
starve, are eaten or are killed off take their culture with them. That is
**cultural group selection** (Boyd & Richerson): culture evolves by tribes
founding and failing, not by individuals.

### What happened when strategies met

**At first, culture didn't matter.** Across 195 tribes, aggression and sociality
correlated with success at only ~0.07, which is pure drift. The effects were too
weak to matter: tribes rarely met, and sharing barely changed who ate.

**Then raiding made aggression suicidal.** Raids were bad economics: a round
trip to a neighbour took ~2,400 steps for at most 60 food, against ~0.15
food/step from foraging. They were also launched blindly at camps with nothing
in them. Optimal-foraging theory (Charnov) says an activity is worth it only if
it beats the alternative per unit of time. So now raiders only go for a nearby
camp holding a full haul (150).

**After that, real trade-offs** (132 tribes, 12 worlds × 150k steps):

| culture | tribes | mean life | daughter tribes each | still alive |
|---|---|---|---|---|
| aggressive + social | 31 | 65k steps | 0.77 | 17 |
| aggressive + loner | 32 | 68k | 0.59 | 15 |
| peaceful + social | 22 | 76k | **0.82** | 11 |
| peaceful + loner | 47 | 70k | 0.49 | 17 |

- **Sociality pays.** Sharing feeds the children, and a party hunts better and
  scares predators off. That's the "many eyes" and selfish-herd idea
  (Pulliam; Hamilton).
- **Aggression is double-edged.** Raids win food but cost raiders, so it nets
  out about even. This is **Hawk–Dove** (Maynard Smith & Price): when fighting
  is costly, hawks never take over, and mixed worlds persist.
- Every culture survives *somewhere*, so no single strategy wins. I had hoped
  for rock-paper-scissors cycles (raiders beat loners, cooperators beat
  raiders, loners outgrow cooperators). The data shows balance, not cycles yet.

### People inside the ecosystem

- People are **omnivores competing with everyone**: with grazers for grass, and
  with carnivores for grazers. Carnivores dropped from ~98 to ~80 on average,
  and their lowest point from 52 to ~45. That is exploitative competition,
  exactly as theory predicts. They also kill carnivores in self-defence.
- **Hunters shape their prey's evolution.** Spears reach 14 units and grazers
  noticed danger at ~11, so careful hunters threw first. Grazer `sense` evolved
  up from 0.53 to ~0.60: people selected for warier prey. Nothing in the code
  asks for that.
- Over 20 worlds × 300k steps: **20/20 ecosystems persisted and people survived
  in 20/20**. Carnivores never fell below 40 and herbivores never below 627.
  Each world averaged 34–106 people in 2–8 living tribes, out of 8–31 tribes
  founded over its history. The closest call was one world down to 4 people
  before it recovered: people are viable, not invulnerable.

---

## 12. Terrain: mountains, lakes and valleys

The world has a landscape (`src/terrain.js`). Its heights are periodic noise, so
the land joins up seamlessly where the world wraps: broad basins and uplands,
mountain ranges rising on the uplands, and the lowest 12% flooded. Three rules
tie it to the ecology:

- **Water and cliffs block everyone.** A step that would end in a lake, or on a
  slope steeper than `cliff`, turns 45°, 90° or 135° aside instead. It turns
  to the side the creature was already veering to, so it follows a shore
  rather than dithering against it.
- **Grass fills toward the ground's fertility** `f`: `g += r·(f − g)`. `f` is 1
  in the lowlands, thins out up the slopes, and is 0 on rock and water (with
  biomes, below, the climate sets it instead). It is
  still supply-driven, a smaller pond under the same rain. In Tilman's terms it
  is a chemostat whose supply point changes from place to place, so bare
  peaks stay bare instead of filling up untouched.
- **Camps go on flat, fertile ground near water.**

**A landscape is mostly a smaller world.** With only those rules (12 seeds ×
100k), herbivores fell from ~900 to 520–735 and carnivores from ~80 to 42–68,
and the worst carnivore dip went from 41 to 14. Nothing was trapped; the world
simply grew less food. The food grown per step fell to 63–75% of the flat
world's, and one line predicts the loss to within 0.02 on every seed: the
land's supply above the grazed level, Σ(f − R\*) over the patches where f > R\*,
against the flat world's N·(1 − R\*), with R\* = 0.25 (§3). The seed with the
worst dip had the poorest land (54%). That is §8 again: fewer animals, nearer
to zero.

**So the sunshine is held fixed.** With `terrain.compensate` (on by default),
regrowth on the land that is left is raised by exactly that ratio (×1.3 to
×1.85, depending on the seed), so every world grows as much food as a flat one.
The landscape decides only *where* it grows. That makes up for lost area without
adding a rule.

**Space on its own does no harm, and may help a little.** Without people
(12 seeds × 150k), herds gather in the fertile lowlands (70–85% of them) and
the predators follow. Even so, carnivores averaged 103 against 97 on the flat
world, never fell below 56 (flat: 52), and swung a little less (CV 0.11
against 0.12). Herbivores were unchanged. That hints at Huffaker's mites, but
only faintly: water and cliffs block hunter and hunted alike, so there is no
true refuge.

**People gain the most.** Camps sit on the best ground, which is exactly where
the herds gather. Hunters took about 17% more grazers than on the flat world,
carnivores ate a few percent fewer, and people killed more carnivores. This is
the exploitative competition of §11, sharpened because people and grazers now
share a habitat.

**People need to know the way home.** At first, a few people per run got stuck
for good on a shore, carrying food toward a camp straight across the water.
Robotics calls "walk at the goal, turn aside when blocked" a *bug algorithm*
(Lumelsky & Stepanov), and it fails in dead ends: in a bay that faces home,
every turn slides you back in. So each camp, when it is founded, measures how
far it is by land from every 10-unit cell (Dijkstra over open ground, in under
a millisecond). People walk straight home when that gets them closer by land, and
otherwise step to the neighbouring cell nearest home. Walkers dropped anywhere
on the land now always reach camp, and the stuck people are gone.

The whole picture, 20 worlds × 150k steps each:

| | flat | terrain |
|---|---|---|
| ecosystems persisted, people survived | 20/20, 20/20 | 20/20, 20/20 |
| herbivores: mean, lowest | 900, 627 | 893, 579 |
| carnivores: mean, lowest, CV | 82, 41, 0.13 | 77, 37, 0.14 |
| people: mean, lowest | 66, 16 | 82, 20 |

The lowest herbivore point came from a world where people peaked at 168.
Phone-shaped and ultrawide worlds (8 × 100k each) also persisted 8/8 and 8/8,
people included. The terrain costs about 3–9% in speed: one array lookup for
each step that moves, plus a slightly richer grass update.

### Biomes: a climate on the land

The land also has a climate (`Terrain.makeBiomes`). Two smooth fields lie over
it. **Moisture** is high beside water and fades with distance from it, plus
broad "weather" noise that makes whole regions wetter or drier. **Temperature**
falls with altitude (a lapse rate), plus broad noise. Read together, like
Whittaker's chart of biomes by temperature and rainfall, they class every
patch:

| biome | where | grass it can hold (`f`) | share of a world |
|---|---|---|---|
| wetland | warm and wet, beside water | 1.0 | 4–13% |
| meadow | the warm, moist rest | 0.9 | 30–57% |
| forest | cooler, moist mid-slopes | 0.6 | 7–20% |
| steppe | dry, far from water | 0.4 | 5–21% |
| tundra | cold, high | 0.3 | 1–9% |
| rock, snow | the summits | 0 | 1–9% |

Nothing else changes. Each patch still fills toward its `f`, and
`terrain.compensate` still makes every world grow a flat world's food (now by
×1.6 to ×2.4 on the land, since forest and steppe grow less). The biomes draw on
a random stream of their own, so a seed gives the same land and the same first
animals with biomes on or off; only the climate on top differs.

**The food moves; the totals do not.** Herds follow the food: 63–86% of the
grazers live on meadow and wetland, which cover 37–65% of the world. With the
supply held fixed, the averages stay put. Over 40 fresh worlds (seeds 21–60,
150k steps each):

| | no biomes | biomes | biomes + forest cover |
|---|---|---|---|
| herbivores: mean, CV | 885, 0.068 | 889, 0.076 | 933, 0.075 |
| carnivores: mean, CV | 77, 0.145 | 78, 0.146 | 81, 0.145 |
| carnivores' lowest point: typical run, worst run | 44, 25 | 45, 35 | 47, 33 |
| people: mean, worst lowest point | 86, 22 | 85, 24 | 84, 27 |

On the standard check (20 × 150k) every world persisted and people survived in
all 20; herbivores never fell below 586, carnivores 30, people 29. Phone-shaped
and ultrawide worlds (8 × 100k each) persisted 8/8 and 8/8, people included.

Without people (12 seeds × 150k), biomes even help a little: carnivores never
fell below 64 (56 without), with the same swings. With people, the herds swing
a little more (CV 0.068 → 0.076), and I have not pinned down why. The obvious
suspect is §11's competition again: camps go on fertile ground near water,
which is now exactly where the herds are. On the first 12 seeds people did hunt
16% more grazers and the carnivores dipped lower. But over the 40 fresh worlds
the share of grazers within a camp's range (63%) and the hunting rate did not
change at all. Those 12 seeds were luck of the draw, a reminder that a dozen
runs cannot tell a 5% effect from noise.

**Forest as cover** (`biomes.cover`, off by default). A hunter, carnivore or
person, sees a grazer standing in forest only from half its usual range. That is
a habitat refuge, the thing Gause's test tubes needed. Here it lifts both
levels: grazers +5%, carnivores +3%, and the carnivores' typical lowest point
rises by about 3 (over 76 runs, every shape of world). It barely calms the
swings; the CVs hardly move. The refuge is small and leaky. Forest is about a
sixth of the land and grows less grass, so only about 16% of the grazers are in
it (18% with cover), and anyone seen close up, or flushed into the open, is
caught as before. The grazers it saves keep breeding, so the predators end up
eating *more*: the ratio-dependent lift of §7 again. It stays off by default because
it is a new rule and it costs about 9% in speed (two neighbour searches per
hunt, and the extra grazers it keeps alive). Biomes alone cost nothing per
step; all their work is done once, when the world is made.

---

## 13. What was removed, and why

| removed | why |
|---|---|
| carrying-capacity caps (`K`) on every species | they *forced* populations flat; stability was not emergent |
| "rescue" immigration | it spawned animals from nothing whenever a species got rare: life support, not stability |
| trees as agents | 600 objects that did almost nothing; a grass grid is cheaper and looks like a field |
| day/night activity multipliers | periodic forcing pushes a predator–prey system into resonance |
| sleep, territories, memory, families, dominance, 8 named mutations | overlapping behaviours that were hard to reason about; several were dead code or exploit vectors |
| sprites, names, energy bars, target arrows, emoji badges | visual noise; dots and triangles read better at 1000 animals |

Individuality came back in a quieter form: every animal has an id, a parent, a
generation, children, kills and a current state. You see them when you follow
it, not stamped on all 1000 at once.

---

## 14. Why it is fast

- **Struct of arrays.** Each species is a handful of `Float64Array`s
  (`x[]`, `y[]`, `energy[]`, …), not thousands of objects. That is
  cache-friendly and creates no garbage.
- **A counting-sort spatial hash.** Every step, each species is bucketed into a
  grid in two linear passes with no allocation. A "nearest predator" query
  visits only the buckets its circle actually touches, and it wraps around the
  edges like the world does. It is checked against brute force: 60,000
  queries, zero mismatches.
- **Grass is a field, not agents.** 16,000 numbers updated in one tight loop.
- **Cheap per-animal work.** Genes are fixed for life, so their upkeep is
  computed at birth. A grazer's three look-ahead directions come from rotating
  one `(cos, sin)` pair instead of six trig calls. The dead are removed by
  swapping the last animal into their slot, not by shifting everyone.
- **Batched drawing.** All herbivores are one path and one `fill()`, and the same
  goes for carnivores. The grass is one small image stretched over the world.

Result: **about 8,500–9,000 simulation steps per second per CPU core with ~1,000 animals**.
Herbivore logic is about 76% of that. The browser at 64× needs ~3,800 steps/s.
The old engine managed ~1,000 steps/s with ~800 entities.

---

## 15. Experiments to try

Each of these is one command. The check runs in a container and prints
persistence, CV, minima and evolved genes.

```sh
make check                                              # the defaults
make check ARGS="--set carnivore.crowdCost=0"           # no interference: back to the knife-edge
make check ARGS="--set carnivore.efficiency=1.0"        # much better hunters
make check ARGS="--set carnivore.maxEnergy=200 --set carnivore.birthEnergy=160"  # fat predators lag and overshoot
make check ARGS="--set evolution.wSpeed=0.3"            # cheaper speed → the arms race returns
make check ARGS="--set carnivore.genes.speed=1 --set herbivore.genes.speed=1"    # evolve from scratch
make check ARGS="--set grass.regrowth=0.0018"           # enrichment: more of everything, calmer
make check ARGS="--shock 0.6@50000"                     # kill 60% of herbivores mid-run: does it recover?
make check ARGS="--aspect 0.46 --spark"                 # a phone-shaped world, with sparklines
make check ARGS="--set human.enabled=false"           # the ecosystem without people
make check ARGS="--set human.raidRate=0.01"           # a world of raiders
make check ARGS="--set human.tribes=8"                # more tribes from the start
make check ARGS="--set terrain.enabled=false"         # a flat world, as before the terrain
make check ARGS="--set terrain.compensate=false"      # the land as it is: a smaller world
make check ARGS="--set terrain.water=0.3"             # a lake district
make check ARGS="--set biomes.enabled=false"          # terrain without a climate: grass thins with altitude alone
make check ARGS="--set biomes.cover=true"             # forests hide grazers from hunters
make check ARGS="--set biomes.fertility.steppe=0.25"  # harsher steppe
```

---

## 16. Reading list (the clever jumps, in order)

- **Verhulst (1838).** Logistic growth and the carrying capacity.
- **Lotka (1925), Volterra (1926).** Predator–prey cycles, and why they are fragile.
- **Gause (1934).** Predator–prey in test tubes: extinction, unless the prey has a refuge.
- **Lindeman (1942).** Energy flow through trophic levels.
- **Huffaker (1958).** Mites on oranges: space and dispersal keep predator and prey alive.
- **Holling (1959).** Functional responses: why a full predator stabilises or destabilises.
- **Rosenzweig & MacArthur (1963).** The standard model and its stable window.
- **Rosenzweig (1971).** The paradox of enrichment.
- **Van Valen (1973).** The Red Queen.
- **Beddington (1975), DeAngelis et al. (1975).** Predator interference.
- **Whittaker (1975).** *Communities and Ecosystems*: biomes laid out on a chart of temperature and rainfall.
- **Dawkins & Krebs (1979).** Arms races and the life-dinner principle.
- **Tilman (1982).** Resource competition and R\*: who sets the grass level.
- **Maynard Smith (1982).** *Evolution and the Theory of Games*: ESS.
- **Sih (1987).** Prey refuges and predator–prey stability: when hiding helps the prey, and when it steadies the whole system.
- **Arditi & Ginzburg (1989).** Ratio-dependent predation, and why enrichment can lift every level.
- **Hamilton (1971).** The selfish herd: why being in a group protects you.
- **Maynard Smith & Price (1973).** Hawk–Dove: why costly fights keep aggression in check.
- **Pulliam (1973).** Many eyes: groups spot predators sooner.
- **Charnov (1976).** Optimal foraging: an activity is worth it only if it beats the alternative per unit of time.
- **Boyd & Richerson (1985).** *Culture and the Evolutionary Process*: cultural group selection.
- **Sinervo & Lively (1996).** Rock–paper–scissors strategies in side-blotched lizards.
- **Wilensky (1997).** NetLogo *Wolf Sheep Predation*, the agent-based cousin of this project.
- **Lumelsky & Stepanov (1987).** "Bug" algorithms: reaching a goal around obstacles you can only feel, and the dead ends where that fails.
