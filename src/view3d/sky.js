// The sky over the 3D view, and the light it gives: the dome (its colours by
// the sun's height, the sun's disc and glow, the moon in its phase, the Milky
// Way, now and then a shooting star), the stars, the sun's (or the moon's)
// light and the sky's, and the haze (haze.js), all from the moment drawn
// (almanac.js) and its colours (daylight.js).
//
// Directions: the sun rises in the east (+x, world), stands in the north
// (−y, up the map) at noon, as it does south of the equator, and sets in the
// west; so on the map, as before, the light comes from its top. three.js
// has world x as X and y as Z.
//
// The stars turn once a day (a little more: the year turns too) about the
// south celestial pole, POLE degrees above the southern horizon. They are a
// cloud of points on a sphere around the camera, behind the land (depth
// tested) and over the dome; the dome paints the Milky Way in the same
// turning frame, and hides the stars behind the moon and the sun.
import * as THREE from 'three';
import { HAZE } from './haze.js';
import { daylight } from './daylight.js';
import { moonOf } from './almanac.js';
import { DEG, TAU, smoothstep } from './util.js';

const STARS = 2600;
const POLE = 26;           // degrees: the celestial pole's height above the south
const SUN_R = 1.5 * DEG;   // the discs' angular radii (drawn larger than life)
const MOON_R = 1.9 * DEG;
const SHOOT_EVERY = [6, 22]; // seconds between shooting stars, at random in this range (dark nights)
const SHOOT_FOR = [0.45, 0.9]; // how long one lasts

// sRGB 0..255 → a linear THREE.Color (in place), times k.
const lin = (c, rgb, k = 1) => c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace).multiplyScalar(k);

// The direction of something at altitude `alt`, bearing `az` (0 east, π/2
// north, π west), as a three.js vector.
function toward(alt, az, v) {
    const c = Math.cos(alt);
    return v.set(c * Math.cos(az), Math.sin(alt), -c * Math.sin(az));
}

// The dome is drawn after the land, at the far end of the view (z = w),
// so only the pixels where the sky shows are painted.
const DOME_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = position;
    gl_Position = ( projectionMatrix * modelViewMatrix * vec4( position, 1.0 ) ).xyww;
}`;

// The Milky Way, worked out once into a small picture of the stars' sphere
// (longitude across, latitude down): a soft band, clumped, brighter toward
// its heart (red: how bright; green: how near the heart), split by a dark
// lane. The dome reads it in the stars' turning frame.
const MILKY = { w: 512, h: 256 };
function milkyWay() {
    const hash = (x, y, z) => {
        let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
        h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
        h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
        return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
    };
    const fade = (t) => t * t * (3 - 2 * t);
    const noise = (x, y, z) => {
        const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
        const u = fade(x - i), v = fade(y - j), w = fade(z - k);
        const l = (a, b, t) => a + (b - a) * t;
        return l(
            l(l(hash(i, j, k), hash(i + 1, j, k), u), l(hash(i, j + 1, k), hash(i + 1, j + 1, k), u), v),
            l(l(hash(i, j, k + 1), hash(i + 1, j, k + 1), u), l(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), u), v), w);
    };
    const G = new THREE.Vector3(0.32, 0.55, 0.77).normalize();
    const C = new THREE.Vector3(0.85, -0.45, 0.2).normalize();
    const out = new Uint8Array(MILKY.w * MILKY.h * 4);
    for (let y = 0; y < MILKY.h; y++) {
        const lat = ((y + 0.5) / MILKY.h - 0.5) * Math.PI;
        for (let x = 0; x < MILKY.w; x++) {
            const lon = ((x + 0.5) / MILKY.w - 0.5) * TAU;
            const cx = Math.cos(lat) * Math.cos(lon);
            const cy = Math.sin(lat);
            const cz = Math.cos(lat) * Math.sin(lon);
            const g = cx * G.x + cy * G.y + cz * G.z + 0.05 * (noise(cx * 3, cy * 3, cz * 3) - 0.5);
            if (Math.abs(g) > 0.4) continue;
            const n = noise(cx * 7, cy * 7, cz * 7) * 0.55 + noise(cx * 17, cy * 17, cz * 17) * 0.3 + noise(cx * 41, cy * 41, cz * 41) * 0.15;
            const heart = Math.max(cx * C.x + cy * C.y + cz * C.z, 0) ** 3;
            let milky = Math.exp((-g * g) / 0.012) * smoothstep(0.25, 0.85, n) * (0.55 + 1.6 * heart);
            milky *= 1 - 0.8 * Math.exp(-((g - 0.015) ** 2) / 0.0012) * smoothstep(0.3, 0.65, noise(cx * 9 + 3, cy * 9 + 3, cz * 9 + 3));
            const o = (y * MILKY.w + x) * 4;
            out[o] = Math.min(255, Math.round((milky / 2.2) * 255));
            out[o + 1] = Math.round(heart * 255);
        }
    }
    const tex = new THREE.DataTexture(out, MILKY.w, MILKY.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter; // (no mipmaps: the longitude's seam would show)
    tex.needsUpdate = true;
    return tex;
}

const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uHalo;
uniform vec3 uDisc;
uniform vec4 uSun;       // its direction, and how much of its disc shows
uniform vec2 uSunFlat;   // its bearing on the ground (unit)
uniform float uGlowPow;
uniform vec4 uMoon;      // its direction, and how much it shows (0..1)
uniform vec3 uMoonU;     // across its disc, toward the sun
uniform vec3 uMoonV;
uniform vec3 uMoonLight; // the lit side's colour
uniform vec3 uMoonGlow;
uniform float uMoonPhase; // the sun's angle from the moon: 0 new .. pi full
uniform mat3 uStarSky;   // the stars' frame → the world
uniform float uMilky;
uniform sampler2D uMilkyWay;
uniform vec4 uShootA;    // a shooting star: from, and how far along (-1: none)
uniform vec4 uShootB;    // to, and how bright
varying vec3 vDir;

float h31( vec3 p ) {
    p = fract( p * 0.3183099 + 0.1 );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float noise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( h31( i ), h31( i + vec3( 1, 0, 0 ) ), f.x ), mix( h31( i + vec3( 0, 1, 0 ) ), h31( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( h31( i + vec3( 0, 0, 1 ) ), h31( i + vec3( 1, 0, 1 ) ), f.x ), mix( h31( i + vec3( 0, 1, 1 ) ), h31( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}

void main() {
    vec3 d = normalize( vDir );
    float up = d.y;
    float h = max( up, 0.0 );
    // The gradient: blue quickly over the first few degrees, then slowly.
    vec3 col = mix( uHorizon, uZenith, 1.0 - pow( 1.0 - h, 2.5 ) );
    float across = length( d.xz );
    float toward = across > 1e-5 ? max( dot( d.xz / across, uSunFlat ), 0.0 ) : 0.0;
    float band = pow( toward, uGlowPow );
    // The glow where the sun is (or was): on the horizon as the haze has it,
    // spreading up the sky; a halo close about it.
    col += uGlow * band * exp( -h * 4.5 );
    float cs = dot( d, uSun.xyz );
    col += uHalo * ( pow( max( cs, 0.0 ), 10.0 ) * 0.5 + pow( max( cs, 0.0 ), 220.0 ) * 1.5 );
    // Below the horizon: the haze, exactly (the land melts into it).
    if ( up < 0.0 ) col = uHorizon + uGlow * band;
    vec3 base = col;

    // The Milky Way (milkyWay()), in the stars' turning frame.
    if ( uMilky > 0.0 && up > -0.05 ) {
        vec3 c = d * uStarSky;
        vec2 uv = vec2( atan( c.z, c.x ) / 6.2831853 + 0.5, asin( clamp( c.y, -1.0, 1.0 ) ) / 3.1415927 + 0.5 );
        vec4 mw = texture2D( uMilkyWay, uv );
        col += mix( vec3( 0.040, 0.046, 0.066 ), vec3( 0.062, 0.052, 0.046 ), mw.g ) * mw.r * 2.2 * uMilky * smoothstep( -0.02, 0.3, up );
    }

    // The sun's disc.
    col += uDisc * smoothstep( cos( ${(SUN_R * 1.15).toFixed(5)} ), cos( ${SUN_R.toFixed(5)} ), cs ) * uSun.w;

    // The moon: a sphere lit from the sun's side, the dark part hiding what is behind.
    if ( uMoon.w > 0.0 ) {
        float cm = dot( d, uMoon.xyz );
        col += uMoonGlow * ( pow( max( cm, 0.0 ), 900.0 ) * 0.6 + pow( max( cm, 0.0 ), 60.0 ) * 0.15 ) * uMoon.w;
        if ( cm > 0.99 ) {
            float r = sin( ${MOON_R.toFixed(5)} );
            vec2 p = vec2( dot( d, uMoonU ), dot( d, uMoonV ) ) / r;
            float rr = dot( p, p );
            if ( rr < 1.0 ) {
                float disc = smoothstep( 1.0, 0.9, rr ) * uMoon.w;
                vec3 n = vec3( p, sqrt( 1.0 - rr ) );
                vec3 L = vec3( sin( uMoonPhase ), 0.0, -cos( uMoonPhase ) );
                float lit = smoothstep( -0.04, 0.1, dot( n, L ) );
                // Grey seas on the face.
                float sea = smoothstep( 0.45, 0.7, noise( vec3( p * 2.6, 7.0 ) ) );
                col = mix( col, base * 0.92, disc );
                col = mix( col, uMoonLight * ( 1.0 - 0.22 * sea ), disc * lit );
            }
        }
    }

    // A shooting star: a short streak along a great circle, brightest at its head.
    if ( uShootA.w >= 0.0 ) {
        vec3 a = uShootA.xyz;
        vec3 nrm = normalize( cross( a, uShootB.xyz ) );
        float off = dot( d, nrm );
        if ( abs( off ) < 0.008 ) {
            vec3 q = normalize( d - nrm * off );
            float total = acos( clamp( dot( a, uShootB.xyz ), -1.0, 1.0 ) );
            float s = atan( dot( q, cross( nrm, a ) ), dot( q, a ) ) / total;
            float head = uShootA.w;
            float streak = smoothstep( head - 0.3, head, s ) * step( s, head ) * step( 0.0, s );
            col += vec3( 1.0, 0.97, 0.9 ) * streak * exp( -off * off / 0.0000035 ) * uShootB.w;
        }
    }
    gl_FragColor = vec4( col, 1.0 );
    #include <colorspace_fragment>
}`;

const STAR_VERTEX = /* glsl */ `
attribute float mag;
attribute vec3 tint;
uniform mat3 uStarSky;
uniform float uShow;
uniform float uTime;
uniform float uPx;
uniform vec4 uMoon;
uniform vec4 uSun;
varying vec3 vColor;
void main() {
    vec3 d = uStarSky * position;
    // Twinkling, each star at its own pace; fainter near the horizon; none
    // behind the moon or the sun.
    float tw = 0.78 + 0.22 * sin( uTime * ( 1.3 + 3.1 * fract( mag * 91.7 ) ) + mag * 437.0 );
    float k = uShow * mag * tw * smoothstep( -0.02, 0.22, d.y );
    if ( dot( d, uMoon.xyz ) > 0.9993 && uMoon.w > 0.0 ) k = 0.0;
    if ( dot( d, uSun.xyz ) > 0.9995 ) k = 0.0;
    vColor = tint * k;
    gl_PointSize = ( 1.0 + 3.4 * mag * mag * mag ) * uPx * step( 0.004, k );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( d, 1.0 );
}`;

const STAR_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot( p, p );
    if ( r > 1.0 ) discard;
    gl_FragColor = vec4( vColor * ( 1.0 - r * r ), 1.0 );
    #include <colorspace_fragment>
}`;

// The stars: on a unit sphere, a third of them crowded toward the Milky
// Way's band; a few bright, most faint; white, some bluish, some warm.
function starGeometry() {
    let s = 0x9e3779b9;
    const rnd = () => {
        s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d);
        s = Math.imul(s ^ (s >>> 12), 0x297a2d39);
        return ((s ^= s >>> 15) >>> 0) / 4294967296;
    };
    const G = new THREE.Vector3(0.32, 0.55, 0.77).normalize();
    const pos = new Float32Array(STARS * 3);
    const mag = new Float32Array(STARS);
    const tint = new Float32Array(STARS * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < STARS; i++) {
        do {
            const z = rnd() * 2 - 1;
            const a = rnd() * TAU;
            const r = Math.sqrt(1 - z * z);
            v.set(r * Math.cos(a), z, r * Math.sin(a));
            if (i % 3 === 0) v.addScaledVector(G, -v.dot(G) * (0.85 + 0.1 * rnd())).normalize(); // toward the band
        } while (!Number.isFinite(v.x));
        pos.set([v.x, v.y, v.z], i * 3);
        mag[i] = 0.12 + 0.88 * rnd() ** 3.2;
        const t = rnd();
        const c = t < 0.2 ? [0.78, 0.86, 1.0] : t > 0.85 ? [1.0, 0.86, 0.68] : [0.95, 0.95, 0.92];
        tint.set(c.map((x) => x * 0.9), i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    return g;
}

export class Sky {
    constructor(scene) {
        this.u = {
            uZenith: { value: new THREE.Color() },
            uHorizon: { value: new THREE.Color() },
            uGlow: { value: new THREE.Color() },
            uHalo: { value: new THREE.Color() },
            uDisc: { value: new THREE.Color() },
            uSun: { value: new THREE.Vector4(0, 1, 0, 1) },
            uSunFlat: { value: new THREE.Vector2(0, -1) },
            uGlowPow: { value: 4 },
            uMoon: { value: new THREE.Vector4(0, -1, 0, 0) },
            uMoonU: { value: new THREE.Vector3(1, 0, 0) },
            uMoonV: { value: new THREE.Vector3(0, 1, 0) },
            uMoonLight: { value: new THREE.Color() },
            uMoonGlow: { value: new THREE.Color() },
            uMoonPhase: { value: 0 },
            uStarSky: { value: new THREE.Matrix3() },
            uMilky: { value: 0 },
            uMilkyWay: { value: milkyWay() },
            uShootA: { value: new THREE.Vector4(0, 1, 0, -1) },
            uShootB: { value: new THREE.Vector4(1, 0, 0, 0) },
        };
        this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
            uniforms: this.u, vertexShader: DOME_VERTEX, fragmentShader: DOME_FRAGMENT,
            side: THREE.BackSide, depthWrite: false,
        }));
        this.dome.renderOrder = 1e6; // (after the land: DOME_VERTEX)
        this.dome.frustumCulled = false;
        this.starU = {
            uStarSky: this.u.uStarSky, uMoon: this.u.uMoon, uSun: this.u.uSun,
            uShow: { value: 0 }, uTime: { value: 0 }, uPx: { value: 1 },
        };
        this.stars = new THREE.Points(starGeometry(), new THREE.ShaderMaterial({
            uniforms: this.starU, vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.stars.frustumCulled = false;
        // The lights: the sky's (hemisphere) and the sun's or the moon's.
        this.ambient = new THREE.HemisphereLight('#e0e9f0', '#6a6c5a', 2.6);
        this.light = new THREE.DirectionalLight('#fff6ea', 3.0);
        scene.add(this.ambient, this.light, this.dome, this.stars);
        this.sunDir = new THREE.Vector3();
        this.moonDir = new THREE.Vector3();
        this.axis = new THREE.Vector3(0, Math.sin(POLE * DEG), Math.cos(POLE * DEG));
        this.turn = new THREE.Matrix4();
        this.c = new THREE.Color();
        this.shoot = { at: -1, next: 4, length: 0.6 };
        this.lastNow = 0;
        this.now = null; // the latest daylight() (for the fog, the weather and the checks)
    }

    // Each frame: `w` is when()'s moment (almanac.js clockOf), `cal` the
    // calendar (world.p.calendar), `overcast` the weather's, `view` the
    // camera rig's, `scene` for the fog; `wall`: real seconds (twinkling,
    // shooting stars); `pixelRatio` for the stars' size.
    update(w, cal, overcast, view, scene, wall, pixelRatio) {
        const u = this.u;
        const moon = moonOf(w, cal);
        const d = daylight(w.sun.alt, moon.alt, moon.lit, overcast);
        this.now = d;
        const sun = toward(w.sun.alt, w.sun.az, this.sunDir);
        const md = toward(moon.alt, moon.az, this.moonDir);

        lin(u.uZenith.value, d.zenith);
        lin(u.uHorizon.value, d.horizon);
        lin(u.uGlow.value, d.glow);
        lin(u.uHalo.value, d.halo);
        lin(u.uDisc.value, d.disc, 1.6 + 2.4 * smoothstep(0.02, 0.3, w.sun.alt));
        u.uSun.value.set(sun.x, sun.y, sun.z, (1 - overcast) * smoothstep(-0.04, 0.0, w.sun.alt));
        const flat = Math.hypot(sun.x, sun.z) || 1;
        u.uSunFlat.value.set(sun.x / flat, sun.z / flat);
        // The glow is broad while the sun is at the horizon, tighter higher up.
        u.uGlowPow.value = 2.5 + 6 * smoothstep(0, 0.35, Math.abs(w.sun.alt));
        // The haze takes the same glow (haze.js).
        HAZE.sun.x = u.uSunFlat.value.x;
        HAZE.sun.z = u.uSunFlat.value.y;
        HAZE.sun.w = u.uGlowPow.value;
        HAZE.glow.x = u.uGlow.value.r;
        HAZE.glow.y = u.uGlow.value.g;
        HAZE.glow.z = u.uGlow.value.b;
        scene.fog.color.copy(u.uHorizon.value);
        scene.background.copy(u.uHorizon.value);

        // The moon: shown while up, faint by day; across its disc, toward the sun.
        const night = 1 - smoothstep(-0.14, -0.02, w.sun.alt);
        const show = smoothstep(-0.03, 0.02, moon.alt) * (0.35 + 0.65 * night) * (1 - 0.8 * overcast);
        u.uMoon.value.set(md.x, md.y, md.z, show);
        const ux = sun.x - md.x * sun.dot(md);
        const uy = sun.y - md.y * sun.dot(md);
        const uz = sun.z - md.z * sun.dot(md);
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 1e-4) u.uMoonU.value.set(ux / ul, uy / ul, uz / ul);
        else u.uMoonU.value.set(-md.z, 0, md.x).normalize();
        u.uMoonV.value.crossVectors(md, u.uMoonU.value).normalize();
        u.uMoonPhase.value = Math.acos(Math.max(-1, Math.min(1, sun.dot(md))));
        lin(u.uMoonLight.value, [236, 234, 222], 0.55 + 0.45 * night);
        lin(u.uMoonGlow.value, [150, 170, 210], 0.6 * moon.lit * night);

        // The stars' frame: a turn about the pole, once a day and a year's share more.
        const days = (w.day + w.t) * (1 + 1 / (cal.seasonDays * 4));
        this.turn.makeRotationAxis(this.axis, TAU * (days % 1) + 2.1);
        u.uStarSky.value.setFromMatrix4(this.turn);
        u.uMilky.value = d.stars;
        this.starU.uShow.value = d.stars;
        this.starU.uTime.value = wall % 1000;
        this.starU.uPx.value = pixelRatio;
        this.shooting(wall, d.stars);

        // Around the camera, just inside the far end of the view.
        const r = view.fogFar * 0.9;
        this.dome.position.set(view.camX, view.camY, view.camZ);
        this.dome.scale.setScalar(r);
        this.stars.position.copy(this.dome.position);
        this.stars.scale.setScalar(r * 0.98);
        this.stars.visible = d.stars > 0.01;

        // The light: the sun by day (never quite flat), the moon by night.
        this.ambient.color.copy(lin(this.c, d.sky));
        this.ambient.groundColor.copy(lin(this.c, d.ground));
        this.ambient.intensity = d.ambient;
        if (d.sun.intensity > 0.002) {
            const a = Math.max(w.sun.alt, 1.5 * DEG);
            toward(a, w.sun.az, this.light.position);
            lin(this.light.color, d.sun.color);
            this.light.intensity = d.sun.intensity;
        } else {
            toward(Math.max(moon.alt, 4 * DEG), moon.az, this.light.position);
            lin(this.light.color, d.moon.color);
            this.light.intensity = d.moon.intensity;
        }
        // Unlit things dim with the sky (haze.js skyLit), about as a lit face
        // would: the sky's light by its brightness, and the sun's or the moon's.
        const bright = (c) => (0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2]) / 255;
        const k = Math.min(1, Math.max(0.06, (d.ambient * bright(d.sky) + 0.6 * d.sun.intensity + 0.35 * d.moon.intensity * bright(d.moon.color)) / 4));
        HAZE.sky.x = k;
        HAZE.sky.y = k;
        HAZE.sky.z = Math.min(1, k * 1.08);
    }

    // Now and then on a dark night, a shooting star somewhere up the sky.
    shooting(wall, dark) {
        const s = this.shoot;
        const u = this.u;
        if (s.at >= 0) {
            const p = (wall - s.at) / s.length;
            if (p >= 1 || p < 0) {
                s.at = -1;
                u.uShootA.value.w = -1;
            } else {
                u.uShootA.value.w = p * 1.3;
                u.uShootB.value.w = 3.5 * Math.sin(Math.PI * Math.min(1, p * 1.1)) * dark;
            }
            return;
        }
        u.uShootA.value.w = -1;
        if (dark < 0.4) {
            s.next = Math.max(s.next, wall + 2);
            return;
        }
        if (wall < s.next) return;
        // A path some 12–25° long, starting high, heading down.
        const az = Math.random() * TAU;
        const alt = (35 + Math.random() * 40) * DEG;
        const a = toward(alt, az, new THREE.Vector3());
        const dir = new THREE.Vector3(Math.cos(az + 1.2 + Math.random()), -0.6 - Math.random() * 0.6, -Math.sin(az + 1.2 + Math.random())).normalize();
        const b = a.clone().addScaledVector(dir, (12 + Math.random() * 13) * DEG).normalize();
        u.uShootA.value.set(a.x, a.y, a.z, 0);
        u.uShootB.value.set(b.x, b.y, b.z, 0);
        s.at = wall;
        s.length = SHOOT_FOR[0] + Math.random() * (SHOOT_FOR[1] - SHOOT_FOR[0]);
        s.next = wall + SHOOT_EVERY[0] + Math.random() * (SHOOT_EVERY[1] - SHOOT_EVERY[0]);
    }
}
