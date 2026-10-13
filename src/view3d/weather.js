// Rain and snow falling about the camera, while the season's weather says so
// (almanac.js weatherAt: spring's light showers, winter's snow).
//
// Each is one draw call: a few thousand streaks (rain) or flakes (snow) in a
// box around the camera, moved on the graphics card. Each drop has its own
// place in the box and falls through it over and over; the box is laid on
// the world's own coordinates (wrapped by its size), so the drops stay where
// they are as the camera moves among them. Only as many fall as the weather
// is heavy (each drop has its own threshold), and none from high above the
// map, where they would be a smear.
import * as THREE from 'three';
import { HAZE } from './haze.js';

const BOX = [90, 46, 90];   // the box around the camera (x, height, z)
const RAIN = 2600;          // streaks at most
const SNOW = 3200;          // flakes at most
const RAIN_SPEED = 38;      // units a second, falling
const SNOW_SPEED = 2.6;
const STREAK = 1.6;         // a streak's length

const VERTEX_COMMON = /* glsl */ `
attribute vec4 drop;       // its place in the box (0..1, x y z), and its threshold (w)
uniform vec3 uBox;
uniform vec3 uCam;          // the camera (render coordinates)
uniform vec3 uShift;        // the box's lattice: the world under the camera, and the fall
uniform float uAmount;
uniform float uTime;
vec3 placed( float fall ) {
    vec3 p = drop.xyz * uBox;
    p.y -= fall;
    // Fixed in the world: wrapped about the camera by the box's size.
    vec3 rel = mod( p - uShift + 0.5 * uBox, uBox ) - 0.5 * uBox;
    return uCam + rel;
}
`;

const RAIN_VERTEX = /* glsl */ `
${VERTEX_COMMON}
attribute float tip;       // 0 the streak's head, 1 its tail
varying float vAlpha;
void main() {
    vec3 at = placed( uTime * ${RAIN_SPEED.toFixed(1)} );
    // A slight slant, the wind; the tail above and behind the head.
    at += vec3( 0.18, 1.0, 0.06 ) * tip * ${STREAK.toFixed(2)};
    float on = step( drop.w, uAmount );
    vec3 rel = at - uCam;
    vAlpha = on * ( 1.0 - smoothstep( 0.25, 0.5, length( rel.xz ) / uBox.x ) ) * ( 0.35 + 0.65 * tip );
    gl_Position = projectionMatrix * viewMatrix * vec4( at, 1.0 );
}`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
    gl_FragColor = vec4( uColor, 0.42 * vAlpha );
    #include <colorspace_fragment>
}`;

const SNOW_VERTEX = /* glsl */ `
${VERTEX_COMMON}
uniform float uPx;
varying float vAlpha;
void main() {
    float k = fract( drop.w * 37.1 );
    vec3 at = placed( uTime * ${SNOW_SPEED.toFixed(1)} * ( 0.7 + 0.6 * k ) );
    // Flakes drift as they fall, each on its own sway.
    at.x += sin( uTime * ( 0.6 + k ) + drop.w * 40.0 ) * 0.9;
    at.z += cos( uTime * ( 0.5 + 0.8 * k ) + drop.w * 23.0 ) * 0.9;
    float on = step( drop.w, uAmount );
    vec4 mv = viewMatrix * vec4( at, 1.0 );
    vec3 rel = at - uCam;
    vAlpha = on * ( 1.0 - smoothstep( 0.25, 0.5, length( rel.xz ) / uBox.x ) ) * smoothstep( 1.5, 4.0, -mv.z );
    gl_PointSize = min( ( 0.14 + 0.1 * k ) * uPx / max( -mv.z, 1.0 ), 9.0 ) * on;
    gl_Position = projectionMatrix * mv;
}`;

const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot( p, p );
    if ( r > 1.0 ) discard;
    gl_FragColor = vec4( uColor, vAlpha * ( 1.0 - r ) * 0.95 );
    #include <colorspace_fragment>
}`;

// Every drop's place and threshold, at random (scenery: Math.random is fine).
function drops(n, perDrop) {
    const data = new Float32Array(n * perDrop * 4);
    for (let i = 0; i < n; i++) {
        const d = [Math.random(), Math.random(), Math.random(), Math.random()];
        for (let k = 0; k < perDrop; k++) data.set(d, (i * perDrop + k) * 4);
    }
    return data;
}

export class Weather {
    constructor(scene) {
        const shared = {
            uBox: { value: new THREE.Vector3(...BOX) },
            uCam: { value: new THREE.Vector3() },
            uShift: { value: new THREE.Vector3() },
            uTime: { value: 0 },
        };
        this.shared = shared;
        // Rain: streaks, two points each.
        const rain = new THREE.BufferGeometry();
        rain.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN * 2 * 3), 3));
        rain.setAttribute('drop', new THREE.BufferAttribute(drops(RAIN, 2), 4));
        rain.setAttribute('tip', new THREE.BufferAttribute(Float32Array.from({ length: RAIN * 2 }, (_, k) => k % 2), 1));
        this.rainU = { ...shared, uAmount: { value: 0 }, uColor: { value: new THREE.Color() } };
        this.rain = new THREE.LineSegments(rain, new THREE.ShaderMaterial({
            uniforms: this.rainU, vertexShader: RAIN_VERTEX, fragmentShader: RAIN_FRAGMENT,
            transparent: true, depthWrite: false,
        }));
        // Snow: soft round flakes.
        const snow = new THREE.BufferGeometry();
        snow.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW * 3), 3));
        snow.setAttribute('drop', new THREE.BufferAttribute(drops(SNOW, 1), 4));
        this.snowU = { ...shared, uAmount: { value: 0 }, uColor: { value: new THREE.Color() }, uPx: { value: 1 } };
        this.snow = new THREE.Points(snow, new THREE.ShaderMaterial({
            uniforms: this.snowU, vertexShader: SNOW_VERTEX, fragmentShader: SNOW_FRAGMENT,
            transparent: true, depthWrite: false,
        }));
        for (const m of [this.rain, this.snow]) {
            m.frustumCulled = false;
            m.visible = false;
            scene.add(m);
        }
        this.stats = { rain: 0, snow: 0 };
    }

    // Each frame: `look` is the season's (almanac.js), `wall` real seconds,
    // `dpr` the device pixels per CSS pixel (for the flakes' size).
    update(view, look, wall, dpr = 1) {
        // Near the ground only (not over the map).
        const near = 1 - view.mapness;
        const rain = look.rain * near;
        const snow = look.snow * near;
        this.stats.rain = +rain.toFixed(2);
        this.stats.snow = +snow.toFixed(2);
        this.rain.visible = rain > 0.01;
        this.snow.visible = snow > 0.01;
        if (!this.rain.visible && !this.snow.visible) return;
        const s = this.shared;
        s.uCam.value.set(view.camX, view.camY, view.camZ);
        // The world under the camera, wrapped by the box (so the lattice is
        // the world's, not the camera's).
        s.uShift.value.set((view.fx + view.camX) % BOX[0], view.camY % BOX[1], (view.fz + view.camZ) % BOX[2]);
        s.uTime.value = wall % 600;
        this.rainU.uAmount.value = rain;
        this.snowU.uAmount.value = snow;
        const k = HAZE.sky.x;
        this.rainU.uColor.value.setRGB(0.72 * k, 0.76 * k, 0.82 * k);
        this.snowU.uColor.value.setRGB(0.95 * k, 0.96 * k, 1.0 * k);
        this.snowU.uPx.value = dpr / view.unitPx; // (a flake s across, z away, is s · uPx / z pixels)
    }
}
