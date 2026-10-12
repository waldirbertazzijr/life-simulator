// People's names, made from their id alone: the same person has the same
// name on every page and in every view, and nothing is drawn from the
// simulation's random numbers (it would change the world). A name does not
// depend on the tribe either, so it survives the tribe splitting in two.
//
// A name is two or three syllables, each a consonant and a vowel (the first
// may be just a vowel), and the last may close on a soft consonant: Tiko,
// Ana, Maren, Shulavi.

const ONSETS = ['b', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'y', 'z', 'sh', 'th', 'k', 't', 'm', 'n', 'r', 'l', 's'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'i', 'o'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'k'];

// Steps in a year: maturity (900 steps) comes at 6, the longest life
// (9000 × 1.2) ends at 72. For display only.
export const YEAR = 150;

// A 32-bit integer hash (lowbias32): neighbouring ids give unrelated names.
function hash(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
}

const cache = new Map();

export function personName(id) {
    let name = cache.get(id);
    if (name !== undefined) return name;
    let h = hash((id | 0) + 0x632be5ab);
    const pick = (list) => {
        h = hash(h + 0x9e3779b9);
        return list[h % list.length];
    };
    const syllables = pick([2, 2, 2, 3, 3]);
    name = '';
    for (let k = 0; k < syllables; k++) {
        // A vowel to begin with now and then (Ana, Oren), never inside a name.
        name += (k === 0 && pick([0, 0, 0, 0, 1])) ? '' : pick(ONSETS);
        name += pick(VOWELS);
    }
    name += pick(CODAS);
    name = name[0].toUpperCase() + name.slice(1);
    if (cache.size > 4096) cache.clear();
    cache.set(id, name);
    return name;
}

// Whole years lived.
export const years = (steps) => Math.floor(steps / YEAR);

export function ageText(steps) {
    const y = years(steps);
    return y < 1 ? 'under a year' : y === 1 ? '1 year' : `${y} years`;
}

// What someone `gap` generations below an ancestor is to them (null: not a
// descendant).
export function relation(gap) {
    if (!(gap >= 1)) return null;
    return ['child', 'grandchild', 'great-grandchild'][gap - 1] ?? 'descendant';
}
