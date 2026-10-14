// Creatures as instanced meshes: one mesh per species (people: one per
// body), so a thousand grazers are a single draw call. Every frame each
// individual's matrix (standing on the ground, turned to its heading,
// scaled) is written straight into the instance buffer.
//
// Bodies move (animate.js): each instance also gets its gait (how far through
// a stride, how fast) and its pose (which, how far through, how much), and
// the species' vertex shader moves the legs, head and arms from those.
//
// The world wraps, so an individual is drawn at each of its copies the camera
// can see: usually just one, but from high above the map shows the world's
// neighbouring copies too, and they are not empty.
//
// A species with an imported model (models.js: the sheep and the wolf) starts
// with its body built in code and changes to the model once it has loaded
// (useModels); then it is drawn at two levels of detail, the model up close
// and its simplified copy where it is under LOD_PX pixels long. The smaller
// it is drawn, the more it wears its species' colour on the 2D map (LOOK):
// in the map view a grazer reads as cream and a predator as red at a glance.
//
// People (Looks L2): each wears one of three bodies, in clothes dyed in their
// tribe's colour, with their own skin and hair (looks.js: made from their id,
// or chosen in the editor), so each instance also gets its tribe's colour,
// its clothes', its skin's and its hair's (and the hair's style). Small on
// screen, they wear their tribe's colour, as on the 2D map. A herd per body
// and outfit (their job's: models.js outfitOf; plain clothes for all until
// jobs come), each outfit fetched when first worn. Until the bodies have
// loaded, the person built in code stands in.
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { STATE } from '../population.js';
import { herbivoreShape, carnivoreShape, personShape, RIGS } from './shapes.js';
import { GAIT, KINDS, POSE, POSES, Motion, VERTEX_PARS, VERTEX_MAIN, VERTEX_COLOR, firstRow, poseTable, SLEEPING } from './animate.js';
import { loadModel, loadPerson, outfitOf, OUTFITS } from './models.js';
import { BODIES, Looks, clothOf } from './looks.js';
import { wrapDelta } from './util.js';
import { depthTwin } from './shadows.js';

// size: rough length in world units; minPx: in the map view, bodies grow with
// distance so they stay at least this many pixels long; center: height of the
// middle of the body (what a click aims at).
export const SPECIES = {
    herbivore: { size: 5, minPx: 6, center: 2.0, ring: 4.5 },
    carnivore: { size: 7, minPx: 11, center: 1.7, ring: 6 },
    human: { size: 4.8, minPx: 10, center: 2.4, ring: 4 },
};
export const SHAPES = { herbivore: herbivoreShape, carnivore: carnivoreShape, human: personShape };
export const CHILD = 0.62; // a child's size, relative to an adult
export const LOD_PX = 40;  // a body with a model drawn shorter than this (pixels) uses the model's far level
// A model drawn small wears its species' map colour over its own (animate.js
// VERTEX_COLOR): none from `from` pixels long down, `most` at `to` and below.
const LOOK = { from: 48, to: 14, most: 0.75 };

// How much of the map colour a copy at scale sc, d2 away (squared), wears;
// k: the view's unitPx over the body's size, 0 for a body without a model.
export function lookOf(k, sc, d2) {
    if (!k) return 0;
    const px = sc / (Math.sqrt(d2) * k);
    return px >= LOOK.from ? 0 : (LOOK.most * Math.min(1, (LOOK.from - px) / (LOOK.from - LOOK.to)));
}

// Is a ball of radius r at (x, y, z) wholly outside one of the view's planes?
export function offScreen(P, x, y, z, r) {
    for (let p = 0; p < 24; p += 4) if (P[p] * x + P[p + 1] * y + P[p + 2] * z + P[p + 3] < -r) return true;
    return false;
}

// The keyframes of every pose, for the vertex shaders: one small float
// texture shared by all three species.
let keyframes = null;
function poseTexture() {
    if (!keyframes) {
        const { data, width, height } = poseTable();
        keyframes = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
        keyframes.needsUpdate = true;
    }
    return keyframes;
}

// A species' material: flat-shaded and lit, with the animation in its vertex
// shader. The species share one shader program (people one of their own);
// what differs (joints, gait, the body's proportions) is in their uniforms,
// which fit() changes for another body.
export function herdMaterial(kind, color) {
    const g = GAIT[kind];
    const uniforms = {
        uPoses: { value: poseTexture() },
        uRow: { value: firstRow(kind) },
        uTorso: { value: new THREE.Vector3(...RIGS[kind].torso) },
        uRoot: { value: new THREE.Vector3(...RIGS[kind].root) },
        uBody: { value: new THREE.Vector3(1, 1, 1) },
        uLook: { value: new THREE.Color(COLORS[kind] ?? '#ffffff') }, // (linear)
        uGaitA: { value: new THREE.Vector4(g.swing, g.runSwing, g.leg, g.pitch) },
        uGaitB: { value: new THREE.Vector4(g.lean, g.headLean, g.arms, g.quad) },
    };
    const material = new THREE.MeshLambertMaterial({ color, vertexColors: true, flatShading: true });
    const people = kind === 'human';
    if (people) material.defines = { PEOPLE: '' };
    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
            .replace('#include <begin_vertex>', VERTEX_MAIN)
            .replace('#include <color_vertex>', VERTEX_COLOR);
    };
    material.customProgramCacheKey = () => (people ? 'creature-people' : 'creature');
    // Its shadow moves as it does (shadows.js): the same vertex shader.
    depthTwin(material, people ? 'creature-people-depth' : 'creature-depth', (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
            .replace('#include <begin_vertex>', VERTEX_MAIN);
    });
    // Another body (a model, models.js): its joints and proportions, and its
    // own colours under a white material.
    material.fit = ({ torso, root, body, hip, ownColors }) => {
        uniforms.uTorso.value.set(...torso);
        uniforms.uRoot.value.set(...root);
        uniforms.uBody.value.set(...body);
        if (hip) uniforms.uGaitA.value.z = hip;
        if (ownColors) material.color.set('#ffffff');
    };
    return material;
}

// What each instance carries besides its matrix (sizes in numbers): its gait
// (stride, speed, and how much of its map colour it wears) and its pose;
// people also their clothes' colour, their skin and their hair (colour and
// style), and their tribe's colour (instanceColor).
const EACH = { gait: 3, pose: 3 };
const PEOPLE_EACH = { ...EACH, cloth: 3, skin: 3, hair: 4 };

// One species (or one body of people): an InstancedMesh that grows when it
// runs out of room.
export class Herd {
    constructor(scene, geometry, material, people = false) {
        this.scene = scene;
        this.geometry = geometry;
        this.material = material;
        this.people = people;
        this.each = people ? PEOPLE_EACH : EACH;
        this.attrs = {};
        this.capacity = 0;
        this.mesh = null;
        this.n = 0; // instances written this frame
        this.grow(people ? 256 : 1024);
    }

    // Another body: the instances keep what they carry; the material takes
    // the body's joints (shape: models.js's).
    setShape(geometry, shape) {
        const old = this.geometry;
        for (const name of Object.keys(this.each)) {
            geometry.setAttribute(name, this.attrs[name]);
            old.deleteAttribute(name);
        }
        this.geometry = geometry;
        this.mesh.geometry = geometry;
        old.dispose();
        this.material.fit(shape);
    }

    grow(need) {
        const cap = Math.max(need, Math.ceil(this.capacity * 1.6), 256);
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (this.people) {
            mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
            mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        const attrs = {};
        for (const [name, size] of Object.entries(this.each)) {
            attrs[name] = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage);
        }
        // Instances move every frame, so precomputed bounds would be stale;
        // instead each one is checked against the view as it is written.
        mesh.frustumCulled = false;
        mesh.count = 0;
        if (this.mesh) {
            mesh.instanceMatrix.array.set(this.mesh.instanceMatrix.array);
            if (this.people) mesh.instanceColor.array.set(this.mesh.instanceColor.array);
            for (const name of Object.keys(attrs)) attrs[name].array.set(this.attrs[name].array);
            this.scene.remove(this.mesh);
            this.mesh.dispose();
        }
        for (const [name, a] of Object.entries(attrs)) this.geometry.setAttribute(name, a);
        this.scene.add(mesh);
        this.mesh = mesh;
        this.capacity = cap;
        this.attrs = attrs;
        this.matrices = mesh.instanceMatrix.array;
        this.colors = this.people ? mesh.instanceColor.array : null;
        this.gaits = attrs.gait.array;
        this.poses = attrs.pose.array;
        this.cloths = attrs.cloth?.array ?? null;
        this.skins = attrs.skin?.array ?? null;
        this.hairs = attrs.hair?.array ?? null;
    }

    commit(count) {
        const { mesh } = this;
        mesh.count = count;
        if (!count) return;
        const update = (attribute, size) => {
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, count * size);
            attribute.needsUpdate = true;
        };
        update(mesh.instanceMatrix, 16);
        if (this.people) update(mesh.instanceColor, 3);
        for (const [name, size] of Object.entries(this.each)) update(this.attrs[name], size);
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.dispose();
        this.geometry.dispose();
    }
}

// One person's colours for the frame, into herd h's instance k: their
// tribe's (`tribe`: { tribe, cloth }, linear), skin and hair (`hair`, linear,
// grey as it is at their age; and the style).
function dress(h, k, tribe, look, hair) {
    h.colors.set(tribe.tribe, k * 3);
    h.cloths.set(tribe.cloth, k * 3);
    h.skins.set(look.skinRgb, k * 3);
    h.hairs[k * 4] = hair[0];
    h.hairs[k * 4 + 1] = hair[1];
    h.hairs[k * 4 + 2] = hair[2];
    h.hairs[k * 4 + 3] = look.style;
}

export class Creatures {
    constructor(scene, looks = new Looks(null)) {
        // Per species, its herds (people: one per body, once loaded) and
        // each one's far level (a model's, once loaded).
        this.herds = {
            herbivore: [new Herd(scene, herbivoreShape(), herdMaterial('herbivore', COLORS.herbivore))],
            carnivore: [new Herd(scene, carnivoreShape(), herdMaterial('carnivore', COLORS.carnivore))],
            human: [new Herd(scene, personShape(), herdMaterial('human', '#ffffff'), true)],
        };
        this.far = { herbivore: [null], carnivore: [null], human: [null] };
        this.modelled = { herbivore: false, carnivore: false, human: false };
        this.bodies = []; // the people's models (models.js shapes), one per herd slot, once loaded
        this.worn = new Map(); // body__outfit → its herd slot (-1 while it loads)
        this.looks = looks;
        this.scene = scene;
        this.motion = new Motion(); // everyone's stride and pose, by id
        this.night = false; // (the scene's: the person you play, resting at night, sleeps)
        this.tribeColors = new Map(); // tribe id → { tribe, cloth } (linear RGB)
        this.color = new THREE.Color();
        this.hair = new Float64Array(3); // (scratch)
        // Where each drawn instance's body is, for clicks.
        this.pickN = 0;
        this.pickPos = new Float32Array(4096 * 3);
        this.pickId = new Float64Array(4096);
        this.vp = new THREE.Matrix4();
    }

    // Load the species' models (models.js), each swapped in when it arrives;
    // until then, and if one fails, the bodies built in code. People: the
    // three bodies, in plain clothes, together.
    useModels() {
        for (const kind of ['herbivore', 'carnivore']) {
            loadModel(kind)
                .then((shape) => shape && this.setShape(kind, shape))
                .catch((err) => console.warn(`The ${kind} model did not load; keeping the built-in body.`, err));
        }
        Promise.all(BODIES.map((body) => loadPerson(body)))
            .then((shapes) => shapes.every(Boolean) && this.setPeople(shapes))
            .catch((err) => console.warn('The people\'s models did not load; keeping the built-in body.', err));
    }

    setShape(kind, shape) {
        const herd = this.herds[kind][0];
        herd.setShape(shape.geometry, shape);
        if (shape.lite) this.far[kind][0] = new Herd(this.scene, shape.lite, herd.material);
        this.modelled[kind] = true;
        if (shape.minPx) SPECIES[kind].minPx = shape.minPx; // (the marker's ring grows with it too)
        if (shape.hip) GAIT[kind].leg = shape.hip; // its legs' length: strides that keep the feet planted
    }

    // The people's bodies in plain clothes (models.js shapes, one per
    // looks.js BODIES), in place of the body built in code.
    setPeople(shapes) {
        for (const h of this.herds.human) h.dispose();
        this.herds.human = [];
        this.far.human = [];
        this.bodies = [];
        shapes.forEach((shape, b) => this.dress(`${BODIES[b]}__${OUTFITS[0]}`, shape));
        this.modelled.human = true;
        if (shapes[0].minPx) SPECIES.human.minPx = shapes[0].minPx;
        GAIT.human.leg = shapes[0].hip; // (strides: the man's legs; the women's are within a few percent)
    }

    // A body in an outfit (`key`: its file's name): a herd with a material of
    // its own (joints differ), and its far level, in the next slot.
    dress(key, shape) {
        const material = herdMaterial('human', '#ffffff');
        material.fit(shape);
        const herd = new Herd(this.scene, shape.geometry, material, true);
        this.herds.human.push(herd);
        this.far.human.push(shape.lite ? new Herd(this.scene, shape.lite, material, true) : null);
        this.bodies.push(shape);
        this.worn.set(key, this.herds.human.length - 1);
    }

    // The slot of body b in `outfit` (models.js OUTFITS): an outfit not worn
    // before is fetched, and its plain clothes stand in until it has come.
    wear(b, outfit) {
        const key = `${BODIES[b]}__${outfit}`;
        const slot = this.worn.get(key);
        if (slot >= 0) return slot;
        if (slot === undefined) {
            this.worn.set(key, -1);
            loadPerson(BODIES[b], outfit)
                .then((shape) => shape && this.dress(key, shape))
                .catch((err) => console.warn(`${key} did not load; plain clothes instead.`, err));
        }
        return b;
    }

    // Where a person's hands, belt and back are (models.js biped's rig), or
    // null for the body built in code.
    rigOf(id) {
        return this.modelled.human ? this.bodies[this.wear(this.looks.of(id).body, outfitOf())].rig : null;
    }

    // A new world: forget the tribes' colours (it reuses their ids), and
    // everyone's strides.
    attach() {
        this.tribeColors.clear();
        this.pickN = 0;
        this.motion.reset();
    }

    // A tribe's colours: its own (on the map) and its clothes'.
    tribeColor(world, id) {
        let c = this.tribeColors.get(id);
        if (!c) {
            const tribe = world.tribeById.get(id) ?? world.fallen.find((t) => t.id === id);
            const hex = tribe ? tribe.color : COLORS.herbivore;
            this.color.set(hex); // three.js converts to linear
            c = { tribe: [this.color.r, this.color.g, this.color.b], cloth: clothOf(hex) };
            this.tribeColors.set(id, c);
        }
        return c;
    }

    // Write all three species, and their dead (`effects`, effects.js).
    // `hideId`: someone not to draw (whoever the first-person camera is
    // looking out of). The motion clock (motion.tick) has been moved on to
    // this frame already.
    update(world, view, ground, hideId, effects = null) {
        if (this.tribeColors.size > 64) this.tribeColors.clear();
        this.looks.tick();
        this.pickN = 0;
        this.write(world, world.herbivores, 'herbivore', view, ground, hideId, 0, effects);
        this.write(world, world.carnivores, 'carnivore', view, ground, hideId, 0, effects);
        this.write(world, world.humans, 'human', view, ground, hideId, world.p.human.maturity, effects);
    }

    // A copy at scale sc, d2 away (squared), is drawn at the far level when
    // it is under LOD_PX long on screen: sc² < lod2 · d2 (lod2 < 0: no far level).
    lod2(kind, view) {
        const k = (LOD_PX * view.unitPx) / SPECIES[kind].size;
        return this.far[kind][0] ? k * k : -1;
    }

    write(world, pop, kind, view, ground, hideId, maturity, effects) {
        const herds = this.herds[kind];
        const fars = this.far[kind];
        for (const h of herds) h.n = 0;
        for (const f of fars) if (f) f.n = 0;
        const lod2 = this.lod2(kind, view);
        const lk = this.modelled[kind] ? view.unitPx / SPECIES[kind].size : 0;
        const spec = SPECIES[kind];
        const motion = this.motion;
        const P = world.p[kind];
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes } = view;
        motion.species(kind, W, H, P.speed * P.cruise);
        const grow = (view.unitPx * spec.minPx * view.mapness) / spec.size; // scale per unit of distance
        const near2 = view.personalSpace * view.personalSpace;
        const { x, y, heading, id, age, tribe, state } = pop;
        // People are tracked even off screen: should one die there, its body
        // still wears its tribe's colour.
        const people = kind === 'human';
        const parent = people ? pop.parent : null;
        const bodies = people && this.modelled.human;
        // What people wear: their job's outfit (no jobs yet: everyone in plain clothes).
        const outfit = outfitOf();
        // The person the page controls (play/) sits only to rest; standing
        // still at camp, it stands.
        const player = people ? world.player ?? null : null;
        if (people) motion.seated = player !== null && player.resting ? player.id : 0; // (always seated while resting)
        for (let i = 0; i < pop.n; i++) {
            const base = maturity && age[i] < maturity ? CHILD : 1;
            // Its copies in view: offsets dx + ax·W with ax in [ax0, ax1].
            const dx = wrapDelta(x[i] - fx, W);
            const ax0 = Math.ceil((minX - dx) / W);
            const ax1 = Math.floor((maxX - dx) / W);
            const dz = wrapDelta(y[i] - fz, H);
            const az0 = Math.ceil((minZ - dz) / H);
            const az1 = Math.floor((maxZ - dz) / H);
            let st = state[i];
            if (player !== null && id[i] === player.id) {
                st = player.resting ? (st === SLEEPING || this.night ? SLEEPING : STATE.AT_CAMP) : st === STATE.AT_CAMP || st === SLEEPING ? STATE.WALKING : st;
            }
            // (Everyone's look is kept while they live, seen or not: a
            // child's hair is the parent's as it was.)
            const look = people ? this.looks.of(id[i], parent ? parent[i] : 0) : null;
            if (ax0 > ax1 || az0 > az1 || id[i] === hideId) {
                if (people) motion.track(id[i], x[i], y[i], st, base, tribe[i]);
                continue;
            }
            motion.track(id[i], x[i], y[i], st, base, tribe[i]);
            const { phase, amount, code, progress, weight } = motion;

            // A person's body, clothes, skin and hair.
            let b = 0;
            let colors = null;
            if (people) {
                if (bodies) b = this.wear(look.body, outfit);
                colors = this.tribeColor(world, tribe[i]);
                this.looks.hairAt(look, age[i], maturity, this.hair);
            }
            const herd = herds[b];
            const far = fars[b];

            const gy = ground(x[i], y[i]);
            const c = Math.cos(heading[i]);
            const s = Math.sin(heading[i]);
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    const ex = rx - camX;
                    const ey = gy - camY;
                    const ez = rz - camZ;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 < near2) continue; // in first person, a neighbour's flank would fill the screen
                    let sc = base;
                    if (grow > 0) {
                        const up = Math.sqrt(d2) * grow;
                        if (up > 1) sc *= up;
                    }
                    const cy = gy + spec.center * sc;
                    if (offScreen(planes, rx, cy, rz, spec.size * sc)) continue;
                    const h = sc * sc < lod2 * d2 ? far : herd;
                    const k = h.n++;
                    if (k >= h.capacity) h.grow(k + 1);
                    const te = h.matrices;
                    const tg = h.gaits;
                    const tp = h.poses;
                    // A turn by the heading about the vertical, a uniform
                    // scale, and a move: model +X ends up along (cos h, sin h)
                    // in world (x, y), which is three.js (X, Z).
                    const o = k * 16;
                    te[o] = sc * c;
                    te[o + 1] = 0;
                    te[o + 2] = sc * s;
                    te[o + 3] = 0;
                    te[o + 4] = 0;
                    te[o + 5] = sc;
                    te[o + 6] = 0;
                    te[o + 7] = 0;
                    te[o + 8] = -sc * s;
                    te[o + 9] = 0;
                    te[o + 10] = sc * c;
                    te[o + 11] = 0;
                    te[o + 12] = rx;
                    te[o + 13] = gy;
                    te[o + 14] = rz;
                    te[o + 15] = 1;
                    if (people) dress(h, k, colors, look, this.hair);
                    tg[k * 3] = phase;
                    tg[k * 3 + 1] = amount;
                    tg[k * 3 + 2] = lookOf(lk, sc, d2);
                    tp[k * 3] = code;
                    tp[k * 3 + 1] = progress;
                    tp[k * 3 + 2] = weight;
                    this.remember(rx, cy, rz, id[i]);
                }
            }
        }
        if (effects) this.writeDead(world, kind, view, effects, lod2, lk);
        for (const h of herds) h.commit(h.n);
        for (const f of fars) if (f) f.commit(f.n);
    }

    // The dead of this kind (effects.js) where they fell, after the living:
    // fallen over in the FALL pose, and sinking into the ground as they fade.
    // They cannot be clicked.
    writeDead(world, kind, view, effects, lod2, lk) {
        const herds = this.herds[kind];
        const fars = this.far[kind];
        const spec = SPECIES[kind];
        const d = effects.dead;
        const which = KINDS.indexOf(kind);
        const fall = POSES[kind][POSE.FALL].seconds;
        const people = kind === 'human';
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, camX, camY, camZ, planes } = view;
        const grow = (view.unitPx * spec.minPx * view.mapness) / spec.size;
        const near2 = view.personalSpace * view.personalSpace;
        for (let q = 0; q < d.count; q++) {
            const j = (d.start + q) % d.cap;
            if (d.kind[j] !== which || d.gone[j] || d.fade[j] >= 1) continue;
            const dx = wrapDelta(d.x[j] - fx, W);
            const ax0 = Math.ceil((minX - dx) / W);
            const ax1 = Math.floor((maxX - dx) / W);
            const dz = wrapDelta(d.y[j] - fz, H);
            const az0 = Math.ceil((minZ - dz) / H);
            const az1 = Math.floor((maxZ - dz) / H);
            if (ax0 > ax1 || az0 > az1) continue;
            const gy = d.gy[j];
            const c = Math.cos(d.heading[j]);
            const s = Math.sin(d.heading[j]);
            const progress = Math.min(1, Math.max(0, (effects.clock - d.t0[j]) / fall));
            // (Being butchered, it shrinks and sinks a little.)
            const sink = (d.fade[j] + 0.15 * d.cut[j]) * spec.center * 1.4;
            const whole = 1 - 0.45 * d.cut[j];
            let b = 0;
            let look = null;
            let colors = null;
            if (people) {
                look = this.looks.of(d.id[j]);
                if (this.modelled.human) b = this.wear(look.body, outfitOf());
                colors = this.tribeColor(world, d.tribe[j]);
                this.looks.hairAt(look, look.age ?? 0, world.p.human.maturity, this.hair); // (as grey as it was)
            }
            for (let ax = ax0; ax <= ax1; ax++) {
                for (let az = az0; az <= az1; az++) {
                    const rx = dx + ax * W;
                    const rz = dz + az * H;
                    const ex = rx - camX;
                    const ey = gy - camY;
                    const ez = rz - camZ;
                    const d2 = ex * ex + ey * ey + ez * ez;
                    if (d2 < near2) continue;
                    let sc = d.scale[j] * whole;
                    if (grow > 0) {
                        const up = Math.sqrt(d2) * grow;
                        if (up > 1) sc *= up;
                    }
                    if (offScreen(planes, rx, gy, rz, spec.size * sc)) continue;
                    const h = sc * sc < lod2 * d2 ? fars[b] : herds[b];
                    const k = h.n++;
                    if (k >= h.capacity) h.grow(k + 1);
                    const te = h.matrices;
                    const o = k * 16;
                    te.fill(0, o, o + 16);
                    te[o] = sc * c;
                    te[o + 2] = sc * s;
                    te[o + 5] = sc;
                    te[o + 8] = -sc * s;
                    te[o + 10] = sc * c;
                    te[o + 12] = rx;
                    te[o + 13] = gy - sink * sc;
                    te[o + 14] = rz;
                    te[o + 15] = 1;
                    if (people) dress(h, k, colors, look, this.hair);
                    h.gaits[k * 3] = 0;
                    h.gaits[k * 3 + 1] = 0;
                    h.gaits[k * 3 + 2] = lookOf(lk, sc, d2);
                    h.poses[k * 3] = POSE.FALL;
                    h.poses[k * 3 + 1] = progress;
                    h.poses[k * 3 + 2] = 1;
                }
            }
        }
    }

    remember(x, y, z, id) {
        const n = this.pickN;
        if (n >= this.pickId.length) {
            const pos = new Float32Array(n * 6);
            pos.set(this.pickPos);
            const ids = new Float64Array(n * 2);
            ids.set(this.pickId);
            this.pickPos = pos;
            this.pickId = ids;
        }
        this.pickPos[n * 3] = x;
        this.pickPos[n * 3 + 1] = y;
        this.pickPos[n * 3 + 2] = z;
        this.pickId[n] = id;
        this.pickN = n + 1;
    }

    // The id of whoever was drawn nearest to pixel (px, py), within `radius`
    // px (16), or 0; skip(id) true passes someone over.
    pick(camera, w, h, px, py, radius = 16, skip = null) {
        const e = this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
        const P = this.pickPos;
        let best = 0;
        let bestD2 = radius * radius;
        for (let k = 0; k < this.pickN; k++) {
            const x = P[k * 3];
            const y = P[k * 3 + 1];
            const z = P[k * 3 + 2];
            const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
            if (cw <= 0) continue; // behind the camera
            const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw + 1) * 0.5 * w;
            const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 * h;
            const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
            if (d2 < bestD2 && (skip === null || !skip(this.pickId[k]))) {
                bestD2 = d2;
                best = this.pickId[k];
            }
        }
        return best;
    }
}
