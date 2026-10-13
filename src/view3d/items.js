// Items in the world, drawn (package 3): what each person holds, where it
// is held, and what lies on the ground. Legendary ones glint; torches burn
// in a soft glow (and with `?torchlight`, the two nearest light the ground).
//
// Where an item is held:
// - a spear or a club in the right hand; a bow in the left;
// - a torch in the left hand (the right, if the left holds a bow);
// - a knife at the belt, and in the right hand at work (butchering,
//   chopping, knapping, crafting); a basket on the back.
// Kneeling or seated at work (gathering, butchering, chopping, knapping,
// crafting, sitting), the weapon lies on the ground beside the body.
//
// The hands move with the body's pose, which the vertex shader works out
// on the graphics card (animate.js). The same keyframes are read here for
// each person near enough to see, and the same turns worked out for the
// hand alone (HandPose), so an item stays in the hand: on each person's own
// body, whose shoulders, hands, belt and back are where its model has them
// (models.js biped's `rig`; CODE_RIG for the body built in code). While a
// spear is thrown or thrust it is held level along the body (`locks`), the
// way a wrist would turn it as the arm goes over the top, and a bow is held
// upright as it is drawn.
//
// Each kind is one instanced mesh (six draw calls, held and lying alike),
// with the rarity a tint on its working part (the point, the stave, the
// head, the blade, the rim); one more for the glints, the flames and their
// glows together (sparkles). One left empty a while is hidden (Pool.commit).
// Drawing only, like the rest of the view.
import * as THREE from 'three';
import { part } from './shapes.js';
import { GAIT, POSE, POSES, KEYS } from './animate.js';
import { offScreen, CHILD } from './creatures.js';
import { TAU, wrapDelta, hash } from './util.js';
import { kindName } from '../play/gear.js';

export const ITEM_SHAPES = ['spear', 'bow', 'club', 'knife', 'basket', 'torch'];
const FAR = 220;          // items farther than this from the camera are not drawn
const MIN_PX = 3;         // nor any whose length on screen is less than this
const IDLE_MS = 3000;      // ms a mesh may stay empty before it is hidden (showWhile)
// Torches that really light their surroundings (the nearest): none unless
// `?torchlight`. A point light in the scene makes every lit surface work it
// out, torch or not: about 3 ms a frame on the page's thread in the
// headless checks for two. Without them, each flame wears a soft glow.
const LIGHTS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('torchlight') ? 2 : 0;
const TINT = {            // the rarity's tint on an item's working part
    normal: [1, 1, 1],
    rare: [0.55, 0.78, 1.45],
    legendary: [1.55, 1.18, 0.42],
};

// ---- Shapes: each kind along +Y, its grip at the origin ----

const WOOD = [0.6, 0.47, 0.32];
const DARK_WOOD = [0.42, 0.31, 0.2];
const STONE = [0.6, 0.6, 0.58];
const FIBRE = [0.72, 0.62, 0.4];

// A part (shapes.js's), coloured, maybe the tinted one.
const piece = (geometry, opts, rgb, tint = 0) => ({ ...part(geometry, opts), rgb, tint });

// Concatenate coloured parts: positions, flat normals, colours and the tint mask.
function build(pieces) {
    let n = 0;
    for (const p of pieces) n += p.g.attributes.position.count;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const tint = new Float32Array(n);
    let o = 0;
    for (const p of pieces) {
        const count = p.g.attributes.position.count;
        position.set(p.g.attributes.position.array, o * 3);
        for (let v = o; v < o + count; v++) {
            color.set(p.rgb, v * 3);
            tint[v] = p.tint;
        }
        o += count;
        p.g.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// The shapes, and the point on each where a legend glints (its tip) and a
// torch burns.
export const SHAPES = {
    // A long shaft with a knapped point.
    spear: () => build([
        piece(box(0.13, 4.6, 0.13), { at: [0, 0.75, 0] }, WOOD),
        piece(new THREE.OctahedronGeometry(0.2, 0), { at: [0, 3.35, 0], scale: [1, 2.6, 0.7] }, STONE, 1),
        piece(box(0.17, 0.25, 0.17), { at: [0, 2.95, 0] }, DARK_WOOD),
    ]),
    // A stave bent forward (+X), its string straight behind.
    bow: () => {
        const parts = [];
        const n = 6;
        const half = 1.7;
        const bend = 0.5;
        const at = (t) => [bend * (1 - t * t) - bend, t * half]; // t −1..1, the grip (t 0) at the origin
        for (let k = 0; k < n; k++) {
            const t0 = -1 + (2 * k) / n;
            const t1 = -1 + (2 * (k + 1)) / n;
            const [x0, y0] = at(t0);
            const [x1, y1] = at(t1);
            const len = Math.hypot(x1 - x0, y1 - y0);
            const w = 0.15 - 0.05 * Math.abs(t0 + t1) / 2;
            parts.push(piece(box(w, len + 0.04, 0.1), { at: [(x0 + x1) / 2, (y0 + y1) / 2, 0], rot: [0, 0, -Math.atan2(x1 - x0, y1 - y0)] }, DARK_WOOD, 1));
        }
        parts.push(piece(box(0.025, 2 * half - 0.05, 0.025), { at: [-bend, 0, 0] }, [0.85, 0.82, 0.74]));
        parts.push(piece(box(0.2, 0.36, 0.14), { at: [0, 0, 0] }, FIBRE));
        return build(parts);
    },
    // A handle thickening into a knotted head.
    club: () => build([
        piece(new THREE.CylinderGeometry(0.08, 0.1, 1.6, 5), { at: [0, 0.55, 0] }, WOOD),
        piece(new THREE.IcosahedronGeometry(0.34, 0), { at: [0, 1.65, 0], scale: [1, 1.7, 1] }, DARK_WOOD, 1),
        piece(new THREE.OctahedronGeometry(0.12, 0), { at: [0.3, 1.75, 0.05] }, DARK_WOOD, 1),
        piece(new THREE.OctahedronGeometry(0.11, 0), { at: [-0.22, 1.5, 0.2] }, DARK_WOOD, 1),
    ]),
    // A wrapped handle and a flint blade.
    knife: () => build([
        piece(box(0.12, 0.42, 0.12), { at: [0, -0.06, 0] }, FIBRE),
        piece(new THREE.OctahedronGeometry(0.2, 0), { at: [0, 0.48, 0], scale: [0.75, 2.1, 0.22] }, STONE, 1),
    ]),
    // A woven basket, wider at the mouth, with a rim.
    basket: () => build([
        piece(new THREE.CylinderGeometry(0.5, 0.36, 0.95, 7, 1, true), { at: [0, 0, 0] }, FIBRE),
        piece(new THREE.CylinderGeometry(0.36, 0.36, 0.04, 7), { at: [0, -0.47, 0] }, FIBRE),
        piece(new THREE.CylinderGeometry(0.53, 0.53, 0.09, 7, 1, true), { at: [0, 0.47, 0] }, DARK_WOOD, 1),
    ]),
    // A stick with a dark, bound head.
    torch: () => build([
        piece(new THREE.CylinderGeometry(0.06, 0.08, 1.9, 5), { at: [0, 0.1, 0] }, WOOD),
        piece(new THREE.CylinderGeometry(0.15, 0.11, 0.4, 6), { at: [0, 1.05, 0] }, [0.3, 0.24, 0.2], 1),
    ]),
};
const TIP = { spear: [0, 3.75, 0], bow: [0, 1.7, 0], club: [0, 2.15, 0], knife: [0, 0.85, 0], basket: [0, 0.52, 0], torch: [0, 1.3, 0] };
const FLAME_AT = [0, 1.32, 0];
// The sparkles' colours (added to what is behind): a legend's glint, a
// flame and its brighter core, and the faint glow about it.
const GLINT = [1, 0.82, 0.42];
const FLAME = [1, 0.5, 0.12];
const FLAME_CORE = [1, 0.85, 0.45];
const GLOW = [0.07, 0.028, 0.006]; // (linear, at its heart; it fades to nothing at its rim)

// ---- Small 3×3 rotations (column-major arrays of 9) ----

// The vertex shader's turn (animate.js): outward about x, then forward
// about z, then the twist about y, as a matrix.
function turnMat(fw, out, tw, m) {
    const ca = Math.cos(out);
    const sa = Math.sin(out);
    const cb = Math.cos(fw);
    const sb = Math.sin(fw);
    const cg = Math.cos(tw);
    const sg = Math.sin(tw);
    m[0] = cg * cb;
    m[1] = sb;
    m[2] = -sg * cb;
    m[3] = -cg * sb * ca + sg * sa;
    m[4] = cb * ca;
    m[5] = sg * sb * ca + cg * sa;
    m[6] = cg * sb * sa + sg * ca;
    m[7] = -cb * sa;
    m[8] = -sg * sb * sa + cg * ca;
    return m;
}
function mul(a, b, out) {
    for (let c = 0; c < 3; c++) {
        const x = b[c * 3];
        const y = b[c * 3 + 1];
        const z = b[c * 3 + 2];
        out[c * 3] = a[0] * x + a[3] * y + a[6] * z;
        out[c * 3 + 1] = a[1] * x + a[4] * y + a[7] * z;
        out[c * 3 + 2] = a[2] * x + a[5] * y + a[8] * z;
    }
    return out;
}
const rotZ = (t) => turnMat(t, 0, 0, new Float64Array(9));
const rotX = (t) => turnMat(0, t, 0, new Float64Array(9));
const IDENTITY = rotZ(0);
// m·v into out (a 3-vector)
function apply(m, x, y, z, out, o = 0) {
    out[o] = m[0] * x + m[3] * y + m[6] * z;
    out[o + 1] = m[1] * x + m[4] * y + m[7] * z;
    out[o + 2] = m[2] * x + m[5] * y + m[8] * z;
}

// ---- Where things are held ----

const ARM_L = 6;
const ARM_R = 7;

// A body's rig, as the hands see it: its hips (where the torso bends and the
// whole body turns), how its poses scale (k: models.js `body`), each arm's
// shoulder and where its hand grips, and where its belt and back are. This
// one is the person built in code (shapes.js); a model's comes from
// models.js (biped's `rig`).
export const CODE_RIG = {
    hip: 1.85,
    k: 1,
    shoulder: { [ARM_L]: [0, 3.45, -0.84], [ARM_R]: [0, 3.45, 0.84] },
    grip: { [ARM_L]: [0.1, 1.95, -0.84], [ARM_R]: [0.1, 1.95, 0.84] },
    belt: [0.3, 2.0, -0.6],
    back: [-0.92, 2.75, 0],
};

// How each kind is held: `at` 'right' | 'left' | 'belt' | 'back'; `grip`,
// its turn in the hand (or on the body); `locks`, poses that hold it in the
// body's frame instead ({code: turn}); `works`, poses in which it goes to
// the right hand (`hand`) instead of the belt.
const LEVEL = rotZ(-1.4);  // +Y pointing forward, a little up
const THRUST = rotZ(-1.62);
const HOLD = {
    spear: { at: 'right', grip: rotZ(-0.35), locks: { [POSE.THROW]: LEVEL, [POSE.JAB]: THRUST } },
    club: { at: 'right', grip: rotZ(-2.35) },
    bow: { at: 'left', grip: IDENTITY, locks: { [POSE.SHOOT]: IDENTITY } },
    torch: { at: 'left', grip: rotZ(-0.5) },
    knife: { at: 'belt', grip: mul(rotZ(Math.PI - 0.25), rotX(0.2), new Float64Array(9)), works: new Set([POSE.BUTCHER, POSE.KNAP, POSE.CRAFT, POSE.CHOP]), hand: rotZ(Math.PI) },
    basket: { at: 'back', grip: rotZ(0.2) },
};
// Poses in which the weapon is laid on the ground beside the body.
const LAID = new Set([POSE.GATHER, POSE.BUTCHER, POSE.CHOP, POSE.KNAP, POSE.CRAFT, POSE.SIT, POSE.EAT]);
const LAID_AT = [0.9, 0.08, 1.45];
const LYING = mul(rotX(Math.PI / 2), rotZ(-Math.PI / 2), new Float64Array(9)); // +Y along the ground, flat

// The pose's keys for one column, sampled (animate.js's samplePose, without allocating).
function sample(def, progress, column, w, out) {
    const f = progress * (def.cycle ? KEYS : KEYS - 1);
    const k = Math.min(Math.floor(f), KEYS - 1);
    let t = f - k;
    t = t * t * (3 - 2 * t);
    const k1 = def.cycle ? (k + 1) % KEYS : Math.min(k + 1, KEYS - 1);
    const a = def.keys[k][column];
    const b = def.keys[k1][column];
    for (let c = 0; c < 3; c++) {
        const va = a ? a[c] : 0;
        const vb = b ? b[c] : 0;
        out[c] += w * (va + (vb - va) * t);
    }
}

// One person's pose worked out for the hands and the torso, as the vertex
// shader does it: the turns (3×3) and the points they turn about.
export class HandPose {
    constructor() {
        this.rig = CODE_RIG;
        this.armL = new Float64Array(3);
        this.armR = new Float64Array(3);
        this.torsoR = new Float64Array(3);
        this.rootR = new Float64Array(3);
        this.shift = new Float64Array(3);
        this.pivot = new Float64Array(3);
        this.mL = new Float64Array(9);
        this.mR = new Float64Array(9);
        this.mT = new Float64Array(9);
        this.mRoot = new Float64Array(9);
        this.body = new Float64Array(9); // root · torso
        this.tmp = new Float64Array(9);
        this.v = new Float64Array(3);
    }

    // From a stride (phase, amount) and a pose (code, progress, weight), on
    // a body's rig (CODE_RIG, or a model's).
    set(phase, amount, code, progress, weight, rig = CODE_RIG) {
        const g = GAIT.human;
        this.rig = rig;
        const ph = phase * TAU;
        const walk = amount < 0 ? 0 : amount > 1 ? 1 : amount;
        const run = amount - 1 < 0 ? 0 : amount - 1 > 1 ? 1 : amount - 1;
        const swing = g.swing * walk * (1 + g.runSwing * run);
        const sw = Math.sin(ph);
        const arm = g.arms * walk * (1 + run);
        this.armL.fill(0);
        this.armR.fill(0);
        this.armL[0] = -arm * sw;
        this.armR[0] = arm * sw;
        this.torsoR.fill(0);
        this.torsoR[0] = g.lean * run;
        this.rootR.fill(0);
        this.rootR[0] = g.pitch * run * Math.cos(ph);
        this.shift.fill(0);
        this.shift[1] = -rig.hip * (1 - Math.cos(swing * sw));
        this.pivot[0] = 0;
        this.pivot[1] = rig.hip;
        this.pivot[2] = 0;
        const def = weight > 0 ? POSES.human[code] : undefined;
        if (def) {
            sample(def, progress, 'armL', weight, this.armL);
            sample(def, progress, 'armR', weight, this.armR);
            sample(def, progress, 'torso', weight, this.torsoR);
            sample(def, progress, 'root', weight, this.rootR);
            // (Shift and pivot in the body's proportions, as the shader's uBody.)
            sample(def, progress, 'shift', weight * rig.k, this.shift);
            sample(def, progress, 'pivot', weight * rig.k, this.pivot);
        }
        // ("Outward" is away from the body: the right arm's is mirrored.)
        turnMat(this.armL[0], this.armL[1], this.armL[2], this.mL);
        turnMat(this.armR[0], -this.armR[1], this.armR[2], this.mR);
        turnMat(this.torsoR[0], this.torsoR[1], this.torsoR[2], this.mT);
        turnMat(this.rootR[0], this.rootR[1], this.rootR[2], this.mRoot);
        mul(this.mRoot, this.mT, this.body);
        return this;
    }

    // Where a point (x, y, z) of the body goes, and its turn: on an arm
    // (side ARM_L or ARM_R) or on the torso (side 0). Leaves the point in
    // `out` (3) and the turn in `turn` (9).
    place(side, x, y, z, out, turn) {
        const v = this.v;
        const hip = this.rig.hip;
        if (side) {
            const m = side === ARM_R ? this.mR : this.mL;
            const j = this.rig.shoulder[side];
            apply(m, x - j[0], y - j[1], z - j[2], v);
            x = v[0] + j[0];
            y = v[1] + j[1];
            z = v[2] + j[2];
            mul(this.body, m, turn);
        } else turn.set(this.body);
        apply(this.mT, x, y - hip, z, v); // (the torso turns about the hips, as RIGS.human.torso)
        x = v[0];
        y = v[1] + hip;
        z = v[2];
        const p = this.pivot;
        apply(this.mRoot, x - p[0], y - p[1], z - p[2], out);
        out[0] += p[0] + this.shift[0];
        out[1] += p[1] + this.shift[1];
        out[2] += p[2] + this.shift[2];
    }
}

// An empty mesh still costs the renderer its program every frame, and one
// hidden and then shown again can stall the frame it comes back in: so a
// mesh is hidden only once it has been empty for IDLE_MS (as on the map,
// where nothing held is drawn), and shown the moment it has anything.
export function showWhile(mesh, count, now = performance.now()) {
    if (count > 0) mesh.userData.used = now;
    mesh.visible = count > 0 || now - (mesh.userData.used ?? now) < IDLE_MS;
    if (mesh.userData.used === undefined) mesh.userData.used = now;
}

// An instanced mesh that grows as needed, with a colour per instance.
class Pool {
    constructor(scene, geometry, material, cap = 64) {
        this.scene = scene;
        this.geometry = geometry;
        this.material = material;
        this.mesh = null;
        this.k = 0;
        this.grow(cap);
    }

    grow(cap) {
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false; // each is checked against the view as it is written
        mesh.count = 0;
        if (this.mesh) {
            mesh.instanceMatrix.array.set(this.mesh.instanceMatrix.array);
            mesh.instanceColor.array.set(this.mesh.instanceColor.array);
            this.scene.remove(this.mesh);
            this.mesh.dispose();
        }
        this.scene.add(mesh);
        this.mesh = mesh;
    }

    // The next instance's slot: its matrix array and offset.
    next() {
        if (this.k >= this.mesh.instanceMatrix.count) this.grow(this.k * 2);
        return this.k++;
    }

    // This frame's instances are written (and the mesh hidden if it has
    // long been empty: showWhile).
    commit() {
        const mesh = this.mesh;
        mesh.count = this.k;
        showWhile(mesh, this.k);
        if (this.k) {
            for (const [a, size] of [[mesh.instanceMatrix, 16], [mesh.instanceColor, 3]]) {
                a.clearUpdateRanges();
                a.addUpdateRange(0, this.k * size);
                a.needsUpdate = true;
            }
        }
        this.k = 0;
    }
}

// Lambert, flat, coloured per vertex; the instance colour (the rarity)
// tints only the parts marked to be tinted.
function itemMaterial() {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float tint;')
            .replace('#include <color_vertex>', [
                'vColor = vec3( 1.0 );',
                'vColor *= color;',
                'vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, tint );',
            ].join('\n'));
    };
    material.customProgramCacheKey = () => 'items';
    return material;
}

// Unlit, added to what is behind, and soft: brightest where it faces the
// camera, fading to nothing at its rim, so a glow has no edge.
function sparkleMaterial() {
    const material = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vFacing;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvFacing = abs( normalize( mat3( modelViewMatrix ) * mat3( instanceMatrix ) * normal ).z );');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vFacing;')
            .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * vFacing * vFacing, opacity );');
    };
    material.customProgramCacheKey = () => 'sparkles';
    return material;
}

export class Items {
    constructor(scene) {
        this.scene = scene;
        const material = itemMaterial();
        this.pools = {};
        for (const kind of ITEM_SHAPES) this.pools[kind] = new Pool(scene, SHAPES[kind](), material);
        // Glints, flames and their glows: lights added to what is behind
        // them, all one mesh (one draw call), each its own colour.
        this.sparkles = new Pool(scene, new THREE.OctahedronGeometry(1, 2), sparkleMaterial());
        this.lights = [];
        for (let k = 0; k < LIGHTS; k++) {
            const light = new THREE.PointLight('#ffae5c', 0, 22, 1.6);
            scene.add(light);
            this.lights.push(light);
        }
        this.torches = []; // this frame's flames: [x, y, z, d2] each, for the lights
        this.hand = new HandPose();
        this.rigOf = () => null; // a person's body's rig (creatures.js rigOf), or null: CODE_RIG
        this.p = new Float64Array(3);
        this.turn = new Float64Array(9);
        this.r = new Float64Array(9);
        this.q = new Float64Array(3);
        this.base = { x: 0, y: 0, z: 0, h: 0, sc: 1 }; // (the body an item is on, reused)
        this.clock = 0;
        this.stats = { held: 0, lying: 0, glints: 0, flames: 0 };
    }

    attach() {
        for (const l of this.lights) l.intensity = 0;
    }

    // Write every item in view. world: the Mirror (byBearer, items,
    // humans); motion: the creatures' (their strides and poses this frame);
    // hideId: a body not drawn (first person); clock: seconds at 1×.
    update(world, view, ground, motion, hideId, clock) {
        this.clock = clock;
        this.view = view;
        this.torches.length = 0;
        this.stats.held = 0;
        this.stats.lying = 0;
        this.stats.glints = 0;
        this.stats.flames = 0;
        const bearers = world.byBearer;
        if (bearers instanceof Map && bearers.size) this.held(world, view, ground, motion, hideId, bearers);
        if (world.items instanceof Map && world.items.size) this.lying(world, view, ground);
        for (const pool of Object.values(this.pools)) pool.commit();
        this.sparkles.commit();
        this.light();
    }

    // Is a body at render (x, z), ground gy, near enough to show what it
    // holds? Its distance squared to the camera, or -1.
    near(view, x, gy, z) {
        const ex = x - view.camX;
        const ey = gy - view.camY;
        const ez = z - view.camZ;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > FAR * FAR || d2 < view.personalSpace * view.personalSpace) return -1;
        if (4 < MIN_PX * Math.sqrt(d2) * view.unitPx) return -1; // (an item a few pixels long)
        if (offScreen(view.planes, x, gy + 2.5, z, 5)) return -1;
        return d2;
    }

    held(world, view, ground, motion, hideId, bearers) {
        const pop = world.humans;
        const { W, H, fx, fz } = view;
        const maturity = world.p.human.maturity;
        const hand = this.hand;
        for (let i = 0; i < pop.n; i++) {
            const id = pop.id[i];
            const hands = bearers.get(id);
            if (!hands || id === hideId || (!hands.weapon && !hands.tool)) continue;
            const x = wrapDelta(pop.x[i] - fx, W);
            const z = wrapDelta(pop.y[i] - fz, H);
            if (x < view.minX || x > view.maxX || z < view.minZ || z > view.maxZ) continue;
            const gy = ground(pop.x[i], pop.y[i]);
            const d2 = this.near(view, x, gy, z);
            if (d2 < 0) continue;
            // In the map view, bodies far off are drawn larger than life: then
            // what they hold would not fit them; leave it.
            if (view.mapness > 0.02 && Math.sqrt(d2) * view.unitPx * 10 * view.mapness > 4.8) continue;
            if (!motion.posed(id)) continue;
            hand.set(motion.phase, motion.amount, motion.code, motion.progress, motion.weight, this.rigOf(id) ?? CODE_RIG);
            const sc = pop.age[i] < maturity ? CHILD : 1;
            const base = this.base;
            base.x = x;
            base.y = gy;
            base.z = z;
            base.h = pop.heading[i];
            base.sc = sc;
            const code = motion.weight > 0.5 ? motion.code : POSE.NONE;
            const weapon = hands.weapon ? kindName(hands.weapon.kind) : '';
            if (weapon) this.mount(hands.weapon, weapon, base, code, motion.weight, weapon === 'bow' ? ARM_L : ARM_R);
            if (hands.tool) {
                const tool = kindName(hands.tool.kind);
                this.mount(hands.tool, tool, base, code, motion.weight, tool === 'torch' && weapon === 'bow' ? ARM_R : ARM_L);
            }
        }
    }

    // One item held by a body (`base`: its place, heading and size), in
    // pose `code` (shown with `weight`).
    mount(item, kind, base, code, weight, side) {
        const how = HOLD[kind];
        const pool = this.pools[kind];
        if (!how || !pool) return;
        const hand = this.hand;
        const p = this.p;
        const r = this.r;
        if (isWeapon(kind) && LAID.has(code)) {
            // Put down beside the body while it works.
            r.set(LYING);
            p[0] = LAID_AT[0];
            p[1] = LAID_AT[1];
            p[2] = LAID_AT[2] * (kind === 'bow' ? -1 : 1);
            this.put(pool, item, kind, base, p, r, true);
            return;
        }
        if (how.at === 'back' || (how.at === 'belt' && !how.works.has(code))) {
            const at = how.at === 'back' ? hand.rig.back : hand.rig.belt;
            hand.place(0, at[0], at[1], at[2], p, this.turn);
            mul(this.turn, how.grip, r);
        } else {
            const arm = how.at === 'belt' ? ARM_R : side;
            const g = hand.rig.grip[arm];
            hand.place(arm, g[0], g[1], g[2], p, this.turn);
            mul(this.turn, how.at === 'belt' ? how.hand : how.grip, r);
            const lock = how.locks?.[code];
            if (lock) blend(r, lock, weight);
        }
        this.put(pool, item, kind, base, p, r, false);
    }

    // Write one item: at model point p, turned r, on the body at `base`.
    put(pool, item, kind, base, p, r, onGround) {
        const k = pool.next();
        const te = pool.mesh.instanceMatrix.array;
        const c = Math.cos(base.h);
        const s = Math.sin(base.h);
        const sc = base.sc;
        // The body's turn (model +X along the heading) and size, times r.
        const o = k * 16;
        for (let col = 0; col < 3; col++) {
            const mx = r[col * 3];
            const my = r[col * 3 + 1];
            const mz = r[col * 3 + 2];
            te[o + col * 4] = sc * (c * mx - s * mz);
            te[o + col * 4 + 1] = sc * my;
            te[o + col * 4 + 2] = sc * (s * mx + c * mz);
            te[o + col * 4 + 3] = 0;
        }
        const wx = base.x + sc * (c * p[0] - s * p[2]);
        const wy = base.y + sc * p[1];
        const wz = base.z + sc * (s * p[0] + c * p[2]);
        te[o + 12] = wx;
        te[o + 13] = wy;
        te[o + 14] = wz;
        te[o + 15] = 1;
        pool.mesh.instanceColor.array.set(TINT[RARITY[item.rarity] ?? 'normal'], k * 3);
        if (onGround) this.stats.lying++;
        else this.stats.held++;
        // The tip of a legend glints; a torch in a hand burns.
        if (item.rarity >= 2) this.glint(te, o, TIP[kind], item.id);
        if (kind === 'torch' && !onGround) this.flame(te, o);
    }

    // Lying on the ground, where it fell or was put down, turned its own way.
    lying(world, view, ground) {
        const { W, H, fx, fz } = view;
        const p = this.p;
        p[0] = 0;
        p[1] = 0.1;
        p[2] = 0;
        for (const item of world.items.values()) {
            if (item.bearer) continue;
            const kind = kindName(item.kind);
            const pool = this.pools[kind];
            if (!pool) continue;
            const x = wrapDelta(item.x - fx, W);
            const z = wrapDelta(item.y - fz, H);
            if (x < view.minX || x > view.maxX || z < view.minZ || z > view.maxZ) continue;
            const gy = ground(item.x, item.y);
            if (this.near(view, x, gy, z) < 0) continue;
            const base = this.base;
            base.x = x;
            base.y = gy;
            base.z = z;
            base.h = (hash(item.id) / 2 ** 32) * TAU;
            base.sc = 1;
            p[1] = kind === 'basket' ? 0.5 : 0.1;
            this.put(pool, item, kind, base, p, kind === 'basket' ? IDENTITY : LYING, true);
        }
    }

    // A glint at point `at` of the item whose matrix is at te[o]: a small
    // gold star that flares now and then.
    glint(te, o, at, id) {
        const q = this.q;
        q[0] = te[o] * at[0] + te[o + 4] * at[1] + te[o + 8] * at[2] + te[o + 12];
        q[1] = te[o + 1] * at[0] + te[o + 5] * at[1] + te[o + 9] * at[2] + te[o + 13];
        q[2] = te[o + 2] * at[0] + te[o + 6] * at[1] + te[o + 10] * at[2] + te[o + 14];
        const beat = Math.sin(this.clock * 2.3 + (id % 97) * 0.71);
        const s = 0.05 + 0.13 * Math.pow(Math.max(0, beat), 10);
        this.sparkle(q[0], q[1], q[2], s, s * 1.6, this.clock * 1.7 + id, GLINT);
        this.stats.glints++;
    }

    // One sparkle (sx wide, sy tall, turned `turn` about the vertical), of
    // colour rgb, added to what is behind it.
    sparkle(x, y, z, sx, sy, turn, rgb) {
        const k = this.sparkles.next();
        const g = this.sparkles.mesh.instanceMatrix.array;
        const c = Math.cos(turn) * sx;
        const sn = Math.sin(turn) * sx;
        const go = k * 16;
        g.fill(0, go, go + 16);
        g[go] = c;
        g[go + 2] = -sn;
        g[go + 5] = sy;
        g[go + 8] = sn;
        g[go + 10] = c;
        g[go + 12] = x;
        g[go + 13] = y;
        g[go + 14] = z;
        g[go + 15] = 1;
        this.sparkles.mesh.instanceColor.array.set(rgb, k * 3);
    }

    // A torch's flame, upright above its head, flickering, in a soft glow;
    // and kept for the lights (if any).
    flame(te, o) {
        const at = FLAME_AT;
        const x = te[o] * at[0] + te[o + 4] * at[1] + te[o + 8] * at[2] + te[o + 12];
        const y = te[o + 1] * at[0] + te[o + 5] * at[1] + te[o + 9] * at[2] + te[o + 13];
        const z = te[o + 2] * at[0] + te[o + 6] * at[1] + te[o + 10] * at[2] + te[o + 14];
        const t = this.clock * 9 + x * 0.37;
        const s = 0.85 + 0.15 * Math.sin(t) + 0.08 * Math.sin(t * 2.7);
        const tall = s * (0.9 + 0.2 * Math.sin(t * 1.3));
        this.sparkle(x, y + 0.3 * tall, z, 0.2 * s, 0.48 * tall, t * 0.1, FLAME);
        this.sparkle(x, y + 0.2 * tall, z, 0.11 * s, 0.3 * tall, -t * 0.1, FLAME_CORE);
        this.sparkle(x, y + 0.35, z, 0.75 + 0.08 * s, 0.85 + 0.08 * s, 0, GLOW);
        this.stats.flames++;
        if (!LIGHTS) return;
        const v = this.view;
        const d2 = (x - v.camX) ** 2 + (y - v.camY) ** 2 + (z - v.camZ) ** 2;
        this.torches.push([x, y + 2.4, z, d2]); // (a little above: the bearer is not glaring)
    }

    // The nearest torches light the ground about them, a little unsteadily.
    light() {
        const t = this.torches;
        if (t.length > LIGHTS) t.sort((a, b) => a[3] - b[3]);
        for (let k = 0; k < LIGHTS; k++) {
            const l = this.lights[k];
            if (k < t.length) {
                l.position.set(t[k][0], t[k][1], t[k][2]);
                l.intensity = 3 * (0.9 + 0.1 * Math.sin(this.clock * 11 + k * 2.1));
            } else l.intensity = 0;
        }
    }
}

const RARITY = ['normal', 'rare', 'legendary'];
const isWeapon = (kind) => kind === 'spear' || kind === 'bow' || kind === 'club';

// Turn r toward `to` by w (0..1), staying a rotation: blended column by
// column, then made orthonormal again.
function blend(r, to, w) {
    if (w <= 0) return;
    if (w >= 1) {
        r.set(to);
        return;
    }
    for (let k = 0; k < 9; k++) r[k] += (to[k] - r[k]) * w;
    // Gram-Schmidt on the first two columns; the third is their cross.
    let l = Math.hypot(r[3], r[4], r[5]) || 1;
    r[3] /= l;
    r[4] /= l;
    r[5] /= l;
    const d = r[0] * r[3] + r[1] * r[4] + r[2] * r[5];
    r[0] -= d * r[3];
    r[1] -= d * r[4];
    r[2] -= d * r[5];
    l = Math.hypot(r[0], r[1], r[2]) || 1;
    r[0] /= l;
    r[1] /= l;
    r[2] /= l;
    r[6] = r[1] * r[5] - r[2] * r[4];
    r[7] = r[2] * r[3] - r[0] * r[5];
    r[8] = r[0] * r[4] - r[1] * r[3];
}
