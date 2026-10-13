// DEV ONLY: `?poses` lines up every species in every pose it has, animated,
// so each one can be checked by eye (and in screenshots) without waiting for
// the world to show it. `?poses=human` (or herbivore, carnivore) shows one
// row, closer. People wear the three bodies in turn, with every hair style,
// skin and hair colour (looks.js); `?poses=people` lines up each body in
// each hair style.
//
// Its own little scene: a meadow, the same light as the world, and the same
// meshes, materials and shaders as the creatures (creatures.js), so what is
// seen here is what the world draws (the models too, once they have loaded:
// models.js). Each figure walks or runs on the spot, or plays its pose:
// cycles go round, sequences (a throw, a fall) play and then wait a moment
// before playing again. The fallen lie on a pool of blood, and a spray flies
// each time they fall.
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { TRIBE_COLORS } from '../identity.js';
import { SHAPES, CHILD, Herd, herdMaterial } from './creatures.js';
import { loadModel, loadPerson } from './models.js';
import { BODIES, HAIR_STYLES, HAIR_COLOURS, SKIN_TONES, linear, clothOf } from './looks.js';
import { Effects } from './effects.js';
import { POSE, POSE_NAMES, POSES } from './animate.js';
import { Items, ITEM_SHAPES, CODE_RIG } from './items.js';
import { Thrown } from './thrown.js';
import { Sparks } from './sparks.js';

const BEAT = 1.2;  // seconds between the items lineup's shots and skills...
const SLOW = 4;    // ...which play this many times slower than life, to be seen

const SKY = '#b3c9da';
const GRASS = '#5d7448';
const TRIBE = TRIBE_COLORS[0]; // the people's tribe colour
const PAUSE = 0.8;     // seconds between the plays of a sequence...
const LIE = 1.6;       // ...and how long the fallen lie before falling again
const FACING = 0.45;   // everyone turned a little toward the camera

// `?poses=items` (package 3): people holding each kind of item, standing,
// walking, in the poses that move it, and at work (the weapon put down);
// and every kind lying on the ground in front. Rare ones in the middle row,
// legendary ones (glinting) at the back.
// (`?poses=items1`: only that row, closer.)
function itemRows(which) {
    const P = POSE;
    // ([code, progress]: that pose stopped at that point.)
    const all = [
        { kind: 'human', gap: 8, holds: ['spear', 'knife'], rarity: 0, columns: ['stand', 'walk', [P.THROW, 1 / 3], [P.THROW, 0.55], [P.JAB, 0.6], P.BUTCHER, P.SIT] },
        { kind: 'human', gap: 8, holds: ['bow', 'torch'], rarity: 1, columns: ['stand', 'walk', [P.SHOOT, 1 / 3], [P.SHOOT, 0.6], P.GATHER, P.KNAP] },
        { kind: 'human', gap: 8, holds: ['club', 'basket'], rarity: 2, columns: ['stand', 'walk', [P.SWING, 1 / 3], [P.SWING, 0.6], P.CHOP, P.CRAFT] },
    ];
    const list = which >= 0 && which < all.length ? [all[which]] : all;
    let z = 0;
    for (const row of list) {
        row.z = z;
        z -= 13;
    }
    return list;
}

// `?poses=people`: each body in each hair style, standing: a row turned to
// show the face, and one the back of the head.
function peopleRows() {
    return BODIES.flatMap((body, b) => [Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6].map((turn, r) => ({
        kind: 'human', gap: 6, body: b, z: -16 * (2 * b + r), turn,
        columns: HAIR_STYLES.map(() => 'stand'),
        labels: HAIR_STYLES.map((s) => (r ? '' : `${body.replace('_', ' ')}: ${s}`)),
    })));
}

// The rows, front to back: what each column shows ('walk', 'run' or a pose).
// People take three: moving and fighting, standing and resting, working.
function rows(only) {
    if (only?.startsWith('items')) return itemRows(only.length > 5 ? Number(only.slice(5)) : -1);
    if (only === 'people') return peopleRows();
    const P = POSE;
    const all = [
        { kind: 'human', gap: 8, columns: ['walk', 'run', P.THROW, P.JAB, P.SWING, P.SHOOT, P.ROLL] },
        { kind: 'human', gap: 8, columns: [P.FALL, P.CROUCH, P.EAT, P.SIT, 'child walk', 'child hop'] },
        { kind: 'human', gap: 8, columns: [P.GATHER, P.BUTCHER, P.CHOP, P.KNAP, P.CRAFT] },
        { kind: 'herbivore', gap: 11, columns: ['walk', 'run', P.GRAZE, P.FALL] },
        { kind: 'carnivore', gap: 11, columns: ['walk', 'run', P.EAT, P.POUNCE, P.CROUCH, P.FALL] },
    ];
    const chosen = all.filter((r) => !only || r.kind === only);
    const list = chosen.length ? chosen : all;
    let z = 0;
    for (const row of list) {
        row.z = z;
        z -= row.kind === 'human' ? 13 : 17;
    }
    return list;
}

// A label in front of a figure: light text on a dark band.
function label(text, width) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(16, 18, 17, 0.6)';
    ctx.fillRect(16, 10, 224, 44);
    ctx.fillStyle = '#f2efe6';
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthWrite: false }));
    sprite.scale.set(width, width / 4, 1);
    return sprite;
}

export class Lineup {
    constructor(only) {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(SKY);
        const sky = new THREE.HemisphereLight('#e0e9f0', '#6a6c5a', 2.6);
        const sun = new THREE.DirectionalLight('#fff6ea', 3.0);
        sun.position.set(-0.6, 0.62, -0.45);
        this.scene.add(sky, sun);
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 400), new THREE.MeshLambertMaterial({ color: GRASS }));
        ground.rotation.x = -Math.PI / 2;
        this.scene.add(ground);

        this.rows = rows(only);
        // (People: one herd per body, once loaded.)
        this.herds = {
            herbivore: [new Herd(this.scene, SHAPES.herbivore(), herdMaterial('herbivore', COLORS.herbivore))],
            carnivore: [new Herd(this.scene, SHAPES.carnivore(), herdMaterial('carnivore', COLORS.carnivore))],
            human: [new Herd(this.scene, SHAPES.human(), herdMaterial('human', '#ffffff'), true)],
        };
        this.bodies = null;
        for (const kind of ['herbivore', 'carnivore']) {
            loadModel(kind)
                .then((shape) => shape && this.herds[kind][0].setShape(shape.geometry, shape))
                .catch((err) => console.warn(`The ${kind} model did not load.`, err));
        }
        Promise.all(BODIES.map((body) => loadPerson(body))).then((shapes) => {
            if (!shapes.every(Boolean)) return;
            for (const h of this.herds.human) h.dispose();
            this.herds.human = shapes.map((shape) => {
                const material = herdMaterial('human', '#ffffff');
                material.fit(shape);
                return new Herd(this.scene, shape.geometry, material, true);
            });
            this.bodies = shapes;
        }).catch((err) => console.warn('The people\'s models did not load.', err));
        this.tribe = new THREE.Color(TRIBE);
        this.cloth = clothOf(TRIBE);
        this.effects = new Effects(this.scene, null);
        this.effects.blood = true;
        this.effects.attach(() => 0);
        // Where each figure stands, and its label; people, how each looks.
        let width = 0;
        this.rows.forEach((row, r) => {
            row.x0 = (-(row.columns.length - 1) * row.gap) / 2;
            width = Math.max(width, row.columns.length * row.gap);
            if (row.kind === 'human') {
                row.looks = row.columns.map((_, c) => ({
                    body: row.body ?? (c + r) % BODIES.length,
                    style: row.body !== undefined ? c : (c + 2 * r) % HAIR_STYLES.length,
                    hair: linear(HAIR_COLOURS[(3 * c + r) % HAIR_COLOURS.length]),
                    skin: linear(SKIN_TONES[(2 * c + r) % SKIN_TONES.length]),
                }));
            }
            row.columns.forEach((col, c) => {
                const text = row.labels ? row.labels[c]
                    : row.holds && col === 'stand' ? row.holds.join(' + ')
                    : Array.isArray(col) ? `${POSE_NAMES[col[0]].toLowerCase()} ${Math.round(col[1] * 100)}%`
                    : typeof col === 'number' ? POSE_NAMES[col].toLowerCase() : col;
                if (text) {
                    const sprite = label(text, row.gap * 0.85);
                    sprite.position.set(row.x0 + c * row.gap, 0.6, row.z + 4.5);
                    this.scene.add(sprite);
                }
                // The fallen lie on a pool (the clock here stays at the
                // world's first moment, so it never fades).
                if (col === POSE.FALL && row.kind !== 'human') this.effects.pool(row.x0 + c * row.gap, row.z, 2.3);
            });
        });
        const depth = -this.rows[this.rows.length - 1].z;
        this.camera = new THREE.PerspectiveCamera(26, 1, 1, 3000);
        this.fit = { width, depth };
        this.view = {
            W: 1e6, H: 1e6, fx: 0, fz: 0, camX: 0, camY: 0, camZ: 0,
            minX: -1e3, maxX: 1e3, minZ: -1e3, maxZ: 1e3, unitPx: 1e-4, mapness: 0, dist: 0, personalSpace: 0,
            planes: new Float64Array(24),
        };
        this.falls = new Map(); // column → the play it last sprayed at
        this.t0 = performance.now();
        if (only?.startsWith('items')) this.holding();
    }

    // The items lineup's flights and marks: each beat, from the figures
    // holding the bow, the spear and the club (their third column), along
    // the way they face.
    flights(real) {
        const t = real / SLOW;
        const beat = Math.floor(t / BEAT);
        if (beat !== this.beat) {
            this.beat = beat;
            const events = [];
            const dx = Math.cos(FACING);
            const dy = Math.sin(FACING);
            for (const row of this.rows) {
                const x = row.x0 + 2 * row.gap;
                const y = row.z;
                const kind = row.holds[0];
                if (kind === 'bow') {
                    // An arrow; then a volley (in the world, three real arrows: as three here).
                    for (const turn of beat % 2 === 0 ? [0] : [-0.17, 0, 0.17]) {
                        const a = FACING + turn;
                        events.push({ type: 'throw', id: 0, x, y, tx: x + Math.cos(a) * 30, ty: y + Math.sin(a) * 30, hit: false, weapon: 'bow' });
                    }
                } else events.push({ type: 'skill', id: 0, kind, x, y, dx, dy });
            }
            this.thrown.clock = t;
            this.thrown.handle(events, null, -1);
            this.sparks.handle(events, () => 0, t);
        }
        this.thrown.update({ p: { play: {} }, spears: null }, this.view, () => 0, t);
        this.sparks.update(this.view, t);
    }

    // The items lineup: a small world of the figures, what they hold and
    // what lies in front, and a motion that tells items.js each one's pose.
    holding() {
        this.items = new Items(this.scene);
        const looks = new Map(); // id → how the figure looks
        this.items.rigOf = (pid) => (this.bodies ? this.bodies[looks.get(pid).body].rig : CODE_RIG);
        // On a beat: the archer looses an arrow, then a volley; the
        // spearman's piercing streak; the clubman's slam.
        this.thrown = new Thrown(this.scene);
        this.thrown.attach();
        this.sparks = new Sparks(this.scene);
        this.sparks.attach();
        this.beat = -1;
        const humans = { n: 0, id: [], x: [], y: [], heading: [], age: [] };
        const byBearer = new Map();
        const items = new Map();
        let id = 0;
        const item = (kind, rarity, bearer, x = 0, y = 0) => {
            const it = { id: ++id + 1000, kind, rarity, legend: rarity === 2 ? { name: 'Grey Fang', history: [] } : null, bearer, x, y, wear: 1 };
            items.set(it.id, it);
            return it;
        };
        for (const row of this.rows) {
            row.ids = row.columns.map((_, c) => {
                const pid = ++id;
                humans.id.push(pid);
                humans.x.push(row.x0 + c * row.gap);
                humans.y.push(row.z);
                humans.heading.push(FACING);
                humans.age.push(1e4);
                humans.n++;
                looks.set(pid, row.looks[c]);
                byBearer.set(pid, { weapon: item(row.holds[0], row.rarity, pid), tool: item(row.holds[1], row.rarity, pid) });
                return pid;
            });
        }
        ITEM_SHAPES.forEach((kind, k) => item(kind, k === 2 ? 2 : k === 4 ? 1 : 0, 0, -12 + k * 4.8, 5.5));
        this.world = { humans, byBearer, items, p: { human: { maturity: 0 } } };
        this.figures = new Map(); // id → its stride and pose this frame
        const figures = this.figures;
        this.motion = {
            posed(pid) {
                const f = figures.get(pid);
                if (!f) return false;
                Object.assign(this, f);
                return true;
            },
        };
    }

    // Frame the whole lineup from in front and above, in the part of the
    // screen the panel (on the left) leaves free.
    resize(w, h) {
        const cam = this.camera;
        cam.aspect = w / h;
        const margin = Math.min(320, w * 0.3);
        const half = Math.tan((cam.fov * Math.PI) / 360); // up from the middle, per unit away
        const pitch = 0.6;
        // Far enough back for every row to fit across, the nearer rows
        // (in front of the middle) being seen wider.
        let across = 0;
        for (const row of this.rows) {
            const need = ((row.columns.length * row.gap) / 2 + 2) / (half * cam.aspect * (1 - margin / w));
            across = Math.max(across, need + (this.fit.depth / 2 + row.z) * Math.cos(pitch));
        }
        const down = (this.fit.depth * Math.sin(pitch) + 20) / (2 * half);
        const dist = Math.max(across, down);
        // Off centre by half the margin, so the lineup sits in the free part;
        // the labels in front of the first row need room too.
        const x = -(margin / w) * half * cam.aspect * dist;
        const z = -this.fit.depth / 2 + 3;
        cam.position.set(x, 2 + dist * Math.sin(pitch), z + dist * Math.cos(pitch));
        cam.lookAt(x, 2, z);
        cam.updateProjectionMatrix();
        this.view.camX = cam.position.x;
        this.view.camY = cam.position.y;
        this.view.camZ = cam.position.z;
    }

    draw(gl) {
        const t = (performance.now() - this.t0) / 1000;
        for (const herds of Object.values(this.herds)) for (const h of herds) h.n = 0;
        for (const row of this.rows) {
            row.columns.forEach((col, c) => {
                const kind = row.kind;
                const look = row.looks?.[c];
                const herd = this.herds[kind][look && this.bodies ? look.body : 0];
                const k = herd.n++;
                if (k >= herd.capacity) herd.grow(k + 1);
                const child = typeof col === 'string' && col.startsWith('child');
                const sc = child ? CHILD : 1;
                const x = row.x0 + c * row.gap;
                const cs = Math.cos(row.turn ?? FACING);
                const sn = Math.sin(row.turn ?? FACING);
                const te = herd.matrices;
                const o = k * 16;
                te.fill(0, o, o + 16);
                te[o] = sc * cs;
                te[o + 2] = sc * sn;
                te[o + 5] = sc;
                te[o + 8] = -sc * sn;
                te[o + 10] = sc * cs;
                te[o + 12] = x;
                te[o + 14] = row.z;
                te[o + 15] = 1;
                if (look) {
                    herd.colors.set([this.tribe.r, this.tribe.g, this.tribe.b], k * 3);
                    herd.cloths.set(this.cloth, k * 3);
                    herd.skins.set(look.skin, k * 3);
                    herd.hairs.set([...look.hair, look.style], k * 4);
                }
                let phase = 0;
                let amount = 0;
                let code = POSE.NONE;
                let progress = 0;
                if (col === 'stand') {
                    // (At rest.)
                } else if (Array.isArray(col)) {
                    code = col[0];
                    progress = col[1];
                } else if (col === 'walk' || col === 'child walk' || col === 'run') {
                    // On the spot, at the stride its speed would take.
                    const run = col === 'run';
                    amount = run ? 2 : 1;
                    phase = (t * (run ? 2.6 : 1.9)) % 1;
                } else if (col === 'child hop') {
                    code = POSE.HOP;
                    progress = (t / POSES.human[POSE.HOP].seconds) % 1;
                } else {
                    code = col;
                    const def = POSES[kind][col];
                    if (def.cycle) progress = (t / def.seconds) % 1;
                    else {
                        // Each column on its own beat, so no moment shows them all at rest.
                        const tc = t + c * 0.37 - row.z * 0.05;
                        const wait = col === POSE.FALL ? LIE : PAUSE;
                        const play = Math.floor(tc / (def.seconds + wait));
                        progress = Math.min(1, (tc - play * (def.seconds + wait)) / def.seconds);
                        if (col === POSE.FALL && kind !== 'human' && this.falls.get(`${kind}${c}`) !== play) {
                            this.falls.set(`${kind}${c}`, play);
                            this.effects.clock = t;
                            this.effects.spray(x, row.z, 2, 1, 0, 1);
                        }
                    }
                }
                herd.gaits[k * 3] = phase;
                herd.gaits[k * 3 + 1] = amount;
                herd.poses[k * 3] = code;
                herd.poses[k * 3 + 1] = progress;
                herd.poses[k * 3 + 2] = code === POSE.NONE ? 0 : 1;
                if (row.ids) this.figures.set(row.ids[c], { phase, amount, code, progress, weight: code === POSE.NONE ? 0 : 1 });
            });
        }
        for (const herds of Object.values(this.herds)) for (const h of herds) h.commit(h.n);
        if (this.items) {
            this.items.update(this.world, this.view, () => 0, this.motion, 0, t);
            this.flights(t);
        }
        this.effects.tick(t, 0);
        this.effects.update(this.view);
        gl.render(this.scene, this.camera);
    }
}
