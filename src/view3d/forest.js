// Forests: low-poly trees wherever the land is wooded.
//
// Trees are scenery. They never move, grow or die, so they are placed once
// per world and then left to the graphics card.
//
// Where: on a grid of places SPACING apart, each nudged by a hash so they do
// not line up in rows. A place holds a tree with a chance that follows the
// ground's tree cover (terrain-mesh.js: the forest biome, blurred over its
// edges): most places in the heart of a forest, fewer toward its edge, now
// and then one just outside it, a lone tree here and there in wetland, and
// a lone fruit tree now and then in a meadow. Never in water, on cliffs, on
// steep ground, or where nothing grows (rock, snow). The same world always
// gets the same trees.
//
// Which: four kinds (almanac.js TREE_KINDS). Pines on high (colder) ground,
// smaller toward the tree line; lower down broadleaf trees, birches more
// toward the pines, oaks lower; fruit trees at the forests' edges and alone
// in meadows. Pines stay green; the others follow the year (almanac.js
// FOLIAGE): oaks and birches turn red and gold in autumn, the birches stand
// bare in winter and the oaks keep a few dry leaves, fruit trees blossom
// white and pink in spring before their leaves come. In winter snow lies on
// the faces that look up (with the ground's snow line: haze.js snowAt).
//
// How they are drawn: one instanced mesh per kind, so all the trees are four
// draw calls. Each tree's place (world x, ground height, world y) and its
// seed and size are four floats in a small float texture, written once, the
// trees sorted by the square CHUNK of ground they stand in. The world wraps,
// and from high up the view takes in more than one copy of it. Each frame
// the chunks of every copy the view can reach are tested against the
// visible box and the camera's view (a few hundred boxes), and those in view
// become runs of whole chunks (as few as MAX_RUNS allows): only their trees
// are drawn, instance i being found in its run on the graphics card. There
// the vertex shader places each tree beside the floating origin (util.js)
// and, if it is still outside the box or the view, collapses it to a point,
// which draws nothing.
//
// The leaves are coloured on the graphics card too: a leaf vertex carries only
// its shade, and the shader gives it this tree's colour for the season (each
// tree turning a little before or after its neighbours), and draws its crown
// in toward the middle of each clump as the leaves thin, down to bare
// branches.
//
// Up close, trees get out of the way. One the camera is about to pass
// through, or one standing between the follow camera and the creature it
// follows, dissolves (a screen-door dither that drops a growing share of its
// pixels) instead of filling the screen with leaves.
import * as THREE from 'three';
import { hash, meshHeight, smoothstep } from './util.js';
import { TREE_KINDS } from './almanac.js';
import { SNOW_LINE, SNOW_COLOR, SNOW_GLSL } from './haze.js';
import { depthTwin } from './shadows.js';

const SPACING = 6.5;      // between the places where a tree may stand (world units)
const DENSE = 0.85;       // share of the places with a tree in the heart of a forest
const STEEP = 0.75;       // no trees on slopes steeper than this (rise over run)
const ORCHARD = 0.004;    // share of the open meadow's places with a lone fruit tree
const EDGE_FRUIT = 0.22;  // share of the broadleaf trees at a forest's edge that bear fruit
const TEX_W = 256;        // width of the trees' data texture
const MAX_COPIES = 5;     // copies of the world along each axis, at most (the ground has 5 × 5)
const CHUNK = 128;        // the trees are kept in square chunks about this wide (world units)...
const MAX_RUNS = 64;      // ...and drawn as at most this many runs of whole chunks
const MARGIN = 25;        // a chunk's trees reach this far past it (crowns, and the map's growth)
const TALLEST = 40;       // and this high above their ground
const SIZE0 = 0.3;        // a tree's size is SIZE0 + SIZE1 · (0..1) in the data texture
const SIZE1 = 1.7;
const MIN_PX = 6;         // in the map view a crown grows to be about this wide on screen...
const MAX_GROW = 1.8;     // ...but to no more than this times its size
const TRUNK = [86, 68, 52];
const OAK_BARK = [78, 64, 52];
const BIRCH_BARK = [206, 200, 188];
const BIRCH_MARK = [70, 64, 58];

// Per kind: `crown`, the crown's radius at its widest; `top`, its height;
// `mid`, `reach`: a ball around the tree (for culling); `cling`, how much
// snow its upper faces hold. All at size 1.
const KINDS = {
    pine: { crown: 2.8, top: 10.6, mid: 5.2, reach: 6.2, cling: 0.9 },
    birch: { crown: 2.2, top: 10.6, mid: 5.6, reach: 6.0, cling: 0.7 },
    oak: { crown: 3.9, top: 9.8, mid: 5.2, reach: 6.4, cling: 0.75 },
    fruit: { crown: 2.8, top: 6.4, mid: 3.4, reach: 4.4, cling: 0.7 },
};

const linear = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
const GREY = new THREE.Color(1, 1, 1); // a leaf's own colour: only its shade (the shader colours it)

// A tree is built as one indexed geometry with a colour per corner, and per
// corner its part: the middle of its clump of leaves (x, y, z) and whether it
// is a leaf (w). Faces share corners; the material's flat shading gives every
// face its own normal anyway (from screen-space derivatives), so the facets
// still show, and a tree is a few dozen corners for the GPU to move.
class Builder {
    constructor() {
        this.pos = [];
        this.col = [];
        this.part = [];
        this.idx = [];
        this.hub = [0, 0, 0, 0]; // what the next corners belong to
    }

    vertex(x, y, z, color, shade) {
        this.pos.push(x, y, z);
        this.col.push(color.r * shade, color.g * shade, color.b * shade);
        this.part.push(...this.hub);
        return this.pos.length / 3 - 1;
    }

    wood() {
        this.hub = [0, 0, 0, 0];
        return this;
    }

    leaves(x, y, z) {
        this.hub = [x, y, z, 1];
        return this;
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
        this.leaves(0, y0 + h * 0.3, 0);
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
    // ground its foot), in sections whose rings may differ in colour (a
    // birch's dark marks): `rings` [[y, radius, colour, shade], ...].
    trunk(n, rings) {
        this.wood();
        const first = rings.map(([y, r, color, shade]) => this.ring(n, y, r, 0, color, shade));
        for (let k = 0; k + 1 < first.length; k++) {
            const lo = first[k];
            const hi = first[k + 1];
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                this.idx.push(lo + i, hi + i, lo + j, lo + j, hi + i, hi + j);
            }
        }
    }

    // A branch: a thin three-sided prism from a to b, tapering.
    branch(a, b, r0, r1, color) {
        this.wood();
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(...d);
        const u = d.map((v) => v / len);
        // Two directions across it.
        const side = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let p = [u[1] * side[2] - u[2] * side[1], u[2] * side[0] - u[0] * side[2], u[0] * side[1] - u[1] * side[0]];
        const pl = Math.hypot(...p);
        p = p.map((v) => v / pl);
        const q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
        const ring = (c, r, shade) => {
            const first = this.pos.length / 3;
            for (let i = 0; i < 3; i++) {
                const t = (i / 3) * Math.PI * 2;
                const ct = Math.cos(t) * r;
                const st = Math.sin(t) * r;
                this.vertex(c[0] + p[0] * ct + q[0] * st, c[1] + p[1] * ct + q[1] * st, c[2] + p[2] * ct + q[2] * st, color, shade);
            }
            return first;
        };
        const lo = ring(a, r0, 0.8);
        const hi = ring(b, r1, 1);
        for (let i = 0; i < 3; i++) {
            const j = (i + 1) % 3;
            this.idx.push(lo + i, hi + i, lo + j, lo + j, hi + i, hi + j);
        }
    }

    // A lumpy ball of leaves: an icosahedron, squashed, darker underneath.
    blob(cx, cy, cz, sx, sy, sz, color = GREY) {
        this.leaves(cx, cy, cz);
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
        g.setAttribute('part', new THREE.Float32BufferAttribute(this.part, 4));
        g.setIndex(this.idx);
        g.computeVertexNormals(); // unused (flat shading), but keeps three.js's attributes complete
        g.instanceCount = 0;
        return g;
    }
}

const SHAPES = {
    // A pine: three stacked cones, each turned a little, on a short trunk.
    pine() {
        const b = new Builder();
        const bark = linear(TRUNK);
        b.trunk(5, [[-0.8, 0.42, bark, 0.75], [2.6, 0.3, bark, 1]]);
        b.cone(7, 1.6, 5.0, 2.8, 0, GREY);
        b.cone(7, 4.1, 4.3, 2.1, 0.45, GREY);
        b.cone(6, 6.5, 4.1, 1.35, 0.9, GREY);
        return b.geometry();
    },
    // A birch: a tall, slender, pale trunk with dark marks, branches reaching
    // up, and a narrow, airy crown.
    birch() {
        const b = new Builder();
        const bark = linear(BIRCH_BARK);
        const mark = linear(BIRCH_MARK);
        b.trunk(5, [[-0.8, 0.34, bark, 0.8], [1.4, 0.3, mark, 1], [2.4, 0.27, bark, 1], [4.6, 0.22, mark, 1], [5.4, 0.2, bark, 1], [7.4, 0.13, bark, 1]]);
        b.branch([0, 4.2, 0], [1.3, 6.9, 0.4], 0.12, 0.05, bark);
        b.branch([0, 5.0, 0], [-1.1, 7.6, -0.6], 0.11, 0.05, bark);
        b.branch([0, 3.6, 0], [-0.4, 5.9, 1.2], 0.1, 0.04, bark);
        b.blob(0, 7.4, 0, 1.9, 2.7, 1.9);
        b.blob(0.8, 8.8, -0.3, 1.3, 1.8, 1.3);
        b.blob(-0.8, 6.4, 0.6, 1.4, 1.6, 1.4);
        return b.geometry();
    },
    // An oak: a thick, dark trunk, heavy branches spreading, a broad crown of
    // four clumps.
    oak() {
        const b = new Builder();
        const bark = linear(OAK_BARK);
        b.trunk(6, [[-0.8, 0.66, bark, 0.72], [3.6, 0.44, bark, 1]]);
        b.branch([0, 3.1, 0], [2.3, 5.6, 1.0], 0.3, 0.1, bark);
        b.branch([0, 3.3, 0], [-2.2, 5.8, -1.1], 0.3, 0.1, bark);
        b.branch([0, 3.5, 0], [0.6, 6.2, -2.0], 0.26, 0.09, bark);
        b.branch([0, 3.4, 0], [-0.7, 6.4, 1.9], 0.26, 0.09, bark);
        b.blob(0, 6.3, 0, 3.4, 2.4, 3.4);
        b.blob(1.8, 7.1, -0.9, 2.2, 1.9, 2.2);
        b.blob(-1.9, 6.9, 1.0, 2.1, 1.8, 2.1);
        b.blob(0.2, 8.1, 0.4, 2.0, 1.6, 2.0);
        return b.geometry();
    },
    // A fruit tree: low, with a short trunk and a round crown.
    fruit() {
        const b = new Builder();
        const bark = linear(TRUNK);
        b.trunk(5, [[-0.8, 0.38, bark, 0.75], [2.3, 0.26, bark, 1]]);
        b.branch([0, 2.0, 0], [1.4, 3.8, 0.5], 0.14, 0.05, bark);
        b.branch([0, 2.1, 0], [-1.2, 4.0, -0.7], 0.14, 0.05, bark);
        b.branch([0, 2.2, 0], [-0.3, 4.2, 1.3], 0.12, 0.05, bark);
        b.blob(0, 4.3, 0, 2.4, 1.8, 2.4);
        b.blob(0.9, 5.0, -0.4, 1.6, 1.3, 1.6);
        b.blob(-0.9, 4.8, 0.6, 1.5, 1.2, 1.5);
        return b.geometry();
    },
};

const VERTEX_PARS = /* glsl */ `
attribute vec4 part;   // the middle of this corner's clump of leaves, and 1 for a leaf (0: wood)
uniform highp sampler2D uTrees; // per tree: world x, ground height, world y, seed (0..1023) + size (fraction)
uniform vec4 uRuns[ ${MAX_RUNS} ]; // the runs of trees drawn: the first, how many, and where that copy of the world stands
uniform float uEnds[ ${MAX_RUNS} ]; // instances up to the end of each run
uniform int uRunCount;
uniform vec4 uBox;     // the ground the camera can see: minX, maxX, minZ, maxZ, from the origin
uniform vec4 uPlanes[ 6 ]; // the camera's view, as six planes
uniform vec3 uCam;     // the camera
uniform float uFocus;  // distance from the camera to what it looks at
uniform float uCut;    // 0..1: how much to clear the line of sight to it
uniform float uGrow;   // map view: growth per unit of distance from the camera (0 elsewhere)
uniform vec3 uFromA;   // the season's leaves (almanac.js foliage): the key before, colours A and B...
uniform vec3 uFromB;
uniform vec3 uToA;     // ...the key after
uniform vec3 uToB;
uniform vec3 uLeaf;    // the leaves' amount at each key (x, y), and how far between them (z)
uniform vec4 uShadowBox; // the shadow map (shadows.js): the ground whose trees may cast into it, as uBox
varying float vFade;   // 1 solid .. 0 gone
varying float vSnow;   // snow on its upper faces
`;

// The vertex shader for one kind of tree (its sizes are written in). Its
// twin for the shadow map (`depth`) places the same trees with the same
// leaves, but keeps those that may cast into the map (uShadowBox) rather
// than those in view, and none fades out of the camera's way.
const vertexMain = (K, depth = false) => /* glsl */ `
vec3 transformed = vec3( position );
{
    // Which run this instance is in (the first whose end is past it), and so
    // which tree, in which copy of the world.
    float id = float( gl_InstanceID );
    int lo = 0;
    int hi = uRunCount - 1;
    for ( int s = 0; s < ${Math.ceil(Math.log2(MAX_RUNS))}; s++ ) {
        if ( lo < hi ) {
            int m = ( lo + hi ) / 2;
            if ( id < uEnds[ m ] ) hi = m;
            else lo = m + 1;
        }
    }
    vec4 run = uRuns[ lo ];
    int tree = int( run.x + id - ( lo > 0 ? uEnds[ lo - 1 ] : 0.0 ) + 0.5 );
    vec4 d = texelFetch( uTrees, ivec2( tree % ${TEX_W}, tree / ${TEX_W} ), 0 );
    vec3 at = vec3( d.x + run.z, d.y, d.z + run.w );
    float seed = floor( d.w ) / 1024.0;
    float size = ${SIZE0.toFixed(2)} + ${SIZE1.toFixed(2)} * fract( d.w );
    // From high above (the map), trees grow with distance, as the creatures
    // do, so that a forest still reads as a canopy rather than as specks.
    size *= clamp( distance( at, uCam ) * uGrow, 1.0, ${MAX_GROW.toFixed(2)} );
    float reach = ${K.reach.toFixed(2)} * size;
${depth ? /* glsl */ `
    bool shown = at.x >= uShadowBox.x - reach && at.x <= uShadowBox.y + reach && at.z >= uShadowBox.z - reach && at.z <= uShadowBox.w + reach;
` : /* glsl */ `
    vec3 mid = at + vec3( 0.0, ${K.mid.toFixed(2)} * size, 0.0 );
    bool shown = at.x >= uBox.x && at.x <= uBox.y && at.z >= uBox.z && at.z <= uBox.w;
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
`}
    // Its leaves this season: it turns a little before or after the others
    // (r), and leans to colour A or B (pick).
    float r = fract( seed * 53.71 );
    float turn = smoothstep( 0.0, 1.0, clamp( ( uLeaf.z - 0.45 * r ) / 0.55, 0.0, 1.0 ) );
    float amount = mix( uLeaf.x, uLeaf.y, turn );
    // A thinning crown draws in toward the middle of each clump, to nothing.
    transformed = mix( transformed, mix( part.xyz, transformed, sqrt( amount ) ), part.w );
${depth ? '' : /* glsl */ `
    float pick = fract( seed * 17.13 );
    vec3 leaf = mix( mix( uFromA, uFromB, pick ), mix( uToA, uToB, pick ), turn );
    vColor *= mix( vec3( 1.0 ), leaf, part.w );
`}
    float a = seed * 6.2831853;
    float c = cos( a );
    float s = sin( a );
    transformed.xz = vec2( c * transformed.x - s * transformed.z, s * transformed.x + c * transformed.z );
    float wide = size * ( 0.88 + 0.24 * fract( seed * 13.1 ) );
    float tall = size * ( 0.9 + 0.2 * fract( seed * 5.7 ) );
    transformed = transformed * vec3( wide, tall, wide ) * ( shown ? 1.0 : 0.0 ) + at;
${depth ? '' : /* glsl */ `
    // Each tree a little lighter or darker, warmer or cooler.
    float warm = fract( seed * 37.7 ) - 0.5;
    vColor *= ( 0.86 + 0.28 * fract( seed * 91.3 ) ) * vec3( 1.0 + 0.16 * warm, 1.0, 1.0 - 0.16 * warm );
    vSnow = snowAt( at.y + 2.0 * size, 0.0 ) * ${K.cling.toFixed(2)};
`}
}
`;

// Screen-door transparency: a fading tree keeps only the share vFade of its
// pixels, picked by a fine noise pattern (interleaved gradient noise). Snow
// whitens the faces that look up.
const FRAGMENT_PARS = /* glsl */ `
varying float vFade;
varying float vSnow;
`;
const FRAGMENT_MAIN = /* glsl */ `
if ( vFade < 0.999 ) {
    float n = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( n >= vFade ) discard;
}
`;
const FRAGMENT_SNOW = /* glsl */ `
diffuseColor.rgb = mix( diffuseColor.rgb, uSnowColor, vSnow * smoothstep( 0.12, 0.5, upward( normal ) ) );
`;

export class Forest {
    constructor(scene) {
        this.scene = scene;
        // Shared by all kinds (the same objects, so one update serves them all).
        this.uniforms = {
            uBox: { value: new THREE.Vector4() },
            uPlanes: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
            uCam: { value: new THREE.Vector3() },
            uFocus: { value: 1 },
            uCut: { value: 0 },
            uGrow: { value: 0 },
            uShadowBox: { value: new THREE.Vector4() },
            uSnowLine: SNOW_LINE,
            uSnowColor: SNOW_COLOR,
        };
        this.shadowBox = null; // the shadow map's ground (shadows.js box), while there are shadows
        this.kinds = TREE_KINDS.map((name) => {
            const geometry = SHAPES[name]();
            const own = {
                uTrees: { value: null },
                uRuns: { value: Array.from({ length: MAX_RUNS }, () => new THREE.Vector4()) },
                uEnds: { value: new Float32Array(MAX_RUNS) },
                uRunCount: { value: 0 },
                uFromA: { value: new THREE.Color() }, uFromB: { value: new THREE.Color() },
                uToA: { value: new THREE.Color() }, uToB: { value: new THREE.Color() },
                uLeaf: { value: new THREE.Vector3(1, 1, 0) },
            };
            const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
            material.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.uniforms, own);
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}\n${SNOW_GLSL}`)
                    .replace('#include <begin_vertex>', vertexMain(KINDS[name]));
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\n${SNOW_GLSL}`)
                    .replace('#include <clipping_planes_fragment>', `${FRAGMENT_MAIN}\n#include <clipping_planes_fragment>`)
                    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_SNOW}`);
            };
            material.customProgramCacheKey = () => `trees-${name}`;
            depthTwin(material, `trees-${name}-depth`, (shader) => {
                Object.assign(shader.uniforms, this.uniforms, own);
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
                    .replace('#include <begin_vertex>', vertexMain(KINDS[name], true));
            });
            const mesh = new THREE.Mesh(geometry, material);
            // The trees stand all over the world, which the geometry's own
            // bounds know nothing about; the shader culls them instead.
            mesh.frustumCulled = false;
            mesh.visible = false;
            scene.add(mesh);
            return { name, geometry, material, mesh, own, count: 0, texture: null, starts: null };
        });
        this.count = 0;
        this.chunks = null; // the chunk grid: { nx, nz, w, h, low, high (per chunk, the trees' ground) }
        this.seen = [];     // this frame's chunks in view: [chunk, copy x offset, copy z offset] ...
        this.stats = { trees: 0, buildMs: 0 };
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
        this.stats = { trees: 0, buildMs: 0 };
        if (!terrain || !terrain.biomeGrid || !ground.cover) return;

        const W = world.width;
        const H = world.height;
        const { cols, rows, cellW, cellH } = world.grass;
        const { biomeGrid, biomes, seaLevel: sea } = terrain;
        const cover = ground.cover;
        const barren = biomes.map((b) => b.fertility === 0); // water, rock, snow: nothing grows
        const meadow = biomes.map((b) => b.name === 'meadow');
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
        const found = Object.fromEntries(TREE_KINDS.map((k) => [k, []]));
        for (let j = 0; j < nz; j++) {
            for (let i = 0; i < nx; i++) {
                const h1 = hash(i + j * nx + 0x51ed270b);
                const h2 = hash(h1 ^ 0x2c1b3c6d);
                const h3 = hash(h2 ^ 0x1b873593);
                const x = (i + 0.1 + 0.8 * ((h1 & 255) / 255)) * sx;
                const y = (j + 0.1 + 0.8 * (((h1 >>> 8) & 255) / 255)) * sz;
                const c = coverAt(x, y);
                const pi = Math.min(cols - 1, Math.floor(x / cellW));
                const pj = Math.min(rows - 1, Math.floor(y / cellH));
                const b = biomeGrid[pi + pj * cols];
                // Dense in the forest, thinning fast at its edge, a few strays;
                // and in the open meadow, now and then a lone fruit tree.
                const p = Math.max(DENSE * smoothstep(0.25, 0.75, c), 0.25 * c);
                const roll = ((h1 >>> 16) & 1023) / 1023;
                const orchard = meadow[b] && c < 0.05 && roll < ORCHARD;
                if (roll >= p && !orchard) continue;
                if (barren[b] || terrain.blocked(x, y)) continue;
                meshHeight(terrain, x, y, out);
                if (out[1] > STEEP || out[0] < sea + 0.5) continue;
                const up = (out[0] - sea) / (peak - sea); // 0 at the shore, 1 at the highest top
                const u2 = (h2 & 1023) / 1023;
                const u3 = (h3 & 1023) / 1023;
                let kind;
                if (orchard) kind = 'fruit';
                else if (u2 < smoothstep(0.1, 0.3, up)) kind = 'pine';
                else if (c < 0.5 && u3 < EDGE_FRUIT * (1 - smoothstep(0.15, 0.3, up))) kind = 'fruit';
                else kind = ((h3 >>> 10) & 1023) / 1023 < 0.25 + 0.55 * smoothstep(0.06, 0.24, up) ? 'birch' : 'oak';
                // Smaller toward the tree line, and at the forest's edge.
                let size = 0.8 + 0.45 * (((h2 >>> 10) & 255) / 255);
                if (kind === 'pine') size *= 1 - 0.35 * smoothstep(0.38, 0.55, up);
                if (!orchard) size *= 0.75 + 0.25 * smoothstep(0.2, 0.8, c);
                const seed = (h2 >>> 22) & 1023;
                // Sink it a little, so its trunk never floats on a slope.
                const packed = seed + Math.min(0.999, Math.max(0, (size - SIZE0) / SIZE1));
                found[kind].push(x, out[0] - 0.15, y, packed);
            }
        }

        // The chunk grid (it divides the world exactly), and how low and high
        // the trees' ground is in each chunk.
        const cnx = Math.max(1, Math.round(W / CHUNK));
        const cnz = Math.max(1, Math.round(H / CHUNK));
        const chunks = { nx: cnx, nz: cnz, w: W / cnx, h: H / cnz, low: new Float32Array(cnx * cnz).fill(Infinity), high: new Float32Array(cnx * cnz).fill(-Infinity) };
        const chunkOf = (x, y) => Math.min(cnx - 1, Math.floor(x / chunks.w)) + Math.min(cnz - 1, Math.floor(y / chunks.h)) * cnx;
        for (const k of this.kinds) {
            const data = found[k.name];
            const n = data.length / 4;
            k.count = n;
            this.stats[k.name] = n;
            // Sorted by chunk (a counting sort): each chunk's trees in a row,
            // from starts[c] to starts[c + 1].
            const starts = new Uint32Array(cnx * cnz + 1);
            for (let t = 0; t < n; t++) starts[chunkOf(data[t * 4], data[t * 4 + 2]) + 1]++;
            for (let c = 0; c < cnx * cnz; c++) starts[c + 1] += starts[c];
            k.starts = starts;
            if (!n) continue;
            const texH = Math.ceil(n / TEX_W);
            const pixels = new Float32Array(TEX_W * texH * 4);
            const next = starts.slice(0, -1);
            for (let t = 0; t < n; t++) {
                const c = chunkOf(data[t * 4], data[t * 4 + 2]);
                pixels.set(data.slice(t * 4, t * 4 + 4), next[c]++ * 4);
                if (data[t * 4 + 1] < chunks.low[c]) chunks.low[c] = data[t * 4 + 1];
                if (data[t * 4 + 1] > chunks.high[c]) chunks.high[c] = data[t * 4 + 1];
            }
            const tex = new THREE.DataTexture(pixels, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
            tex.minFilter = THREE.NearestFilter;
            tex.magFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            k.texture = tex;
            k.own.uTrees.value = tex;
            k.mesh.visible = true;
            this.count += n;
        }
        this.chunks = chunks;
        this.stats.trees = this.count;
        this.stats.buildMs = +(performance.now() - t0).toFixed(1);
    }

    // Every tree: fn(x, y, crown), its place (world units) and its crown's
    // radius (for what is baked from them: contact.js).
    trees(fn) {
        for (const k of this.kinds) {
            if (!k.texture) continue;
            const data = k.texture.image.data;
            const crown = KINDS[k.name].crown;
            for (let t = 0; t < k.count; t++) fn(data[t * 4], data[t * 4 + 2], crown * (SIZE0 + SIZE1 * (data[t * 4 + 3] % 1)));
        }
    }

    // Every frame: where the camera is and what it can see, and the season's
    // leaves (almanac.js seasonLook). No tree is touched here; `focusY` is the
    // height of the point the camera looks at.
    update(view, focusY, look) {
        if (!this.count) return;
        const u = this.uniforms;
        u.uBox.value.set(view.minX, view.maxX, view.minZ, view.maxZ);
        for (let p = 0; p < 6; p++) u.uPlanes.value[p].fromArray(view.planes, p * 4);
        u.uCam.value.set(view.camX, view.camY, view.camZ);
        u.uFocus.value = Math.hypot(view.camX, view.camY - focusY, view.camZ);
        u.uCut.value = 1 - view.mapness;
        u.uGrow.value = (view.unitPx * MIN_PX * view.mapness) / (2 * KINDS.pine.crown);
        const sb = this.shadowBox;
        if (sb) u.uShadowBox.value.set(sb.minX, sb.maxX, sb.minZ, sb.maxZ);
        this.see(view);
        for (const k of this.kinds) {
            this.runs(k);
            const { from, to, u: along } = look.leaves[k.name];
            const o = k.own;
            setColor(o.uFromA.value, from[0]);
            setColor(o.uFromB.value, from[1]);
            setColor(o.uToA.value, to[0]);
            setColor(o.uToB.value, to[1]);
            o.uLeaf.value.set(from[2], to[2], along);
        }
    }

    // The chunks in view this frame, in every copy of the world the view
    // reaches: [chunk, copy's x, copy's z (render coordinates of its corner)]
    // in this.seen, copy by copy, each copy's chunks in order. With shadows,
    // also those whose trees may cast into the shadow map (shadowBox).
    see(view) {
        const { W, H, fx, fz, minX, maxX, minZ, maxZ, planes } = view;
        const { nx, nz, w, h, low, high } = this.chunks;
        const sb = this.shadowBox;
        const seen = this.seen;
        seen.length = 0;
        const kx0 = Math.floor((Math.min(minX, sb ? sb.minX : minX) + fx - MARGIN) / W);
        const kx1 = Math.min(kx0 + MAX_COPIES - 1, Math.floor((Math.max(maxX, sb ? sb.maxX : maxX) + fx + MARGIN) / W));
        const kz0 = Math.floor((Math.min(minZ, sb ? sb.minZ : minZ) + fz - MARGIN) / H);
        const kz1 = Math.min(kz0 + MAX_COPIES - 1, Math.floor((Math.max(maxZ, sb ? sb.maxZ : maxZ) + fz + MARGIN) / H));
        for (let kz = kz0; kz <= kz1; kz++) {
            for (let kx = kx0; kx <= kx1; kx++) {
                const ox = kx * W - fx;
                const oz = kz * H - fz;
                for (let c = 0; c < nx * nz; c++) {
                    if (low[c] > high[c]) continue; // (no trees)
                    const x0 = ox + (c % nx) * w - MARGIN;
                    const z0 = oz + Math.floor(c / nx) * h - MARGIN;
                    const x1 = x0 + w + 2 * MARGIN;
                    const z1 = z0 + h + 2 * MARGIN;
                    const casts = sb !== null && !(x1 < sb.minX || x0 > sb.maxX || z1 < sb.minZ || z0 > sb.maxZ);
                    if (!casts && (x1 < minX || x0 > maxX || z1 < minZ || z0 > maxZ)) continue;
                    if (!casts && outside(planes, x0, low[c] - 1, z0, x1, high[c] + TALLEST, z1)) continue;
                    seen.push(c, ox, oz);
                }
            }
        }
    }

    // One kind's runs of trees for this frame (from this.seen): neighbouring
    // chunks of a copy are one run; with too many runs, the closest are
    // joined (drawing the trees between them too, which the shader drops).
    runs(k) {
        const { starts } = k;
        const seen = this.seen;
        const runs = [];
        for (let s = 0; s < seen.length; s += 3) {
            const c = seen[s];
            const a = starts[c];
            const b = starts[c + 1];
            if (b === a) continue;
            const last = runs[runs.length - 1];
            if (last && last[2] === seen[s + 1] && last[3] === seen[s + 2] && last[1] === a) last[1] = b;
            else runs.push([a, b, seen[s + 1], seen[s + 2]]);
        }
        while (runs.length > MAX_RUNS) {
            let best = -1;
            for (let r = 0; r + 1 < runs.length; r++) {
                if (runs[r][2] !== runs[r + 1][2] || runs[r][3] !== runs[r + 1][3]) continue;
                if (best < 0 || runs[r + 1][0] - runs[r][1] < runs[best + 1][0] - runs[best][1]) best = r;
            }
            if (best < 0) {
                runs.length = MAX_RUNS; // (only when the view takes in more copies than can be told apart)
                break;
            }
            runs[best][1] = runs[best + 1][1];
            runs.splice(best + 1, 1);
        }
        const o = k.own;
        let total = 0;
        runs.forEach(([a, b, ox, oz], r) => {
            o.uRuns.value[r].set(a, b - a, ox, oz);
            total += b - a;
            o.uEnds.value[r] = total;
        });
        o.uRunCount.value = runs.length;
        k.geometry.instanceCount = total;
        k.mesh.visible = total > 0;
    }
}

// Is the box (x0, y0, z0)–(x1, y1, z1) wholly outside one of the view's six
// planes ([nx, ny, nz, d] each)?
function outside(planes, x0, y0, z0, x1, y1, z1) {
    for (let p = 0; p < 24; p += 4) {
        const nx = planes[p];
        const ny = planes[p + 1];
        const nz = planes[p + 2];
        if (nx * (nx > 0 ? x1 : x0) + ny * (ny > 0 ? y1 : y0) + nz * (nz > 0 ? z1 : z0) + planes[p + 3] < 0) return true;
    }
    return false;
}

const setColor = (c, rgb) => c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
