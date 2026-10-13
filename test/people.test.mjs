// The people's models (src/view3d/models.js biped, hair.js): the owner's
// fifteen files in assets/models/people/, sorted into our rig, their arms
// turned down to hang, their colours given roles, hair on their heads, and
// held items in their hands (items.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

const THREE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(
    `export async function resolve(s, c, next) { return s === 'three' ? { url: ${JSON.stringify(THREE_URL)}, shortCircuit: true } : next(s, c); }`,
)}`);

const { readGlb } = await import('../src/view3d/glb.js');
const { toShape, lite, PERSON, OUTFITS, personUrl, outfitOf } = await import('../src/view3d/models.js');
const { BODIES, DYE, HAIR_STYLES, SHAVED, paint, clothOf, linear } = await import('../src/view3d/looks.js');
const { PART, GAIT, POSE, samplePose } = await import('../src/view3d/animate.js');
const { HandPose, CODE_RIG } = await import('../src/view3d/items.js');

const ARMS = [PART.ARM_L, PART.ARM_R];
const fileOf = (body, outfit) => new URL(personUrl(body, outfit).replace('../../', '../'), import.meta.url);
const glbOf = (body, outfit) => readGlb(fs.readFileSync(fileOf(body, outfit)));
const shapes = new Map();
const shapeOf = (body, outfit = 'plain_base') => {
    const key = `${body}__${outfit}`;
    if (!shapes.has(key)) shapes.set(key, toShape(glbOf(body, outfit), PERSON, 'human'));
    return shapes.get(key);
};

// Per part, from the body's own pieces (not its hair): their vertices' extent and mean.
function partsOf(shape) {
    const parts = new Map();
    for (const p of shape.pieces) {
        if (p.dye >= DYE.hair) continue;
        for (let v = 0; v < p.part.length; v++) {
            const k = p.part[v];
            if (!parts.has(k)) parts.set(k, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0], n: 0 });
            const e = parts.get(k);
            for (let c = 0; c < 3; c++) {
                const x = p.pos[v * 3 + c];
                e.min[c] = Math.min(e.min[c], x);
                e.max[c] = Math.max(e.max[c], x);
                e.sum[c] += x;
            }
            e.n++;
        }
    }
    for (const e of parts.values()) e.mean = e.sum.map((s) => s / e.n);
    return parts;
}

// The hand of the file's A-pose (the outermost piece), how far out from the
// middle line, in world units.
function aPoseReach(body) {
    let out = 0;
    for (const p of glbOf(body, 'plain_base').primitives) {
        for (let i = 0; i < p.position.length; i += 3) out = Math.max(out, Math.abs(p.position[i]));
    }
    return out * PERSON.scale;
}

test('the people come in three bodies, five outfits each: small files, all sorted', () => {
    for (const body of BODIES) {
        for (const outfit of OUTFITS) {
            assert.ok(fs.statSync(fileOf(body, outfit)).size < 100 * 1024, `${body} ${outfit} under 100 KB`);
            const s = shapeOf(body, outfit);
            assert.equal(s.info.split, 'parts');
            const parts = [...partsOf(s).keys()].sort((a, b) => a - b);
            assert.deepEqual(parts, [PART.TORSO, PART.HEAD, PART.LEG_FL, PART.LEG_FR, PART.ARM_L, PART.ARM_R], `${body} ${outfit}`);
        }
    }
    assert.equal(outfitOf(undefined), 'plain_base', 'nobody has a job yet: plain clothes');
    assert.equal(outfitOf('shaman'), 'shaman');
});

test('a person stands at our size: the man 4.8 tall, the women as made beside him', () => {
    const tall = (body) => {
        const parts = partsOf(shapeOf(body));
        return Math.max(...[...parts.values()].map((e) => e.max[1]));
    };
    assert.ok(Math.abs(tall('man_sturdy') - 4.8) < 0.05, `the man is ${tall('man_sturdy')}`);
    assert.ok(tall('woman_slender') > tall('man_sturdy') && tall('woman_stocky') < tall('man_sturdy'), 'the slender woman taller, the stocky one shorter');
    for (const body of BODIES) {
        const parts = partsOf(shapeOf(body));
        const low = Math.min(...[...parts.values()].map((e) => e.min[1]));
        assert.ok(Math.abs(low) < 1e-6, `${body}: feet at 0`);
        // It faces +X: the eyes (dark, its own colour, on the head) are in front.
        const eyes = shapeOf(body).pieces.filter((p) => p.dye === DYE.own && p.part[0] === PART.HEAD);
        assert.ok(eyes.length && eyes.every((p) => p.pos[0] > 0.2), `${body}: eyes in front`);
    }
});

test('legs below the hip, left and right; the head above the neck', () => {
    for (const body of BODIES) {
        for (const outfit of OUTFITS) {
            const s = shapeOf(body, outfit);
            const parts = partsOf(s);
            const L = parts.get(PART.LEG_FL);
            const R = parts.get(PART.LEG_FR);
            assert.ok(L.max[2] < 0 && R.min[2] > 0, `${body} ${outfit}: the left leg at −Z, the right at +Z`);
            assert.ok(L.max[1] < s.hip + 0.3 && R.max[1] < s.hip + 0.3, `${body} ${outfit}: legs below the hip`);
            assert.ok(L.min[1] < 0.05 && R.min[1] < 0.05, 'and on the ground');
            assert.ok(Math.abs(s.joints[PART.LEG_FL][1] - s.hip) < 1e-9 && s.joints[PART.LEG_FL][2] < 0 && s.joints[PART.LEG_FR][2] > 0);
            const head = parts.get(PART.HEAD);
            const neck = s.joints[PART.HEAD];
            assert.ok(head.min[1] > neck[1] - 0.25, `${body} ${outfit}: the head (from ${head.min[1]}) above the neck (${neck[1]})`);
            assert.ok(neck[1] > s.joints[PART.ARM_R][1], 'the neck above the shoulders');
        }
        // What is worn goes with what it is on: the shaman's long robe and the
        // fringe at its hem stay torso (they do not swing with the legs); the
        // warrior's wraps go with the legs and the forearms they bind.
        const shaman = shapeOf(body, 'shaman');
        assert.ok(shaman.pieces.filter((p) => p.dye !== DYE.skin && p.dye < DYE.hair && p.box.maxY < 1.2).every((p) => p.part[0] === PART.TORSO), `${body}: the hem stays with the robe`);
        const warrior = shapeOf(body, 'warrior');
        const keys = new Map(glbOf(body, 'warrior').primitives.map((p) => [p.node, [0, 1, 2].map((c) => Math.round(p.color[c] * 255)).join(',')]));
        const wraps = { [PART.LEG_FL]: 0, [PART.LEG_FR]: 0, [PART.ARM_L]: 0, [PART.ARM_R]: 0 };
        for (const p of warrior.pieces) if (keys.get(p.name) === '88,62,47') wraps[p.part[0]]++;
        assert.deepEqual(Object.values(wraps), [3, 3, 3, 3], `${body}: three wraps on each limb`);
    }
    // The poses' shift and pivot scale with the hips (FRAME.human: 1.85).
    const s = shapeOf('man_sturdy');
    assert.ok(Math.abs(s.body[1] - s.hip / 1.85) < 1e-9);
    assert.deepEqual(s.torso, [0, s.hip, 0]);
});

test('arms are turned down from the A-pose to hang at the sides, hands clear of the body', () => {
    for (const body of BODIES) {
        const s = shapeOf(body);
        const reach = aPoseReach(body);
        for (const arm of ARMS) {
            const side = arm === PART.ARM_L ? -1 : 1;
            const shoulder = s.joints[arm];
            const grip = s.rig.grip[arm];
            assert.equal(Math.sign(shoulder[2]), side, `${body}: the ${arm === PART.ARM_L ? 'left' : 'right'} arm on its side`);
            assert.ok(side * grip[2] < reach - 0.15, `${body}: the hand came in from ${reach.toFixed(2)} to ${grip[2].toFixed(2)}`);
            const out = Math.atan2(side * (grip[2] - shoulder[2]), shoulder[1] - grip[1]);
            assert.ok(out > 0 && out < 0.5, `${body}: the arm hangs ${(out * 57.3).toFixed(0)}° out`);
            assert.ok(grip[1] > s.hip - 0.2 && grip[1] < shoulder[1] - 1, `${body}: the hand at ${grip[1].toFixed(2)}, by the hip`);
            // Every vertex of the arm hangs below its shoulder's top.
            const e = partsOf(s).get(arm);
            assert.ok(e.min[1] > 1.5 && e.max[1] < shoulder[1] + 0.4);
        }
    }
});

test('colour roles: the skin is skin, the tunic is cloth, belt, bone and eyes keep their own', () => {
    const s = shapeOf('man_sturdy');
    const glb = glbOf('man_sturdy', 'plain_base');
    const key = (p) => [0, 1, 2].map((c) => Math.round(p.color[c] * 255)).join(',');
    const byName = new Map(glb.primitives.map((p) => [p.node, key(p)]));
    const roles = {};
    for (const p of s.pieces) if (p.dye < DYE.hair) roles[byName.get(p.name)] = p.dye;
    assert.deepEqual(roles, {
        '168,121,87': DYE.skin,   // skin
        '111,76,59': DYE.skin,    // the lips, toned with the skin
        '145,112,74': DYE.cloth,  // the tunic
        '79,61,43': DYE.own,      // belt and cord
        '220,209,174': DYE.own,   // a bone
        '52,43,35': DYE.own,      // eyes
    });
    // Skin is kept as a share of the skin's colour (1: the skin itself); cloth as a grey shade.
    for (const p of s.pieces) {
        if (byName.get(p.name) === '168,121,87') assert.ok([...p.col.slice(0, 3)].every((c) => Math.abs(c - 1) < 1e-6));
        if (p.dye === DYE.cloth) assert.ok(p.col[0] === p.col[1] && p.col[1] === p.col[2]);
    }
    // Every outfit has some cloth and keeps its own small things (beads, cords, paint).
    for (const outfit of OUTFITS) {
        const dyes = new Set(shapeOf('woman_slender', outfit).pieces.map((p) => p.dye));
        assert.ok(dyes.has(DYE.skin) && dyes.has(DYE.cloth) && dyes.has(DYE.own), outfit);
    }
});

test('colour roles drawn: skin takes the person\'s tone, cloth the tribe\'s, the rest stays', () => {
    const s = shapeOf('woman_stocky');
    const tribe = '#4a90e2';
    const person = { cloth: clothOf(tribe), skin: linear('#714b34'), hair: linear('#8b3f23'), tribe: linear(tribe), look: 0 };
    const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
    const skin = s.pieces.find((p) => p.dye === DYE.skin && p.part[0] === PART.TORSO);
    assert.ok(near(paint(DYE.skin, [...skin.col.slice(0, 3)], person), person.skin), 'bare skin is the person\'s skin');
    const tunic = s.pieces.find((p) => p.dye === DYE.cloth);
    assert.ok(near(paint(DYE.cloth, [...tunic.col.slice(0, 3)], person), person.cloth), 'the main garment is the tribe\'s cloth');
    const belt = s.pieces.find((p) => p.dye === DYE.own);
    assert.ok(near(paint(DYE.own, [...belt.col.slice(0, 3)], person), [...belt.col.slice(0, 3)]), 'a belt keeps its colour');
    // Small on screen, everyone wears their tribe's colour (the map).
    assert.ok(near(paint(DYE.skin, [1, 1, 1], { ...person, look: 1 }), person.tribe));
    // The hair is the person's; a shaved head shows a little of it over the skin.
    assert.ok(near(paint(DYE.hair, [1, 1, 1], person), person.hair));
    const stubble = paint(DYE.hair + SHAVED, [1, 1, 1], person);
    assert.ok(stubble.every((v, k) => v > Math.min(person.skin[k], person.hair[k]) - 1e-9 && v < Math.max(person.skin[k], person.hair[k]) + 1e-9));
});

test('hair: every style on every head, riding on the head', () => {
    for (const body of BODIES) {
        const s = shapeOf(body);
        const hair = s.pieces.filter((p) => p.dye >= DYE.hair);
        const styles = new Set(hair.map((p) => p.dye - DYE.hair));
        assert.deepEqual([...styles].sort(), HAIR_STYLES.map((_, k) => k), body);
        assert.ok(hair.every((p) => p.part.every((k) => k === PART.HEAD)), 'hair is part of the head');
        const head = partsOf(s).get(PART.HEAD);
        for (const p of hair) {
            let low = Infinity;
            for (let i = 1; i < p.pos.length; i += 3) low = Math.min(low, p.pos[i]);
            if (p.name.endsWith('cap')) assert.ok(low > s.joints[PART.HEAD][1], `${p.name} above the neck`);
            else assert.ok(low > s.hip + 0.5, `${p.name} falls from the head, not to the waist`);
        }
        // Each style's cap stands off the head's own surface: no point of it inside the head's box top.
        const cap = hair.find((p) => p.dye === DYE.hair && p.name.endsWith('cap'));
        let capTop = -Infinity;
        for (let i = 1; i < cap.pos.length; i += 3) capTop = Math.max(capTop, cap.pos[i]);
        assert.ok(capTop > head.max[1], `${body}: the cap's crown above the head's`);
        assert.ok(s.info.triangles < 2600, `${body}: ${s.info.triangles} triangles with all its hair`);
    }
});

test('the far level keeps the parts, the colour roles and the hair', async () => {
    const s = shapeOf('man_sturdy');
    const far = await lite(s, PERSON.lite);
    const tri = far.attributes.position.count / 3;
    assert.ok(tri < s.info.triangles / 3, `${tri} triangles`);
    const dye = far.attributes.dye.array;
    const seen = new Set(dye);
    for (const d of [DYE.own, DYE.skin, DYE.cloth, ...HAIR_STYLES.map((_, k) => DYE.hair + k)]) assert.ok(seen.has(d), `dye ${d} kept`);
});

// Where the shader puts a vertex of the right arm (animate.js VERTEX_MAIN),
// on a model's rig: joints, hips and the poses' scale its own.
function shaderArm(p, rig, phase, amount, code, progress, w) {
    const g = GAIT.human;
    const TAU = Math.PI * 2;
    const turn = (v, r) => {
        let [x, y, z] = v;
        let c = Math.cos(r[1]);
        let s = Math.sin(r[1]);
        [y, z] = [c * y - s * z, s * y + c * z];
        c = Math.cos(r[0]);
        s = Math.sin(r[0]);
        [x, y] = [c * x - s * y, s * x + c * y];
        c = Math.cos(r[2]);
        s = Math.sin(r[2]);
        return [c * x + s * z, y, -s * x + c * z];
    };
    const walk = Math.min(1, Math.max(0, amount));
    const run = Math.min(1, Math.max(0, amount - 1));
    const swing = g.swing * walk * (1 + g.runSwing * run);
    const sw = Math.sin(phase * TAU);
    const add = (a, b, k = 1) => a.map((v, i) => v + w * k * b[i]);
    let own = [g.arms * walk * (1 + run) * sw, 0, 0];
    let torso = [g.lean * run, 0, 0];
    let root = [g.pitch * run * Math.cos(phase * TAU), 0, 0];
    let shift = [0, -rig.hip * (1 - Math.cos(swing * sw)), 0];
    let pivot = [0, rig.hip, 0];
    if (w > 0) {
        own = add(own, samplePose('human', code, progress, 'armR'));
        torso = add(torso, samplePose('human', code, progress, 'torso'));
        root = add(root, samplePose('human', code, progress, 'root'));
        shift = add(shift, samplePose('human', code, progress, 'shift'), rig.k);
        pivot = add(pivot, samplePose('human', code, progress, 'pivot'), rig.k);
    }
    own[1] = -own[1];
    const joint = rig.shoulder[PART.ARM_R];
    const T = [0, rig.hip, 0];
    const sub = (a, b) => a.map((v, k) => v - b[k]);
    const plus = (a, b) => a.map((v, k) => v + b[k]);
    let v = plus(turn(sub(p, joint), own), joint);
    v = plus(turn(sub(v, T), torso), T);
    return plus(plus(turn(sub(v, pivot), root), pivot), shift);
}

test('held items stay in a model\'s hands in every pose (items.js reads the body\'s rig)', () => {
    const hand = new HandPose();
    const out = new Float64Array(3);
    const turn = new Float64Array(9);
    for (const body of BODIES) {
        const rig = shapeOf(body).rig;
        const grip = rig.grip[PART.ARM_R];
        for (const [phase, amount, code, progress, w] of [
            [0, 0, POSE.NONE, 0, 0], [0.3, 1, POSE.NONE, 0, 0], [0.7, 1.8, POSE.NONE, 0, 0],
            [0, 0, POSE.THROW, 1 / 3, 1], [0.2, 0.6, POSE.JAB, 0.6, 0.7], [0, 0, POSE.SWING, 0.6, 1],
            [0, 0, POSE.SIT, 0.3, 1], [0, 0, POSE.CRAFT, 0.5, 1], [0, 0, POSE.BUTCHER, 0.4, 1], [0, 0, POSE.CHOP, 0.25, 1],
        ]) {
            hand.set(phase, amount, code, progress, w, rig);
            hand.place(PART.ARM_R, ...grip, out, turn);
            const want = shaderArm(grip, rig, phase, amount, code, progress, w);
            for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[k] - want[k]) < 1e-9, `${body} pose ${code}: ${[...out]} vs ${want}`);
        }
    }
    // The body built in code keeps its own rig.
    assert.equal(CODE_RIG.hip, 1.85);
});

// ---- People drawn (creatures.js) ----

const THREE = await import('three');
const { Creatures } = await import('../src/view3d/creatures.js');
const { Looks } = await import('../src/view3d/looks.js');
const { params } = await import('../src/config.js');
const { STATE } = await import('../src/population.js');

test('people are drawn in their body, their tribe\'s cloth, their own skin and hair', () => {
    const tribes = new Map([[1, { id: 1, color: '#4a90e2' }], [2, { id: 2, color: '#e86fb0' }]]);
    const people = [
        { id: 3, tribe: 1, age: 5000 }, { id: 4, tribe: 1, age: 5000 }, { id: 8, tribe: 2, age: 9000 },
        { id: 9, tribe: 2, age: 300, parent: 8 }, { id: 10, tribe: 1, age: 5000 }, { id: 11, tribe: 2, age: 5000 },
    ];
    const humans = { n: people.length };
    for (const k of ['x', 'y', 'heading', 'id', 'age', 'tribe', 'state', 'parent']) humans[k] = new Float64Array(people.length);
    people.forEach((p, i) => {
        Object.assign(p, { x: 100 + 3 * i, y: 100 });
        for (const k of ['x', 'y', 'id', 'age', 'tribe']) humans[k][i] = p[k];
        humans.parent[i] = p.parent ?? 0;
        humans.state[i] = STATE.HUNTING;
    });
    const empty = () => ({ n: 0, x: [], y: [], heading: [], id: [], age: [], tribe: [], state: [] });
    const world = { seed: 7, p: params, herbivores: empty(), carnivores: empty(), humans, tribeById: tribes, fallen: [] };
    const W = 1000;
    const view = {
        W, H: 600, fx: 100, fz: 100, camX: 0, camY: 30, camZ: 40, minX: -400, maxX: 400, minZ: -400, maxZ: 400,
        unitPx: 1e-4, mapness: 0, dist: 50, personalSpace: 0, fogFar: 3000, planes: new Float64Array(24),
    };
    const looks = new Looks(null);
    looks.attach(world);
    const c = new Creatures(new THREE.Scene(), looks);
    c.setPeople(BODIES.map((b) => shapeOf(b)));
    c.motion.tick(0, 0);
    c.update(world, view, () => 0, 0);
    // Each herd has its body's people, in the order they come.
    const k = [0, 0, 0];
    for (const p of people) {
        const look = looks.of(p.id);
        const h = c.herds.human[look.body];
        const i = k[look.body]++;
        const near = (a, b) => b.every((v, j) => Math.abs(a[i * b.length + j] - v) < 1e-6);
        assert.ok(near(h.cloths, clothOf(tribes.get(p.tribe).color)), `${p.id}: dyed in its tribe's colour`);
        assert.ok(near(h.colors, linear(tribes.get(p.tribe).color)), `${p.id}: its tribe's colour, for the map`);
        assert.ok(near(h.skins, look.skinRgb), `${p.id}: its own skin`);
        assert.equal(h.hairs[i * 4 + 3], look.style, `${p.id}: its hair style`);
    }
    assert.deepEqual(c.herds.human.map((h) => h.mesh.count), k, 'one herd per body');
    // The child takes after its parent.
    assert.equal(looks.of(9).hair, looks.of(8).hair);
    // Held items go in each body's hands.
    assert.equal(c.rigOf(3), shapeOf(BODIES[looks.of(3).body]).rig);
});
