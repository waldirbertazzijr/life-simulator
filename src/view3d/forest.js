// Forests: low-poly trees wherever the land is wooded.
//
// Trees are scenery. They never move, grow or die, so they are placed once
// per world and then left to the graphics card.
//
// Where: on a grid of places SPACING apart, each nudged by a hash so they do
// not line up in rows. A place holds a tree with a chance that follows the
// ground's tree cover (terrain-mesh.js: the forest biome, blurred over its
// edges): most places in the heart of a forest, fewer toward its edge, now
// and then one just outside it, and a lone tree here and there in wetland.
// Never in water, on cliffs, on steep ground, or where nothing grows (rock,
// snow). The same world always gets the same trees.
//
// Which: conifers on high (colder) ground, round broadleaf trees lower down,
// mixed in between; toward the tree line the conifers grow smaller.
//
// How they are drawn: one instanced mesh per kind, so all the trees are two
// draw calls. Each tree's place (world x, ground height, world y) and its
// seed and size are four floats in a small float texture, written once. The
// world wraps, and from high up the view takes in more than one copy of it,
// so each tree is drawn once per copy of the world the view can reach
// (cx × cz of them): instance number i is tree i mod N of copy i div N. The
// vertex shader works out where that copy stands relative to the floating
// origin (util.js) and, if it is outside the visible box or the camera's
// view, collapses it to a point, which draws nothing. So the only JavaScript
// per frame is a handful of uniforms; the culling happens on the GPU.
//
// Up close, trees get out of the way. One the camera is about to pass
// through, or one standing between the follow camera and the creature it
// follows, dissolves (a screen-door dither that drops a growing share of its
// pixels) instead of filling the screen with leaves.
import * as THREE from 'three';
import { biomeLook } from './biomes.js';
import { hash, meshHeight, smoothstep } from './util.js';

const SPACING = 6.5;      // between the places where a tree may stand (world units)
const DENSE = 0.85;       // share of the places with a tree in the heart of a forest
const STEEP = 0.75;       // no trees on slopes steeper than this (rise over run)
const TEX_W = 256;        // width of the trees' data texture
const MAX_COPIES = 5;     // copies of the world along each axis, at most (the ground has 5 × 5)
const SIZE0 = 0.3;        // a tree's size is SIZE0 + SIZE1 · (0..1) in the data texture
const SIZE1 = 1.7;
const MIN_PX = 6;         // in the map view a crown grows to be about this wide on screen...
const MAX_GROW = 1.8;     // ...but to no more than this times its size
const TRUNK = [86, 68, 52];

// The two kinds. `crown`: radius of the crown at its widest; `top`: height;
// `mid`, `reach`: a ball around the tree (for culling). All at size 1.
const KINDS = {
    conifer: { leaves: [44, 70, 54], crown: 2.8, top: 10.6, mid: 5.2, reach: 6.2 },
    broadleaf: { leaves: [78, 102, 58], crown: 3.4, top: 9.2, mid: 5.0, reach: 5.6 },
};

const linear = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);

// A tree is built as one indexed geometry with a colour per corner. Faces
// share corners; the material's flat shading gives every face its own normal
// anyway (from screen-space derivatives), so the facets still show, and a
// tree is only some 40 corners for the GPU to move.
class Builder {
    constructor() {
        this.pos = [];
        this.col = [];
        this.idx = [];
    }

    vertex(x, y, z, color, shade) {
        this.pos.push(x, y, z);
        this.col.push(color.r * shade, color.g * shade, color.b * shade);
        return this.pos.length / 3 - 1;
    }

    ring(n, y, r, turn, color, shade) {
        const first = this.pos.length / 3;
        for (let i = 0; i < n; i++) {
            const a = turn + (i / n) * Math.PI * 2;
            this.vertex(Math.cos(a) * r, y, Math.sin(a) * r, color, shade);
        }
        return first;
    }

    // A cone with its base: darker at the skirt, lighter at the tip, as if
    // the tier above shaded it.
    cone(n, y0, h, r, turn, color) {
        const ring = this.ring(n, y0, r, turn, color, 0.7);
        const apex = this.vertex(0, y0 + h, 0, color, 1.12);
        const base = this.vertex(0, y0 + 0.4, 0, color, 0.6);
        for (let i = 0; i < n; i++) {
            const a = ring + i;
            const b = ring + ((i + 1) % n);
            this.idx.push(a, apex, b, base, a, b); // side (outward), underside (downward)
        }
    }

    // A trunk: a tapering prism without ends (the crown hides its top, the
    // ground its foot).
    trunk(n, y0, y1, r0, r1, color) {
        const lo = this.ring(n, y0, r0, 0, color, 0.75);
        const hi = this.ring(n, y1, r1, 0, color, 1);
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            this.idx.push(lo + i, hi + i, lo + j, lo + j, hi + i, hi + j);
        }
    }

    // A lumpy ball of leaves: an icosahedron, squashed, darker underneath.
    blob(cx, cy, cz, sx, sy, sz, color) {
        const p = (1 + Math.sqrt(5)) / 2;
        const corners = [
            [-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p],
            [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1],
        ];
        const len = Math.hypot(1, p);
        const first = this.pos.length / 3;
        for (const [x, y, z] of corners) {
            const u = y / len; // −1 at the bottom .. 1 at the top
            this.vertex(cx + (x / len) * sx, cy + u * sy, cz + (z / len) * sz, color, 0.84 + 0.24 * u);
        }
        const faces = [
            [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
        ];
        // Turn every face to look away from the middle, so none is culled.
        for (const [a, b, c] of faces) {
            const A = corners[a];
            const B = corners[b];
            const C = corners[c];
            const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
            const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const out = nx * (A[0] + B[0] + C[0]) + ny * (A[1] + B[1] + C[1]) + nz * (A[2] + B[2] + C[2]) > 0;
            if (out) this.idx.push(first + a, first + b, first + c);
            else this.idx.push(first + a, first + c, first + b);
        }
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

// A fir: three stacked cones, each turned a little, on a short trunk.
function coniferGeometry() {
    const b = new Builder();
    const leaves = linear(KINDS.conifer.leaves);
    b.trunk(5, -0.8, 2.6, 0.42, 0.3, linear(TRUNK));
    b.cone(7, 1.6, 5.0, 2.8, 0, leaves);
    b.cone(7, 4.1, 4.3, 2.1, 0.45, leaves);
    b.cone(6, 6.5, 4.1, 1.35, 0.9, leaves);
    return b.geometry();
}

// A broadleaf tree: a taller trunk and a round, lumpy crown of three blobs.
function broadleafGeometry() {
    const b = new Builder();
    const leaves = linear(KINDS.broadleaf.leaves);
    b.trunk(5, -0.8, 4.4, 0.5, 0.34, linear(TRUNK));
    b.blob(0, 6.0, 0, 3.0, 2.5, 3.0, leaves);
    b.blob(1.1, 7.2, -0.5, 2.0, 1.8, 2.0, leaves);
    b.blob(-1.2, 6.8, 0.8, 1.8, 1.6, 1.8, leaves);
    return b.geometry();
}

const VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uTrees; // per tree: world x, ground height, world y, seed (0..1023) + size (fraction)
uniform int uCount;    // trees of this kind
uniform int uCopiesX;  // copies of the world drawn along x (the instance count says how many along z)
uniform vec2 uWorld;   // the world's width and height
uniform vec2 uOrigin;  // world (x, y) of the floating origin
uniform vec4 uBox;     // the ground the camera can see: minX, maxX, minZ, maxZ, from the origin
uniform vec4 uPlanes[ 6 ]; // the camera's view, as six planes
uniform vec3 uCam;     // the camera
uniform float uFocus;  // distance from the camera to what it looks at
uniform float uCut;    // 0..1: how much to clear the line of sight to it
uniform float uGrow;   // map view: growth per unit of distance from the camera (0 elsewhere)
varying float vFade;   // 1 solid .. 0 gone
`;

// The vertex shader for one kind of tree (its sizes are written in).
const vertexMain = (K) => /* glsl */ `
vec3 transformed = vec3( position );
{
    int copy = gl_InstanceID / uCount;
    int tree = gl_InstanceID - copy * uCount;
    vec4 d = texelFetch( uTrees, ivec2( tree % ${TEX_W}, tree / ${TEX_W} ), 0 );
    int cz = copy / uCopiesX;
    int cx = copy - cz * uCopiesX;
    // This copy of the tree: the first one past the box's low corner, then
    // whole worlds further on.
    vec3 at = vec3(
        uBox.x + mod( d.x - uOrigin.x - uBox.x, uWorld.x ) + float( cx ) * uWorld.x,
        d.y,
        uBox.z + mod( d.z - uOrigin.y - uBox.z, uWorld.y ) + float( cz ) * uWorld.y );
    float seed = floor( d.w ) / 1024.0;
    float size = ${SIZE0.toFixed(2)} + ${SIZE1.toFixed(2)} * fract( d.w );
    // From high above (the map), trees grow with distance, as the creatures
    // do, so that a forest still reads as a canopy rather than as specks.
    size *= clamp( distance( at, uCam ) * uGrow, 1.0, ${MAX_GROW.toFixed(2)} );
    vec3 mid = at + vec3( 0.0, ${K.mid.toFixed(2)} * size, 0.0 );
    float reach = ${K.reach.toFixed(2)} * size;
    bool shown = at.x <= uBox.y && at.z <= uBox.w;
    for ( int p = 0; p < 6; p++ ) shown = shown && dot( uPlanes[ p ].xyz, mid ) + uPlanes[ p ].w > -reach;

    // Out of the camera's way. Near: the camera is below the tree's top and
    // about to touch its crown.
    float crown = ${K.crown.toFixed(2)} * size;
    float top = at.y + ${K.top.toFixed(2)} * size;
    float below = 1.0 - smoothstep( top, top + 2.0, uCam.y );
    vFade = 1.0 - below * ( 1.0 - smoothstep( crown - 0.5, crown + 2.0, distance( at.xz, uCam.xz ) ) );
    // In the line of sight: the camera looks straight at what it follows,
    // so that is the middle of the screen, the view-space ray (0, 0, -z).
    // How close does the tree's axis pass to that ray, and is it nearer?
    if ( uCut > 0.0 ) {
        vec3 a = ( viewMatrix * vec4( at.x, at.y + size, at.z, 1.0 ) ).xyz;
        vec3 b = ( viewMatrix * vec4( at.x, top, at.z, 1.0 ) ).xyz;
        vec2 ab = b.xy - a.xy;
        float t = clamp( -dot( a.xy, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 );
        float depth = -mix( a.z, b.z, t );
        if ( depth > 0.0 && depth < uFocus - 3.0 ) {
            float off = length( a.xy + ab * t );
            vFade = min( vFade, 1.0 - uCut * ( 1.0 - smoothstep( crown + 1.0, crown + 5.0, off ) ) );
        }
    }
    if ( vFade < 0.02 ) shown = false;

    float a = seed * 6.2831853;
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    float wide = size * ( 0.88 + 0.24 * fract( seed * 13.1 ) );
    float tall = size * ( 0.9 + 0.2 * fract( seed * 5.7 ) );
    transformed = transformed * vec3( wide, tall, wide ) * ( shown ? 1.0 : 0.0 ) + at;
    // Each tree a little lighter or darker, warmer or cooler.
    float warm = fract( seed * 37.7 ) - 0.5;
    vColor *= ( 0.86 + 0.28 * fract( seed * 91.3 ) ) * vec3( 1.0 + 0.16 * warm, 1.0, 1.0 - 0.16 * warm );
}
`;

// Screen-door transparency: a fading tree keeps only the share vFade of its
// pixels, picked by a fine noise pattern (interleaved gradient noise).
const FRAGMENT_PARS = /* glsl */ `
varying float vFade;
`;
const FRAGMENT_MAIN = /* glsl */ `
if ( vFade < 0.999 ) {
    float n = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( n >= vFade ) discard;
}
`;

export class Forest {
    constructor(scene) {
        this.scene = scene;
        // Shared by both kinds (the same objects, so one update serves both).
        this.uniforms = {
            uCopiesX: { value: 1 },
            uWorld: { value: new THREE.Vector2(1, 1) },
            uOrigin: { value: new THREE.Vector2() },
            uBox: { value: new THREE.Vector4() },
            uPlanes: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
            uCam: { value: new THREE.Vector3() },
            uFocus: { value: 1 },
            uCut: { value: 0 },
            uGrow: { value: 0 },
        };
        this.kinds = ['conifer', 'broadleaf'].map((name) => {
            const geometry = name === 'conifer' ? coniferGeometry() : broadleafGeometry();
            const own = { uTrees: { value: null }, uCount: { value: 1 } };
            const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
            material.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.uniforms, own);
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
                    .replace('#include <begin_vertex>', vertexMain(KINDS[name]));
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
                    .replace('#include <clipping_planes_fragment>', `${FRAGMENT_MAIN}\n#include <clipping_planes_fragment>`);
            };
            material.customProgramCacheKey = () => `trees-${name}`;
            const mesh = new THREE.Mesh(geometry, material);
            // The trees stand all over the world, which the geometry's own
            // bounds know nothing about; the shader culls them instead.
            mesh.frustumCulled = false;
            mesh.visible = false;
            scene.add(mesh);
            return { name, geometry, material, mesh, own, count: 0, texture: null };
        });
        this.count = 0;
        this.stats = { trees: 0, conifer: 0, broadleaf: 0, buildMs: 0 };
    }

    // A new world: place its trees. Needs biomes (the ground's tree cover).
    attach(world, terrain, ground) {
        const t0 = performance.now();
        for (const k of this.kinds) {
            k.texture?.dispose();
            k.texture = null;
            k.count = 0;
            k.geometry.instanceCount = 0;
            k.mesh.visible = false;
        }
        this.count = 0;
        this.stats = { trees: 0, conifer: 0, broadleaf: 0, buildMs: 0 };
        if (!terrain || !terrain.biomeGrid || !ground.cover) return;

        const W = world.width;
        const H = world.height;
        const { cols, rows, cellW, cellH } = world.grass;
        const { biomeGrid, biomes, seaLevel: sea } = terrain;
        const cover = ground.cover;
        const barren = biomes.map((b) => b.fertility === 0); // water, rock, snow: nothing grows
        let peak = sea + 1;
        for (const h of terrain.height) if (h > peak) peak = h;
        // The tree cover at any point, bilinear between the patch centres.
        const coverAt = (x, y) => {
            const fx = x / cellW - 0.5;
            const fy = y / cellH - 0.5;
            const i = Math.floor(fx);
            const j = Math.floor(fy);
            const tx = fx - i;
            const ty = fy - j;
            const i0 = (i + cols) % cols;
            const i1 = (i + 1) % cols;
            const j0 = ((j + rows) % rows) * cols;
            const j1 = ((j + 1) % rows) * cols;
            const top = cover[i0 + j0] + (cover[i1 + j0] - cover[i0 + j0]) * tx;
            const bottom = cover[i0 + j1] + (cover[i1 + j1] - cover[i0 + j1]) * tx;
            return top + (bottom - top) * ty;
        };

        // The grid divides the world exactly, so it wraps without a seam.
        const nx = Math.round(W / SPACING);
        const nz = Math.round(H / SPACING);
        const sx = W / nx;
        const sz = H / nz;
        const out = [0, 0];
        const found = { conifer: [], broadleaf: [] };
        for (let j = 0; j < nz; j++) {
            for (let i = 0; i < nx; i++) {
                const h1 = hash(i + j * nx + 0x51ed270b);
                const h2 = hash(h1 ^ 0x2c1b3c6d);
                const x = (i + 0.1 + 0.8 * ((h1 & 255) / 255)) * sx;
                const y = (j + 0.1 + 0.8 * (((h1 >>> 8) & 255) / 255)) * sz;
                const c = coverAt(x, y);
                // Dense in the forest, thinning fast at its edge, a few strays.
                const p = Math.max(DENSE * smoothstep(0.25, 0.75, c), 0.25 * c);
                if (((h1 >>> 16) & 1023) / 1023 >= p) continue;
                const pi = Math.min(cols - 1, Math.floor(x / cellW));
                const pj = Math.min(rows - 1, Math.floor(y / cellH));
                if (barren[biomeGrid[pi + pj * cols]] || terrain.blocked(x, y)) continue;
                meshHeight(terrain, x, y, out);
                if (out[1] > STEEP || out[0] < sea + 0.5) continue;
                const up = (out[0] - sea) / (peak - sea); // 0 at the shore, 1 at the highest top
                const conifer = ((h2 & 1023) / 1023) < smoothstep(0.1, 0.3, up);
                // Smaller toward the tree line, and at the forest's edge.
                let size = 0.8 + 0.45 * (((h2 >>> 10) & 255) / 255);
                if (conifer) size *= 1 - 0.35 * smoothstep(0.38, 0.55, up);
                size *= 0.75 + 0.25 * smoothstep(0.2, 0.8, c);
                const seed = (h2 >>> 22) & 1023;
                // Sink it a little, so its trunk never floats on a slope.
                const packed = seed + Math.min(0.999, Math.max(0, (size - SIZE0) / SIZE1));
                found[conifer ? 'conifer' : 'broadleaf'].push(x, out[0] - 0.15, y, packed);
            }
        }

        for (const k of this.kinds) {
            const data = found[k.name];
            const n = data.length / 4;
            k.count = n;
            if (!n) continue;
            const texH = Math.ceil(n / TEX_W);
            const pixels = new Float32Array(TEX_W * texH * 4);
            pixels.set(data);
            const tex = new THREE.DataTexture(pixels, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
            tex.minFilter = THREE.NearestFilter;
            tex.magFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            k.texture = tex;
            k.own.uTrees.value = tex;
            k.own.uCount.value = n;
            k.mesh.visible = true;
            this.count += n;
        }
        this.uniforms.uWorld.value.set(W, H);
        this.stats = {
            trees: this.count,
            conifer: this.kinds[0].count,
            broadleaf: this.kinds[1].count,
            buildMs: +(performance.now() - t0).toFixed(1),
        };
    }

    // Every frame: where the camera is and what it can see. No tree is
    // touched here; `focusY` is the height of the point the camera looks at.
    update(view, focusY) {
        if (!this.count) return;
        const u = this.uniforms;
        u.uOrigin.value.set(view.fx, view.fz);
        u.uBox.value.set(view.minX, view.maxX, view.minZ, view.maxZ);
        for (let p = 0; p < 6; p++) u.uPlanes.value[p].fromArray(view.planes, p * 4);
        u.uCam.value.set(view.camX, view.camY, view.camZ);
        u.uFocus.value = Math.hypot(view.camX, view.camY - focusY, view.camZ);
        u.uCut.value = 1 - view.mapness;
        u.uGrow.value = (view.unitPx * MIN_PX * view.mapness) / (2 * KINDS.conifer.crown);
        const cx = Math.min(MAX_COPIES, Math.floor((view.maxX - view.minX) / view.W) + 1);
        const cz = Math.min(MAX_COPIES, Math.floor((view.maxZ - view.minZ) / view.H) + 1);
        u.uCopiesX.value = cx;
        for (const k of this.kinds) k.geometry.instanceCount = k.count * cx * cz;
    }
}
