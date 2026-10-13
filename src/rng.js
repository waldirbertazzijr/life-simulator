// Seedable PRNG (mulberry32). Every random choice in the simulation goes
// through one of these, so a seed reproduces a run exactly — in the browser
// (?seed=42) and in the headless checks alike.
export function createRng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Standard normal via Box–Muller (the second value is cached).
    let spare = null;
    const gauss = () => {
        if (spare !== null) {
            const s = spare;
            spare = null;
            return s;
        }
        const u = next() || 1e-12;
        const v = next();
        const r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
    };

    // The whole of the stream's state, for a save (save.js): where it is, and
    // gauss()'s cached second value. Reading it draws nothing; restoring it
    // carries on with exactly the numbers the saved stream would have drawn.
    const state = () => ({ a, spare });
    const restore = (s) => {
        a = s.a;
        spare = s.spare;
    };

    return { next, gauss, state, restore };
}
