// The poses' keyframes: what a body does in each pose, for each species
// (animate.js turns them into the table the vertex shader reads, and plays
// them). Pure data and a sampler: no three.js (tested in node).
//
// A new pose: a code in POSE (append it: the numbers are fixed, other
// packages trigger poses by them), its keys under each species that has it
// below, and, if a state shows it, a line in animate.js's statePose. ?poses
// lines them all up to look at (poses.js).
import { TAU } from './util.js';

// Pose codes. Fixed numbers: other packages trigger poses by them.
export const POSE = Object.freeze({
    NONE: 0, THROW: 1, JAB: 2, SWING: 3, GATHER: 4, BUTCHER: 5, EAT: 6, CHOP: 7, KNAP: 8,
    CRAFT: 9, SIT: 10, ROLL: 11, FALL: 12, CROUCH: 13, POUNCE: 14, GRAZE: 15, HOP: 16,
    SHOOT: 17, // (package 3: a bow drawn and loosed)
});
export const POSE_NAMES = Object.keys(POSE);

export const KEYS = 4; // keyframes per pose

// ---- Poses ----
//
// Per species, each pose has its length in seconds (at 1×) and four keys.
// Its keys form a cycle (the last leads back to the first: grazing, sitting)
// or a sequence played once (a throw, a fall). A sequence that can be held
// stops at `hold` (its wind-up); one without loops when held (a roll).
//
// A key lists the parts it moves; the rest are at rest. A part's numbers are
// turns in radians, [forward, outward, twist]:
// - forward, about the side-to-side axis: a leg or arm swings forward, the
//   torso or head tips back (negative: down);
// - outward: a limb raised away from the body, on either side; for the torso
//   and the whole body (`root`), a roll onto the right side;
// - twist: about the vertical.
// `shift` moves the whole body [forward, up, sideways], and `pivot` moves the
// point the whole body turns about, from its usual place.
//
// Angles are interpolated as numbers, so an arm brought over the top (an
// overarm throw, an axe) goes the long way: −2.5 → −4.4 passes straight up,
// and it comes back to rest at −2π.

// People. Hips at 1.85, shoulders at 3.45; legs are 1.85 long, arms 1.7.
const SEATED = { shift: [0, -1.25, 0], legL: [1.5, 0.12, 0], legR: [1.5, 0.12, 0] };
const KNEEL = { shift: [0, -0.75, 0], legL: [0.93, 0.05, 0], legR: [-0.93, 0.05, 0] };
const STANCE = { legL: [0.25, 0, 0], legR: [-0.2, 0, 0] };
const CURL = { torso: [-0.5, 0, 0], head: [-0.3, 0, 0], legL: [1.3, 0.05, 0], legR: [1.3, 0.05, 0], armL: [1.4, -0.1, 0], armR: [1.4, -0.1, 0] };
const CROUCHED = {
    shift: [0, -0.8, 0], legL: [0.97, 0.05, 0], legR: [-0.97, 0.05, 0], torso: [-0.6, 0, 0], head: [0.45, 0, 0],
    armL: [0.6, 0.2, 0], armR: [0.7, 0.15, 0],
};
const human = {
    [POSE.THROW]: {
        seconds: 0.6, hold: 1 / 3, keys: [
            {},
            { torso: [0.12, 0, -0.5], armR: [-2.5, 0.15, 0], armL: [0.9, 0.1, 0], legL: [0.3, 0, 0], legR: [-0.25, 0, 0] },
            { torso: [-0.25, 0, 0.45], armR: [-4.38, 0, 0], armL: [-0.3, 0.1, 0], legL: [0.35, 0, 0], legR: [-0.3, 0, 0] },
            { armR: [-TAU, 0, 0] },
        ],
    },
    [POSE.JAB]: {
        seconds: 0.45, hold: 1 / 3, keys: [
            {},
            { torso: [0.05, 0, -0.3], armR: [-0.6, 0.1, 0], armL: [0.3, 0.1, 0], legL: [0.25, 0, 0], legR: [-0.2, 0, 0] },
            { torso: [-0.2, 0, 0.3], armR: [1.5, 0, 0], armL: [1.2, -0.15, 0], legL: [0.4, 0, 0], legR: [-0.3, 0, 0], shift: [0.4, -0.05, 0] },
            {},
        ],
    },
    [POSE.SWING]: {
        seconds: 0.6, hold: 1 / 3, keys: [
            {},
            { torso: [0.15, 0, -0.25], armR: [-2.8, -0.1, 0], armL: [-2.6, -0.25, 0], legL: [0.25, 0, 0], legR: [-0.2, 0, 0] },
            { torso: [-0.35, 0, 0.3], armR: [-5.38, 0, 0], armL: [-5.45, -0.2, 0], legL: [0.35, 0, 0], legR: [-0.3, 0, 0], shift: [0.2, -0.1, 0] },
            { armR: [-TAU, 0, 0], armL: [-TAU, 0, 0] },
        ],
    },
    // A bow: side-on to the target, the bow arm out (the left), the string
    // drawn to the chest, loosed, and down. Held, it waits drawn.
    [POSE.SHOOT]: {
        seconds: 0.7, hold: 1 / 3, keys: [
            {},
            { ...STANCE, torso: [0, 0, -0.5], head: [0, 0, 0.45], armL: [1.5, 0, 0.5], armR: [1.35, -0.55, 0.85] },
            { ...STANCE, torso: [0, 0, -0.5], head: [0, 0, 0.45], armL: [1.5, 0, 0.5], armR: [1.05, 0.25, 0.4] },
            {},
        ],
    },
    // Kneel and reach for the ground, one hand and then the other.
    [POSE.GATHER]: {
        seconds: 1.6, cycle: true, keys: [
            { ...KNEEL, torso: [-0.75, 0, 0], head: [-0.15, 0, 0], armR: [1.15, 0.05, 0], armL: [0.8, 0.05, 0] },
            { ...KNEEL, torso: [-0.75, 0, 0], head: [-0.15, 0, 0], armR: [0.95, 0.05, 0.2], armL: [0.95, 0.05, 0] },
            { ...KNEEL, torso: [-0.75, 0, 0], head: [-0.15, 0, 0], armR: [0.8, 0.05, 0], armL: [1.15, 0.05, 0] },
            { ...KNEEL, torso: [-0.75, 0, 0], head: [-0.15, 0, 0], armR: [0.95, 0.05, 0], armL: [0.95, 0.05, -0.2] },
        ],
    },
    // Kneel over a carcass: one hand holds, the other cuts.
    [POSE.BUTCHER]: {
        seconds: 1, cycle: true, keys: [
            { ...KNEEL, torso: [-0.6, 0, 0], head: [-0.2, 0, 0], armL: [1, -0.1, 0], armR: [0.7, -0.05, 0] },
            { ...KNEEL, torso: [-0.6, 0, 0], head: [-0.2, 0, 0], armL: [1, -0.1, 0], armR: [1.25, -0.1, 0] },
            { ...KNEEL, torso: [-0.6, 0, 0], head: [-0.2, 0, 0], armL: [1, -0.1, 0], armR: [0.7, -0.05, 0] },
            { ...KNEEL, torso: [-0.6, 0, 0], head: [-0.2, 0, 0], armL: [1, -0.1, 0], armR: [1.25, -0.1, 0] },
        ],
    },
    // Hand to mouth, and chew.
    [POSE.EAT]: {
        seconds: 1.4, cycle: true, keys: [
            { armR: [0.5, -0.1, 0], armL: [0.35, 0, 0] },
            { armR: [1.85, -0.35, 0], armL: [0.35, 0, 0], head: [-0.1, 0, 0] },
            { armR: [1.85, -0.35, 0], armL: [0.35, 0, 0], head: [0.05, 0, 0] },
            { armR: [0.5, -0.1, 0], armL: [0.35, 0, 0] },
        ],
    },
    // Two-handed, over the top, at a tree.
    [POSE.CHOP]: {
        seconds: 1, cycle: true, keys: [
            { ...STANCE, torso: [0.15, 0, 0], armR: [-2.7, -0.1, 0], armL: [-2.6, -0.2, 0] },
            { ...STANCE, torso: [-0.35, 0, 0], armR: [-5.28, -0.1, 0], armL: [-5.3, -0.2, 0], shift: [0, -0.1, 0] },
            { ...STANCE, torso: [-0.3, 0, 0], armR: [-5.48, -0.1, 0], armL: [-5.5, -0.2, 0], shift: [0, -0.1, 0] },
            { ...STANCE, armR: [-4, -0.1, 0], armL: [-3.9, -0.2, 0] },
        ],
    },
    // Seated, striking one stone with another.
    [POSE.KNAP]: {
        seconds: 0.7, cycle: true, keys: [
            { ...SEATED, torso: [-0.35, 0, 0], head: [-0.35, 0, 0], armL: [0.85, -0.1, 0], armR: [0.55, -0.1, 0] },
            { ...SEATED, torso: [-0.35, 0, 0], head: [-0.35, 0, 0], armL: [0.85, -0.1, 0], armR: [1.15, -0.15, 0] },
            { ...SEATED, torso: [-0.35, 0, 0], head: [-0.35, 0, 0], armL: [0.85, -0.1, 0], armR: [0.55, -0.1, 0] },
            { ...SEATED, torso: [-0.35, 0, 0], head: [-0.35, 0, 0], armL: [0.85, -0.1, 0], armR: [1.15, -0.15, 0] },
        ],
    },
    // Seated, hands working together.
    [POSE.CRAFT]: {
        seconds: 1.6, cycle: true, keys: [
            { ...SEATED, torso: [-0.3, 0, 0], head: [-0.3, 0, 0], armL: [0.8, -0.25, 0], armR: [1, -0.25, 0] },
            { ...SEATED, torso: [-0.3, 0, 0], head: [-0.3, 0, 0], armL: [0.9, -0.3, 0.15], armR: [0.9, -0.3, -0.15] },
            { ...SEATED, torso: [-0.3, 0, 0], head: [-0.3, 0, 0], armL: [1, -0.25, 0], armR: [0.8, -0.25, 0] },
            { ...SEATED, torso: [-0.3, 0, 0], head: [-0.3, 0, 0], armL: [0.9, -0.2, 0], armR: [0.9, -0.2, 0] },
        ],
    },
    // Resting at camp, legs out, looking about now and then.
    [POSE.SIT]: {
        seconds: 4, cycle: true, keys: [
            { ...SEATED, torso: [0.08, 0, 0], armL: [0.35, 0.15, 0], armR: [0.35, 0.15, 0] },
            { ...SEATED, torso: [0.08, 0, 0], armL: [0.35, 0.15, 0], armR: [0.35, 0.15, 0], head: [-0.12, 0, 0] },
            { ...SEATED, torso: [0.08, 0, 0], armL: [0.35, 0.15, 0], armR: [0.35, 0.15, 0], head: [-0.05, 0, 0.25] },
            { ...SEATED, torso: [0.08, 0, 0], armL: [0.35, 0.15, 0], armR: [0.35, 0.15, 0], head: [0, 0, -0.1] },
        ],
    },
    // Curled up, over and over forward, about the middle of the curled body.
    [POSE.ROLL]: {
        seconds: 0.4, keys: [
            { pivot: [0.9, -0.45, 0] },
            { ...CURL, root: [-2.1, 0, 0], pivot: [0.9, -0.45, 0] },
            { ...CURL, root: [-4.2, 0, 0], pivot: [0.9, -0.45, 0] },
            { root: [-TAU, 0, 0], pivot: [0.9, -0.45, 0] },
        ],
    },
    // Face down, tipping over the toes, arms flung forward; it comes to lie
    // over the spot where it died.
    [POSE.FALL]: {
        seconds: 0.5, hold: 1, keys: [
            { pivot: [0.42, -1.85, 0] },
            { root: [-0.3, 0, 0], shift: [-0.2, 0, 0], armL: [0.6, 0.2, 0], armR: [0.7, 0.2, 0], pivot: [0.42, -1.85, 0] },
            { root: [-1, 0, 0], shift: [-1.2, 0, 0], armL: [1.6, 0.25, 0], armR: [1.8, 0.2, 0], head: [0.2, 0, 0], pivot: [0.42, -1.85, 0] },
            {
                root: [-Math.PI / 2, 0, 0], shift: [-2.4, 0.15, 0], armL: [2.7, 0.3, 0], armR: [2.5, 0.15, 0], head: [0.1, 0, 0.7],
                legL: [0, 0.12, 0], legR: [0.15, 0.05, 0], pivot: [0.42, -1.85, 0],
            },
        ],
    },
    // Low, watchful.
    [POSE.CROUCH]: {
        seconds: 2.4, cycle: true, keys: [
            CROUCHED,
            { ...CROUCHED, torso: [-0.63, 0, 0] },
            CROUCHED,
            { ...CROUCHED, head: [0.45, 0, 0.15] },
        ],
    },
    // Children at play: hop, arms up.
    [POSE.HOP]: {
        seconds: 0.6, cycle: true, keys: [
            { shift: [0, -0.15, 0], legL: [0.1, 0, 0], legR: [-0.1, 0, 0], armL: [0.3, 0.2, 0], armR: [0.3, 0.2, 0] },
            { shift: [0, 0.5, 0], legL: [-0.2, 0, 0], legR: [-0.2, 0, 0], armL: [2.5, 0.3, 0], armR: [2.5, 0.3, 0] },
            { shift: [0, 0.85, 0], legL: [-0.15, 0.1, 0], legR: [-0.15, 0.1, 0], armL: [2.8, 0.4, 0], armR: [2.8, 0.4, 0] },
            { shift: [0, 0.4, 0], legL: [0.05, 0, 0], legR: [0.05, 0, 0], armL: [1.2, 0.25, 0], armR: [1.2, 0.25, 0] },
        ],
    },
};

// The bodies the poses were written for (shapes.js): an animal's height of
// the body's middle (the root), its half width, and its length; a person's hips.
// An imported body of other proportions (models.js) scales the poses' shift
// and pivot by its own, so it falls onto its own side.
export const FRAME = {
    human: { hip: 1.85 }, // (people: the height of the hips)
    herbivore: { center: 2.05, half: 1.4, length: 5 },
    carnivore: { center: 2.0, half: 0.78, length: 7 },
};

// Grazers. Body centre at 2.05 (its half width 1.4), neck at 1.2, 2.45.
const GRAZING = {
    seconds: 2.4, cycle: true, keys: [
        { torso: [-0.12, 0, 0], head: [-1.2, 0, 0] },
        { torso: [-0.12, 0, 0], head: [-1.3, 0, 0.12] },
        { torso: [-0.12, 0, 0], head: [-1.15, 0, 0] },
        { torso: [-0.12, 0, 0], head: [-1.3, 0, -0.12] },
    ],
};
// An animal falls onto its side, tipping over its feet (half its width), and
// comes to lie over the spot where it died (`back`: how far it slides back).
const fall = (pivot, back, head) => ({
    seconds: 0.5, hold: 1, keys: [
        { pivot },
        { root: [0, 0.3, 0], shift: [0, 0, -back * 0.1], pivot },
        { root: [0, 1.1, 0], shift: [0, 0, -back * 0.55], head: [-0.2, 0, 0], pivot },
        {
            root: [0, Math.PI / 2, 0], shift: [0, 0, -back], head, pivot,
            legFL: [0.2, 0, 0], legFR: [0.35, 0, 0], legBL: [-0.25, 0, 0], legBR: [-0.1, 0, 0],
        },
    ],
});
const herbivore = {
    [POSE.GRAZE]: GRAZING,
    [POSE.EAT]: GRAZING,
    [POSE.FALL]: fall([0, -FRAME.herbivore.center, FRAME.herbivore.half], 2.9, [-0.45, 0.25, 0]),
};

// Predators. Body centre at 2.0 (its half width 0.78), neck at 1.3, 2.25.
const STALK = {
    shift: [0, -0.3, 0], torso: [-0.05, 0, 0], head: [-0.2, 0, 0],
    legFL: [0.35, 0.45, 0], legFR: [0.35, 0.45, 0], legBL: [-0.35, 0.45, 0], legBR: [-0.35, 0.45, 0],
};
const carnivore = {
    // Head down at the kill, tearing side to side, forelegs braced.
    [POSE.EAT]: {
        seconds: 0.9, cycle: true, keys: [
            { torso: [-0.18, 0, 0], legFL: [0.3, 0.1, 0], legFR: [0.3, 0.1, 0], head: [-0.95, 0, 0.2] },
            { torso: [-0.18, 0, 0], legFL: [0.3, 0.1, 0], legFR: [0.3, 0.1, 0], head: [-0.7, 0, -0.1] },
            { torso: [-0.18, 0, 0], legFL: [0.3, 0.1, 0], legFR: [0.3, 0.1, 0], head: [-0.95, 0, -0.25] },
            { torso: [-0.18, 0, 0], legFL: [0.3, 0.1, 0], legFR: [0.3, 0.1, 0], head: [-0.7, 0, 0.1] },
        ],
    },
    // Gather, spring forward with forelegs reaching, land.
    [POSE.POUNCE]: {
        seconds: 0.55, hold: 1 / 3, keys: [
            {},
            { root: [0.12, 0, 0], shift: [-0.2, -0.25, 0], legBL: [0.45, 0, 0], legBR: [0.45, 0, 0], legFL: [0.2, 0, 0], legFR: [0.2, 0, 0], head: [-0.1, 0, 0] },
            {
                root: [-0.08, 0, 0], shift: [1.6, 0.55, 0], torso: [-0.05, 0, 0], head: [-0.3, 0, 0],
                legFL: [1.05, 0, 0], legFR: [1, 0, 0], legBL: [-0.95, 0, 0], legBR: [-0.9, 0, 0],
            },
            {},
        ],
    },
    // Stalking: low, legs splayed.
    [POSE.CROUCH]: {
        seconds: 2, cycle: true, keys: [STALK, { ...STALK, head: [-0.2, 0, 0.1] }, STALK, { ...STALK, head: [-0.2, 0, -0.1] }],
    },
    [POSE.FALL]: fall([0, -FRAME.carnivore.center, FRAME.carnivore.half], 2.3, [-0.3, 0.2, 0]),
};

export const POSES = { herbivore, carnivore, human };

// Does this species have this pose? (NONE: everyone.)
export const poseApplies = (kind, code) => code === POSE.NONE || POSES[kind][code] !== undefined;

// One column of a pose, `progress` (0..1) of the way through: what the shader
// computes (here for the tests and anyone curious).
export function samplePose(kind, code, progress, column) {
    const def = POSES[kind][code];
    if (!def) return [0, 0, 0];
    const f = progress * (def.cycle ? KEYS : KEYS - 1);
    const k = Math.min(Math.floor(f), KEYS - 1);
    let t = f - k;
    t = t * t * (3 - 2 * t);
    const k1 = def.cycle ? (k + 1) % KEYS : Math.min(k + 1, KEYS - 1);
    const a = def.keys[k][column] ?? [0, 0, 0];
    const b = def.keys[k1][column] ?? [0, 0, 0];
    return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * t);
}
