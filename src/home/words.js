// The world in words, for the cards of Begin a life (home.js): a tribe's
// culture and its land, a person's traits, and the cards themselves, read
// from the world as it is (the Mirror; in tests, a World). Pure: no DOM,
// and nothing here draws a random number.
//
//   culture   from aggression and sociality: "fierce, close-knit",
//             "peaceful, independent"
//   land      from the ground around the camp: water near it, the biome
//             most of it is, and its lie (a hillside, a valley):
//             "by a lake, in the meadows", "on a forested hillside"
//   traits    from the genes: "swift" (speed), "keen-eyed" (sense)
import { BIOME } from '../terrain.js';
import { personName, years } from '../play/names.js';
import { mostExperienced } from '../play/modes.js';

const TAU = Math.PI * 2;

// ---- A tribe's culture ----

// Each in three bands, from 0 to 1: how readily they fight and raid, how
// much they share and keep together.
const FIGHT = ['peaceful', 'bold', 'fierce'];
const TOGETHER = ['independent', 'neighbourly', 'close-knit'];
const band = (v) => (v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2);

export function cultureWords(aggression, sociality) {
    return `${FIGHT[band(aggression)]}, ${TOGETHER[band(sociality)]}`;
}

// ---- A camp's land ----

// How the ground around a camp is read: distances in world units, heights
// as a share of the way from the shore to the highest peak, the rest as
// shares of the ground sampled.
export const LAND = {
    shore: 40,      // water this near: "on a lakeshore"...
    lake: 90,       // ...this near: "by a lake"
    wide: 0.25,     // water this much of the ground within `around`: a wide lake
    small: 0.06,    // ...this little: a small one
    around: 200,
    own: 60,        // the camp's own ground: its biome, and how much it rises across it
    hillside: 0.1,  // rising this much: a hillside
    far: 220,       // the ring a valley lies below...
    valley: 0.12,   // ...by this much
    ring: [60, 160], // the land around the camp's own: its forest, marsh and steppe
    edge: 0.15,     // forest or steppe this much of it: at its edge
    marsh: 0.35,    // marsh this much: near the marshes
    mountains: 0.85, // a peak this high within `range`: under the mountains
    range: 400,
};

// Where a camp is by its own ground's biome: on the flat, on a hillside, in a valley.
const PLACE = {
    [BIOME.MEADOW]: ['in the meadows', 'on a grassy hillside', 'in a green valley'],
    [BIOME.FOREST]: ['in the forest', 'on a forested hillside', 'in a wooded valley'],
    [BIOME.WETLAND]: ['in the marshes', 'on a reedy slope', 'in a marshy valley'],
    [BIOME.STEPPE]: ['on the dry steppe', 'on a dry hillside', 'in a dry valley'],
    [BIOME.TUNDRA]: ['on the cold tundra', 'on a bleak hillside', 'in a cold valley'],
    [BIOME.ROCK]: ['among the rocks', 'on a rocky hillside', 'in a stony valley'],
    [BIOME.SNOW]: ['under the snows', 'on a snowy slope', 'in a snowbound valley'],
};
const NO_BIOMES = ['in the lowlands', 'on a hillside', 'in a valley'];

// What the ground around (x, y) is like, read from `terrain` (null with
// none): { water (the nearest, or Infinity), wet (share of the ground
// within LAND.around under water), own (the biome most of the camp's own
// ground is, or -1), rise, below (how far below the ring around it),
// forest, marsh, steppe (shares of the land around), peak (the highest
// ground within LAND.range) }.
export function landOf(terrain, x, y) {
    if (!terrain) return null;
    const up = (h) => Math.max(0, (h - terrain.seaLevel) / Math.max(1e-6, terrain.peak - terrain.seaLevel));
    const at = (r, k, n) => [x + Math.cos((k * TAU) / n) * r, y + Math.sin((k * TAU) / n) * r];
    const land = { water: Infinity, wet: 0, own: -1, rise: 0, below: 0, forest: 0, marsh: 0, steppe: 0, peak: 0 };
    for (let r = 10; r <= LAND.lake && land.water === Infinity; r += 10) {
        for (let k = 0; k < 16; k++) {
            if (terrain.isWater(...at(r, k, 16))) {
                land.water = r;
                break;
            }
        }
    }
    let n = 0;
    for (let r = 20; r <= LAND.around; r += 20) {
        for (let k = 0; k < 16; k++, n++) if (terrain.isWater(...at(r, k, 16))) land.wet++;
    }
    land.wet /= n;
    // The camp's own ground.
    const votes = new Map();
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of [0, LAND.own / 2, LAND.own]) {
        for (let k = 0, m = r ? 12 : 1; k < m; k++) {
            const [px, py] = at(r, k, m);
            if (terrain.isWater(px, py)) continue;
            const h = up(terrain.heightAt(px, py));
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
            if (terrain.biomes) {
                const b = terrain.biome(px, py);
                votes.set(b, (votes.get(b) ?? 0) + 1);
            }
        }
    }
    land.rise = hi > lo ? hi - lo : 0;
    let most = 0;
    for (const [b, v] of votes) {
        if (v > most) {
            most = v;
            land.own = b;
        }
    }
    // The ring a valley lies below, and the land around.
    let ring = 0;
    for (let k = 0; k < 16; k++) ring += up(terrain.heightAt(...at(LAND.far, k, 16)));
    land.below = ring / 16 - up(terrain.heightAt(x, y));
    if (terrain.biomes) {
        let total = 0;
        for (let r = LAND.ring[0]; r <= LAND.ring[1]; r += 20) {
            for (let k = 0; k < 16; k++) {
                const b = terrain.biome(...at(r, k, 16));
                if (b === BIOME.WATER) continue;
                total++;
                if (b === BIOME.FOREST) land.forest++;
                else if (b === BIOME.WETLAND) land.marsh++;
                else if (b === BIOME.STEPPE) land.steppe++;
            }
        }
        if (total) {
            land.forest /= total;
            land.marsh /= total;
            land.steppe /= total;
        }
    }
    for (let r = 150; r <= LAND.range; r += 50) {
        for (let k = 0; k < 16; k++) land.peak = Math.max(land.peak, up(terrain.heightAt(...at(r, k, 16))));
    }
    return land;
}

// The land (landOf's) in words: the water, then the place, "by a lake, in
// the meadows". The place is the first that fits, in this order: a
// hillside, a valley, the forest's edge, the marshes, the steppe's edge,
// under the mountains, and else the camp's own ground.
export function landText(land) {
    if (!land) return '';
    const L = LAND;
    const water = land.water > L.lake ? ''
        : land.wet >= L.wide ? 'by a wide lake'
        : land.wet < L.small ? 'by a small lake'
        : land.water <= L.shore ? 'on a lakeshore' : 'by a lake';
    const own = PLACE[land.own] ?? NO_BIOMES;
    const place = land.rise >= L.hillside ? own[1]
        : land.below >= L.valley ? own[2]
        : land.forest >= L.edge && land.own !== BIOME.FOREST ? "at the forest's edge"
        : land.marsh >= L.marsh && land.own !== BIOME.WETLAND ? 'near the marshes'
        : land.steppe >= L.edge && land.own !== BIOME.STEPPE ? 'where the steppe begins'
        : land.peak >= L.mountains ? 'under the mountains'
        : own[0];
    return water ? `${water}, ${place}` : place;
}

// The land around (x, y) in words ('' with no terrain). The same camp always reads the same.
export const landWords = (terrain, x, y) => landText(landOf(terrain, x, y));

// ---- A person's traits ----

// A gene this far above or below the species' own (1) is worth a word.
export const NOTABLE = 0.06;

export function traitWords(speedGene, senseGene) {
    const out = [];
    if (speedGene >= 1 + NOTABLE) out.push('swift');
    else if (speedGene <= 1 - NOTABLE) out.push('slow-footed');
    if (senseGene >= 1 + NOTABLE) out.push('keen-eyed');
    else if (senseGene <= 1 - NOTABLE) out.push('short-sighted');
    return out.length ? out : ['steady'];
}

// ---- The cards ----

// Each tribe's people and adults, counted here (a tribe's own count waits
// for the world's first step).
function headcount(world) {
    const pop = world.humans;
    const adult = world.p.human.maturity;
    const count = new Map();
    for (let i = 0; i < pop.n; i++) {
        const c = count.get(pop.tribe[i]) ?? { members: 0, adults: 0 };
        c.members++;
        if (pop.age[i] >= adult) c.adults++;
        count.set(pop.tribe[i], c);
    }
    return count;
}

// How unlike two cultures are (0 the same .. √2).
const unlike = (a, b) => Math.hypot(a.aggression - b.aggression, a.sociality - b.sociality);

// Up to `n` living tribes with adults to be, for "Choose your people": from
// the biggest few, as unlike one another as they can be (the biggest first
// in), then biggest first. Each card: { id, name, flag, color, members,
// adults, culture, land, camp: {x, y} }.
export function tribeCards(world, n = 4) {
    const count = headcount(world);
    const living = world.tribes
        .filter((t) => (count.get(t.id)?.adults ?? 0) > 0)
        .sort((a, b) => count.get(b.id).members - count.get(a.id).members || a.id - b.id);
    const pool = living.slice(0, Math.max(n, Math.ceil(n * 1.5)));
    const chosen = pool.slice(0, 1);
    while (chosen.length < n && chosen.length < pool.length) {
        let best = null;
        let bestScore = -1;
        for (const t of pool) {
            if (chosen.includes(t)) continue;
            const score = Math.min(...chosen.map((c) => unlike(c, t)));
            if (score > bestScore) {
                best = t;
                bestScore = score;
            }
        }
        chosen.push(best);
    }
    return chosen
        .sort((a, b) => count.get(b.id).members - count.get(a.id).members || a.id - b.id)
        .map((t) => ({
            id: t.id, name: t.name, flag: t.flag, color: t.color,
            members: count.get(t.id).members, adults: count.get(t.id).adults,
            culture: cultureWords(t.aggression, t.sociality),
            land: landWords(world.terrain, t.camp.x, t.camp.y),
            camp: { x: t.camp.x, y: t.camp.y },
        }));
}

// The tribe's adults, for "Choose who you are": the most experienced first
// (play/modes.js's rule; suggested), then by kills and age. Each card:
// { id, name, years, traits, kills, children, suggested }.
export function adultCards(world, tribeId) {
    const pop = world.humans;
    const P = world.p.human;
    const suggested = mostExperienced(world, tribeId);
    const out = [];
    for (let i = 0; i < pop.n; i++) {
        if (pop.tribe[i] !== tribeId || pop.age[i] < P.maturity || pop.energy[i] <= 0) continue;
        const id = pop.id[i];
        out.push({
            id, name: personName(id), years: years(pop.age[i], P.maturity), age: pop.age[i],
            traits: traitWords(pop.speedGene[i], pop.senseGene[i]),
            kills: pop.kills[i], children: pop.children[i], suggested: id === suggested,
        });
    }
    return out.sort((a, b) => b.suggested - a.suggested || b.kills - a.kills || b.age - a.age);
}

// "3 kills · 2 children", "no kills · 1 child".
export function deedsText(kills, children) {
    const n = (v, one, many) => (v === 0 ? `no ${many}` : v === 1 ? `1 ${one}` : `${v} ${many}`);
    return `${n(kills, 'kill', 'kills')} · ${n(children, 'child', 'children')}`;
}
