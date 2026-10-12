// The 3D view: the same world as the 2D map, drawn with three.js. Like the
// canvas renderer it only reads the world, never changes it, and main.js
// drives both through the same small interface:
//
//   attach(world)  resize(world)  updateCamera(world, target, dt)
//   draw(world, target, focus, senseRadius)  pick(world, px, py)  mode
//
// Coordinates: world x → three.js X, world y → Z, height → Y; one world unit
// is one three.js unit. The parts: the ground (terrain-mesh.js), creatures,
// camps, the followed creature's marker, and the camera with its controls
// (camera.js), which also keeps the floating origin (see util.js).
//
// Draw calls stay few: a handful of ground copies, three instanced meshes
// (one per species), the water sheet, and two per visible camp.
import * as THREE from 'three';
import { CameraRig } from './camera.js';
import { Ground } from './terrain-mesh.js';
import { Creatures } from './creatures.js';
import { Camps } from './camps.js';
import { Marker } from './marker.js';
import { groundOf } from './util.js';
import { stubTerrain } from './terrain-stub.js';

// A muted, overcast sky, a little darker overhead; the fog fades the far
// ground into its horizon colour.
const SKY = '#2a3133';
const ZENITH = '#1a1f21';
const FOG_NEAR = 0.35; // fog starts at this fraction of the far distance

// A dome around the camera with the sky's gradient, drawn behind everything.
function skyDome() {
    const material = new THREE.ShaderMaterial({
        uniforms: { horizon: { value: new THREE.Color(SKY) }, zenith: { value: new THREE.Color(ZENITH) } },
        vertexShader: `
            varying vec3 vDir;
            void main() {
                vDir = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform vec3 horizon;
            uniform vec3 zenith;
            varying vec3 vDir;
            void main() {
                gl_FragColor = vec4(mix(horizon, zenith, smoothstep(0.0, 0.7, normalize(vDir).y)), 1.0);
                #include <colorspace_fragment>
            }`,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), material);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    return dome;
}

// DEV ONLY: `?stubterrain` shows a made-up terrain while the engine has none.
const STUB = new URLSearchParams(location.search).has('stubterrain');

export class View3D {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
        this.gl.setClearColor(SKY);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(SKY);
        this.scene.fog = new THREE.Fog(SKY, 1000, 3000);
        // Soft light from the sky, a little from the ground, and a fairly low
        // sun (40°) from the north-west, the top left of the map: it models
        // the hills, while flat ground keeps about the 2D view's colours.
        const sky = new THREE.HemisphereLight('#e2e8ea', '#3a4035', 1.25);
        const sun = new THREE.DirectionalLight('#fff8f0', 3.3);
        sun.position.set(-0.6, 0.62, -0.45);
        this.dome = skyDome();
        this.scene.add(sky, sun, this.dome);

        this.rig = new CameraRig(canvas);
        this.ground = new Ground(this.scene, this.gl);
        this.creatures = new Creatures(this.scene);
        this.camps = new Camps(this.scene, this.gl);
        this.marker = new Marker(this.scene);
        // JavaScript milliseconds per frame, for the last frame and smoothed:
        // our own updates (camera, ground, creatures, camps, marker), and
        // three.js's render call.
        this.stats = { update: 0, render: 0, lastUpdate: 0, lastRender: 0 };
    }

    get mode() {
        return this.rig.mode;
    }

    set mode(mode) {
        this.rig.setMode(mode);
    }

    attach(world) {
        this.terrain = world.terrain ?? (STUB ? stubTerrain(world) : null);
        this.heightAt = groundOf(this.terrain, world.width, world.height);
        this.resize(world);
        this.ground.attach(world, this.terrain);
        this.creatures.attach();
        this.camps.attach();
        this.rig.attach(world, this.terrain);
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.gl.setSize(w, h);
        this.rig.resize(w, h);
    }

    updateCamera(world, target, dt) {
        const t0 = performance.now();
        this.rig.update(world, target, dt);
        this.cameraMs = performance.now() - t0;
    }

    draw(world, target, focus, senseRadius) {
        const t0 = performance.now();
        const view = this.rig.view;
        this.scene.fog.far = view.fogFar;
        this.scene.fog.near = view.fogFar * FOG_NEAR;
        this.dome.position.set(view.camX, view.camY, view.camZ);
        this.dome.scale.setScalar(view.fogFar * 0.9);
        this.ground.update(world);
        this.ground.place(view);
        // In first person we look out of the followed creature's eyes, so its
        // own body is not drawn (once the camera is close enough to be inside it).
        const inside = target && this.rig.mode === 'first' && this.rig.pose.dist < 6;
        this.creatures.update(world, view, this.heightAt, inside ? target.pop.id[target.i] : 0);
        this.camps.update(world, view, this.heightAt);
        this.marker.update(world, view, this.heightAt, target, focus, senseRadius);
        const t1 = performance.now();
        this.gl.render(this.scene, this.rig.camera);
        const t2 = performance.now();
        const s = this.stats;
        s.lastUpdate = t1 - t0 + (this.cameraMs || 0);
        s.lastRender = t2 - t1;
        s.update += (s.lastUpdate - s.update) * 0.05;
        s.render += (s.lastRender - s.render) * 0.05;
    }

    // The id of whoever is drawn under pixel (px, py) (within 16 px), or 0.
    pick(world, px, py) {
        return this.creatures.pick(this.rig.camera, this.rig.w, this.rig.h, px, py);
    }
}
