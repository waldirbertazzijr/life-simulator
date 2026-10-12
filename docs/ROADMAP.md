# Roadmap

Where this project is going, in stages. Each stage is playable on its own.

**Rule for every stage:** anything that changes the *model* (new species, terrain,
seasons, disasters) invalidates the verified balance. So it is re-checked
headlessly (`make check`, sweeps, shock tests) before it counts as done. The
browser only ever *draws* the engine; it never forks it.

**Tech:** plain JavaScript (moving to TypeScript when the codebase grows), three.js
for 3D from stage 2, everything built and served from containers. If the
simulation ever becomes the bottleneck, only `src/world.js` moves to Rust and
WebAssembly.

---

## Stage 0: a stable ecosystem ✅

Grass, herbivores, carnivores and two evolving genes. Stable without caps (see
`docs/THEORY.md`). You can follow any animal, with map, follow and first-person
(heading-up) cameras.

## Stage 1: human tribes (2D, headless-verified) ✅ first version

Humans join the ecosystem as a third species living in **tribes**.

- **Founding.** A tribe has a camp, a generated **flag** and name, and a shared
  food store.
- **Hunter-gatherers.** Adults hunt herbivores (spear throws, better together)
  and gather plants, carry food home and deposit it in the store. Hungry members
  eat from the store at camp. Effort follows need: when the store is full,
  people rest.
- **Families.** A birth happens at camp when the store has surplus (energy is
  conserved, like the animals). Children stay at camp until grown.
- **Danger.** Carnivores hunt humans. A lone human is easy prey; a group drives
  the predator off.
- **Strategy is culture.** Each tribe has `aggression` and `sociality`:
  - aggression: stand and fight predators instead of fleeing; meeting a
    foreigner, fight and steal ("hawk") rather than walk away ("dove");
  - sociality: share more of each kill with the camp, hunt better together,
    stay close to tribe mates.
- **Tribes split.** A tribe that grows too large splits. The daughter founds a
  new camp nearby with a new flag, and inherits the strategy with a small
  mutation. Tribes that fail die out, so strategies evolve between groups.
- **Done when:** herbivores and carnivores still persist on every seed. Humans
  persist on most seeds. We can see which strategies spread, and why.

**Where it stands:** 20/20 worlds persisted with people over 300k steps, and
people survived in all 20. Sociality pays; aggression is roughly break-even
(Hawk–Dove). See `docs/THEORY.md` §11. Open ideas for a second pass:

- the closest call was 4 people left, so camps could **move** when local food
  runs out (nomadism), and lone survivors could join another tribe;
- aim for rock-paper-scissors **cycles** between raiders, cooperators and
  loners, rather than just balance;
- alliances and trade between peaceful neighbours.

## Stage 2: 3D world (three.js)

- Terrain with mountains (blocking movement and sight), lakes and rivers.
  Fertility follows the land: lush valleys, bare peaks.
- Low-poly, flat-shaded animals and people (sober palette), drawn as instanced
  meshes so thousands cost little. Camps with flags in the wind.
- Day/night lighting and fog.
- Cameras: god view (orbit over the map), follow, and a true eye-level first
  person.
- The simulation moves to a Web Worker, and drawing interpolates between steps.
- Re-verify: terrain changes the ecology (mountains create refuges and isolated
  populations).

## Stage 3: you are the leader

- Play your tribe's leader in first person: walk, sprint (stamina), throw a
  spear, carry meat home, rally people.
- God view at any time: see the whole map and take control of any person.
- Permadeath, continued through your lineage: when you die, you continue as your
  child.
- Simple orders for your tribe (hunt here, gather, defend camp, move camp).

## Stage 4: alive

- Herds that move as flocks, carnivore packs, procedural animation (grazing
  heads, walking legs), swaying grass that gets eaten, carcasses and scavengers.
- Sound: wind, birds, howls at night.
- Seasons: lean winters, migration, food storage that matters.
- **Disasters** (god-mode buttons, each re-checked as a shock):
  - wildfire spreading across the grass, followed by rich regrowth (the
    forest-fire model);
  - drought, sending starvation up the food chain;
  - an epidemic (SIR model) that hits crowded herds and camps hardest;
  - flood on low ground;
  - meteor.

## Later

- Speciation: populations separated by mountains evolve apart.
- A "nature documentary" camera that cuts to chases, births and wars, with captions.
- Family trees and tribe histories.
- Trade, alliances and war between tribes; huts, fire and tools.
- God tools: sculpt terrain, plant forests, introduce an invasive species.
