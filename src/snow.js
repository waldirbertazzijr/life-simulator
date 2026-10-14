// Snow (stage 4, package 2), shared by the simulation and the page, so the
// snow the page draws is the snow people wade through. Pure: no DOM, no
// three.js, no random numbers.
//
// The snow line is a height, 0 the shore .. 1 the highest peak (below 0,
// even the lowest land is white). It comes down the mountains in late
// autumn and over the first days of winter (lower and faster in a hard
// winter, and lower still as the winter goes on), and climbs back as it
// melts in early spring. The snow biome's snowfields lie all year.
//
// Depth, 0..1: where snow lies (snowAt), deeper the higher the ground, and
// deep in a snowfield. Walking in it is slower: × snowPace(slow, depth),
// `slow` being the pace in the deepest snow (params.snow.slow).
import { when, winterOf } from './calendar.js';
import { BIOME } from './terrain.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// Snow line by the winter's hardness (mild, normal, hard): where it settles
// (0 the shore .. 1 the highest peak; below 0, even the lowest land is
// white); how long it takes to come down (of the winter), and how long the
// melt takes (of the spring).
const SNOW = { low: [0.5, 0.1, -0.3], build: [0.55, 0.4, 0.28], melt: [0.3, 0.45, 0.6] };
export const NO_SNOW = 1.2; // a line above every peak: no snow (the snowfields of the snow biome stay)
const PEAKS = 0.72;         // the line by the end of autumn: the first snow on the high tops

// The snow line at the moment `w` (when()'s), given this winter's and the
// last one's hardness (0..2; `last` -1: there was none, the world's first spring).
export function snowLine(w, hard, last) {
    switch (w.season) {
        case 2: // autumn: the first snow on the peaks in its second half
            return NO_SNOW + (PEAKS - NO_SNOW) * smoothstep(0.45, 1, w.seasonT);
        case 3: { // winter: down over its first days, a little lower as it goes on
            const low = SNOW.low[hard] - 0.12 * w.seasonT;
            return PEAKS + (low - PEAKS) * smoothstep(0, SNOW.build[hard], w.seasonT);
        }
        case 0: { // spring: the melt, from where the winter left it
            if (last < 0) return NO_SNOW;
            const low = SNOW.low[last] - 0.12;
            return low + (NO_SNOW - low) * smoothstep(0, SNOW.melt[last], w.seasonT);
        }
        default:
            return NO_SNOW;
    }
}

// How much snow lies at height `h` (0 shore .. 1 peak) on a level face, for
// a snow line `line` (the page's shader adds noise and the face's slope).
export const SNOW_FADE = 0.14;
export const snowAt = (line, h) => clamp01((h - line) / SNOW_FADE + 0.5);

// The snow line at `time` in the world of `seed` (calendar c).
export function snowLineAt(c, seed, time) {
    const w = when(c, time);
    const hard = winterOf(c, seed, w.year);
    const last = w.year > 1 ? winterOf(c, seed, w.year - 1) : -1;
    return snowLine(w, hard, last);
}

// How deep the snow is (0..1) at height `h` (0 shore .. 1 peak), for the
// snow line `line`: where it lies, a third deep on the lowest land and
// deep on the peaks; in a snowfield (`field`), deep.
const SHALLOW = 0.3;
export function depthAt(line, h, field = false) {
    if (field) return 1;
    const cover = snowAt(line, h);
    return cover === 0 ? 0 : cover * (SHALLOW + (1 - SHALLOW) * clamp01(h));
}

// How deep the snow is at (x, y) at `time` (the page passes its clock), in
// a world-ish `w`: anything with p.calendar, seed and terrain (the World,
// or the page's Mirror). 0 on water and on a flat world.
export function snowDepth(w, x, y, time = w.time) {
    const T = w.terrain;
    if (!T) return 0;
    const height = T.heightAt(x, y);
    if (height < T.seaLevel) return 0;
    const h = (height - T.seaLevel) / (T.peak - T.seaLevel);
    const field = T.biomes !== null && T.biome(x, y) === BIOME.SNOW;
    return depthAt(snowLineAt(w.p.calendar, w.seed, time), h, field);
}

// The pace in snow `depth` deep (0..1): × 1 on bare ground, × `slow` in the deepest.
export const snowPace = (slow, depth) => 1 - (1 - slow) * depth;
