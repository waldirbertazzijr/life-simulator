# Why the ecosystem kept collapsing — and the theory that fixes it

*A readable tour of the population-ecology behind the Life Simulator, the one
structural bug that doomed every run, and how a headless parameter search found
a stable balance.*

---

## 1. The symptom

You could watch it happen every time: a lively world of trees, herbivores and
carnivores that, after a few minutes, quietly emptied out. Herbivores thinned,
carnivores starved, and eventually the whole thing flatlined. No parameter you
nudged in the UI seemed to hold it together for long.

It turns out there were **two** separate problems — one structural (a bug in the
rules of the world) and one about *balance* (the numbers). Ecology has crisp,
well-studied theory for both, and it maps almost one-to-one onto this code.

---

## 2. The structural bug: nothing made new trees

Here is the original tree configuration:

```js
trees: {
    procreatingChance: 0,   // trees NEVER reproduce
    maxAge: 10000,          // ...but they DO die of old age
}
```

Trees were seeded once at startup and then only ever *removed* — eaten by
herbivores, or dying of old age at 10,000 frames. Nothing ever created a new
tree. So the forest was a **non-renewable resource**: a tank that only drains.

This is the single most important idea in the whole project, so it's worth
stating plainly:

> **Every stable food web needs primary production.** Something has to turn
> "free" energy (sunlight, in the real world) into new biomass at the bottom of
> the chain, continuously. If the base doesn't regrow, no amount of tuning the
> layers above it can help — you're just choosing the order in which things
> starve.

In the classic equations (next section), this is the difference between a prey
term that can *grow* (`+r·x`) and one that can only be consumed. The original
sim had no growth term for trees at all. **That alone guarantees extinction**,
100% of the time, regardless of every other setting.

The fix has two parts, both drawn straight from theory:

1. **Renewal** — trees can now reproduce (`procreatingChance > 0`): a mature tree
   occasionally drops a sapling nearby. That's the `+r·x` growth term.
2. **A carrying capacity `K`** — a cap on how many trees the world supports, so
   the forest grows toward `K` and holds there instead of exploding. That's the
   logistic `(1 − x/K)` brake.

---

## 3. The theory, one clever jump at a time

The beauty of this subject is that it was built up as a sequence of "aha"
corrections, each one fixing an unrealistic assumption in the previous model.
Here's that ladder.

### Jump 0 — Exponential growth (Malthus, 1798)

Start with the dumbest possible model of one population: everything reproduces at
a constant per-capita rate.

```
dx/dt = r·x
```

Solution: `x` explodes exponentially forever. Obviously wrong — nothing grows
without limit — but it's the seed everything else grafts onto.

### Jump 1 — Carrying capacity (Verhulst, 1838): the *logistic* model

The clever fix: make the growth rate *shrink as the population fills up the
environment*. Introduce `K`, the carrying capacity.

```
dx/dt = r·x·(1 − x/K)
```

Now the population S-curves up to `K` and stops. This is exactly what we gave the
trees. In an agent sim you don't even need the smooth equation — a hard "don't
reproduce past `K`" gate produces the same self-limiting behaviour, which is what
`carryingCapacity` does in `procriate()`.

### Jump 2 — Predator and prey together (Lotka & Volterra, 1925–1926)

Now couple two species. Prey `x` grow; predators `y` eat them and would starve
without them.

```
dx/dt =  α·x − β·x·y        (prey: grow, get eaten)
dy/dt =  δ·x·y − γ·y        (predators: eat & breed, else die)
```

This is *your herbivore ↔ carnivore loop*, almost literally. `β·x·y` — encounters
between the two species — is the herbivore's death and the carnivore's meal.

The famous result: **perpetual cycles**. Prey boom → predators boom → prey bust →
predators bust → repeat. Predator peaks *lag* prey peaks. It's a genuinely
beautiful model and it predicted real lynx/hare data.

**The catch — the clever, sobering jump:** those cycles are *neutrally stable*.
The orbit the system rides on is fixed entirely by where it started, and there's
no force pulling it back if it's bumped. In a smooth equation that's just
aesthetically fragile. In a **finite, random, agent-based world like this one**
it's fatal: random drift eventually pushes a cycle's trough down to *zero
individuals*, and zero is forever. Pure Lotka–Volterra, simulated with discrete
animals, always eventually dies. This is a big reason your carnivores kept
winking out.

### Jump 3 — Give the prey a carrying capacity too (Rosenzweig–MacArthur, 1963)

Combine Jump 1 and Jump 2: logistic prey *plus* predators, and make predators
*saturate* (a single predator can only eat so fast — it gets full). That last
piece is a **functional response** (Holling, 1959): predation per predator rises
with prey density but levels off.

```
dx/dt = r·x·(1 − x/K) − (a·x)/(1 + a·h·x)·y
dy/dt = e·(a·x)/(1 + a·h·x)·y − γ·y
```

This model is realistic enough to be the workhorse of the field, and it produces
a genuinely *stable* equilibrium (or a stable, self-correcting limit cycle) — the
thing we actually want. Your simulator already has the ingredients:

- **Logistic prey** — trees with `procreatingChance` + `carryingCapacity`.
- **A saturating functional response** — a carnivore has finite `maxEnergy` and
  can only chase one target at a time within a finite vision cone. It literally
  cannot eat unboundedly fast. That saturation is *stabilizing*.

### Jump 4 — The paradox of enrichment (Rosenzweig, 1971)

This is the most counter-intuitive result, and the most useful one for tuning:

> **Making the world *richer* (raising the prey's carrying capacity `K`) can
> *destabilize* it.** More food → bigger prey booms → bigger predator booms →
> deeper busts → extinction.

So "the herbivores keep dying, let me just add way more trees" can backfire: a
huge `K` gives fatter oscillations that slam into zero. There is a *sweet spot*
for `K`, not a "more is better." This is precisely why a blind search over the
knobs beats hand-tuning — the optimum is an interior point, not a corner.

### Jump 5 — Space is a stabilizer (Huffaker, 1958; and spatial ecology)

Huffaker's famous mite experiment showed predator and prey go extinct fast in a
simple arena, but persist for many cycles once you add spatial structure and
refuges. Movement, patchiness, and places prey can hide *decorrelate* the
population — one local bust doesn't sync the whole world into collapse.

Your sim is spatial by construction: a toroidal world, local perception (vision
cones + finite search radius), herding, and territories. That spatial structure
is doing real stabilizing work for you *for free* — it's why the fixed sim can
hold a balance that the mean-field Lotka–Volterra equations say should be
fragile.

---

## 4. The reference model to steal from: *Wolf–Sheep Predation*

If you read one thing, make it the **NetLogo "Wolf Sheep Predation" model**
(Wilensky, 1997, in the NetLogo Models Library). It is almost exactly this
simulator — grass, sheep, wolves — and it's the canonical teaching example of a
*stable* three-tier agent ecosystem.

The one mechanic that makes it stable is the one this project was missing:
**grass regrows on a timer.** When you tick the "grass regrowth" switch off, the
NetLogo model collapses in the same way yours did; turn it on and it can cycle
happily forever. Everything we did here is a variation on that insight.

Its other lessons that we mirror:

- Eating converts food into an **energy** stockpile; movement/living **costs**
  energy; run out and you die. (You already had this.)
- Reproduction is **probabilistic per tick** and costs energy. (You already had
  this too.)
- Balance is found by **sweeping the reproduction/energy parameters**, not by
  deriving them. (That's the search below.)

---

## 5. From theory to this codebase — the knobs that matter

| Theory quantity | Where it lives now | What it controls |
|---|---|---|
| Prey growth rate `r` | `trees.procreatingChance` | how fast the forest regrows |
| Prey carrying capacity `K` | `trees.carryingCapacity` | max forest size (paradox of enrichment!) |
| Prey→predator conversion `e` | carnivore energy gained per kill (`consume`) | how much a meal is worth |
| Predator death `γ` | `carnivores.energyGain` (drain), `maxAge` | how fast carnivores burn out |
| Herbivore birth/death | `herbivores.procreatingChance`, `energyGain`, `maxAge` | the middle tier's turnover |
| Functional response saturation | `maxEnergy`, vision cone, one-target hunting | already stabilizing, mostly leave alone |
| Spatial refuge | toroidal world + local vision | already stabilizing, free |

---

## 6. How the search works (the algorithm)

We can't *derive* the stable numbers, but we can *search* for them, because the
simulator itself is the fitness function. The harness:

1. **Runs the real simulation headless** — no canvas, no DOM — so whatever it
   finds transfers 1:1 to the on-screen sim. (Same `Engine.step()` powers both.)
2. **Seeds the RNG** so each run is reproducible, and scores every candidate on
   several seeds so we reward *robust* stability, not luck.
3. **Scores "health"** with a function that values, in order: (a) all three
   species surviving the full horizon, then (b) *low variability* (small
   oscillations — the anti-paradox-of-enrichment term), then (c) a healthy
   *minimum* population (a resilience buffer so a random dip doesn't hit zero).
   Collapsed runs score proportional to how long they lasted, giving the search a
   smooth gradient to climb even out of the "everything dies" region.
4. **Explores then refines.** Phase 1 samples the whole space at random (rates on
   a log scale, since they span orders of magnitude). Phase 2 takes the best few
   ("elites") and perturbs them with shrinking Gaussian steps — a simple
   evolutionary hill-climb. The winner is re-validated on more seeds and a longer
   horizon.

Runs fan out across a worker pool (one simulation per core), and any run is
abandoned the instant a species hits zero — nothing returns from extinction in
this model, so the outcome is already decided. Bad candidates (the majority of
random samples) die in a second, which is what makes searching thousands of them
affordable.

---

## 7. Results

<!-- FILLED IN AFTER THE SEARCH RUNS -->
_(see below — populated from the winning `headless/best-config.json`)_

---

## 8. Reading list (the clever jumps, in order)

- **Verhulst (1838)** — logistic growth; the origin of carrying capacity `K`.
- **Lotka (1925) / Volterra (1926)** — the predator–prey equations; neutral
  cycles and why they're fragile.
- **Holling (1959)** — functional responses (Types I/II/III); why predator
  saturation and a low-density prey refuge are stabilizing.
- **Rosenzweig & MacArthur (1963)** — logistic prey + saturating predator; the
  standard stable model.
- **Rosenzweig (1971)** — "Paradox of Enrichment"; why more food can mean
  extinction.
- **Huffaker (1958)** — the mite experiment; space and refuges as stabilizers.
- **Wilensky (1997), NetLogo "Wolf Sheep Predation"** — the agent-based model to
  copy; grass regrowth as the key to persistence.
- **May (1972, 1976)** — complexity vs stability, and how simple deterministic
  rules produce chaos; great for intuition on why these systems are twitchy.
