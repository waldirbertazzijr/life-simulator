// Giant water lilies (vitória-régia, Victoria amazonica) on the warm lakes.
//
// Where they float is decided once per world by lily-places.js; this draws
// them. Two parts, each one instanced mesh (one draw call): the pads, round
// trays with the plant's upturned rim (green inside, the reddish underside
// showing on the outside) and a notch where the rim is cleft, and the flowers,
// white or (older blooms) pink, a cup of petals on spiky reddish sepals.
//
// Like the trees, each instance's place (world x, height, world y) and size
// are written once; the vertex shader puts it beside the floating origin
// (util.js), turns it, and lets it drift and rock very gently on the water.
// A pad or flower smaller than a pixel or so on screen shrinks away, so from
// high over the map there is nothing to draw. Per frame: a few uniforms.
import * as THREE from 'three';
import { placeLilies } from './lily-places.js';

export const PAD_LIFT = 0.07;  // pads float this far above the water sheet
const FLOWER_LIFT = 0.02;
const RIM = 0.14;              // the rim's height, at radius 1 (before PAD_TALL)
const PAD_TALL = 0.85;         // a pad's height scales with its radius times this
const SEGMENTS = 20;           // around a pad
const NOTCH = 0.1;             // half the notch's angle (radians), at the rim...
const NOTCH_IN = 0.86;         // ...and how far in it reaches (radius)

const linear = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

// Muted, in the palette of the land: the leaf, the rim's inner face catching
// the light, its lip and outer face showing the reddish underside.
const LEAF = linear([84, 116, 58]);
const RIM_IN = linear([104, 126, 62]);
const LIP = linear([150, 96, 80]);
const RIM_OUT = linear([118, 56, 58]);
const SEPAL = linear([104, 58, 50]);
const HEART = linear([206, 180, 98]);
const WHITE = linear([222, 218, 206]);
const PINK = linear([200, 112, 140]);

// Indexed geometry with a colour per corner, triangles turned to face a
// given way (so single-sided materials show the right faces).
class Builder {
    constructor() {
        this.pos = [];
        this.col = [];
        this.idx = [];
    }

    vertex(x, y, z, color, shade = 1) {
        this.pos.push(x, y, z);
        this.col.push(color.r * shade, color.g * shade, color.b * shade);
        return this.pos.length / 3 - 1;
    }

    // A triangle whose front faces along (nx, ny, nz).
    tri(a, b, c, nx, ny, nz) {
        const P = this.pos;
        const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
        else this.idx.push(a, c, b);
    }

    quad(a, b, c, d, nx, ny, nz) {
        this.tri(a, b, c, nx, ny, nz);
        this.tri(a, c, d, nx, ny, nz);
    }

    geometry() {
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
        g.setIndex(this.idx);
        g.computeVertexNormals(); // unused (flat shading), but keeps three.js's attributes complete
        g.instanceCount = 0;
        return g;
    }
}

// A pad of radius 1, flat at y = 0, its notch toward +x. The leaf is a fan
// with faint ribs (alternate shades toward the middle); the rim rises around
// its edge, lower beside the notch, flaring a little outward.
function padGeometry() {
    const b = new Builder();
    const n = SEGMENTS;
    const span = Math.PI * 2 - 2 * NOTCH;
    const angle = (k) => NOTCH + (k / n) * span;
    const centre = b.vertex(0, 0, 0, LEAF, 1.1);
    const mid = [];
    const foot = [];
    for (let k = 0; k <= n; k++) {
        const a = angle(k);
        const c = Math.cos(a);
        const s = Math.sin(a);
        mid.push(b.vertex(c * 0.55, 0, s * 0.55, LEAF, k % 2 ? 0.9 : 1.06));
        foot.push(b.vertex(c * 0.97, 0, s * 0.97, LEAF, k % 2 ? 0.95 : 0.84));
    }
    const apex = b.vertex(NOTCH_IN, 0, 0, LEAF, 0.9);
    for (let k = 0; k < n; k++) {
        b.tri(centre, mid[k], mid[k + 1], 0, 1, 0);
        b.quad(mid[k], foot[k], foot[k + 1], mid[k + 1], 0, 1, 0);
    }
    // Across the notch: the leaf up to the cleft's tip.
    b.tri(centre, mid[n], mid[0], 0, 1, 0);
    b.tri(mid[n], apex, mid[0], 0, 1, 0);
    b.tri(mid[0], apex, foot[0], 0, 1, 0);
    b.tri(mid[n], foot[n], apex, 0, 1, 0);
    // The rim: inner face, lip, outer face.
    const top = [];
    const lip = [];
    const outer = [];
    for (let k = 0; k <= n; k++) {
        const a = angle(k);
        const c = Math.cos(a);
        const s = Math.sin(a);
        const near = Math.min(k, n - k); // segments from the notch
        const h = RIM * (0.45 + 0.55 * Math.min(1, near / 3));
        top.push(b.vertex(c * 1.0, h, s * 1.0, RIM_IN, 1.0));
        lip.push(b.vertex(c * 1.04, h, s * 1.04, LIP, 1.0));
        outer.push(b.vertex(c * 1.0, -0.03, s * 1.0, RIM_OUT, 0.85));
    }
    for (let k = 0; k < n; k++) {
        const a = (angle(k) + angle(k + 1)) / 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        b.quad(foot[k], foot[k + 1], top[k + 1], top[k], -c, 0.3, -s); // facing in
        b.quad(top[k], top[k + 1], lip[k + 1], lip[k], 0, 1, 0);
        b.quad(lip[k], lip[k + 1], outer[k + 1], outer[k], c, 0.2, s); // facing out
    }
    return b.geometry();
}

// A flower about 1.4 across: four spiky sepals lying on the water, an outer
// ring of petals opening wide, an inner ring standing up as a cup, and a
// golden heart. Petal corners carry (shade, inner, −1) in their colour: the
// shader paints them white or pink, per flower.
function flowerGeometry() {
    const b = new Builder();
    const petal = (k, n, turn, r0, y0, r1, y1, half, inner) => {
        const a = turn + (k / n) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const mark = (shade) => ({ r: shade, g: inner, b: -1 });
        const rm = r0 + (r1 - r0) * 0.45;
        const ym = y0 + (y1 - y0) * 0.5;
        const base = b.vertex(c * r0, y0, s * r0, mark(0.8));
        const left = b.vertex(c * rm - s * half, ym, s * rm + c * half, mark(0.95));
        const right = b.vertex(c * rm + s * half, ym, s * rm - c * half, mark(0.95));
        const tip = b.vertex(c * r1, y1, s * r1, mark(1.05));
        // Facing up and inward (petals are seen from both sides anyway).
        b.quad(base, left, tip, right, -c * (y1 - y0), r1 - r0, -s * (y1 - y0));
    };
    for (let k = 0; k < 4; k++) {
        const a = 0.4 + (k / 4) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const base = b.vertex(c * 0.1, 0.02, s * 0.1, SEPAL, 0.9);
        const l = b.vertex(c * 0.25 - s * 0.11, 0.0, s * 0.25 + c * 0.11, SEPAL, 1.0);
        const r = b.vertex(c * 0.25 + s * 0.11, 0.0, s * 0.25 - c * 0.11, SEPAL, 1.0);
        const tip = b.vertex(c * 0.56, 0.03, s * 0.56, SEPAL, 1.1);
        b.quad(base, l, tip, r, 0, 1, 0);
    }
    for (let k = 0; k < 9; k++) petal(k, 9, 0, 0.12, 0.05, 0.66, 0.24, 0.15, 0);
    for (let k = 0; k < 8; k++) petal(k, 8, 0.39, 0.09, 0.1, 0.34, 0.5, 0.12, 1);
    const ring = [];
    for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ring.push(b.vertex(Math.cos(a) * 0.13, 0.18, Math.sin(a) * 0.13, HEART, 0.85));
    }
    const top = b.vertex(0, 0.3, 0, HEART, 1.1);
    for (let k = 0; k < 6; k++) b.tri(ring[k], ring[(k + 1) % 6], top, 0, 1, 0);
    return b.geometry();
}

// Shared by both parts: where an instance stands beside the floating origin,
// and whether it is big enough on screen to draw.
const COMMON = /* glsl */ `
uniform vec2 uOrigin;  // world (x, y) of the floating origin
uniform vec2 uWorld;   // the world's width and height
uniform vec3 uCam;     // the camera, from the origin
uniform float uUnitPx; // world units per pixel, one unit from the camera
uniform float uTime;   // seconds
vec3 nearOrigin( vec3 p ) {
    return vec3(
        mod( p.x - uOrigin.x + 0.5 * uWorld.x, uWorld.x ) - 0.5 * uWorld.x,
        p.y,
        mod( p.z - uOrigin.y + 0.5 * uWorld.y, uWorld.y ) - 0.5 * uWorld.y );
}
float onScreen( vec3 at, float r ) {
    return smoothstep( 0.7, 1.5, r / max( distance( at, uCam ) * uUnitPx, 1e-6 ) );
}
`;

const PAD_PARS = /* glsl */ `
attribute vec4 pad;   // world x, height, world y, radius
attribute float seed; // 0..1: which way it is turned, and its own shade
${COMMON}
`;

const PAD_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
{
    vec3 at = nearOrigin( pad.xyz );
    float r = pad.w;
    float show = onScreen( at, r );
    float a = seed * 6.2831853 + 0.04 * sin( uTime * 0.21 + seed * 41.0 );
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    transformed *= vec3( r, r * ${PAD_TALL.toFixed(2)}, r ) * show;
    // Rocking on the faintest swell, and drifting a hand's breadth.
    vec2 tilt = 0.01 * vec2( sin( uTime * 0.83 + seed * 17.0 ), sin( uTime * 0.67 + seed * 29.0 ) );
    transformed.y += dot( transformed.xz, tilt );
    transformed.xz += 0.05 * vec2( sin( uTime * 0.13 + seed * 11.0 ), cos( uTime * 0.11 + seed * 23.0 ) );
    transformed += at;
    // Each pad a little lighter or darker, greener or more yellow.
    float warm = fract( seed * 37.7 ) - 0.5;
    vColor *= ( 0.86 + 0.24 * fract( seed * 91.3 ) ) * vec3( 1.0 + 0.16 * warm, 1.0 + 0.05 * warm, 1.0 - 0.14 * warm );
}
`;

const FLOWER_PARS = /* glsl */ `
attribute vec4 bloom;  // world x, height, world y, size
attribute vec2 look;   // which way it is turned (0..1), how pink (0..1)
uniform vec3 uWhite;
uniform vec3 uPink;
varying vec3 vGlow;    // petals let light through: even the shaded side stays pale
${COMMON}
`;

const FLOWER_MAIN = /* glsl */ `
vec3 transformed = vec3( position );
{
    vec3 at = nearOrigin( bloom.xyz );
    float size = bloom.w;
    float show = onScreen( at, 0.6 * size );
    float a = look.x * 6.2831853 + 0.05 * sin( uTime * 0.27 + look.x * 31.0 );
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    transformed *= size * show;
    transformed.y += 0.015 * sin( uTime * 0.9 + look.x * 13.0 );
    transformed += at;
    vGlow = vec3( 0.0 );
    if ( color.b < 0.0 ) {
        // A petal: white, or pink (the inner petals pinker still).
        float pink = clamp( look.y * ( 1.0 + 0.3 * color.g ), 0.0, 1.0 );
        vColor = mix( uWhite, uPink, pink ) * color.r;
        vGlow = vColor * 0.3;
    }
}
`;

const FLOWER_FRAGMENT_PARS = 'varying vec3 vGlow;';
const FLOWER_GLOW = '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;';

function material(name, pars, main, uniforms, extra = {}, fragment = null) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...extra });
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${pars}`)
            .replace('#include <begin_vertex>', main);
        if (fragment) {
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\n${fragment.pars}`)
                .replace('#include <emissivemap_fragment>', fragment.main);
        }
    };
    m.customProgramCacheKey = () => name;
    return m;
}

export class Lilies {
    constructor(scene) {
        this.uniforms = {
            uOrigin: { value: new THREE.Vector2() },
            uWorld: { value: new THREE.Vector2(1, 1) },
            uCam: { value: new THREE.Vector3() },
            uUnitPx: { value: 0.001 },
            uTime: { value: 0 },
        };
        const flowerUniforms = { ...this.uniforms, uWhite: { value: WHITE }, uPink: { value: PINK } };
        this.pads = this.part(scene, padGeometry(), material('lily-pads', PAD_PARS, PAD_MAIN, this.uniforms));
        this.flowers = this.part(scene, flowerGeometry(),
            material('lily-flowers', FLOWER_PARS, FLOWER_MAIN, flowerUniforms, { side: THREE.DoubleSide },
                { pars: FLOWER_FRAGMENT_PARS, main: FLOWER_GLOW }));
        this.places = null;
        this.start = performance.now();
        this.stats = { pads: 0, flowers: 0, colonies: 0, buildMs: 0 };
    }

    part(scene, geometry, mat) {
        const mesh = new THREE.Mesh(geometry, mat);
        // Instances are all over the world, which the geometry's own bounds
        // know nothing about; the shader hides the far ones instead.
        mesh.frustumCulled = false;
        mesh.visible = false;
        scene.add(mesh);
        return { geometry, mesh };
    }

    // A new world: place its lilies (none without terrain).
    attach(world, terrain) {
        const t0 = performance.now();
        const P = placeLilies(terrain, world.seed ?? 1);
        this.places = P;
        const sea = terrain ? terrain.seaLevel : 0;

        const pads = new Float32Array(P.pads.length * 4);
        const seeds = new Float32Array(P.pads.length);
        P.pads.forEach((p, i) => {
            pads.set([p.x, sea + PAD_LIFT, p.y, p.r], i * 4);
            seeds[i] = p.turn;
        });
        this.fill(this.pads, { pad: [pads, 4], seed: [seeds, 1] }, P.pads.length);

        const blooms = new Float32Array(P.flowers.length * 4);
        const looks = new Float32Array(P.flowers.length * 2);
        P.flowers.forEach((f, i) => {
            blooms.set([f.x, sea + FLOWER_LIFT, f.y, f.size], i * 4);
            looks.set([f.turn, f.pink], i * 2);
        });
        this.fill(this.flowers, { bloom: [blooms, 4], look: [looks, 2] }, P.flowers.length);

        this.uniforms.uWorld.value.set(world.width, world.height);
        this.stats = {
            pads: P.pads.length,
            flowers: P.flowers.length,
            colonies: P.colonies.length,
            buildMs: +(performance.now() - t0).toFixed(1),
        };
    }

    fill(part, attributes, count) {
        for (const [name, [array, size]] of Object.entries(attributes)) {
            part.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
        }
        part.geometry.instanceCount = count;
        part.mesh.visible = count > 0;
    }

    // Every frame: where the camera is. No lily is touched here.
    update(view) {
        if (!this.pads.mesh.visible) return;
        const u = this.uniforms;
        u.uOrigin.value.set(view.fx, view.fz);
        u.uCam.value.set(view.camX, view.camY, view.camZ);
        u.uUnitPx.value = view.unitPx;
        u.uTime.value = (performance.now() - this.start) / 1000;
    }
}
