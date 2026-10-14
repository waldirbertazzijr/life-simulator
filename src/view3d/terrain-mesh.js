// The ground: the shape of the land and the grass on it.
//
// The whole world is one mesh: a grid laid over the terrain's height nodes
// (or a single flat square when there is no terrain). Because the world wraps,
// that mesh is drawn as several copies side by side, as many as the camera can
// see (usually 3×3 or fewer), so its edge is never in view. All copies share
// one geometry, one material and one texture.
//
// The texture is the grass: one texel per grass patch, recoloured every few
// frames with the same palette and the same soft blur as the 2D map. The
// grass grid (10 units) is finer than the height grid (~20), so colour comes
// from the texture and shape from the mesh. Rock on steep or high ground and
// the dark beds of lakes come from the terrain and are baked into the same
// texture once; a flat, slightly see-through sheet at sea level is the water.
//
// With biomes, each patch has its own bare ground (earth, leaf litter, mud,
// dry sand, tundra, rock; see biomes.js) and grass greens it from there, as
// in 2D. That is baked once per world into two numbers per colour channel,
// the bare ground and how far full grass moves it, so the refresh stays one
// multiply-add per channel. Snowfields ride in the texture's alpha channel
// (see SNOW_FRAGMENT).
//
// The seasons (almanac.js): full grass takes the season's colour (fresh in
// spring, golden in autumn: one more multiply-add per channel, by how much
// grass shows in each patch); in winter snow settles on the faces that look
// up, from the snow line down (a ragged edge from a tiling noise), and the
// lakes freeze in from their shores (the water sheet reads each patch's depth
// from a small texture).
import * as THREE from 'three';
import { COLORS } from '../render.js';
import { biomeLook, SNOW, CANOPY } from './biomes.js';
import { smoothstep, blurGrid, tileNoise } from './util.js';
import { SNOW_LINE, SNOW_COLOR, SNOW_GLSL } from './haze.js';
import { SNOW_FADE } from './almanac.js';

const ROCK = COLORS.rock;        // muted warm grey, as on the 2D map
const SHORE = [44, 56, 52];      // lake bed near the shore...
const DEEP = [20, 28, 32];       // ...and where it is deep
const WATER = '#2e4a56';
const REFRESH = 6;               // frames between grass texture updates
const MAX_TILES = 25;

// With biomes: how far along from bare ground to lush grass a patch with
// grass g looks, indexed by g × 255. Steeper at first than the 2D view's
// curve: the bare ground here is light earth rather than near-black, and a
// pasture grazed short (g ≈ 0.25, where herbivores keep most of it) should
// still read as green-olive turf; only ground grazed nearly bare shows earth.
const GREEN = Float32Array.from({ length: 256 }, (_, i) => 1 - (1 - i / 255) ** 2);

// The ground's colour, with snow. The texture's alpha is 1 where there is no
// snow (everywhere, without biomes) and falls smoothly to 0 across the edge
// of a snowfield, blurred over a few patches. Cutting it at one half draws a
// crisp, rounded snow line through the middle of the patches, rather than a
// grey smear: the peaks look capped. The cut is about a pixel wide on screen
// at any distance (fwidth: how much the alpha changes from one pixel to the
// next), so the line is sharp up close and not jagged far away.
const SNOW_FRAGMENT = /* glsl */ `
float lyingSnow = 0.0;
#ifdef USE_MAP
    vec4 sampledDiffuseColor = texture2D( map, vMapUv );
    float edge = max( fwidth( sampledDiffuseColor.a ), 0.002 );
    float snow = 1.0 - smoothstep( 0.5 - edge, 0.5 + edge, sampledDiffuseColor.a );
    diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, uSnow, snow );
    lyingSnow = snow;
#endif
`;

// The season's snow on the ground: from the snow line down (snowAt, with
// noise for a ragged edge), settled on the faces that look up; the steep
// ones only dusted.
const SEASON_SNOW = /* glsl */ `
{
    vec2 nuv = vGroundUv * uNoiseScale;
    float jitter = ( texture2D( uNoise, nuv ).r - 0.5 ) * 0.9 + ( texture2D( uNoise, nuv * 4.0 ).b - 0.5 ) * 0.35;
    float face = 0.3 + 0.7 * smoothstep( 0.6, 0.86, upward( normal ) );
    float fallen = smoothstep( 0.2, 0.55, snowAt( vGroundY, jitter ) ) * face;
    diffuseColor.rgb = mix( diffuseColor.rgb, uSnowColor, fallen );
    lyingSnow = max( lyingSnow, fallen );
}
`;

// With shadows (graphics.js, Medium and High): grass stands up to a low sun,
// so a meadow catches more of its light than a bare, level face would, and
// the long shadows of dawn and dusk lie dark across a lit field. Blades
// standing across the face take the light that skims it: up to uGrassLight
// of it (0: a level face, as on Low), so only a low light (under some 25°
// on level ground) gains; behind the face's own horizon none.
const GRASS_LIGHT = /* glsl */ `
uniform float uGrassLight;
void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
    float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
    float skims = sqrt( 1.0 - dotNL * dotNL ) * smoothstep( 0.0, 0.12, dotNL );
    dotNL = max( dotNL, uGrassLight * skims );
    vec3 irradiance = dotNL * directLight.color;
    reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
`;

// Glints on the snow (the High setting, graphics.js: uGlint > 0): here and
// there a speck of it, struck by the direct light (none in shadow), flashes
// as the eye moves, bright enough for the bloom (post.js). Near only.
const GLINT = /* glsl */ `
if ( uGlint > 0.0 && lyingSnow > 0.05 ) {
    float near = 1.0 - smoothstep( 45.0, 130.0, length( vViewPosition ) );
    vec2 q = vGroundUv * uWorld / 0.2;
    vec2 cell = floor( q );
    float h = fract( sin( dot( cell, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
    float flash = fract( h * 13.7 + dot( normalize( vViewPosition ), vec3( 3.1, 5.3, 2.7 ) ) * 3.0 );
    float speck = 1.0 - smoothstep( 0.1, 0.35, length( q - cell - 0.5 ) );
    float lit = dot( reflectedLight.directDiffuse, vec3( 0.3, 0.55, 0.15 ) );
    outgoingLight += uSnowColor * ( step( 0.993, flash ) * speck * lyingSnow * near * lit * uGlint );
}
`;

// Ice on the lakes, from the shore out to the depth the winter has reached
// (uIce, 0..1 of 25 units): snowy near the shore, clear grey-blue further out.
const ICE_FRAGMENT = /* glsl */ `
{
    vec2 uv = vWaterXZ / uWorld;
    float depth = texture2D( uDepth, uv ).r;
    float n = texture2D( uNoise, uv * uNoiseScale ).g - 0.5;
    float ice = uIce > 0.001 ? smoothstep( uIce + 0.012, uIce - 0.012, depth + n * 0.07 ) : 0.0;
    vec3 iceColor = mix( uSnowColor, vec3( 0.2, 0.28, 0.34 ), smoothstep( 0.0, 0.4 * uIce + 0.01, depth + n * 0.04 ) * 0.85 );
    diffuseColor.rgb = mix( diffuseColor.rgb, iceColor, ice );
    diffuseColor.a = mix( diffuseColor.a, 0.97, ice );
}
`;

// Grass amount (0..255) → colour, as in the 2D view.
function grassPalette() {
    const lut = new Uint8Array(256 * 3);
    const [r0, g0, b0] = COLORS.bare;
    const [r1, g1, b1] = COLORS.lush;
    for (let i = 0; i < 256; i++) {
        const t = Math.pow(i / 255, 0.8);
        lut[i * 3] = Math.round(r0 + (r1 - r0) * t);
        lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * t);
        lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * t);
    }
    return lut;
}

// One copy of the world's ground, from the terrain's height nodes. The grid
// gets one extra row and column (copies of the first), so copies meet exactly.
function terrainGeometry(terrain) {
    const { cols, rows, cellW, cellH, height } = terrain;
    const nx = cols + 1;
    const nz = rows + 1;
    const position = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            const v = j * nx + i;
            position[v * 3] = i * cellW;
            position[v * 3 + 1] = height[(i % cols) + (j % rows) * cols];
            position[v * 3 + 2] = j * cellH;
            uv[v * 2] = i / cols;
            uv[v * 2 + 1] = j / rows;
        }
    }
    const index = new (nx * nz > 65535 ? Uint32Array : Uint16Array)(cols * rows * 6);
    let o = 0;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const a = j * nx + i;
            const b = a + 1;
            const c = a + nx;
            const d = c + 1;
            index[o++] = a; index[o++] = c; index[o++] = b; // counter-clockwise seen from above
            index[o++] = b; index[o++] = c; index[o++] = d;
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
}

function flatGeometry(width, height) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, width, 0, 0, 0, 0, height, width, 0, height], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    g.computeBoundingSphere();
    return g;
}

export class Ground {
    constructor(scene, gl) {
        this.scene = scene;
        this.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        this.material = new THREE.MeshLambertMaterial({ flatShading: true });
        const snow = new THREE.Color().setRGB(SNOW[0] / 255, SNOW[1] / 255, SNOW[2] / 255, THREE.SRGBColorSpace);
        const noise = new THREE.DataTexture(tileNoise(64), 64, 64, THREE.RGBAFormat, THREE.UnsignedByteType);
        noise.wrapS = THREE.RepeatWrapping;
        noise.wrapT = THREE.RepeatWrapping;
        noise.magFilter = THREE.LinearFilter;
        noise.minFilter = THREE.LinearMipmapLinearFilter;
        noise.generateMipmaps = true;
        noise.needsUpdate = true;
        // The noise tiles the world a whole number of times (so it wraps with it).
        this.season = { uNoise: { value: noise }, uNoiseScale: { value: new THREE.Vector2(1, 1) }, uSnowLine: SNOW_LINE, uSnowColor: SNOW_COLOR };
        // The graphics setting's: how bright the snow's glints are, and how
        // much more a low sun lights the grass (0: none, as on Low).
        this.glint = { value: 0 };
        this.grassLight = { value: 0 };
        this.material.onBeforeCompile = (shader) => {
            shader.uniforms.uSnow = { value: snow };
            Object.assign(shader.uniforms, this.season, { uGlint: this.glint, uGrassLight: this.grassLight, uWorld: this.ice.uWorld });
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec2 vGroundUv;\nvarying float vGroundY;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundUv = uv;\nvGroundY = position.y;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\nuniform vec3 uSnow;\nuniform sampler2D uNoise;\nuniform vec2 uNoiseScale;\nuniform float uGlint;\nuniform vec2 uWorld;\nvarying vec2 vGroundUv;\nvarying float vGroundY;\n${SNOW_GLSL}`)
                .replace('#include <lights_lambert_pars_fragment>', `#include <lights_lambert_pars_fragment>\n${GRASS_LIGHT}`)
                .replace('#include <map_fragment>', SNOW_FRAGMENT)
                .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SEASON_SNOW}`)
                .replace('#include <opaque_fragment>', `${GLINT}\n#include <opaque_fragment>`);
        };
        this.material.customProgramCacheKey = () => 'ground';
        this.tiles = [];
        this.geometry = null;
        this.texture = null;
        this.palette = grassPalette();
        // The water: a sheet at sea level, freezing at the edges in winter.
        this.ice = {
            uDepth: { value: null }, uIce: { value: 0 }, uWorld: { value: new THREE.Vector2(1, 1) },
            uOrigin: { value: new THREE.Vector2() }, uNoise: this.season.uNoise, uNoiseScale: this.season.uNoiseScale, uSnowColor: SNOW_COLOR,
        };
        const water = new THREE.MeshLambertMaterial({ color: WATER, transparent: true, opacity: 0.82, depthWrite: false });
        water.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.ice);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nuniform vec2 uOrigin;\nvarying vec2 vWaterXZ;')
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterXZ = ( modelMatrix * vec4( position, 1.0 ) ).xz + uOrigin;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nuniform sampler2D uDepth;\nuniform sampler2D uNoise;\nuniform vec2 uNoiseScale;\nuniform vec2 uWorld;\nuniform float uIce;\nuniform vec3 uSnowColor;\nvarying vec2 vWaterXZ;')
                .replace('#include <color_fragment>', `#include <color_fragment>\n${ICE_FRAGMENT}`);
        };
        water.customProgramCacheKey = () => 'water';
        this.water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), water);
        this.water.visible = false;
        this.water.frustumCulled = false;
        scene.add(this.water);
        this.lush = [...COLORS.lush]; // full grass's colour now (the season's)
    }

    attach(world, terrain) {
        const { cols, rows } = world.grass;
        this.cols = cols;
        this.rows = rows;
        this.blurA = new Float32Array(cols * rows);
        this.blurB = new Float32Array(cols * rows);
        this.pixels = new Uint8Array(cols * rows * 4);

        this.texture?.dispose();
        const tex = new THREE.DataTexture(this.pixels, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping; // the world wraps, so the grass blends across its edge
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter; // a soft meadow rather than squares
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = this.anisotropy;
        this.texture = tex;
        this.material.map = tex;
        this.material.needsUpdate = true;

        this.geometry?.dispose();
        this.geometry = terrain ? terrainGeometry(terrain) : flatGeometry(world.width, world.height);
        for (const t of this.tiles) t.geometry = this.geometry;

        this.bakeTerrain(world, terrain);
        this.bakeBiomes(terrain);
        this.water.visible = !!terrain;
        this.seaLevel = terrain ? terrain.seaLevel : 0;
        this.bakeSeasons(world, terrain);
        this.frame = 0;
        this.refresh(world);
    }

    // For the seasons, once per world: the snow line's scale (the sea to the
    // highest peak), the noise's tiling, and each patch's depth for the ice.
    bakeSeasons(world, terrain) {
        let top = this.seaLevel + 1;
        if (terrain) for (const h of terrain.height) if (h > top) top = h;
        SNOW_LINE.value.set(1.2, this.seaLevel, top, SNOW_FADE);
        this.season.uNoiseScale.value.set(Math.max(1, Math.round(world.width / 64)), Math.max(1, Math.round(world.height / 64)));
        this.ice.uWorld.value.set(world.width, world.height);
        const { cols, rows, depth } = this;
        const bytes = new Uint8Array(cols * rows);
        for (let k = 0; k < bytes.length; k++) bytes[k] = depth[k] > 0 ? Math.min(255, Math.round((depth[k] / 25) * 255)) : 0;
        this.ice.uDepth.value?.dispose();
        const tex = new THREE.DataTexture(bytes, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        this.ice.uDepth.value = tex;
    }

    // Per grass patch, once: how much rock shows (steep or high ground) and
    // how deep the water is (−1 on dry land). With biomes, the high ground's
    // rock and snow are biomes of their own, so only cliffs show rock here.
    bakeTerrain(world, terrain) {
        const n = this.cols * this.rows;
        this.rock = new Float32Array(n);
        this.depth = new Float32Array(n).fill(-1);
        if (!terrain) return;
        const { cellW, cellH } = world.grass;
        const W = world.width;
        const H = world.height;
        const at = (x, y) => terrain.heightAt(((x % W) + W) % W, ((y % H) + H) % H);
        let top = 0;
        for (const h of terrain.height) if (h > top) top = h;
        const sea = terrain.seaLevel;
        const high0 = sea + 0.62 * (top - sea);
        const high1 = sea + 0.9 * (top - sea);
        const d = Math.max(terrain.cellW, terrain.cellH);
        const byHeight = !terrain.biomeGrid;
        for (let j = 0; j < this.rows; j++) {
            for (let i = 0; i < this.cols; i++) {
                const k = j * this.cols + i;
                const x = (i + 0.5) * cellW;
                const y = (j + 0.5) * cellH;
                const h = at(x, y);
                if (h < sea) {
                    this.depth[k] = sea - h;
                    continue;
                }
                const sx = (at(x + d, y) - at(x - d, y)) / (2 * d);
                const sy = (at(x, y + d) - at(x, y - d)) / (2 * d);
                const slope = Math.sqrt(sx * sx + sy * sy); // rise per unit run
                this.rock[k] = 0.7 * Math.max(smoothstep(0.55, 1.1, slope), byHeight ? smoothstep(high0, high1, h) : 0);
            }
        }
    }

    // With biomes, per grass patch, once: the colour of its bare ground (with
    // the cliffs' rock) in `base`, how far full grass moves it toward lush
    // green in `diff` (less under the forest canopy), the tree cover in `cover`
    // (0..1, for the trees and tufts), and the snow in the texture's alpha.
    bakeBiomes(terrain) {
        this.base = null;
        this.diff = null;
        this.cover = null;
        if (!terrain || !terrain.biomeGrid) return;
        const { cols, rows, rock, depth, pixels: px } = this;
        const n = cols * rows;
        const looks = terrain.biomes.map(biomeLook);
        const water = new Uint8Array(n);
        // Bare ground (r, g, b), trees and snow, per land patch.
        const look = new Float32Array(n * 5);
        for (let k = 0; k < n; k++) {
            if (depth[k] >= 0) {
                water[k] = 1;
                continue;
            }
            const L = looks[terrain.biomeGrid[k]];
            look.set(L.ground, k * 5);
            look[k * 5 + 3] = L.trees;
            look[k * 5 + 4] = L.snow ? 1 : 0;
        }
        // Biomes are decided patch by patch, so their borders run along the
        // patch grid in steps. Two passes of a 3×3 blur over the land (water
        // keeps out of it, as in 2D) round them off into soft margins.
        blurGrid(look, 5, cols, rows, water);
        blurGrid(look, 5, cols, rows, water);

        const base = new Float32Array(n * 3);
        const diff = new Float32Array(n * 3);
        const cover = new Float32Array(n);
        const shows = new Float32Array(n);
        const lush = COLORS.lush;
        for (let k = 0; k < n; k++) {
            const q = k * 3;
            if (water[k]) {
                const t = Math.min(1, depth[k] / 25);
                for (let c = 0; c < 3; c++) base[q + c] = SHORE[c] + (DEEP[c] - SHORE[c]) * t;
                px[k * 4 + 3] = 255;
                continue;
            }
            const s = rock[k];
            cover[k] = look[k * 5 + 3];
            const show = (1 - CANOPY * cover[k]) * (1 - s);
            shows[k] = show;
            for (let c = 0; c < 3; c++) {
                const bare = look[k * 5 + c];
                base[q + c] = bare + (ROCK[c] - bare) * s;
                diff[q + c] = (lush[c] - bare) * show;
            }
            // Snow does not lie on the steepest faces: rock shows through.
            const snow = look[k * 5 + 4] * (1 - 0.8 * smoothstep(0.2, 0.5, s));
            px[k * 4 + 3] = Math.round(255 * (1 - snow));
        }
        this.base = base;
        this.diff = diff;
        this.cover = cover;
        this.shows = shows;
    }

    // Each patch is grazed on its own, so the raw field is speckled. A 3×3 box
    // blur (wrapping, like the world) turns it into a soft meadow, as in 2D.
    soften(g) {
        const { cols, rows, blurA: a, blurB: b } = this;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                const l = x === 0 ? cols - 1 : x - 1;
                const r = x === cols - 1 ? 0 : x + 1;
                a[row + x] = (g[row + l] + g[row + x] + g[row + r]) / 3;
            }
        }
        for (let y = 0; y < rows; y++) {
            const up = (y === 0 ? rows - 1 : y - 1) * cols;
            const down = (y === rows - 1 ? 0 : y + 1) * cols;
            const row = y * cols;
            for (let x = 0; x < cols; x++) b[row + x] = (a[up + x] + a[row + x] + a[down + x]) / 3;
        }
        return b;
    }

    refresh(world) {
        const g = this.soften(world.grass.g);
        const { pixels: px, palette: lut, rock, depth } = this;
        if (this.base !== null) {
            // Biomes: bare ground plus grass, one multiply-add per channel,
            // and one more for the season's colour of the grass (sx, sy, sz:
            // how far it is from summer's, where the grass shows).
            // (Water has no grass to add; the alpha, snow, was set once.)
            const { base, diff, shows } = this;
            const L = COLORS.lush;
            const sx = this.lush[0] - L[0];
            const sy = this.lush[1] - L[1];
            const sz = this.lush[2] - L[2];
            for (let k = 0, n = g.length; k < n; k++) {
                const t = GREEN[Math.min(255, (g[k] * 255) | 0)];
                const q = k * 3;
                const o = k * 4;
                const st = shows[k] * t;
                px[o] = base[q] + diff[q] * t + sx * st;
                px[o + 1] = base[q + 1] + diff[q + 1] * t + sy * st;
                px[o + 2] = base[q + 2] + diff[q + 2] * t + sz * st;
            }
            this.texture.needsUpdate = true;
            return;
        }
        for (let k = 0, n = g.length; k < n; k++) {
            let r, gr, b;
            if (depth[k] >= 0) {
                const t = Math.min(1, depth[k] / 25);
                r = SHORE[0] + (DEEP[0] - SHORE[0]) * t;
                gr = SHORE[1] + (DEEP[1] - SHORE[1]) * t;
                b = SHORE[2] + (DEEP[2] - SHORE[2]) * t;
            } else {
                const c = Math.min(255, (g[k] * 255) | 0) * 3;
                r = lut[c];
                gr = lut[c + 1];
                b = lut[c + 2];
                const s = rock[k];
                if (s > 0) {
                    r += (ROCK[0] - r) * s;
                    gr += (ROCK[1] - gr) * s;
                    b += (ROCK[2] - b) * s;
                }
            }
            const o = k * 4;
            px[o] = r;
            px[o + 1] = gr;
            px[o + 2] = b;
            px[o + 3] = 255;
        }
        this.texture.needsUpdate = true;
    }

    // Each frame: the season (almanac.js seasonLook): the grass's colour, the
    // snow line, the ice; the texture is refreshed every few frames.
    update(world, look) {
        this.lush = look.lush;
        SNOW_LINE.value.x = look.line;
        this.ice.uIce.value = look.ice;
        if (++this.frame % REFRESH === 0) this.refresh(world);
    }

    tile(n) {
        if (!this.tiles[n]) {
            const t = new THREE.Mesh(this.geometry, this.material);
            this.scene.add(t);
            this.tiles[n] = t;
        }
        return this.tiles[n];
    }

    // Lay out the copies of the world that the camera can see. Copy (kx, kz)
    // starts at world (kx·W, kz·H), which is kx·W − fx from the floating origin.
    place(view) {
        const { W, H, fx, fz } = view;
        const kx0 = Math.floor((view.minX + fx) / W);
        const kx1 = Math.floor((view.maxX + fx) / W);
        const kz0 = Math.floor((view.minZ + fz) / H);
        const kz1 = Math.floor((view.maxZ + fz) / H);
        let n = 0;
        for (let kx = kx0; kx <= kx1; kx++) {
            for (let kz = kz0; kz <= kz1 && n < MAX_TILES; kz++) {
                const t = this.tile(n++);
                t.position.set(kx * W - fx, 0, kz * H - fz);
                t.visible = true;
            }
        }
        for (let i = n; i < this.tiles.length; i++) this.tiles[i].visible = false;
        this.tileCount = n;

        if (this.water.visible) {
            this.water.position.set((view.minX + view.maxX) / 2, this.seaLevel, (view.minZ + view.maxZ) / 2);
            this.water.scale.set(view.maxX - view.minX, 1, view.maxZ - view.minZ);
            this.ice.uOrigin.value.set(fx, fz);
        }
    }
}
