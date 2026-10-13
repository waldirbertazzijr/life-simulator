// The character editor's preview (play/editor.js): one person, turning
// slowly, drawn as the world draws people (creatures.js: the same bodies,
// shader and colours), in a small view of its own on the editor's canvas. It
// draws only while the editor is open (start, stop).
import * as THREE from 'three';
import { Herd, herdMaterial } from './creatures.js';
import { loadPerson } from './models.js';
import { BODIES } from './looks.js';

const TURN = 0.5; // radians a second
const FACING = Math.PI / 2; // facing the camera (+Z)

export class Preview {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.gl.setClearColor(0x000000, 0);
        this.scene = new THREE.Scene();
        // The world's light: a soft sky and a low sun, here from the front left.
        const sky = new THREE.HemisphereLight('#e0e9f0', '#6a6c5a', 2.6);
        const sun = new THREE.DirectionalLight('#fff6ea', 3.0);
        sun.position.set(-0.4, 0.62, 0.7);
        this.scene.add(sky, sun);
        this.camera = new THREE.PerspectiveCamera(24, 1, 1, 100);
        this.camera.position.set(0, 3.2, 12.6);
        this.camera.lookAt(0, 2.55, 0);
        this.herds = null;
        this.person = null;
        this.running = false;
        this.turn = 0;
        this.last = 0;
        // Each body a herd of one, on copies of the world's geometry (a herd
        // hangs what each instance carries on its geometry).
        this.ready = Promise.all(BODIES.map((body) => loadPerson(body))).then((shapes) => {
            if (!shapes.every(Boolean)) return;
            this.herds = shapes.map((shape) => {
                const material = herdMaterial('human', '#ffffff');
                material.fit(shape);
                return new Herd(this.scene, shape.geometry.clone(), material, true);
            });
        });
    }

    // Who to show: { body, style, hair, skin, cloth, tribe } (colours linear).
    show(person) {
        this.person = person;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.last = performance.now();
        const loop = (now) => {
            if (!this.running) return;
            this.frame(now);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
    }

    frame(now) {
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.turn += TURN * dt;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (!w || !h) return;
        if (this.canvas.width !== Math.round(w * this.ratio()) || this.canvas.height !== Math.round(h * this.ratio())) {
            this.gl.setPixelRatio(this.ratio());
            this.gl.setSize(w, h, false);
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
        if (this.herds) {
            const p = this.person;
            this.herds.forEach((herd, b) => {
                const shown = p && p.body === b ? 1 : 0;
                if (shown) {
                    const a = FACING + this.turn;
                    const c = Math.cos(a);
                    const s = Math.sin(a);
                    herd.matrices.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1], 0);
                    herd.colors.set(p.tribe, 0);
                    herd.cloths.set(p.cloth, 0);
                    herd.skins.set(p.skin, 0);
                    herd.hairs.set([...p.hair, p.style], 0);
                    herd.gaits.fill(0, 0, 3);
                    herd.poses.fill(0, 0, 3);
                }
                herd.commit(shown);
            });
        }
        this.gl.render(this.scene, this.camera);
    }

    ratio() {
        return Math.min(window.devicePixelRatio || 1, 2);
    }
}
