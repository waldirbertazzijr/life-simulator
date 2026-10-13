// What the calendar (calendar.js) means for the page: the moment drawn, and
// what the season looks like then. The sky (daylight.js, sky.js), the land
// (terrain-mesh.js, forest.js, tufts.js), the weather (weather.js), the HUD
// and the panel all read the time through clockOf(), so they agree.
//
// Like the calendar it reads, nothing here is random: the weather comes from
// a hash of the seed and the hour, so a world has the same showers every time.
// No three.js and no DOM (node tests it), but for reading `?at=` once.
//
// The season, for the view:
//   snow     where it lies: `line`, the height (0 the shore .. 1 the highest
//            peak) above which the ground is white, coming down the
//            mountains in late autumn and over the first days of winter
//            (lower and faster in a hard winter, and lower still as the
//            winter goes on), and climbing back as it melts in early spring;
//   ice      how deep (0..1, of 25 units) the lakes freeze in from the shore;
//   lush     the colour full grass takes (fresh in spring, golden in autumn);
//   gold     how far the grass tufts have turned (autumn), `dry` (winter);
//   bloom    meadow flowers (spring, a few into summer);
//   lilies   the water lilies, up (1) or gone (0);
//   leaves   per tree kind, a stretch of the year's foliage (see FOLIAGE);
//   rain, snowfall, overcast   the weather now (0..1).
import { when, winterOf } from '../calendar.js';
import { hash, smoothstep, clamp01 } from './util.js';

export const TREE_KINDS = ['pine', 'birch', 'oak', 'fruit'];

// ---- The page's clock ----

// DEV ONLY (for screenshots): `?at=winter-dusk` shows the calendar as if the
// world were that far on: a season, a time of day, `full` or `new` (the
// moon), `mild`, `normal` or `hard` (the winter), `d3` (the day of the
// season), `clear`, `rain` or `snow` (the weather). It only moves the page's
// view of the calendar; the simulation lives in its own time.
let AT = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('at') : null;
// (The same, from a probe: `import('/src/view3d/almanac.js').then((a) => a.setAt('autumn-noon'))`.)
export function setAt(text) {
    AT = text;
    atCache = { seed: NaN, offset: 0 };
}
const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];
const HARDNESS = ['mild', 'normal', 'hard'];

// Where in the day (0..1 from first light) each named time falls.
function timeOfDay(c, name) {
    const dawn = c.dawn / c.day;
    const dusk0 = (c.dawn + c.light) / c.day;
    const night0 = (c.dawn + c.light + c.dusk) / c.day;
    const rise = dawn / 2;
    const set = (dusk0 + night0) / 2;
    const at = {
        dawn: rise * 0.7, sunrise: rise + 0.016, morning: rise + (set - rise) * 0.22, noon: (rise + set) / 2,
        afternoon: rise + (set - rise) * 0.78, sunset: set - 0.018, dusk: set + 0.012, night: night0 + (1 - night0) * 0.25,
        midnight: (night0 + 1) / 2,
    };
    return at[name];
}

// The moment (steps) that `?at=` asks for, in the world of `seed`: the first
// from step 0 that fits every word, or null.
export function atMoment(c, seed, text) {
    if (!text) return null;
    const words = text.toLowerCase().split(/[-,\s]+/);
    const sky = ['clear', 'rain', 'snow'].find((s) => words.includes(s));
    const season = SEASON_NAMES.findIndex((s) => words.includes(s));
    const hard = HARDNESS.findIndex((s) => words.includes(s));
    const moon = words.includes('full') ? 0.5 : words.includes('new') ? 0 : -1;
    const dayWord = words.find((w) => /^d\d+$/.test(w));
    const day = dayWord ? Number(dayWord.slice(1)) : 0;
    const named = words.map((w) => timeOfDay(c, w)).find((t) => t !== undefined);
    // (With no time named, any daylight hour will do for the weather.)
    const times = named !== undefined ? [named] : [0.3, 0.2, 0.4, 0.5, 0.25, 0.35, 0.45, 0.55];
    const yearDays = c.seasonDays * 4;
    for (let k = 0; k < yearDays * 60 * times.length; k++) {
        const d = Math.floor(k / times.length);
        const time = (d + times[k % times.length]) * c.day;
        const w = when(c, time);
        if (season >= 0 && w.season !== season) continue;
        if (day && w.dayOfSeason !== day) continue;
        if (moon >= 0 && Math.abs(((w.moon.phase - moon + 1.5) % 1) - 0.5) > 0.5 / c.moonDays) continue;
        // (A spring's snow is the winter before's: the year before.)
        if (hard >= 0 && winterOf(c, seed, season === 0 ? w.year - 1 : w.year) !== hard) continue;
        if (sky) {
            const wx = weatherAt(c, seed, time, w);
            if (sky === 'clear' ? wx.overcast > 0 : wx[sky] < 0.25) continue;
        }
        return time;
    }
    return null;
}

let atCache = { seed: NaN, offset: 0 };

// The moment the page shows, in steps (fractional): the Mirror's drawn
// moment (`shown`, between snapshots) or the World's `time`. (With `?at=`,
// that moment is shown first, and the world's time runs on from it.)
export function clockOf(world) {
    const base = world.shown ?? world.time ?? 0;
    if (!AT || !world.p?.calendar) return base;
    if (atCache.seed !== world.seed) {
        const at = atMoment(world.p.calendar, world.seed, AT);
        atCache = { seed: world.seed, offset: at === null ? 0 : at - base };
    }
    return base + atCache.offset;
}

// The moon as the page draws it, from when()'s moment `w` (calendar `c`):
// new with the sun, and falling behind it a little more each day (it rises
// later), so a waxing moon follows the sun down in the evening, the full moon
// rides opposite it all night, and a waning one is high at dawn. calendar.js
// places it half a turn off and turning the wrong way (`maz = az + PI + TAU
// * phase`: full with the sun at noon, never up at night), so the page places
// it from the sun and the phase here, the calendar's own way otherwise.
// DROP THIS once calendar.js has `maz = az - TAU * phase` (and use w.moon).
export function moonOf(w, c) {
    const TAU = Math.PI * 2;
    const maz = (((w.sun.az - TAU * w.moon.phase) % TAU) + TAU) % TAU;
    return { alt: Math.sin(maz) * c.noon * (Math.PI / 180), az: maz, phase: w.moon.phase, lit: (1 - Math.cos(TAU * w.moon.phase)) / 2 };
}

// How far through the night it is (0 at its start, 1 at first light), or -1
// by day. (The sleeper's work bar.)
export function nightDone(c, time) {
    const t = (((time / c.day) % 1) + 1) % 1;
    const night0 = (c.dawn + c.light + c.dusk) / c.day;
    return t < night0 ? -1 : (t - night0) / (1 - night0);
}

// ---- Keyframes ----

// A value at `x` (0..1, wrapping) from keys [[x, value], ...] in order,
// eased between them; values are numbers or arrays of numbers.
export function keyed(keys, x) {
    x = ((x % 1) + 1) % 1;
    let k = 0;
    while (k < keys.length - 1 && keys[k + 1][0] <= x) k++;
    const [x0, a] = keys[k];
    const [x1, b] = k + 1 < keys.length ? keys[k + 1] : [keys[0][0] + 1, keys[0][1]];
    const u = smoothstep(0, 1, (x - x0) / (x1 - x0));
    return Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * u) : a + (b - a) * u;
}

// The colour of full grass through the year (sRGB), from yearT (0: the
// first dawn of spring). Summer's is the 2D map's lush green.
const LUSH = [
    [0, [74, 114, 56]], [0.08, [70, 122, 60]], [0.25, [64, 110, 62]], [0.4, [62, 104, 64]], [0.52, [70, 102, 58]],
    [0.62, [112, 106, 54]], [0.72, [122, 106, 60]], [0.8, [100, 92, 62]], [0.95, [90, 90, 60]],
];
// How far the tufts have turned golden, and how dry they are.
const GOLD = [[0, 0], [0.52, 0], [0.62, 0.75], [0.74, 1], [0.8, 0.4], [0.95, 0.15]];
const DRY = [[0, 0.4], [0.06, 0], [0.7, 0], [0.8, 0.8], [0.97, 0.6]];
// Meadow flowers: spring, a few into summer.
const BLOOM = [[0, 0], [0.04, 0.45], [0.1, 1], [0.2, 0.9], [0.3, 0.35], [0.45, 0.12], [0.55, 0]];
// The water lilies (and their frogs): up through the warm months, gone under
// the winter's ice. (A world's first spring follows no winter: they are up.)
const LILIES = [[0, 0], [0.07, 1], [0.68, 1], [0.76, 0]];

// Foliage per tree kind: keys over the year, each [yearT, colour A, colour
// B (sRGB), amount (0 bare .. 1 a full crown)]. Each tree mixes A and B by
// its own number, and turns from one key to the next a little before or
// after the others: an autumn wood is red and yellow at once, and a birch
// stands bare while its neighbour still holds its last leaves.
export const FOLIAGE = {
    pine: [[0, [44, 70, 54], [40, 64, 58], 1]],
    birch: [
        [0, [150, 172, 92], [140, 166, 88], 0.2], [0.08, [138, 166, 84], [128, 158, 80], 0.85], [0.18, [110, 140, 70], [104, 134, 66], 1],
        [0.3, [96, 124, 64], [90, 118, 60], 1], [0.53, [110, 124, 60], [104, 118, 58], 1], [0.61, [214, 178, 62], [196, 150, 52], 1],
        [0.69, [204, 152, 60], [180, 122, 50], 0.5], [0.74, [190, 140, 60], [170, 116, 50], 0], [0.95, [150, 172, 92], [140, 166, 88], 0],
    ],
    oak: [
        [0, [132, 150, 76], [124, 144, 72], 0.35], [0.08, [118, 146, 70], [108, 138, 66], 0.8], [0.16, [96, 128, 62], [86, 118, 58], 1],
        [0.3, [78, 102, 58], [72, 98, 56], 1], [0.52, [86, 104, 56], [80, 100, 54], 1], [0.62, [176, 120, 48], [150, 70, 40], 1],
        [0.71, [150, 96, 52], [124, 62, 40], 0.75], [0.8, [112, 84, 52], [98, 72, 46], 0.25], [0.93, [112, 84, 52], [98, 72, 46], 0.22],
    ],
    // Fruit trees blossom white and pink before their leaves come.
    fruit: [
        [0, [236, 226, 224], [232, 180, 196], 0.3], [0.04, [238, 230, 228], [234, 184, 200], 0.9], [0.12, [228, 222, 214], [226, 186, 196], 0.9],
        [0.18, [104, 132, 64], [98, 126, 62], 1], [0.55, [100, 124, 60], [96, 120, 58], 1], [0.63, [200, 150, 60], [186, 96, 48], 1],
        [0.72, [180, 130, 60], [160, 90, 50], 0.3], [0.76, [160, 120, 70], [150, 100, 60], 0], [0.96, [236, 226, 224], [232, 180, 196], 0],
    ],
};

// The stretch of the year a kind's foliage is in: the key before and after
// (`from`, `to`: [A, B, amount]) and how far along (`u`, 0..1, not eased:
// each tree eases on its own; see leafOf).
export function foliage(kind, yearT) {
    const keys = FOLIAGE[kind];
    const x = ((yearT % 1) + 1) % 1;
    let k = 0;
    while (k < keys.length - 1 && keys[k + 1][0] <= x) k++;
    const a = keys[k];
    const b = k + 1 < keys.length ? keys[k + 1] : keys[0];
    const x1 = k + 1 < keys.length ? b[0] : b[0] + 1;
    const u = x1 > a[0] ? (x - a[0]) / (x1 - a[0]) : 0;
    return { from: [a[1], a[2], a[3]], to: [b[1], b[2], b[3]], u };
}

// One tree's leaves (forest.js's shader does the same on the graphics card):
// `r` (0..1) is its own number, which picks between A and B and how early it
// turns. { color (sRGB), amount }.
export function leafOf(kind, yearT, r) {
    const { from, to, u } = foliage(kind, yearT);
    const k = smoothstep(0, 1, clamp01((u - 0.45 * r) / 0.55));
    const mixAB = (key) => key[0].map((v, i) => v + (key[1][i] - v) * r);
    const a = mixAB(from);
    const b = mixAB(to);
    return { color: a.map((v, i) => v + (b[i] - v) * k), amount: from[2] + (to[2] - from[2]) * k };
}

// ---- Snow and ice ----

// Snow line by the winter's hardness (mild, normal, hard): where it settles
// (0 the shore .. 1 the highest peak; below 0, even the lowest land is
// white); how long it takes to come down (of the winter), and how long the
// melt takes (of the spring).
const SNOW = { low: [0.5, 0.1, -0.3], build: [0.55, 0.4, 0.28], melt: [0.3, 0.45, 0.6], ice: [0.06, 0.13, 0.26] };
const NONE = 1.2;  // a line above every peak: no snow (the snowfields of the snow biome stay)
const PEAKS = 0.72; // the line by the end of autumn: the first snow on the high tops

// The snow line at the moment `w` (when()'s), given this winter's and the
// last one's hardness (0..2; `last` -1: there was none, the world's first spring).
export function snowLine(w, hard, last) {
    switch (w.season) {
        case 2: // autumn: the first snow on the peaks in its second half
            return NONE + (PEAKS - NONE) * smoothstep(0.45, 1, w.seasonT);
        case 3: { // winter: down over its first days, a little lower as it goes on
            const low = SNOW.low[hard] - 0.12 * w.seasonT;
            return PEAKS + (low - PEAKS) * smoothstep(0, SNOW.build[hard], w.seasonT);
        }
        case 0: { // spring: the melt, from where the winter left it
            if (last < 0) return NONE;
            const low = SNOW.low[last] - 0.12;
            return low + (NONE - low) * smoothstep(0, SNOW.melt[last], w.seasonT);
        }
        default:
            return NONE;
    }
}

// How far into the lakes ice reaches from the shore (0..1 of 25 units deep).
export function iceDepth(w, hard, last) {
    if (w.season === 3) return SNOW.ice[hard] * smoothstep(0.1, 0.6, w.seasonT);
    if (w.season === 0 && last >= 0) return SNOW.ice[last] * (1 - smoothstep(0, 0.25, w.seasonT));
    return 0;
}

// How much snow lies at height `h` (0 shore .. 1 peak) on a level face, for
// a snow line `line` (the shader adds noise and the face's slope).
export const SNOW_FADE = 0.14;
export const snowAt = (line, h) => clamp01((h - line) / SNOW_FADE + 0.5);

// ---- Weather ----

// The day is cut into SPELLS; each may be a shower (rain, or snow in
// winter), by a hash of the seed and its number: more often in spring for
// rain, in winter for snow (more in a hard winter), never in summer's heat.
const SPELLS = 3;
const RAIN = [0.32, 0.06, 0.18, 0];
const SNOWS = [0.3, 0.45, 0.6];
const RAIN_MAX = [0.6, 0.5, 0.7, 0]; // spring's rain is light

export function weatherAt(c, seed, time, w = when(c, time), hard = winterOf(c, seed, w.year)) {
    const span = c.day / SPELLS;
    const n = Math.floor(time / span);
    const u = time / span - n; // through this spell
    const h = hash((seed | 0) * 7919 + n * 104729 + 0x2545f491);
    const roll = (h & 0xffff) / 65536;
    const strength = 0.45 + 0.55 * ((h >>> 16) / 65536);
    const wet = w.season === 3 ? roll < SNOWS[hard] : roll < RAIN[w.season];
    // Clouds gather a little before a shower and clear after it.
    const shower = wet ? smoothstep(0.08, 0.22, u) * (1 - smoothstep(0.78, 0.92, u)) : 0;
    const cloud = wet ? smoothstep(0, 0.12, u) * (1 - smoothstep(0.88, 1, u)) : 0;
    const snowing = w.season === 3 || (w.season === 2 && w.seasonT > 0.8);
    return {
        rain: snowing ? 0 : shower * strength * RAIN_MAX[w.season],
        snow: snowing ? shower * strength : 0,
        overcast: cloud * (0.55 + 0.4 * strength),
    };
}

// ---- Everything at once ----

// What the season looks like at `time` in the world of `seed` (calendar c).
export function seasonLook(c, seed, time) {
    const w = when(c, time);
    const hard = winterOf(c, seed, w.year);
    const last = w.year > 1 ? winterOf(c, seed, w.year - 1) : -1;
    const y = w.yearT;
    const leaves = {};
    for (const kind of TREE_KINDS) leaves[kind] = foliage(kind, y);
    return {
        w,
        hard,
        line: snowLine(w, hard, last),
        ice: iceDepth(w, hard, last),
        lush: keyed(LUSH, y),
        gold: keyed(GOLD, y),
        dry: keyed(DRY, y),
        bloom: keyed(BLOOM, y),
        lilies: last < 0 && w.season === 0 ? 1 : keyed(LILIES, y),
        leaves,
        ...weatherAt(c, seed, time, w, hard),
    };
}
