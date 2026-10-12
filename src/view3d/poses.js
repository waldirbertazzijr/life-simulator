// DEV ONLY: `?poses` lines up every species in every pose it has, animated,
// so each one can be checked by eye (and in screenshots) without waiting for
// the world to show it. `?poses=human` (or herbivore, carnivore) shows one
// row, closer.
//
// Its own little scene: a meadow, the same light as the world, and the same
// meshes, materials and shaders as the creatures (creatures.js), so what is
// seen here is what the world draws. Each figure walks or runs on the spot,
// or plays its pose: cycles go round, sequences (a throw, a fall) play and
// then wait a moment before playing again. The fallen lie on a pool of blood,
// and a spray flies each time they fall.
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { SHAPES, CHILD, Herd, herdMaterial } from './creatures.js';
import { Effects } from './effects.js';
import { POSE, POSE_NAMES, POSES } from './animate.js';

const SKY = '#b3c9da';
const GRASS = '#5d7448';
const PEOPLE = '#9aa9bd';
const PAUSE = 0.8;     // seconds between the plays of a sequence...
const LIE = 1.6;       // ...and how long the fallen lie before falling again
const FACING = 0.45;   // everyone turned a little toward the camera

// The rows, front to back: what each column shows ('walk', 'run' or a pose).
// People take three: moving and fighting, standing and resting, working.
function rows(only) {
    const P = POSE;
    const all = [
        { kind: 'human', gap: 8, columns: ['walk', 'run', P.THROW, P.JAB, P.SWING, P.ROLL] },
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
        this.herds = {
            herbivore: new Herd(this.scene, SHAPES.herbivore(), herdMaterial('herbivore', COLORS.herbivore), false),
            carnivore: new Herd(this.scene, SHAPES.carnivore(), herdMaterial('carnivore', COLORS.carnivore), false),
            human: new Herd(this.scene, SHAPES.human(), herdMaterial('human', '#ffffff'), true),
        };
        this.tint = new THREE.Color(PEOPLE);
        this.effects = new Effects(this.scene, null);
        this.effects.blood = true;
        this.effects.attach(() => 0);
        // Where each figure stands, and its label.
        let width = 0;
        for (const row of this.rows) {
            row.x0 = (-(row.columns.length - 1) * row.gap) / 2;
            width = Math.max(width, row.columns.length * row.gap);
            row.columns.forEach((col, c) => {
                const text = typeof col === 'number' ? POSE_NAMES[col].toLowerCase() : col;
                const sprite = label(text, row.gap * 0.85);
                sprite.position.set(row.x0 + c * row.gap, 0.6, row.z + 4.5);
                this.scene.add(sprite);
                // The fallen lie on a pool (the clock here stays at the
                // world's first moment, so it never fades).
                if (col === POSE.FALL && row.kind !== 'human') this.effects.pool(row.x0 + c * row.gap, row.z, 2.3);
            });
        }
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
        const counts = { herbivore: 0, carnivore: 0, human: 0 };
        for (const row of this.rows) {
            row.columns.forEach((col, c) => {
                const kind = row.kind;
                const herd = this.herds[kind];
                const k = counts[kind]++;
                if (k >= herd.capacity) herd.grow(k + 1);
                const child = typeof col === 'string' && col.startsWith('child');
                const sc = child ? CHILD : 1;
                const x = row.x0 + c * row.gap;
                const cs = Math.cos(FACING);
                const sn = Math.sin(FACING);
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
                if (herd.colors) herd.colors.set([this.tint.r, this.tint.g, this.tint.b], k * 3);
                let phase = 0;
                let amount = 0;
                let code = POSE.NONE;
                let progress = 0;
                if (col === 'walk' || col === 'child walk' || col === 'run') {
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
                herd.gaits[k * 2] = phase;
                herd.gaits[k * 2 + 1] = amount;
                herd.poses[k * 3] = code;
                herd.poses[k * 3 + 1] = progress;
                herd.poses[k * 3 + 2] = code === POSE.NONE ? 0 : 1;
            });
        }
        for (const kind of Object.keys(this.herds)) this.herds[kind].commit(counts[kind]);
        this.effects.tick(t, 0);
        this.effects.update(this.view);
        gl.render(this.scene, this.camera);
    }
}
