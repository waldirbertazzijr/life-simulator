![Life Simulator](./screenshot.png?raw=true)

# Life Simulator

A small world on a canvas: grass regrows, herbivores graze and flee,
carnivores stalk and chase, people live in tribes, and everyone evolves.
Nothing is capped or scripted. The populations hold steady because of how the
ecology works, and [docs/THEORY.md](docs/THEORY.md) explains why, one idea at
a time. Where it's heading: [docs/ROADMAP.md](docs/ROADMAP.md).

**Play it: <https://waldirbertazzijr.github.io/life-simulator/>**

- **Grass** (green field): food that regrows on its own, fastest where it was grazed down.
- **Herbivores** (light dots): graze, look for greener patches, run from predators and hunters.
- **Carnivores** (red triangles): stalk, chase until out of stamina, crowd each other out.
- **People** (diamonds in their tribe's colour): hunter-gatherers living in **tribes**.
  Each tribe has a camp with a generated flag, a shared food store and a culture,
  **aggression** and **sociality**:
  - adults hunt with spears, gather plants and carry food home;
  - births come out of the store, and children stay at camp until grown;
  - aggressive tribes stand up to predators, rob strangers and raid rich neighbours;
  - social tribes share, forage in parties and defend each other;
  - a tribe that grows too large splits, and the daughter carries a slightly changed
    culture under a new flag.

  Watch which cultures spread.
- **Evolution**: `speed` and `sense` are inherited with small mutations. Both cost
  energy (more of a trait costs disproportionately more), so each settles at an optimum
  instead of running away.

**Follow anyone.** Click any animal or person, or click a tribe in the panel to
follow its eldest. The panel tells their story: what they are doing (grazing, fleeing,
hunting, raiding…), energy, age, genes against the population average, children and
kills, and for a person, their tribe and what they carry. When they die you learn how,
and you can carry on with one of their descendants. Pick a camera:

- **map**: a god view over the land (it keeps whoever you follow centred until you pan);
- **follow**: behind and above them, turning as they turn;
- **first person**: through their eyes, looking where they are heading.

You see their sense range and a line to whatever they are reacting to: the predator
they flee, the prey they chase, the stranger they fight.

The world is drawn in 3D with three.js. `?2d` in the URL gives the flat canvas view
(also used if the browser has no WebGL).

## Run it

Everything runs in containers (Docker via colima); nothing is installed on the host.

```sh
make serve          # → http://localhost:8000
make check          # stability check: 8 seeds × 100k steps, in parallel
make shot           # headless-browser screenshots into .shots/
make fingerprint    # hash of the simulation's behaviour (unchanged by a pure refactor)
```

`?seed=42` in the URL replays a specific world. In the browser console, `sim.world`
is the live world and `sim.follow(id)` follows anyone.

| key | |
|---|---|
| space | pause / play |
| 1 2 3 4 | speed 1× 4× 16× 64× |
| click | follow someone |
| F | follow someone at random |
| V | switch camera: map → follow → first person |
| Esc | stop following |
| R | new world |
| H | hide the panel |

| mouse / touch (3D) | map | follow | first person |
|---|---|---|---|
| drag (one finger) | pan | swing around them | look around (drifts back) |
| right-drag, ctrl- or shift-drag | turn and tilt | swing around them | look around |
| wheel (pinch) | zoom | closer / farther | |
| two-finger twist | turn | swing around them | |

## How stable?

Without people, 20 seeds × 300,000 steps (about 28 simulated hours each at 1×): all
20 persisted. Herbivores averaged ~940 and never dropped below 637. Carnivores averaged
~98 and never dropped below 52. The world also recovers from losing 60% of its
herbivores at once, and holds with every key parameter nudged ±25%.

With people, 20 seeds × 300,000 steps: all 20 ecosystems persisted and people survived
in all 20. Each world founded 8–31 tribes over its history, with 2–8 alive at a time.
Carnivores never fell below 40, as people compete with them for prey.

Details and the theory behind each mechanism are in [docs/THEORY.md](docs/THEORY.md).

## Code

| file | |
|---|---|
| `src/config.js` | every tunable number, with units |
| `src/world.js` | the engine: species behaviour and `step()` |
| `src/humans.js` | people and tribes: foraging, camps, births, raids, splits |
| `src/population.js`, `src/spatial.js`, `src/grass.js` | typed-array populations, the spatial hash, the grass field |
| `src/identity.js` | generated tribe names and flags |
| `src/view3d/` | the 3D view (three.js): ground, creatures, camps, cameras and controls (reads the world, never changes it) |
| `src/render.js` | the flat canvas view, `?2d` (reads the world, never changes it) |
| `src/flag.js` | paints a tribe's flag (shared by both views and the panel) |
| `src/ui.js` | the panel: controls, followed individual, sparklines, genes, tribes |
| `src/main.js` | frame loop (fixed timestep, speed, pause), choosing the view, clicking and following |
| `headless/check.mjs` | runs the same engine headlessly over many seeds and reports stability |

The browser and the checks share the engine, so what is verified headlessly is
exactly what you see.
