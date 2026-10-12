// Deterministic PRNG so headless runs are reproducible and comparable.
//
// The whole simulation uses the global Math.random(), so by swapping Math.random
// for a seeded generator BEFORE a run we make that entire run deterministic
// without touching a single line of the simulation code.

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Install a seeded RNG as the global Math.random.
export function seedRandom(seed) {
    Math.random = mulberry32(seed);
}
