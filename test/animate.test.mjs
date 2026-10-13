// Bodies in motion (src/view3d/): gait and poses (animate.js), body parts
// (shapes.js), carcasses and blood (effects.js), meat racks (camps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { params } from '../src/config.js';
import { STATE } from '../src/population.js';

// The view's modules import 'three', which the page maps to the vendored
// copy (an import map in index.html); here a loader hook does the same.
const THREE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(
    `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true } : next(s, c); }`,
)}`);

const { POSE, POSES, KINDS, Motion, statePose, poseApplies, samplePose, strideOf } = await import('../src/view3d/animate.js');

const W = 1000;
const H = 600;
const TAU = Math.PI * 2;
const walking = (kind) => params[kind].speed * params[kind].cruise; // units per step at gene 1

// A Motion whose clock has started; frame() moves it on by one 60 Hz frame
// at 1× (a quarter of a step), or as told.
function motion() {
    const m = new Motion();
    m.tick(0, 0);
    return m;
}
const frame = (m, steps = 0.25, ms = 1000 / 60) => m.tick(m.shown + steps, m.last + ms);
function track(m, kind, id, x, y, state, scale = 1, tribe = 0) {
    m.species(kind, W, H, walking(kind));
    m.track(id, x, y, state, scale, tribe);
    return { phase: m.phase, amount: m.amount, code: m.code, progress: m.progress, weight: m.weight };
}
// Walk an individual along x at `perStep` units per step for `frames` frames.
function walk(m, kind, id, x0, perStep, frames, state = STATE.SEARCHING, scale = 1) {
    let x = x0;
    let out = null;
    for (let f = 0; f < frames; f++) {
        frame(m);
        x += perStep * 0.25;
        out = track(m, kind, id, x, 100, state, scale);
    }
    return { x, ...out };
}
const cycleDelta = (a, b) => ((b - a) % 1 + 1) % 1;

test('pose codes are the agreed numbers', () => {
    assert.deepEqual({ ...POSE }, {
        NONE: 0, THROW: 1, JAB: 2, SWING: 3, GATHER: 4, BUTCHER: 5, EAT: 6, CHOP: 7, KNAP: 8,
        CRAFT: 9, SIT: 10, ROLL: 11, FALL: 12, CROUCH: 13, POUNCE: 14, GRAZE: 15, HOP: 16, SHOOT: 17,
    });
});

test('the gait advances with distance, not time', () => {
    const m = motion();
    const settled = walk(m, 'herbivore', 7, 100, 0.5, 120); // up to a steady walk
    assert.ok(Math.abs(settled.amount - 1) < 0.01, `walking amount ${settled.amount}`);
    // Three and a quarter strides further on, the legs are a quarter cycle on.
    const stride = strideOf('herbivore', 1);
    const n = 52;
    const per = (stride * 3.25) / n;
    let x = settled.x;
    let out;
    for (let f = 0; f < n; f++) {
        frame(m);
        x += per;
        out = track(m, 'herbivore', 7, x, 100, STATE.SEARCHING);
    }
    assert.ok(Math.abs(cycleDelta(settled.phase, out.phase) - 0.25) < 1e-6, `advanced ${cycleDelta(settled.phase, out.phase)}`);
    // Standing still while time passes: the legs stay where they are.
    for (let f = 0; f < 60; f++) {
        frame(m);
        track(m, 'herbivore', 7, x, 100, STATE.GRAZING);
    }
    assert.equal(m.phase, out.phase);
});

test("the gait takes the short way across the world's edge", () => {
    const m = motion();
    walk(m, 'herbivore', 7, W - 30, 0.5, 120); // settled, heading for the edge
    frame(m);
    const before = track(m, 'herbivore', 7, W - 0.2, 100, STATE.SEARCHING).phase;
    frame(m);
    const after = track(m, 'herbivore', 7, 0.1, 100, STATE.SEARCHING).phase;
    const expect = 0.3 / strideOf('herbivore', m.amount);
    assert.ok(Math.abs(cycleDelta(before, after) - expect) < 0.01, `advanced ${cycleDelta(before, after)}, want ${expect}`);
});

test('newborns start mid-stride, not in step', () => {
    const m = motion();
    const quarters = [0, 0, 0, 0];
    const phases = [];
    for (let id = 1000; id < 1400; id++) {
        const { phase } = track(m, 'herbivore', id, 50, 50, STATE.GRAZING);
        assert.ok(phase >= 0 && phase < 1);
        quarters[Math.floor(phase * 4)]++;
        phases.push(phase);
    }
    for (const q of quarters) assert.ok(q > 60, `quarters ${quarters}`);
    let same = 0;
    for (let k = 1; k < phases.length; k++) if (Math.abs(phases[k] - phases[k - 1]) < 0.005) same++;
    assert.ok(same < 15, `${same} consecutive ids nearly in step`);
});

test('a child takes shorter strides', () => {
    const m = motion();
    const a = walk(m, 'human', 1, 100, 0.4, 120);
    const c = walk(m, 'human', 2, 100, 0.4, 120, STATE.SEARCHING, 0.62);
    const a0 = a.phase;
    const c0 = c.phase;
    const a1 = walk(m, 'human', 1, a.x, 0.4, 8).phase;
    const c1 = walk(m, 'human', 2, c.x, 0.4, 8, STATE.SEARCHING, 0.62).phase;
    const ratio = cycleDelta(c0, c1) / cycleDelta(a0, a1);
    assert.ok(Math.abs(ratio - 1 / 0.62) < 0.02, `ratio ${ratio}`);
});

test('a jump does not spin the legs', () => {
    const m = motion();
    const { phase } = track(m, 'carnivore', 9, 100, 100, STATE.ROAMING);
    frame(m);
    const after = track(m, 'carnivore', 9, 160, 100, STATE.ROAMING).phase;
    assert.ok(cycleDelta(phase, after) <= 0.2 + 1e-9);
});

test('state decides the pose', () => {
    const S = STATE;
    assert.equal(statePose('herbivore', S.GRAZING, true), POSE.GRAZE);
    assert.equal(statePose('herbivore', S.EATING, true), POSE.GRAZE);
    assert.equal(statePose('herbivore', S.SEARCHING, false), POSE.NONE);
    assert.equal(statePose('herbivore', S.FLEEING, false), POSE.NONE);
    assert.equal(statePose('carnivore', S.EATING, true), POSE.EAT);
    assert.equal(statePose('carnivore', S.CHASING, false), POSE.NONE);
    assert.equal(statePose('human', S.GATHERING, true), POSE.GATHER);
    assert.equal(statePose('human', S.GATHERING, false), POSE.NONE);
    assert.equal(statePose('human', S.AT_CAMP, true), POSE.SIT);
    assert.equal(statePose('human', S.AT_CAMP, false), POSE.NONE);
    assert.equal(statePose('human', S.PLAYING, true), POSE.HOP);
    assert.equal(statePose('human', S.PLAYING, false), POSE.HOP);
    assert.equal(statePose('human', S.HUNTING, true), POSE.NONE);
    // In Motion: a grazer standing at its patch eases into the pose.
    const m = motion();
    let out;
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'herbivore', 3, 10, 10, S.GRAZING);
    }
    assert.equal(out.code, POSE.GRAZE);
    assert.equal(out.weight, 1);
    // Off it goes: the pose eases out, then there is none.
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'herbivore', 3, 10 + f * 0.1, 10, S.SEARCHING);
    }
    assert.equal(out.code, POSE.NONE);
    assert.equal(out.weight, 0);
});

test('running states make a fast gait', () => {
    const m = motion();
    const top = params.herbivore.speed * 1.3; // a typical grazer's top speed
    assert.ok(walk(m, 'herbivore', 1, 100, top, 120, STATE.FLEEING).amount > 1.5);
    assert.ok(walk(m, 'herbivore', 2, 100, top, 120, STATE.SEARCHING).amount <= 1);
    const chase = params.carnivore.speed * 1.55;
    assert.ok(walk(m, 'carnivore', 3, 100, chase, 120, STATE.CHASING).amount > 1.5);
    assert.ok(walk(m, 'carnivore', 4, 100, chase * 0.4, 120, STATE.ROAMING).amount <= 1);
    // Standing still is still, whatever the state.
    for (let f = 0; f < 120; f++) {
        frame(m);
        track(m, 'carnivore', 5, 100, 100, STATE.CHASING);
    }
    assert.ok(m.amount < 0.01);
});

test("a one-shot plays once, then the state's pose returns", () => {
    const m = motion();
    for (let f = 0; f < 60; f++) {
        frame(m);
        track(m, 'carnivore', 5, 100, 100, STATE.EATING);
    }
    m.pose(5, POSE.POUNCE, 0.5);
    frame(m);
    let out = track(m, 'carnivore', 5, 100, 100, STATE.EATING);
    assert.equal(out.code, POSE.POUNCE);
    assert.ok(out.progress > 0 && out.progress < 0.1);
    assert.equal(out.weight, 1);
    for (let f = 0; f < 14; f++) {
        frame(m);
        out = track(m, 'carnivore', 5, 100, 100, STATE.EATING);
    }
    assert.equal(out.code, POSE.POUNCE);
    assert.ok(Math.abs(out.progress - 0.5) < 0.04, `half way: ${out.progress}`);
    for (let f = 0; f < 16; f++) {
        frame(m);
        out = track(m, 'carnivore', 5, 100, 100, STATE.EATING);
    }
    assert.equal(out.code, POSE.EAT);
    assert.ok(out.weight < 0.2, 'the state pose eases back in');
    // The length defaults to the pose's own.
    m.pose(5, POSE.POUNCE);
    frame(m);
    track(m, 'carnivore', 5, 100, 100, STATE.EATING);
    assert.equal(m.code, POSE.POUNCE);
});

test('hold loops until release', () => {
    const m = motion();
    m.hold(8, POSE.CROUCH);
    let out;
    const seen = [];
    for (let f = 0; f < 400; f++) {
        frame(m);
        out = track(m, 'human', 8, 100, 100, STATE.HUNTING);
        seen.push(out.progress);
    }
    assert.equal(out.code, POSE.CROUCH);
    assert.equal(out.weight, 1);
    assert.ok(seen.some((p, k) => k && p < seen[k - 1]), 'the cycle wraps around');
    m.release(8);
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'human', 8, 100, 100, STATE.HUNTING);
    }
    assert.equal(out.code, POSE.NONE);
    // A one-shot pose held stops at its wind-up; played, it carries on from there.
    m.hold(8, POSE.THROW);
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'human', 8, 100, 100, STATE.HUNTING);
    }
    assert.equal(out.code, POSE.THROW);
    assert.equal(out.progress, POSES.human[POSE.THROW].hold);
    m.pose(8, POSE.THROW, 0.6);
    frame(m);
    out = track(m, 'human', 8, 100, 100, STATE.HUNTING);
    assert.ok(out.progress > POSES.human[POSE.THROW].hold, 'carries on');
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'human', 8, 100, 100, STATE.HUNTING);
    }
    assert.equal(out.code, POSE.NONE, 'and the hold is over');
});

test("poses keep the drawn world's clock: paused they wait, at speed at most 4× real time", () => {
    const m = motion();
    frame(m, 0.25);
    assert.ok(Math.abs(m.clock - 1 / 60) < 1e-9, '1×: a frame is a frame');
    const c = m.clock;
    frame(m, 0);
    assert.equal(m.clock, c, 'paused');
    frame(m, 16); // 64×
    assert.ok(Math.abs(m.clock - c - 4 / 60) < 1e-9, '64×: four frames at most');
    frame(m, 0.5); // 2×
    assert.ok(Math.abs(m.clock - c - 6 / 60) < 1e-9, '2×: as the world goes');
});

test('every key is finite; sequences start at rest and all but FALL end at rest', () => {
    const rest = (v) => v.every((a) => Math.abs(Math.sin(a / 2)) < 1e-6); // a whole number of turns
    for (const kind of KINDS) {
        for (const [code, def] of Object.entries(POSES[kind])) {
            const name = `${kind} ${code}`;
            assert.equal(def.keys.length, 4, name);
            assert.ok(def.seconds > 0, name);
            for (const key of def.keys) {
                for (const v of Object.values(key)) assert.ok(v.length === 3 && v.every(Number.isFinite), name);
            }
            if (def.cycle) continue;
            const ends = Number(code) === POSE.FALL ? [0] : [0, 1];
            for (const p of ends) {
                for (const col of Object.keys(def.keys[0]).concat(Object.keys(def.keys[3]))) {
                    if (col === 'pivot') continue; // where it would turn, had it turned
                    const v = samplePose(kind, Number(code), p, col);
                    if (col === 'shift') assert.ok(v.every((a) => Math.abs(a) < 1e-9), `${name} ${col} at ${p}`);
                    else assert.ok(rest(v), `${name} ${col} at ${p}: ${v}`);
                }
            }
            // A hold point is on a key.
            if (def.hold !== undefined) assert.ok(Math.abs(def.hold * 3 - Math.round(def.hold * 3)) < 1e-9, name);
        }
    }
    // The JS reference meets the keys exactly at their moments.
    const t = POSES.human[POSE.THROW];
    assert.deepEqual(samplePose('human', POSE.THROW, 1 / 3, 'armR'), t.keys[1].armR);
});

test('each species has its own poses', () => {
    assert.ok(poseApplies('herbivore', POSE.GRAZE));
    assert.ok(poseApplies('herbivore', POSE.FALL));
    assert.ok(!poseApplies('herbivore', POSE.THROW));
    assert.ok(poseApplies('carnivore', POSE.POUNCE));
    assert.ok(poseApplies('carnivore', POSE.EAT));
    assert.ok(!poseApplies('carnivore', POSE.SIT));
    for (const code of ['THROW', 'JAB', 'SWING', 'GATHER', 'BUTCHER', 'EAT', 'CHOP', 'KNAP', 'CRAFT', 'SIT', 'ROLL', 'FALL', 'CROUCH', 'HOP']) {
        assert.ok(poseApplies('human', POSE[code]), code);
    }
    assert.ok(!poseApplies('human', POSE.POUNCE));
});

test('forget returns how the dead looked and drops them', () => {
    const m = motion();
    track(m, 'human', 42, 10, 10, STATE.PLAYING, 0.62, 7);
    m.hold(42, POSE.SIT);
    assert.deepEqual({ ...m.describe(42), phase: 0 }, { tribe: 7, scale: 0.62, phase: 0 });
    m.forget(42);
    assert.equal(m.describe(42), null);
    assert.equal(m.holds.size, 0);
    assert.equal(m.describe(43), null);
});

// ---- Bodies (shapes.js) ----

const shapes = await import('../src/view3d/shapes.js');
const { PART, GAIT } = await import('../src/view3d/animate.js');
const BODIES = { herbivore: shapes.herbivoreShape, carnivore: shapes.carnivoreShape, human: shapes.personShape };
const PARTS_OF = {
    herbivore: [PART.TORSO, PART.HEAD, PART.LEG_FL, PART.LEG_FR, PART.LEG_BL, PART.LEG_BR],
    carnivore: [PART.TORSO, PART.HEAD, PART.LEG_FL, PART.LEG_FR, PART.LEG_BL, PART.LEG_BR],
    human: [PART.TORSO, PART.HEAD, PART.LEG_FL, PART.LEG_FR, PART.ARM_L, PART.ARM_R],
};

// Per part: its joint (the same for all its vertices) and its vertices' extent.
function partsOf(g) {
    const pos = g.attributes.position;
    const rig = g.attributes.rig;
    const parts = new Map();
    for (let v = 0; v < pos.count; v++) {
        const p = rig.getW(v);
        const joint = [rig.getX(v), rig.getY(v), rig.getZ(v)];
        if (!parts.has(p)) parts.set(p, { joint, minY: Infinity, maxY: -Infinity, n: 0 });
        const e = parts.get(p);
        assert.deepEqual(joint, e.joint, `part ${p} has one joint`);
        e.minY = Math.min(e.minY, pos.getY(v));
        e.maxY = Math.max(e.maxY, pos.getY(v));
        e.n++;
    }
    return parts;
}
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);

test('every vertex belongs to a part, and every part has a pivot', () => {
    for (const kind of KINDS) {
        const g = BODIES[kind]();
        assert.equal(g.attributes.rig.itemSize, 4, kind);
        assert.equal(g.attributes.rig.count, g.attributes.position.count, kind);
        const parts = partsOf(g);
        assert.deepEqual([...parts.keys()].sort((a, b) => a - b), PARTS_OF[kind], kind);
        assert.ok(near(parts.get(PART.TORSO).joint, shapes.RIGS[kind].torso), `${kind} torso joint`);
        // Hips at the gait's leg length: a leg hanging straight down reaches the ground.
        for (const leg of [PART.LEG_FL, PART.LEG_FR, PART.LEG_BL, PART.LEG_BR]) {
            if (!parts.has(leg)) continue;
            const { joint, minY, maxY } = parts.get(leg);
            assert.ok(Math.abs(joint[1] - GAIT[kind].leg) < 1e-6, `${kind} leg ${leg} hip at ${joint[1]}`);
            assert.ok(Math.abs(minY) < 1e-6, `${kind} leg ${leg} on the ground`);
            assert.ok(maxY > joint[1], `${kind} leg ${leg} reaches up into the body`);
        }
    }
});

test('people have legs and arms, animals four legs', () => {
    const side = (kind, p) => Math.sign(partsOf(BODIES[kind]()).get(p).joint[2]);
    const front = (kind, p) => Math.sign(partsOf(BODIES[kind]()).get(p).joint[0] - shapes.RIGS[kind].torso[0]);
    for (const kind of ['herbivore', 'carnivore']) {
        assert.deepEqual([side(kind, PART.LEG_FL), front(kind, PART.LEG_FL)], [-1, 1], `${kind} front left`);
        assert.deepEqual([side(kind, PART.LEG_FR), front(kind, PART.LEG_FR)], [1, 1], `${kind} front right`);
        assert.deepEqual([side(kind, PART.LEG_BL), front(kind, PART.LEG_BL)], [-1, -1], `${kind} back left`);
        assert.deepEqual([side(kind, PART.LEG_BR), front(kind, PART.LEG_BR)], [1, -1], `${kind} back right`);
    }
    assert.equal(side('human', PART.LEG_FL), -1);
    assert.equal(side('human', PART.LEG_FR), 1);
    assert.equal(side('human', PART.ARM_L), -1);
    assert.equal(side('human', PART.ARM_R), 1);
    const arm = partsOf(BODIES.human()).get(PART.ARM_R);
    assert.ok(arm.joint[1] > 3 && arm.minY > 1.5, 'arms hang from the shoulders');
});

test('bodies stand on the ground', () => {
    for (const kind of KINDS) {
        const g = BODIES[kind]();
        g.computeBoundingBox();
        assert.ok(Math.abs(g.boundingBox.min.y) < 1e-6, `${kind} feet at 0`);
    }
    const g = BODIES.human();
    g.computeBoundingBox();
    assert.ok(g.boundingBox.max.y > 4.6 && g.boundingBox.max.y < 5, `a person is ${g.boundingBox.max.y} tall`);
});

// ---- Meat racks (camps.js) ----

test('the meat on a rack follows the store, up to a cap', async () => {
    const { meatOnRack, MEAT_CAP } = await import('../src/view3d/camps.js');
    assert.equal(meatOnRack(0), 0);
    assert.equal(meatOnRack(-5), 0);
    assert.equal(meatOnRack(1), 1, 'any food at all shows');
    let last = 0;
    for (let store = 0; store <= 3000; store += 5) {
        const n = meatOnRack(store);
        assert.ok(n >= last && n <= MEAT_CAP, `${store}: ${n}`);
        last = n;
    }
    assert.ok(meatOnRack(300) >= 3 && meatOnRack(300) < MEAT_CAP, 'a starting camp has some');
    assert.equal(meatOnRack(1e6), MEAT_CAP);
});

// ---- Death and blood (effects.js, and carcasses in creatures.js) ----

const THREE = await import('three');
const { Effects } = await import('../src/view3d/effects.js');
const { Creatures } = await import('../src/view3d/creatures.js');

// A view like camera.js's: floating origin (fx, fz), the camera at `cam`
// (render coordinates), the box of ground in sight. No planes: nothing is off
// screen.
function view({ fx = 100, fz = 100, span = 400, personalSpace = 0, cam = [0, 300, 0] } = {}) {
    return {
        W, H, fx, fz, camX: cam[0], camY: cam[1], camZ: cam[2],
        minX: -span, maxX: span, minZ: -span, maxZ: span,
        unitPx: 1e-4, mapness: 0, dist: 300, personalSpace, fogFar: 3000,
        planes: new Float64Array(24),
    };
}
function effects(m = motion()) {
    const fx = new Effects(new THREE.Scene(), m);
    fx.attach(() => 0);
    fx.tick(m.clock, 0);
    return fx;
}
const death = (id, cause, extra = {}) => ({ type: 'death', kind: 'herbivore', id, x: 100, y: 100, heading: 0.5, cause, by: 0, time: 0, ...extra });
// A world with nobody alive in it, for drawing only the dead.
const empty = () => {
    const pop = { n: 0 };
    for (const c of ['x', 'y', 'heading', 'id', 'age', 'tribe', 'state']) pop[c] = new Float64Array(0);
    return pop;
};
const deadWorld = () => ({ p: params, herbivores: empty(), carnivores: empty(), humans: empty(), tribeById: new Map(), fallen: [] });

test('a kill leaves a bloody carcass and makes the predator pounce', () => {
    const m = motion();
    track(m, 'herbivore', 10, 100, 100, STATE.FLEEING);
    const fx = effects(m);
    fx.handle([death(10, 'eaten', { by: 20 })]);
    assert.equal(fx.dead.count, 1);
    assert.equal(fx.pools.count, 1);
    assert.ok(fx.drops.count >= 10, `${fx.drops.count} droplets`);
    assert.equal(m.describe(10), null, 'the dead are forgotten');
    assert.equal(m.oneShots.get(20).code, POSE.POUNCE);
    // Hunters throw, and a person killed by a person was stabbed.
    fx.handle([death(11, 'hunted', { by: 21 }), death(12, 'killed', { kind: 'human', by: 22 }), death(13, 'killed', { kind: 'carnivore', by: 23 })]);
    assert.equal(m.oneShots.get(21).code, POSE.THROW);
    assert.equal(m.oneShots.get(22).code, POSE.JAB);
    assert.equal(m.oneShots.get(23).code, POSE.THROW);
    assert.equal(fx.pools.count, 4);
});

test('old age and starvation leave clean carcasses', () => {
    const m = motion();
    const fx = effects(m);
    fx.handle([death(1, 'old age'), death(2, 'starvation'), { type: 'bite', id: 3, by: 4 }]);
    assert.equal(fx.dead.count, 2);
    assert.equal(fx.pools.count, 0);
    assert.equal(fx.drops.count, 0);
    assert.equal(m.oneShots.size, 0);
});

test('the caps hold under thousands of deaths', () => {
    const m = motion();
    const fx = effects(m);
    const events = [];
    for (let id = 1; id <= 5000; id++) events.push(death(id, 'eaten', { x: id % W, by: 9000 + id }));
    const t0 = performance.now();
    fx.handle(events);
    fx.update(view());
    const ms = performance.now() - t0;
    assert.equal(fx.dead.count, 300);
    assert.equal(fx.pools.count, 300);
    assert.ok(fx.drops.count <= 2000);
    assert.equal(fx.dead.id[(fx.dead.start + fx.dead.count - 1) % fx.dead.cap], 5000, 'the newest is kept');
    assert.equal(fx.dead.id[fx.dead.start], 4701, 'the oldest went first');
    assert.ok(fx.poolMesh.count <= 300 && fx.dropMesh.count <= 2000);
    assert.ok(ms < 250, `${ms.toFixed(1)} ms for 5000 deaths`);
});

test('carcasses fade with world time', () => {
    const m = motion();
    const fx = effects(m);
    fx.handle([death(1, 'eaten')]);
    fx.tick(m.clock, 300);
    assert.equal(fx.dead.count, 1);
    assert.equal(fx.dead.fade[fx.dead.start], 0);
    fx.tick(m.clock, 520);
    const f = fx.dead.fade[fx.dead.start];
    assert.ok(f > 0 && f < 1, `fading: ${f}`);
    fx.tick(m.clock, 601);
    assert.equal(fx.dead.count, 0);
    assert.equal(fx.pools.count, 0);
});

test('blood off hides sprays and pools, not carcasses', () => {
    const m = motion();
    const fx = effects(m);
    fx.setBlood(false);
    fx.handle([death(1, 'eaten')]);
    fx.update(view());
    assert.equal(fx.dropMesh.visible, false);
    assert.equal(fx.poolMesh.visible, false);
    const c = new Creatures(new THREE.Scene());
    c.update(deadWorld(), view(), () => 0, 0, fx);
    assert.equal(c.herds.herbivore[0].mesh.count, 1, 'the carcass still lies there');
    fx.setBlood(true);
    frame(m);
    fx.tick(m.clock, 1);
    fx.update(view());
    assert.ok(fx.dropMesh.visible && fx.dropMesh.count > 0);
    assert.ok(fx.poolMesh.visible && fx.poolMesh.count === 1);
});

test("effects at the world's edge are drawn at their wrapped copy", () => {
    const m = motion();
    const fx = effects(m);
    fx.handle([death(1, 'eaten', { x: W - 1, y: 100 })]);
    frame(m);
    fx.tick(m.clock, 1);
    const v = view({ fx: 0, fz: 100, span: 50 });
    fx.update(v);
    assert.equal(fx.poolMesh.count, 1);
    assert.ok(Math.abs(fx.poolMesh.instanceMatrix.array[12] + 1) < 1e-6, 'the pool is 1 unit left of the origin');
    const xs = [];
    for (let k = 0; k < fx.dropMesh.count; k++) xs.push(fx.dropMesh.instanceMatrix.array[k * 16 + 12]);
    assert.ok(xs.length && xs.every((x) => Math.abs(x + 1) < 3), `droplets near it: ${xs}`);
    const c = new Creatures(new THREE.Scene());
    c.update(deadWorld(), v, () => 0, 0, fx);
    const herd = c.herds.herbivore[0];
    assert.equal(herd.mesh.count, 1);
    assert.ok(Math.abs(herd.matrices[12] + 1) < 1e-6, 'and so is the carcass');
    assert.equal(herd.poses[0], POSE.FALL);
    assert.equal(herd.poses[2], 1);
    // It falls, then lies still.
    for (let f = 0; f < 60; f++) frame(m);
    fx.tick(m.clock, 2);
    c.update(deadWorld(), v, () => 0, 0, fx);
    assert.equal(herd.poses[1], 1);
});

test('the person you control sits only to rest', () => {
    const c = new Creatures(new THREE.Scene());
    const humans = empty();
    for (const k of Object.keys(humans)) if (k !== 'n') humans[k] = new Float64Array(1);
    humans.n = 1;
    humans.x[0] = 100;
    humans.y[0] = 100;
    humans.id[0] = 5;
    humans.age[0] = 5000;
    humans.state[0] = STATE.AT_CAMP; // standing still at camp
    const w = { ...deadWorld(), humans, player: { id: 5, resting: false } };
    const m = c.motion;
    m.tick(0, 0);
    const settle = () => {
        for (let f = 0; f < 40; f++) {
            m.tick(m.shown + 0.25, m.last + 1000 / 60);
            c.update(w, view(), () => 0, 0);
        }
        return c.herds.human[0].poses[0];
    };
    assert.equal(settle(), POSE.NONE, 'standing');
    w.player.resting = true;
    assert.equal(settle(), POSE.SIT, 'resting');
    for (let k = 0; k < 8; k++) {
        m.clock += 6.5;
        assert.equal(settle(), POSE.SIT, 'resting, always seated');
    }
    w.player = null;
    w.humans.state[0] = STATE.AT_CAMP;
    const seen = new Set();
    for (let k = 0; k < 8; k++) {
        m.clock += 6.5;
        seen.add(settle());
    }
    assert.deepEqual([...seen].sort(), [POSE.NONE, POSE.SIT], 'anyone else at camp sits now and then, and stands between');
});

test('nothing is drawn inside personal space', () => {
    const m = motion();
    const fx = effects(m);
    fx.handle([death(1, 'eaten', { x: 0, y: 0 })]);
    frame(m);
    fx.tick(m.clock, 1);
    const eyes = view({ fx: 0, fz: 0, span: 50, personalSpace: 5, cam: [0.5, 2.5, 0] });
    fx.update(eyes);
    assert.equal(fx.dropMesh.count, 0);
    const c = new Creatures(new THREE.Scene());
    c.update(deadWorld(), eyes, () => 0, 0, fx);
    assert.equal(c.herds.herbivore[0].mesh.count, 0);
    const away = view({ fx: 0, fz: 0, span: 50, personalSpace: 5, cam: [30, 10, 0] });
    fx.update(away);
    assert.ok(fx.dropMesh.count > 0);
    c.update(deadWorld(), away, () => 0, 0, fx);
    assert.equal(c.herds.herbivore[0].mesh.count, 1);
});

// ---- Spears in the air (thrown.js), and the marks of the hands ----

const { Thrown } = await import('../src/view3d/thrown.js');

function thrown() {
    const t = new Thrown(new THREE.Scene());
    t.attach();
    return t;
}
// The world a Thrown reads: the player's spears as of step `spearsAt`, drawn at `shown`.
const spearWorld = (spears = [], spearsAt = 0, shown = 0) => ({ p: params, spears, spearsAt, shown, time: spearsAt });
// Where the k-th spear drawn is (render coordinates: x, height, z).
const placed = (t, k = 0) => t.mesh.instanceMatrix.array.slice(k * 16 + 12, k * 16 + 15);

test("others' throws are drawn as arcs and pose the thrower", () => {
    const m = motion();
    const t = thrown();
    const v = view(); // (the origin at 100, 100)
    const draw = () => t.update(spearWorld(), v, () => 0, m.clock);
    t.handle([{ type: 'throw', id: 5, x: 100, y: 100, tx: 110, ty: 100, hit: true, time: 0 }], m);
    assert.equal(m.oneShots.get(5).code, POSE.THROW, 'the thrower throws');
    draw();
    assert.equal(t.mesh.count, 1, 'in the air');
    for (let f = 0; f < 12; f++) frame(m); // 0.2 s
    draw();
    const [x, h] = placed(t);
    assert.ok(Math.abs(x - 5) < 0.3, `halfway there: ${x}`);
    assert.ok(h > 3, `arcing: ${h}`);
    for (let f = 0; f < 20; f++) frame(m);
    draw();
    assert.equal(t.mesh.count, 0, 'a hit: into its target, and gone');
    // A miss flies a little past and sticks in the ground for a while.
    t.handle([{ type: 'throw', id: 6, x: 100, y: 100, tx: 110, ty: 100, hit: false, time: 1 }], m);
    for (let f = 0; f < 30; f++) frame(m);
    draw();
    assert.equal(t.mesh.count, 1);
    assert.ok(placed(t)[0] > 10, `past the target: ${placed(t)[0]}`);
    for (let f = 0; f < 150; f++) frame(m);
    draw();
    assert.equal(t.mesh.count, 0, 'then gone');
});

test("the player's spears are drawn where they are at the moment shown", () => {
    const m = motion();
    const t = thrown();
    const v = view();
    const s = [110, 100, 3, 0, 0.45, 1]; // as of step 10: 9 of its 20 units out (a spear)
    t.update(spearWorld(s, 10, 9), v, () => 0, m.clock);
    assert.equal(t.mesh.count, 1);
    assert.ok(Math.abs(placed(t)[0] - 7) < 1e-9, 'a step back along its flight');
    t.update(spearWorld(s, 10, 6.5), v, () => 0, m.clock);
    assert.equal(t.mesh.count, 0, 'not yet thrown at that moment');
    // Its throw event draws nothing more, and the page poses its own body.
    t.handle([{ type: 'throw', id: 7, x: 100, y: 100, tx: 120, ty: 100, time: 9 }], m, 7);
    t.update(spearWorld(), v, () => 0, m.clock);
    assert.equal(t.mesh.count, 0);
    assert.equal(m.oneShots.size, 0);
    // Come down, it stands in the ground a moment.
    t.handle([{ type: 'miss', x: 120, y: 100, dx: 1, dy: 0, by: 7, time: 12 }], m, 7);
    t.update(spearWorld(), v, () => 0, m.clock);
    assert.equal(t.mesh.count, 1);
    assert.ok(placed(t)[0] < 20 && placed(t)[1] > 0.5, 'leaning back the way it came, its point in the ground');
});

test('a hit splashes blood back from where the blow went in; a stroke a little', () => {
    const fx = effects();
    fx.handle([{ type: 'hit', id: 3, by: 9, kind: 'herbivore', x: 100, y: 100, dx: 1, dy: 0, time: 0 }]);
    const n = fx.drops.count;
    assert.ok(n >= 8 && n <= 14, `${n} droplets`);
    let vx = 0;
    for (let q = 0; q < n; q++) {
        const j = (fx.drops.start + q) % fx.drops.cap;
        vx += fx.drops.vx[j];
        assert.ok(fx.drops.x[j] < 100, 'from the side it was struck on (toward the thrower)');
    }
    assert.ok(vx / n < -1, 'splashing back toward the thrower, who sees it');
    assert.equal(fx.dead.count, 0, 'a hit is not a death');
    fx.handle([{ type: 'butcher', id: 9, carcass: 3, x: 100, y: 100, time: 1 }]);
    const stroke = fx.drops.count - n;
    assert.ok(stroke >= 2 && stroke < n, `a stroke: ${stroke}`);
});

test("the player's kill stays until butchered, shrinking", () => {
    const m = motion();
    const fx = effects(m);
    const c = new Creatures(new THREE.Scene());
    const herd = c.herds.herbivore[0];
    const draw = () => {
        c.update(deadWorld(), view(), () => 0, 0, fx);
        return herd.mesh.count ? Math.hypot(herd.matrices[0], herd.matrices[2]) : 0;
    };
    fx.handle([death(10, 'hunted', { by: 9 }), death(11, 'eaten')], 9);
    assert.equal(m.oneShots.get(9), undefined, 'the player poses itself');
    fx.follow([{ id: 10, cut: 0 }]);
    assert.ok(fx.kept.has(10));
    // Long past a carcass's time, it still lies there (and the other is gone).
    for (const shown of [200, 400, 650, 900]) {
        fx.tick(m.clock, shown);
        fx.follow([{ id: 10, cut: 0 }]);
    }
    const whole = draw();
    assert.equal(herd.mesh.count, 1);
    assert.equal(herd.matrices[13], 0, 'not sinking');
    fx.follow([{ id: 10, cut: 0.5 }]);
    const half = draw();
    assert.ok(half < whole * 0.85 && half > whole * 0.6, `shrinking as it is cut up: ${whole} → ${half}`);
    fx.handle([{ type: 'butchered', id: 9, carcass: 10, time: 950 }]);
    fx.follow([]);
    draw();
    assert.equal(herd.mesh.count, 0, 'cut up: gone');
    // One the simulation no longer lists (spoilt) fades from then on.
    fx.handle([death(12, 'hunted', { by: 9 })]);
    fx.follow([{ id: 12, cut: 0 }]);
    fx.follow([]);
    assert.equal(fx.kept.size, 0);
    fx.tick(m.clock, 1000);
    const j = fx.slotOf(12);
    assert.ok(fx.dead.fade[j] > 0 && fx.dead.fade[j] < 1, `fading: ${fx.dead.fade[j]}`);
});

// ---- Items (package 3): the work poses, held and lying items, piles, arrows, marks ----

const { HandPose, Items } = await import('../src/view3d/items.js');
const { Sparks } = await import('../src/view3d/sparks.js');
const { pileOf, PILE_CAP } = await import('../src/view3d/camps.js');
const { sitsNow } = await import('../src/view3d/animate.js');

test('the work of items has its poses; idle at camp, people sit now and then', () => {
    const { CHOPPING, QUARRYING, CRAFTING } = STATE;
    assert.equal(statePose('human', CHOPPING, true), POSE.CHOP);
    assert.equal(statePose('human', QUARRYING, true), POSE.KNAP);
    assert.equal(statePose('human', CRAFTING, true), POSE.CRAFT);
    assert.equal(statePose('human', CHOPPING, false), POSE.NONE, 'walking to the tree');
    assert.equal(statePose('human', STATE.BUTCHERING, false), POSE.BUTCHER, 'anyone butchering');
    let sitting = 0;
    for (let t = 0; t < 400; t += 0.5) sitting += sitsNow(t, 0.3) ? 1 : 0;
    assert.ok(sitting > 500 && sitting < 620, `seated about 70% of the time: ${sitting / 8}%`);
});

// The vertex shader's turn (animate.js), word for word, for checking HandPose.
function shaderTurn(v, r) {
    let c = Math.cos(r[1]);
    let s = Math.sin(r[1]);
    v = [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
    c = Math.cos(r[0]);
    s = Math.sin(r[0]);
    v = [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
    c = Math.cos(r[2]);
    s = Math.sin(r[2]);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}
// Where the shader puts a vertex of the right arm, for a stride and a pose.
function shaderArm(p, phase, amount, code, progress, w) {
    const g = GAIT.human;
    const ph = phase * TAU;
    const walk = Math.min(1, Math.max(0, amount));
    const run = Math.min(1, Math.max(0, amount - 1));
    const swing = g.swing * walk * (1 + g.runSwing * run);
    const sw = Math.sin(ph);
    const add = (a, b) => a.map((v, k) => v + w * b[k]);
    let own = [g.arms * walk * (1 + run) * sw, 0, 0];
    let torso = [g.lean * run, 0, 0];
    let root = [g.pitch * run * Math.cos(ph), 0, 0];
    let shift = [0, -g.leg * (1 - Math.cos(swing * sw)), 0];
    let pivot = [0, g.leg, 0];
    if (w > 0) {
        own = add(own, samplePose('human', code, progress, 'armR'));
        torso = add(torso, samplePose('human', code, progress, 'torso'));
        root = add(root, samplePose('human', code, progress, 'root'));
        shift = add(shift, samplePose('human', code, progress, 'shift'));
        pivot = add(pivot, samplePose('human', code, progress, 'pivot'));
    }
    own[1] = -own[1]; // (the right arm: outward mirrored)
    const joint = [0, 3.45, 0.84];
    const T = [0, g.leg, 0];
    const sub = (a, b) => a.map((v, k) => v - b[k]);
    const plus = (a, b) => a.map((v, k) => v + b[k]);
    let v = plus(shaderTurn(sub(p, joint), own), joint);
    v = plus(shaderTurn(sub(v, T), torso), T);
    return plus(plus(shaderTurn(sub(v, pivot), root), pivot), shift);
}

test('a held item stays in the hand: the hand is where the shader draws it', () => {
    const hand = new HandPose();
    const out = new Float64Array(3);
    const turn = new Float64Array(9);
    const grip = [0.1, 1.95, 0.84];
    const cases = [
        [0, 0, POSE.NONE, 0, 0],             // standing
        [0.3, 1, POSE.NONE, 0, 0],           // walking
        [0.7, 1.8, POSE.NONE, 0, 0],         // running
        [0, 0, POSE.THROW, 1 / 3, 1],        // drawn back to throw
        [0.2, 0.6, POSE.JAB, 0.6, 0.7],      // a thrust, while easing in
        [0, 0, POSE.SWING, 0.6, 1],
        [0, 0, POSE.BUTCHER, 0.4, 1],
        [0, 0, POSE.SHOOT, 1 / 3, 1],
    ];
    for (const [phase, amount, code, progress, w] of cases) {
        hand.set(phase, amount, code, progress, w);
        hand.place(7, ...grip, out, turn);
        const want = shaderArm(grip, phase, amount, code, progress, w);
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[k] - want[k]) < 1e-9, `${code} ${progress}: ${[...out]} vs ${want}`);
        // The turn is a rotation (orthonormal columns).
        for (let a = 0; a < 3; a++) {
            const len = Math.hypot(turn[a * 3], turn[a * 3 + 1], turn[a * 3 + 2]);
            assert.ok(Math.abs(len - 1) < 1e-9);
        }
    }
    // Drawn back to throw, the hand is up behind the shoulder.
    hand.set(0, 0, POSE.THROW, 1 / 3, 1);
    hand.place(7, ...grip, out, turn);
    assert.ok(out[1] > 3.45 && out[0] < 0, `up and back: ${[...out]}`);
});

// A world for Items: people (id, x, y) holding {weapon, tool}, and items lying.
function itemWorld(people, lying = []) {
    const humans = empty();
    for (const k of ['x', 'y', 'heading', 'id', 'age', 'tribe', 'state']) humans[k] = Float64Array.from(people.map((p) => p[k] ?? (k === 'age' ? 5000 : 0)));
    humans.n = people.length;
    const items = new Map();
    const byBearer = new Map();
    let next = 1;
    const item = (kind, rarity = 0, more = {}) => {
        const it = { id: next++, kind, rarity, legend: rarity === 2 ? { name: 'Grey Fang', history: [] } : null, bearer: 0, x: 0, y: 0, wear: 1, ...more };
        items.set(it.id, it);
        return it;
    };
    for (const p of people) byBearer.set(p.id, { weapon: p.weapon && item(p.weapon, p.rarity ?? 0, { bearer: p.id }), tool: p.tool && item(p.tool, 0, { bearer: p.id }) });
    for (const l of lying) item(l.kind, l.rarity ?? 0, { x: l.x, y: l.y });
    return { ...deadWorld(), humans, items, byBearer };
}

test('items are drawn in hands near the camera and lying on the ground; legends glint; torches burn', () => {
    const m = motion();
    const items = new Items(new THREE.Scene());
    const w = itemWorld([
        { id: 1, x: 100, y: 100, weapon: 'spear', tool: 'torch', rarity: 2 },
        { id: 2, x: 104, y: 100, weapon: 'bow', tool: 'torch' },
        { id: 3, x: 108, y: 100, weapon: 'club', tool: 'torch' },
        { id: 4, x: 400, y: 100, weapon: 'spear' }, // far off
        { id: 5, x: 102, y: 104 },                  // empty hands
    ], [{ kind: 'basket', x: 101, y: 98 }, { kind: 'club', x: 99, y: 98, rarity: 2 }, { kind: 'knife', x: 380, y: 100 }]);
    const v = view({ span: 400, cam: [0, 8, 25] });
    for (const p of [1, 2, 3, 4, 5]) track(m, 'human', p, w.humans.x[p - 1], w.humans.y[p - 1], STATE.HUNTING);
    items.update(w, v, () => 0, m, 0, 1);
    const count = (k) => items.pools[k].mesh.count;
    assert.deepEqual([count('spear'), count('bow'), count('club'), count('torch'), count('basket'), count('knife')], [1, 1, 2, 3, 1, 0],
        'the near ones held, the near ones lying; the far ones not at all');
    assert.equal(items.stats.glints, 2, "a legend's glint, held or lying");
    assert.equal(items.stats.flames, 3, 'every torch in a hand burns');
    assert.equal(items.sparkles.mesh.count, 2 + 3 * 3, 'glints, and flames with their cores and glows: one mesh');
    assert.equal(items.lights.length, 0, 'no real lights unless asked for (?torchlight)');
    // The spear is in the right hand, the bow in the left (the heading is 0: +Z is the right).
    const at = (k) => [...items.pools[k].mesh.instanceMatrix.array.slice(12, 15)];
    assert.ok(at('spear')[2] > 0.3, `right: ${at('spear')}`);
    assert.ok(at('bow')[2] < -0.3, `left: ${at('bow')}`);
    // In first person, your own hands' things are not drawn; nor without items at all.
    items.update(w, v, () => 0, m, 1, 1.1);
    assert.equal(count('spear'), 0);
    items.update(deadWorld(), v, () => 0, m, 0, 1.2);
    assert.equal(count('torch') + count('basket') + items.sparkles.mesh.count, 0);
});

test('at work, the weapon is put down beside the body', () => {
    const m = motion();
    const items = new Items(new THREE.Scene());
    const w = itemWorld([{ id: 1, x: 100, y: 100, weapon: 'spear', tool: 'knife' }]);
    const v = view({ span: 400, cam: [0, 8, 25] });
    let out;
    for (let f = 0; f < 60; f++) {
        frame(m);
        out = track(m, 'human', 1, 100, 100, STATE.BUTCHERING);
    }
    assert.equal(out.code, POSE.BUTCHER);
    items.update(w, v, () => 0, m, 0, m.clock);
    const te = items.pools.spear.mesh.instanceMatrix.array;
    assert.ok(te[13] < 0.3, `on the ground: ${te[13]}`);
    assert.ok(Math.abs(te[5]) < 1e-9, 'lying flat: its length level');
    const knife = items.pools.knife.mesh.instanceMatrix.array;
    assert.ok(knife[13] < 1.8, `the knife in the hand, low at the carcass: ${knife[13]}`);
});

test("the camps' piles follow the store, up to their caps", () => {
    assert.deepEqual(pileOf({ store: 100 }), { logs: 0, stones: 0, hides: 0 }, 'no materials: no piles');
    assert.deepEqual(pileOf({ wood: 1, flint: 1, hide: 1 }), { logs: 1, stones: 1, hides: 1 }, 'any at all shows');
    assert.deepEqual(pileOf({ wood: 9, flint: 3, hide: 2 }), { logs: 5, stones: 3, hides: 2 });
    assert.deepEqual(pileOf({ wood: 1e4, flint: 1e4, hide: 1e4 }), { logs: PILE_CAP.logs, stones: PILE_CAP.stones, hides: PILE_CAP.hides });
});

test("a bow's throw is an arrow, and its archer shoots; a club's blow a swing; the player's flights say their kind", () => {
    const m = motion();
    const t = thrown();
    const v = view();
    t.handle([{ type: 'throw', id: 5, x: 100, y: 100, tx: 120, ty: 100, hit: false, weapon: 2, time: 0 }], m);
    assert.equal(m.oneShots.get(5).code, POSE.SHOOT);
    t.update(spearWorld(), v, () => 0, m.clock);
    assert.deepEqual([t.mesh.count, t.arrows.count], [0, 1], 'an arrow, not a spear');
    t.handle([{ type: 'swing', id: 6, x: 100, y: 100, tx: 103, ty: 100, hit: true, weapon: 3, time: 1 }], m);
    assert.equal(m.oneShots.get(6).code, POSE.SWING);
    t.update(spearWorld(), v, () => 0, m.clock);
    assert.deepEqual([t.mesh.count, t.arrows.count], [0, 1], 'a club flies nothing');
    // The volley is the simulation's: its skill event draws nothing more.
    t.handle([{ type: 'skill', id: 9, kind: 2, name: '', x: 100, y: 100, dx: 1, dy: 0, time: 1 }], m, 9);
    t.update(spearWorld(), v, () => 0, m.clock);
    assert.equal(t.arrows.count, 1);
    // The player's own flights, an arrow (kind 2) and a spear (1), each as it is.
    const P = params.play;
    const arrowSpeed = P.throwSpeed * params.items.arrowSpeed;
    const w = spearWorld([110, 100, arrowSpeed, 0, 0.3, 2, 100, 110, P.throwSpeed, 0, 0.3, 1], 10, 10);
    t.update(w, v, () => 0, m.clock);
    assert.deepEqual([t.mesh.count, t.arrows.count], [1, 2]);
});

test('chops, knaps and skills leave their marks, briefly', () => {
    const s = new Sparks(new THREE.Scene());
    s.attach();
    const v = view({ span: 400, cam: [0, 8, 25] });
    s.handle([
        { type: 'chop', id: 1, x: 100, y: 100, time: 0 },
        { type: 'knap', id: 2, x: 104, y: 100, time: 0 },
        { type: 'skill', id: 3, kind: 'spear', x: 100, y: 100, dx: 1, dy: 0, time: 0 },
        { type: 'skill', id: 3, kind: 'club', x: 100, y: 100, dx: 1, dy: 0, time: 0 },
    ], () => 0, 0);
    s.update(v, 0.05);
    assert.ok(s.mesh.count >= 20, `chips, sparks and dust: ${s.mesh.count}`);
    assert.equal(s.streaks.filter((x) => x.mesh.visible).length, 1, 'a streak');
    assert.equal(s.rings.filter((x) => x.mesh.visible).length, 1, 'a ring of dust');
    s.update(v, 3);
    assert.equal(s.mesh.count, 0);
    assert.equal(s.streaks.filter((x) => x.mesh.visible).length + s.rings.filter((x) => x.mesh.visible).length, 0, 'gone');
});
