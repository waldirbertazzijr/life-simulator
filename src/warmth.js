// Cold and warmth (stage 4, package 2), shared by the simulation and the
// page, so the frost the HUD shows is the cold that costs the body. Pure:
// no DOM, no random numbers.
//
// chill, 0..1: how cold it is out there. The air's cold follows the season
// (winter's by its hardness: mild, normal or hard) and the hour (the night
// is colder than the day); high ground adds to it, the more the higher, and
// tundra, bare rock and snowfields more again, most of all in winter and on
// spring and autumn nights. A summer's day is never cold; a hard winter's
// night is bitter everywhere.
//
// warmth, 0..1: what keeps the cold off: a cloak (rare ones are warmer),
// the camp's fire (as well as it burns), a shelter (huts: package 4), a
// torch (a little). Each keeps off its share of what the others let
// through.
//
// exposure = chill × (1 − warmth): what the cold costs a person, the frost
// mark on the HUD.
import { when, winterOf, seasonal } from './calendar.js';
import { BIOME } from './terrain.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The chill's numbers.
//   seasons  the air's cold by season (spring, summer, autumn, winter)...
//   winters  ...the winter's × its hardness (mild, normal, hard)
//   day      by day, this share of the night's cold
//   high     high ground: × how far up it is from `from` of the way up
//            (0 the shore, 1 the peaks: the valleys add nothing)...
//   land     ...plus this on tundra, rock and snowfields...
//   heights  ...× this by season...
//   highDay  ...and by day, this share of it
export const CHILL = {
    seasons: [0.15, 0, 0.25, 1],
    winters: [0.5, 0.8, 1.2],
    day: 0.5,
    high: 0.5,
    from: 0.25,
    land: { [BIOME.TUNDRA]: 0.3, [BIOME.ROCK]: 0.3, [BIOME.SNOW]: 0.5 },
    heights: [0.6, 0.25, 0.7, 1],
    highDay: 0.4,
};

// How much each keeps off: a plain cloak, the fire burning well (× how well
// it burns), a shelter, a torch. (params.cold has the simulation's copy.)
export const WARMTH = { cloak: 0.55, fire: 0.9, shelter: 0.9, torch: 0.15 };

// The moment's cold, at `time` in the world of `seed` (calendar c), before
// the ground is known: `air`, everywhere, and `high`, what high ground
// multiplies (chillAt). Once a step will do for everyone.
export function coldNow(c, seed, time, K = CHILL) {
    const w = when(c, time);
    // (The winter that eases into spring is last year's; the world's first
    // spring follows none.)
    const first = w.season === 0 && w.year === 1;
    const hard = winterOf(c, seed, w.season === 0 ? w.year - 1 : w.year);
    const dark = 1 - w.light;
    const s = K.seasons;
    const h = K.heights;
    const air = seasonal(w, s[0], s[1], s[2], first ? s[0] : s[3] * K.winters[hard]) * (K.day + (1 - K.day) * dark);
    const high = seasonal(w, h[0], h[1], h[2], first ? h[0] : h[3]) * (K.highDay + (1 - K.highDay) * dark);
    return { air, high };
}

// The chill on ground of height `h` (0 the shore .. 1 the peaks) and biome
// `biome` (terrain.js BIOME; -1 or anything else: none in particular), for
// the moment's cold (coldNow).
export function chillAt(air, high, h, biome, K = CHILL) {
    const up = K.high * clamp01((h - K.from) / (1 - K.from)) + (K.land[biome] ?? 0);
    return clamp01(air + high * up);
}

// How cold it is out there (0..1) at `time`, at height `h` (0..1) on biome `biome`.
export function chill(c, seed, time, h, biome, K = CHILL) {
    const now = coldNow(c, seed, time, K);
    return chillAt(now.air, now.high, h, biome, K);
}

// The chill at (x, y) at `time`, in a world-ish `w` (the World, or the
// page's Mirror: p.calendar, seed, terrain). A flat world is all lowland.
export function chillHere(w, x, y, time = w.time) {
    const T = w.terrain;
    let h = 0;
    let biome = -1;
    if (T) {
        h = (T.heightAt(x, y) - T.seaLevel) / (T.peak - T.seaLevel);
        if (T.biomes !== null) biome = T.biome(x, y);
    }
    return chill(w.p.calendar, w.seed, time, h, biome);
}

// How warm a cloak keeps (0..1): `item` an item ({kind, trait, mult}) or
// nothing. A rare or legendary cloak's trait is warmth: × its mult.
export function cloakWarmth(item, k = WARMTH) {
    if (!item) return 0;
    const v = k.cloak * (item.trait === 'warmth' ? item.mult : 1);
    return v > 0.95 ? 0.95 : v;
}

// The warmth (0..1) of {cloak, nearFire, inShelter, torch}: `cloak` its
// warmth (cloakWarmth; true: a plain one), `nearFire` how well the fire
// one stands by burns (0..1; true: well), `inShelter` and `torch` true or
// false. Each keeps off its share of the cold the others let through.
export function warmthOf({ cloak = 0, nearFire = 0, inShelter = false, torch = false } = {}, k = WARMTH) {
    const c = cloak === true ? k.cloak : cloak || 0;
    const f = nearFire === true ? 1 : nearFire || 0;
    let left = (1 - c) * (1 - k.fire * f);
    if (inShelter) left *= 1 - k.shelter;
    if (torch) left *= 1 - k.torch;
    return clamp01(1 - left);
}
