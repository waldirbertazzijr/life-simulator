// How each biome looks in the 3D view: the ground, the grass tufts, the trees.
//
// The engine names the biomes and gives each a bare-ground colour
// (terrain.biomes[i].color). Those colours are made for the 2D map, which is
// dark: there a grazed meadow is nearly black, and that reads as "no grass".
// Under the 3D view's daylight sky the same colour reads as a hole in the
// ground. So the 3D view keeps its own, lighter bare ground per biome, in the
// same families (earth, leaf litter, mud, dry sand, tundra, rock), and grass
// greens it exactly as in 2D. A biome this table does not know falls back to
// the engine's colour, lifted toward earth.
//
// Every patch's look is worked out once per world (lookups are by patch, as
// the engine's biomeGrid is): only the grass on top of it changes.
import { COLORS } from '../render.js';

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Tuft colours, root of a blade → tip. The first is the grass of a world
// without biomes (and of meadows): the root a bit darker than lush ground, the
// tip the lush green lifted toward pale straw.
export const TUFT_PALETTES = [
    { root: mix(COLORS.bare, COLORS.lush, 0.6), tip: mix(COLORS.lush, [200, 208, 160], 0.38) }, // 0 meadow
    { root: [38, 70, 52], tip: [92, 134, 102] },   // 1 wetland: a deeper, cooler green
    { root: [36, 58, 40], tip: [80, 112, 78] },    // 2 forest floor: shaded and dark
    { root: [90, 92, 52], tip: [176, 166, 104] },  // 3 steppe: dry, yellowing
    { root: [82, 76, 54], tip: [146, 130, 92] },   // 4 tundra: brownish, wind-burnt
    { root: [44, 60, 40], tip: [126, 122, 78] },   // 5 reeds: dark stems, straw-coloured heads
];
export const REEDS = 5;

// Per biome, by name:
//   ground  the bare ground, what shows where the grass is grazed down (sRGB)
//   trees   how wooded it is: 1 for forest, a little for scattered trees
//   tuft    which TUFT_PALETTES entry its grass uses
//   snow    covered in snow (the ground underneath is `ground`)
const LOOK = {
    water: { ground: COLORS.shallow, trees: 0, tuft: 0 },
    wetland: { ground: [66, 72, 56], trees: 0.035, tuft: 1 },  // dark mud
    meadow: { ground: [104, 88, 64], trees: 0, tuft: 0 },      // brown earth
    forest: { ground: [70, 64, 46], trees: 1, tuft: 2 },       // leaf litter
    steppe: { ground: [142, 124, 86], trees: 0, tuft: 3 },     // dry, sandy earth
    tundra: { ground: [114, 112, 96], trees: 0, tuft: 4 },     // thin, stony soil
    rock: { ground: COLORS.rock, trees: 0, tuft: 4 },
    snow: { ground: COLORS.rock, trees: 0, tuft: 4, snow: true },
};

// The look of one engine biome ({ name, color }).
export function biomeLook(biome) {
    const look = LOOK[biome.name];
    if (look) return look;
    return { ground: mix(biome.color, [104, 88, 64], 0.6), trees: 0, tuft: 0 };
}

// Snow, slightly cool, and how much grass shows through the forest canopy
// seen from above (the trees themselves are drawn by forest.js; this darkens
// the ground between them).
export const SNOW = [188, 196, 206];
export const CANOPY = 0.45;
