// A tribe's identity: a generated name and flag. Pure data (drawing lives in
// render.js), generated from the world's seeded random numbers, so a seed
// always produces the same tribes.

const SYLLABLES = [
    'ka', 'to', 'ri', 'ma', 'nu', 'sha', 've', 'lo', 'an', 'ur', 'ek', 'ti', 'zu', 'ha',
    'mo', 'ra', 'ne', 'yo', 'ba', 'ki', 'ul', 'os', 'ta', 'we', 'il', 'da', 'ko', 'se',
];

// People are drawn in their tribe's main colour, so these avoid the animals'
// cream and red and the grass greens.
export const TRIBE_COLORS = ['#4a90e2', '#f2c14e', '#9b6dd6', '#2ec4b6', '#e86fb0', '#7fb3ff', '#c08a52', '#d7e36a'];
const EXTRA_COLORS = ['#f4f1ea', '#1b1d22', '#b23a48', '#2d4a7a'];

export const FLAG_PATTERNS = ['bands', 'stripes', 'tricolor', 'diagonal', 'cross', 'disc', 'chevron', 'border'];

const pick = (rng, list) => list[Math.floor(rng.next() * list.length)];

export function tribeIdentity(rng, usedColors = new Set()) {
    const syllables = 2 + Math.floor(rng.next() * 2);
    let name = '';
    for (let k = 0; k < syllables; k++) name += pick(rng, SYLLABLES);
    name = name[0].toUpperCase() + name.slice(1);

    const free = TRIBE_COLORS.filter((c) => !usedColors.has(c));
    const color = pick(rng, free.length ? free : TRIBE_COLORS);
    const others = [...TRIBE_COLORS, ...EXTRA_COLORS].filter((c) => c !== color);
    const second = pick(rng, others);
    const third = pick(rng, others.filter((c) => c !== second));

    return { name, color, flag: { pattern: pick(rng, FLAG_PATTERNS), colors: [color, second, third] } };
}
