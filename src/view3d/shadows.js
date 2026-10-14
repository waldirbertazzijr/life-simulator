// Shadows (graphics.js: Medium and High): the sky's light casts them, the
// sun's by day and, faintly, the moon's by night (sky.js has one light, which
// is the one or the other).
//
// One shadow map, drawn each frame, follows the view:
// - It covers a disc of ground ahead of the camera (`region`), sized so that
//   all the view shows out to SHADOW_REACH (in the map view, a share of its
//   distance) lies inside; past that, and toward the disc's rim, the shadows
//   fade out (the patch below), so where the map ends nothing shows. Zoomed
//   out over the map the disc is the whole view and the map coarse: the
//   mountains', the forests' and the camps' shadows still read, and the
//   creatures (drawn larger than life there) stop casting.
// - Seen from the light it is a box: as wide as the disc across the light,
//   and along it as long as the disc's shadow-side slope needs (a low sun
//   sees the ground at a slant: the map's texels stay about square on it).
//   It reaches back toward the light far enough for the hills and the trees
//   beyond the disc to cast into it.
// - Its corner is snapped to the map's texels, in the world's coordinates
//   (the floating origin moves with the camera), so the shadows of what
//   stands still do not crawl as the camera moves.
// - How dark the shadows are: graphics.js shadowStrength. While they are
//   none (night without a moon, deep cloud) the map is not drawn at all.
//
// Who casts and who receives is decided here, by material (castsOf), for
// whatever the scene holds now (meshes come and go as herds grow):
// - lit (Lambert), opaque, whose shape is three.js's own: both (the ground,
//   the items, the camps' racks and piles, spears, droplets);
// - a shape moved by its own vertex shader casts only with a twin that moves
//   it the same way for the shadow map (`userData.depth`, depthTwin): the
//   creatures (people with their hair, animate.js) and the trees (forest.js);
//   without one it only receives (tufts, flowers, lilies, frogs);
// - see-through (water, blood pools): receive; the flags (unlit, sky-lit):
//   cast; the rest (the sky, sparks, glows, markers): neither.
// Shadows are soft-edged: PCF over a bilinear 3×3 (three.js PCFSoftShadowMap).
import * as THREE from 'three';
import { PRESETS, shadowStrength } from './graphics.js';
import { DEG, clamp } from './util.js';

// ---- The fade (patched into three.js's chunks before anything compiles) ----

// The disc the map covers, in view space: its middle (x, y, z) and radius
// (w); and the world's up, in view space. Shared by every lit material, as
// haze.js shares its numbers (plain objects, kept by reference).
export const SHADOW = {
    disc: { x: 0, y: 0, z: 0, w: 1e9 },
    up: { x: 0, y: 1, z: 0 },
};
const FADE_FROM = 0.78; // of the disc's radius: the shadows fade out from here to its rim

const C = THREE.ShaderChunk;
const INTENSITY = 'directionalLightShadow.shadowIntensity,';
if (!C.lights_fragment_begin.includes(INTENSITY)) console.warn('shadows.js: three.js\'s lights chunk has changed; shadows will not fade out');
C.lights_fragment_begin = C.lights_fragment_begin.replace(INTENSITY, 'directionalLightShadow.shadowIntensity * shadowFar( geometryPosition ),');
C.shadowmap_pars_fragment = `${C.shadowmap_pars_fragment}
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    uniform vec4 shadowDisc;
    uniform vec3 shadowUp;
    // 1 inside the disc the shadow map covers, fading to 0 at its rim
    // (measured along the ground: the disc's height is the light's business).
    float shadowFar( vec3 p ) {
        vec3 d = p - shadowDisc.xyz;
        d -= shadowUp * dot( d, shadowUp );
        return 1.0 - smoothstep( ${FADE_FROM} * shadowDisc.w, shadowDisc.w, length( d ) );
    }
#endif`;
for (const shader of Object.values(THREE.ShaderLib)) {
    if (!shader.uniforms?.directionalShadowMap) continue;
    shader.uniforms.shadowDisc = { value: SHADOW.disc };
    shader.uniforms.shadowUp = { value: SHADOW.up };
}

// A shadow-map twin for a material whose vertex shader moves its shape:
// a depth material with the same `defines` and the same vertex code
// (`patch`, an onBeforeCompile). Set as the material's userData.depth, it
// is given to every mesh drawn with it (castsOf).
export function depthTwin(material, key, patch) {
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.defines = { ...material.defines };
    depth.onBeforeCompile = patch;
    depth.customProgramCacheKey = () => key;
    material.userData.depth = depth;
    return material;
}

// ---- Who casts ----

// Materials whose own shader leaves the shape as three.js's: they cast with
// three.js's plain depth material.
const PLAIN_SHAPE = new Set(['ground', 'items']);
// Drawn larger than life far over the map (creatures.js, items.js): they
// stop casting there.
const GROWN = /^(creature|items)/;
const NONE = Object.freeze({ cast: false, receive: false, grown: false, depth: undefined });

function castsOf(material) {
    if (!material || Array.isArray(material)) return NONE;
    const key = material.customProgramCacheKey();
    const depth = material.userData.depth;
    const grown = GROWN.test(key);
    if (material.isMeshLambertMaterial) {
        if (material.transparent) return { ...NONE, receive: true };
        const plain = material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile || PLAIN_SHAPE.has(key);
        return { cast: plain || !!depth, receive: true, grown, depth };
    }
    if (material.isMeshBasicMaterial && material.defines?.SKY_LIT !== undefined && !material.transparent) return { ...NONE, cast: true };
    return NONE;
}

// ---- The fit ----

const SHADOW_REACH = { near: 150, perDist: 1.6, base: 110 }; // how far the shadows reach: base + perDist × the camera's distance, at least `near`
const MAX_RADIUS = 2400;    // the disc's largest radius (the map zoomed out over the whole world)
const GROWN_FROM = 300;     // the map's distance beyond which creatures and what they hold cast none
const STANDING = 45;        // how high what casts stands above its ground (the trees, with the map's growth)
const TREES_REACH = 320;    // how far toward a low sun trees beyond the disc may stand and still cast into it
const HILLS = 160;          // how high the land rises above the disc (the highest peak, and its trees)
const BACK_MAX = 3000;      // the furthest the map reaches back toward a low light for them

export class Shadows {
    constructor(gl, scene, light) {
        this.gl = gl;
        this.scene = scene;
        this.light = light;
        scene.add(light.target); // (so its place is updated with the scene's)
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.shadowMap.autoUpdate = false; // drawn when there is something to show (update)
        this.size = 0;
        this.version = 0;
        this.roles = new WeakMap(); // material → castsOf
        this.grown = true;          // whether creatures cast now
        this.strength = 0;
        this.by = 'sun';
        // The ground (render coordinates) whose trees may cast into the map:
        // forest.js draws those too.
        this.box = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
        this.dir = new THREE.Vector3();
        this.center = new THREE.Vector3();
        this.v = new THREE.Vector3();
        this.ax = new THREE.Vector3();
        this.ay = new THREE.Vector3();
        this.stats = { size: 0, radius: 0, texel: 0, strength: 0, drawn: false };
    }

    get on() {
        return this.size > 0;
    }

    // The graphics setting (graphics.js PRESETS): the map's size, or none.
    set(quality) {
        const size = PRESETS[quality].shadowMap;
        const light = this.light;
        if (size !== this.size) {
            light.shadow.map?.dispose();
            light.shadow.map = null;
            if (size) light.shadow.mapSize.set(size, size);
        }
        this.size = size;
        this.stats.size = size;
        this.gl.shadowMap.enabled = size > 0;
        light.castShadow = size > 0;
        if (!size) light.target.position.set(0, 0, 0); // (sky.js aims the light from the origin)
        this.version++;
        this.flag();
    }

    // Who casts and receives, on whatever has not been told since the last
    // change (each frame: herds and pools add meshes as they grow).
    flag() {
        const on = this.size > 0;
        for (const obj of this.scene.children) {
            if (!obj.isMesh) continue;
            let role = this.roles.get(obj.material);
            if (role === undefined) {
                role = castsOf(obj.material);
                if (obj.material) this.roles.set(obj.material, role);
            }
            const cast = on && role.cast && (this.grown || !role.grown);
            if (obj.castShadow !== cast) obj.castShadow = cast;
            if (obj.userData.shadows !== this.version) {
                obj.userData.shadows = this.version;
                obj.receiveShadow = on && role.receive; // (a change recompiles: only with the setting)
                if (role.depth) obj.customDepthMaterial = role.depth;
            }
        }
    }

    // Each frame, after the sky (sky.js has aimed its light: a unit vector
    // toward the sun or the moon) and before drawing. `view`, `camera`: the
    // rig's (camera.js); `d`: the sky's daylight; `sunAlt`, `overcast`: the
    // moment's; `fy`: the height the camera looks at.
    update(view, camera, d, sunAlt, overcast, fy) {
        const s = this.stats;
        if (!this.size) {
            s.drawn = false;
            return;
        }
        const { strength, by } = shadowStrength(d, sunAlt, overcast);
        this.strength = strength;
        this.by = by;
        const light = this.light;
        light.shadow.intensity = strength;
        this.grown = !(view.mapness > 0.5 && view.dist > GROWN_FROM);
        this.flag();
        s.strength = +strength.toFixed(3);
        s.drawn = strength > 0.004;
        this.gl.shadowMap.needsUpdate = s.drawn;
        if (!s.drawn) return;

        // The disc: all the view shows out to `reach` lies inside it, its
        // middle ahead of the camera along the ground (camera.js keeps what
        // it looks at at the origin).
        const reach = Math.max(SHADOW_REACH.near, SHADOW_REACH.base + SHADOW_REACH.perDist * view.dist);
        const t = Math.tan((camera.fov * DEG) / 2);
        const cosA = 1 / Math.sqrt(1 + t * t * (1 + camera.aspect * camera.aspect)); // the view's widest half-angle
        // With its middle 0.9 of the radius ahead, the disc takes in the view
        // to `reach` at that half-angle when reach = radius × k.
        const k = (1.8 * cosA + Math.sqrt(3.24 * cosA * cosA + 0.76)) / 2;
        const R = Math.min(reach / k, MAX_RADIUS);
        let ahead = Math.hypot(view.camX, view.camZ);
        const fx = ahead > 1e-6 ? -view.camX / ahead : 0;
        const fz = ahead > 1e-6 ? -view.camZ / ahead : 0;
        ahead = 0.9 * R;
        const c = this.center.set(view.camX + fx * ahead, fy, view.camZ + fz * ahead);

        // The light's frame: z toward it, x level across it, y up its slope.
        const L = this.dir.copy(light.position).normalize();
        const sinAlt = clamp(L.y, 0.02, 1);
        const cosAlt = Math.sqrt(1 - sinAlt * sinAlt);
        const ax = this.ax.set(L.z, 0, -L.x);
        if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0);
        ax.normalize();
        const ay = this.ay.crossVectors(L, ax);
        const Ry = R * sinAlt + STANDING * cosAlt + 10;
        const size = this.size;
        const tx = (2 * R) / size;
        const ty = (2 * Ry) / size;
        // Snap the middle to the texels, in world coordinates.
        const wx = c.x + view.fx;
        const wz = c.z + view.fz;
        const u = ax.x * wx + ax.z * wz;           // (ax is level)
        const w = ay.x * wx + ay.y * c.y + ay.z * wz;
        c.addScaledVector(ax, Math.round(u / tx) * tx - u).addScaledVector(ay, Math.round(w / ty) * ty - w);

        // Back toward the light, far enough for the hills beyond.
        const back = Math.min(BACK_MAX, HILLS / sinAlt) + R + STANDING;
        light.target.position.copy(c);
        light.position.copy(c).addScaledVector(L, back);
        const cam = light.shadow.camera;
        cam.left = -R;
        cam.right = R;
        cam.bottom = -Ry;
        cam.top = Ry;
        cam.near = 1;
        cam.far = back + R * cosAlt + STANDING + 40;
        cam.updateProjectionMatrix();
        const depth = cam.far - cam.near;
        light.shadow.bias = -0.08 / depth;
        light.shadow.normalBias = 0.7 * Math.max(tx, ty * sinAlt);

        // The fade, in view space.
        const m = camera.matrixWorldInverse;
        const cv = this.v.copy(this.center).applyMatrix4(m);
        Object.assign(SHADOW.disc, { x: cv.x, y: cv.y, z: cv.z, w: R });
        const e = m.elements;
        Object.assign(SHADOW.up, { x: e[4], y: e[5], z: e[6] });

        // The trees that may cast into it: the disc, and as far toward a low
        // light as tall trees' shadows reach.
        const lh = Math.hypot(L.x, L.z) || 1;
        const shift = Math.min(TREES_REACH, STANDING * (cosAlt / sinAlt));
        const sx = (L.x / lh) * shift;
        const sz = (L.z / lh) * shift;
        const b = this.box;
        b.minX = Math.min(c.x, c.x + sx) - R;
        b.maxX = Math.max(c.x, c.x + sx) + R;
        b.minZ = Math.min(c.z, c.z + sz) - R;
        b.maxZ = Math.max(c.z, c.z + sz) + R;

        s.radius = Math.round(R);
        s.texel = +tx.toFixed(3);
    }
}
