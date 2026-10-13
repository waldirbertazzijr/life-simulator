// Bodies in motion: legs that walk, heads that graze, people who sit, kneel,
// throw and fall.
//
// The animation runs on the graphics card, so a thousand grazers stay one
// draw call. Every vertex of a body knows which part it belongs to (torso,
// head, a leg, an arm) and where that part's joint is (shapes.js). Every
// drawn individual carries two numbers for its gait, how far through a
// stride it is and how fast it goes, and three for a pose: which one, how far
// through it, and how much of it. The vertex shader below turns each part
// about its joint:
// - the legs swing with the stride, and the body sinks a little as they
//   swing apart, so the feet stay on the ground;
// - running, four legs bound and people lean forward;
// - a pose (grazing, sitting, a throw, a fall) moves the parts as its
//   keyframes (keyframes.js) say. The keyframes of every pose live in a
//   small table, a texture the shader reads only while a pose is showing.
//
// Motion, at the end, keeps each individual's stride and pose from frame to
// frame. The stride advances with the distance it was actually drawn moving,
// never with time, so feet do not slide; the poses come from what each one
// is doing (its state), or are set by others (pose, hold, release).
//
// There is no three.js in this file: its logic is tested in node
// (test/animate.test.mjs).
import { STATE } from '../population.js';
import { STEPS_PER_SECOND } from '../sim.js';
import { wrapDelta, hash, clamp01 } from './util.js';
import { POSE, POSE_NAMES, KEYS, POSES } from './keyframes.js';
import { DYE, SHAVED, STUBBLE } from './looks.js';

// (The poses' codes and keyframes, from here as ever.)
export { POSE, POSE_NAMES, KEYS, POSES, poseApplies, samplePose } from './keyframes.js';

const CODES = POSE_NAMES.length;

// The parts of a body, as each vertex is tagged (shapes.js). Animals use the
// four legs; people use legs 2 (left) and 3 (right), and the two arms.
export const PART = Object.freeze({ TORSO: 0, HEAD: 1, LEG_FL: 2, LEG_FR: 3, LEG_BL: 4, LEG_BR: 5, ARM_L: 6, ARM_R: 7 });

export const KINDS = ['herbivore', 'carnivore', 'human'];

// People asleep at camp at night (stage 4, wp-1-interface.md): the
// simulation's STATE.SLEEPING, lying down in the SLEEP pose.
export const SLEEPING = STATE.SLEEPING;

// How each species walks:
// - leg: from the hip joint to the sole (shapes.js puts the joints there; a
//   model, models.js, sets its own when it loads);
// - swing: how far a leg swings either way at a walk (radians), and runSwing
//   how much more when running;
// - pitch: the body's rocking when bounding;
// - lean: the torso tips forward running (people, and a predator in a
//   chase), and headLean the head;
// - arms: how far arms swing;
// - quad: four legs (they trot, and bound when running) or two.
export const GAIT = {
    herbivore: { leg: 1.5, swing: 0.45, runSwing: 0.35, pitch: 0.1, lean: 0, headLean: 0.12, arms: 0, quad: 1 },
    carnivore: { leg: 1.55, swing: 0.5, runSwing: 0.5, pitch: 0.08, lean: -0.08, headLean: -0.12, arms: 0, quad: 1 },
    human: { leg: 1.85, swing: 0.42, runSwing: 0.6, pitch: 0, lean: -0.3, headLean: 0.15, arms: 0.35, quad: 0 },
};

// The ground covered by one whole stride with the feet planted: each foot
// sweeps 2·leg·sin(swing) while it is down, which is half the cycle.
export function strideOf(kind, amount) {
    const g = GAIT[kind];
    return 4 * g.leg * Math.sin(g.swing * (1 + g.runSwing * clamp01(amount - 1)));
}

// The table's columns: the eight parts (people's legs are the first two),
// then the whole body's turn, its shift, and its pivot.
const COLUMN = {
    torso: 0, head: 1, legFL: 2, legL: 2, legFR: 3, legR: 3, legBL: 4, legBR: 5, armL: 6, armR: 7,
    root: 8, shift: 9, pivot: 10,
};
const ROOT = 8;
const SHIFT = 9;
const PIVOT = 10;
export const COLS = 11;

// The first row of a species' keys in the table.
export const firstRow = (kind) => KINDS.indexOf(kind) * CODES * KEYS;

// The keyframes as a float texture's data: a row per (species, pose, key),
// COLS texels of four numbers per row. The shift column's fourth number says
// whether the pose's keys form a cycle.
export function poseTable() {
    const height = KINDS.length * CODES * KEYS;
    const data = new Float32Array(height * COLS * 4);
    for (const kind of KINDS) {
        for (const [code, def] of Object.entries(POSES[kind])) {
            for (let k = 0; k < KEYS; k++) {
                const row = firstRow(kind) + Number(code) * KEYS + k;
                for (const [name, v] of Object.entries(def.keys[k])) data.set(v, (row * COLS + COLUMN[name]) * 4);
                data[(row * COLS + SHIFT) * 4 + 3] = def.cycle ? 1 : 0;
            }
        }
    }
    return { data, width: COLS, height };
}

// ---- The vertex shader ----
//
// Injected into each species' material (creatures.js) in place of
// <begin_vertex>. Per vertex: its part's own joint first, then (head and
// arms) the torso's, then the whole body's. Lighting needs no normals:
// the materials are flat-shaded, which takes each face's normal from the
// moved positions themselves.
export const VERTEX_PARS = /* glsl */ `
attribute vec4 rig;   // the joint of this vertex's part (x, y, z), and the part
attribute vec3 gait;  // per individual: how far through a stride (0..1), how fast (0 still, 1 walking, 2 running),
                      // and how much it wears its map colour (small on screen) over its own
attribute vec3 pose;  // per individual: the pose, how far through it (0..1), and how much of it (0..1)
#ifdef PEOPLE
attribute float dye;  // this vertex's colour role (looks.js DYE): 0 its own, 1 skin, 2 cloth, 10 + style: hair
attribute vec3 cloth; // per person: their clothes' colour (their tribe's, muted)
attribute vec3 skin;  // per person: their skin
attribute vec4 hair;  // per person: their hair's colour, and its style
#else
uniform vec3 uLook;   // the species' map colour (the 2D map's)
#endif
uniform highp sampler2D uPoses; // the keyframes (poseTable)
uniform int uRow;     // this species' first row in it
uniform vec3 uTorso;  // the torso's joint: head and arms ride on it
uniform vec3 uRoot;   // the whole body turns about this
uniform vec3 uBody;   // this body's proportions to the one the poses were written for (keyframes.js FRAME): 1, 1, 1 for shapes.js's
uniform vec4 uGaitA;  // leg swing, its increase running, leg length, rocking when bounding
uniform vec4 uGaitB;  // torso and head lean running, arm swing, four legs (1) or two (0)

// v turned by r: outward (r.y, about x) first, then forward (r.x, about z),
// then the twist (r.z, about y).
vec3 turn( vec3 v, vec3 r ) {
    float c = cos( r.y );
    float s = sin( r.y );
    v = vec3( v.x, c * v.y - s * v.z, s * v.y + c * v.z );
    c = cos( r.x );
    s = sin( r.x );
    v = vec3( c * v.x - s * v.y, s * v.x + c * v.y, v.z );
    c = cos( r.z );
    s = sin( r.z );
    return vec3( c * v.x + s * v.z, v.y, -s * v.x + c * v.z );
}

// One column of the table, between two key rows.
vec3 keyed( int col, int r0, int r1, float t ) {
    return mix( texelFetch( uPoses, ivec2( col, r0 ), 0 ).xyz, texelFetch( uPoses, ivec2( col, r1 ), 0 ).xyz, t );
}
`;

export const VERTEX_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
#ifdef PEOPLE
// Every hair style is on every head: those this person does not wear fold
// to a point, and draw nothing.
if ( dye > ${DYE.hair - 0.5} && abs( dye - ${DYE.hair}.0 - hair.w ) > 0.5 ) transformed = rig.xyz;
#endif
{
    int part = int( rig.w + 0.5 );
    float ph = gait.x * 6.2831853;
    float walk = clamp( gait.y, 0.0, 1.0 );
    float run = clamp( gait.y - 1.0, 0.0, 1.0 );
    float swing = uGaitA.x * walk * ( 1.0 + uGaitA.y * run );
    float sw = sin( ph );
    vec3 own = vec3( 0.0 );                        // this part's turn about its joint
    vec3 torso = vec3( uGaitB.x * run, 0.0, 0.0 ); // the torso's (and so the head's and arms')
    vec3 root = vec3( uGaitA.w * run * cos( ph ), 0.0, 0.0 );
    // The body sinks as the legs swing apart, so the feet stay on the ground.
    vec3 shift = vec3( 0.0, -uGaitA.z * ( 1.0 - cos( swing * sw ) ), 0.0 );
    vec3 pivot = uRoot;
    if ( part >= 2 && part <= 5 ) {
        // Walking, diagonal legs move together (people: one, then the other);
        // four legs at a run bound, the front pair and then the back pair.
        float trot = ( part == 3 || part == 4 ) ? 3.14159265 : 0.0;
        float bound = ( part >= 4 ? 3.14159265 : 0.0 ) + ( ( part == 3 || part == 5 ) ? 0.5 : 0.0 );
        own.x = swing * sin( ph + mix( trot, bound, run * uGaitB.w ) );
    } else if ( part >= 6 ) {
        own.x = uGaitB.z * walk * ( 1.0 + run ) * ( part == 6 ? -sw : sw ); // each arm with the other side's leg
    } else if ( part == 1 ) {
        own.x = uGaitB.y * run + 0.05 * walk * sin( 2.0 * ph );
    }
    if ( pose.z > 0.0 ) {
        int base = uRow + int( pose.x + 0.5 ) * ${KEYS};
        bool cycle = texelFetch( uPoses, ivec2( ${SHIFT}, base ), 0 ).w > 0.5;
        float f = pose.y * ( cycle ? ${KEYS}.0 : ${KEYS - 1}.0 );
        int k = min( int( f ), ${KEYS - 1} );
        float t = f - float( k );
        t = t * t * ( 3.0 - 2.0 * t );
        int r0 = base + k;
        int r1 = base + ( cycle ? ( k + 1 ) % ${KEYS} : min( k + 1, ${KEYS - 1} ) );
        float w = pose.z;
        if ( part != 0 ) own += w * keyed( part, r0, r1, t );
        if ( part <= 1 || part >= 6 ) torso += w * keyed( 0, r0, r1, t );
        root += w * keyed( ${ROOT}, r0, r1, t );
        shift += w * uBody * keyed( ${SHIFT}, r0, r1, t );
        pivot += w * uBody * keyed( ${PIVOT}, r0, r1, t );
    }
    // "Outward" is away from the body, whichever side the limb is on.
    if ( part >= 2 && rig.z > 0.0 ) own.y = -own.y;
    if ( part != 0 ) transformed = turn( transformed - rig.xyz, own ) + rig.xyz;
    if ( part <= 1 || part >= 6 ) transformed = turn( transformed - uTorso, torso ) + uTorso;
    transformed = turn( transformed - pivot, root ) + pivot + shift;
}
`;

// In place of <color_vertex>: a model's own colours give way to its
// species' map colour as it gets small on screen (creatures.js), so a grey
// wolf a few pixels long still reads as a predator, as on the 2D map.
// People: each vertex's colour by its role (models.js), with the person's
// skin, clothes and hair (a shaved head: a little of the hair over the
// skin); small on screen, their tribe's colour (instanceColor). (looks.js
// `paint` does the same, for the tests.)
export const VERTEX_COLOR = /* glsl */ `
#ifdef PEOPLE
vColor = color;
if ( dye > ${DYE.hair - 0.5} ) vColor *= abs( hair.w - ${SHAVED}.0 ) < 0.5 ? mix( skin, hair.rgb, ${STUBBLE} ) : hair.rgb;
else if ( dye > ${DYE.cloth - 0.5} ) vColor *= cloth;
else if ( dye > ${DYE.skin - 0.5} ) vColor *= skin;
vColor = mix( vColor, instanceColor, gait.z );
#else
#include <color_vertex>
#ifdef USE_COLOR
vColor.rgb = mix( vColor.rgb, uLook, gait.z );
#endif
#endif
`;

// ---- What each one is doing ----

// The pose a state shows. `still`: not walking anywhere. (Chopping and
// quarrying also cover the walk to the spot: their poses wait for it.)
export function statePose(kind, state, still) {
    if (kind === 'herbivore') return state === STATE.GRAZING || state === STATE.EATING ? POSE.GRAZE : POSE.NONE;
    if (kind === 'carnivore') return state === STATE.EATING ? POSE.EAT : POSE.NONE;
    switch (state) {
        case STATE.GATHERING: return still ? POSE.GATHER : POSE.NONE;
        case STATE.AT_CAMP: return still ? POSE.SIT : POSE.NONE;
        case STATE.PLAYING: return POSE.HOP;
        case SLEEPING: return POSE.SLEEP;
        // The controlled person's postures (if the simulation has them).
        case STATE.CREEPING: return POSE.CROUCH;
        case STATE.ROLLING: return POSE.ROLL;
        // Anyone's kill, butchered where it fell; and the work of items.
        case STATE.BUTCHERING: return POSE.BUTCHER;
        case STATE.CHOPPING: return still ? POSE.CHOP : POSE.NONE;
        case STATE.QUARRYING: return still ? POSE.KNAP : POSE.NONE;
        case STATE.CRAFTING: return still ? POSE.CRAFT : POSE.NONE;
        default: return POSE.NONE;
    }
}

// People idle at camp sit for a while, then stand a while: each in a
// SIT_PERIOD (seconds at 1×) of its own, seated SIT_SHARE of it.
const SIT_PERIOD = 40;
const SIT_SHARE = 0.7;
export const sitsNow = (clock, off) => (clock / SIT_PERIOD + off) % 1 < SIT_SHARE;

// Does this state run (the fast gait)?
export const runs = (kind, state) => state === STATE.FLEEING || state === STATE.RUNNING
    || (kind === 'carnivore' && state === STATE.CHASING);

// The two above as tables per species, for the per-frame loop: the pose at
// [state · 2 + still], and whether a state runs.
const STATES = 64;
const POSE_OF = {};
const RUNS = {};
for (const kind of KINDS) {
    POSE_OF[kind] = Uint8Array.from({ length: STATES * 2 }, (_, k) => statePose(kind, k >> 1, (k & 1) === 1));
    RUNS[kind] = Uint8Array.from({ length: STATES }, (_, s) => (runs(kind, s) ? 1 : 0));
}

const MAX_ADVANCE = 0.2; // of a stride per frame at most: at high speed the legs blur rather than spin
const STILL = 0.15;      // a gait amount below this is standing still
const BLEND = 0.25;      // seconds (at 1×) to ease into or out of a pose
const SETTLE = 0.12;     // seconds over which the gait follows a change of speed
const FASTEST = 4;       // poses play at the world's speed, but at most this many times real time
const RAMP = 0.1;        // a cyclic pose played once fades in and out over this long
const FORGET = 600;      // frames unseen before an individual's stride is let go

// Each individual's stride and pose, from frame to frame, by id.
//
// Each frame: tick() with the moment drawn, then for each species
// species(), and track() for each individual, which leaves its numbers in
// phase, amount, code, progress and weight.
//
// The clock (seconds at 1×) runs with the world drawn: it stops when paused
// and speeds up with the world, but no faster than FASTEST times real time,
// so a pounce or a fall can still be seen at 64×.
export class Motion {
    constructor() {
        this.slots = new Map();   // id → slot in the arrays below
        this.oneShots = new Map(); // id → { code, start, length, from }
        this.holds = new Map();    // id → code
        this.capacity = 0;
        this.grow(2048);
        this.reset();
    }

    reset() {
        this.slots.clear();
        this.oneShots.clear();
        this.holds.clear();
        this.free = [];
        this.used = 0;
        this.clock = 0;
        this.shown = NaN;
        this.last = NaN;
        this.dSteps = 0;
        this.dt = 0;
        this.settle = 0;
        this.frame = 0;
        this.phase = 0;
        this.amount = 0;
        this.code = 0;
        this.progress = 0;
        this.weight = 0;
        this.seated = 0; // someone who sits whenever its state says so (the player resting)
    }

    grow(capacity) {
        const more = (Type, old) => {
            const a = new Type(capacity);
            if (old) a.set(old);
            return a;
        };
        this.ph = more(Float64Array, this.ph);     // stride, 0..1
        this.off = more(Float64Array, this.off);   // its own offset into cyclic poses, so a herd does not graze in step
        this.amt = more(Float64Array, this.amt);   // gait amount
        this.lx = more(Float64Array, this.lx);     // where it was drawn last frame
        this.ly = more(Float64Array, this.ly);
        this.cur = more(Uint8Array, this.cur);     // its state's (or held) pose...
        this.w = more(Float64Array, this.w);       // ...and how much of it shows
        this.seen = more(Int32Array, this.seen);   // the frame it was last tracked
        this.tribe = more(Float64Array, this.tribe);
        this.sc = more(Float64Array, this.sc);     // its size (children are smaller)
        this.pc = more(Uint8Array, this.pc);       // the pose it showed when last tracked (as code, progress, weight)...
        this.pp = more(Float64Array, this.pp);
        this.pw = more(Float64Array, this.pw);     // ...for whatever is drawn with the body (items.js)
        this.capacity = capacity;
    }

    // A new frame: the moment drawn (in steps) and now (ms).
    tick(shown, now) {
        let ds = shown - this.shown;
        let dr = (now - this.last) / 1000;
        if (!(ds > 0)) ds = 0; // paused, the same moment again, or the first frame
        if (!(dr > 0)) dr = 0;
        this.shown = shown;
        this.last = now;
        this.dSteps = ds;
        this.dt = Math.min(ds / STEPS_PER_SECOND, dr * FASTEST);
        this.clock += this.dt;
        this.settle = 1 - Math.exp(-this.dt / SETTLE);
        if (++this.frame % 120 === 0) this.sweep();
    }

    // The species about to be tracked: its kind, the world's size and its
    // walking speed (units per step).
    species(kind, W, H, walking) {
        this.kind = kind;
        this.poses = POSES[kind];
        this.poseOf = POSE_OF[kind];
        this.runs = RUNS[kind];
        this.stride = strideOf(kind, 1); // walking; running strides are longer
        this.W = W;
        this.H = H;
        this.walking = walking;
    }

    // One individual this frame, at (x, y) in `state`; its stride and pose
    // are left in phase, amount, code, progress and weight.
    track(id, x, y, state, scale = 1, tribe = 0) {
        let s = this.slots.get(id);
        if (s === undefined) {
            s = this.free.length ? this.free.pop() : this.used++;
            if (s >= this.capacity) this.grow(this.capacity * 2);
            this.slots.set(id, s);
            // Anyone new (a newborn, or someone just come into view) is
            // somewhere in a stride of its own, so a herd never walks in step.
            const h = hash(id);
            this.ph[s] = (h & 0xffff) / 0x10000;
            this.off[s] = (h >>> 16) / 0x10000;
            this.amt[s] = 0;
            this.cur[s] = POSE.NONE;
            this.w[s] = 0;
        } else if (this.dSteps > 0) {
            const dx = wrapDelta(x - this.lx[s], this.W);
            const dy = wrapDelta(y - this.ly[s], this.H);
            const d = Math.sqrt(dx * dx + dy * dy);
            const r = d / this.dSteps / this.walking; // speed, in walking speeds
            let want = r < 1 ? r : 1;
            if (r > 1 && (state < STATES ? this.runs[state] : runs(this.kind, state))) want += r < 2 ? r - 1 : 1;
            const a = this.amt[s] + (want - this.amt[s]) * this.settle;
            this.amt[s] = a;
            let adv = d / ((a > 1 ? strideOf(this.kind, a) : this.stride) * scale);
            if (adv > MAX_ADVANCE) adv = MAX_ADVANCE;
            const p = this.ph[s] + adv;
            this.ph[s] = p - Math.floor(p);
        }
        this.lx[s] = x;
        this.ly[s] = y;
        this.seen[s] = this.frame;
        this.tribe[s] = tribe;
        this.sc[s] = scale;
        this.phase = this.ph[s];
        this.amount = this.amt[s];

        // The pose its state shows (or one it is told to hold), eased in and
        // out: a change waits for the old pose to ease out first.
        const held = this.holds.size ? this.holds.get(id) : undefined;
        const still = this.amt[s] < STILL;
        let want = held ?? (state < STATES ? this.poseOf[state * 2 + (still ? 1 : 0)] : statePose(this.kind, state, still));
        // (Idle at camp, now seated, now standing; resting by choice, seated.)
        if (want === POSE.SIT && held === undefined && id !== this.seated && !sitsNow(this.clock, this.off[s])) want = POSE.NONE;
        let cur = this.cur[s];
        let w = cur === POSE.NONE ? 0 : this.w[s];
        const step = this.dt / BLEND;
        if (want === cur) w = w + step > 1 ? 1 : w + step;
        else if ((w -= step) <= 0) {
            w = 0;
            cur = want;
        }
        this.cur[s] = cur;

        // A one-shot overrides it, and the state's pose eases back in after.
        const one = this.oneShots.size ? this.oneShots.get(id) : undefined;
        if (one !== undefined) {
            const def = this.poses[one.code];
            if (one.length !== one.length) one.length = def ? def.seconds : 0.5;
            if (one.from !== one.from) one.from = def?.hold ?? 0;
            const t = this.clock - one.start;
            if (t < one.length) {
                this.w[s] = 0;
                this.code = one.code;
                this.progress = one.from + (1 - one.from) * (t / one.length);
                // A sequence starts and ends at rest; a cycle played once fades in and out.
                const ramp = Math.min(RAMP, one.length / 4);
                this.weight = def?.cycle ? Math.min(1, one.from > 0 ? 1 : t / ramp, (one.length - t) / ramp) : 1;
                this.keep(s);
                return;
            }
            this.oneShots.delete(id);
        }
        this.w[s] = w;
        this.code = cur;
        this.weight = cur === POSE.NONE ? 0 : w;
        this.progress = cur === POSE.NONE ? 0 : this.progressOf(cur, s);
        this.keep(s);
    }

    // Remember the pose just worked out for slot s (posed()).
    keep(s) {
        this.pc[s] = this.code;
        this.pp[s] = this.progress;
        this.pw[s] = this.weight;
    }

    // How `id` was posed when last tracked: its stride and pose left in
    // phase, amount, code, progress and weight (as track() leaves them).
    // False if it is not tracked.
    posed(id) {
        const s = this.slots.get(id);
        if (s === undefined) return false;
        this.phase = this.ph[s];
        this.amount = this.amt[s];
        this.code = this.pc[s];
        this.progress = this.pp[s];
        this.weight = this.pw[s];
        return true;
    }

    // How far through a pose that is shown for as long as it lasts: a cycle
    // goes round (each individual at its own point), a sequence stops at its
    // hold, or repeats if it has none.
    progressOf(code, s) {
        const def = this.poses[code];
        if (!def) return 0;
        if (!def.cycle && def.hold !== undefined) return def.hold;
        const p = this.clock / def.seconds + this.off[s];
        return p - Math.floor(p);
    }

    // A one-shot pose; `seconds` (at 1×) defaults to the pose's own length.
    // If the same pose is being held, it carries on from the hold, which ends.
    pose(id, code, seconds) {
        const from = this.holds.get(id) === code ? NaN : 0; // NaN: the hold point, once the species is known
        if (from !== 0) this.holds.delete(id);
        this.oneShots.set(id, { code, start: this.clock, length: seconds > 0 ? seconds : NaN, from });
    }

    // Show a pose until release(): a cycle loops; a sequence stops at its
    // wind-up (a throw drawn back), or repeats (a roll).
    hold(id, code) {
        this.holds.set(id, code);
    }

    release(id) {
        this.holds.delete(id);
    }

    // How an individual last looked (its tribe and size), or null.
    describe(id) {
        const s = this.slots.get(id);
        return s === undefined ? null : { tribe: this.tribe[s], scale: this.sc[s], phase: this.ph[s] };
    }

    // An individual is gone (dead): let go of all of it.
    forget(id) {
        const s = this.slots.get(id);
        if (s !== undefined) {
            this.slots.delete(id);
            this.free.push(s);
        }
        this.oneShots.delete(id);
        this.holds.delete(id);
    }

    // Now and then: let go of those not drawn for a while (off screen), and
    // of one-shots long over.
    sweep() {
        for (const [id, s] of this.slots) {
            if (this.frame - this.seen[s] > FORGET) {
                this.slots.delete(id);
                this.free.push(s);
            }
        }
        for (const [id, one] of this.oneShots) {
            if (this.clock - one.start > (one.length === one.length ? one.length : 5) + 1) this.oneShots.delete(id);
        }
    }
}
