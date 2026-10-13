// Small helpers the simulation's modules share. The world is a torus: what
// runs off one edge comes back on the other, so offsets and positions wrap.

export const TAU = Math.PI * 2;

// The shortest signed offset d on a ring of `size` (−size/2 .. size/2).
export function wrapDelta(d, size) {
    return d > size / 2 ? d - size : d < -size / 2 ? d + size : d;
}

// A position wrapped onto the world, 0 .. size. One already on it is kept
// exactly as it is (the modulo below would round it in its last bits).
export function wrapPos(v, size) {
    return v >= 0 && v < size ? v : ((v % size) + size) % size;
}

// The plain modulo, which does round a position already on the world in its
// last bits. People's moves (humans.js), the admin console and the orders
// check have always wrapped this way, and their trajectories (the
// fingerprint) depend on it to the bit: keep it there, use wrapPos elsewhere.
export function wrapMod(v, size) {
    return ((v % size) + size) % size;
}

export function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// The index in `pop` of the individual with this id, or -1. (Indices shift
// as others die; ids never do.)
export function indexOf(pop, id) {
    const ids = pop.id;
    for (let i = 0; i < pop.n; i++) if (ids[i] === id) return i;
    return -1;
}

// The same, but only if it is alive (dead, killed this step and not yet
// compacted away, it is -1 too).
export function livingIndexOf(pop, id) {
    const ids = pop.id;
    for (let i = 0; i < pop.n; i++) if (ids[i] === id) return pop.energy[i] > 0 ? i : -1;
    return -1;
}
