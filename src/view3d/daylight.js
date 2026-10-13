// The sky's colours and the light, from the sun's height, the moon and the
// clouds. The 3D view paints them (sky.js); this only works them out, so node
// tests it. Colours are sRGB, 0..255; strengths are three.js intensities.
//
// The day keeps the look the 3D view always had: a light hazy blue at the
// horizon, a muted blue overhead, a warm white sun and plenty of soft light
// from the sky. As the sun goes down the horizon warms through gold to rose,
// a glow gathers where it sets (the haze toward the sun takes it too: haze.js),
// the light turns orange and long, then the blue hour, then the night: deep
// blue, really dark but readable, lit by the moon as its phase allows (a full
// moon gives a cool light you can walk by; a new one leaves the stars).
import { smoothstep, clamp01, DEG } from './util.js';

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// By the sun's height (degrees): the zenith, the horizon (and the haze), the
// glow on the horizon toward the sun (added to it), and the halo about it.
const SKY = [
    [-90, [9, 15, 32], [18, 26, 44], [0, 0, 0], [0, 0, 0]],
    [-16, [10, 16, 34], [20, 28, 46], [0, 0, 0], [0, 0, 0]],
    [-11, [18, 30, 60], [46, 52, 80], [54, 38, 52], [8, 5, 8]],
    [-5, [34, 54, 96], [106, 92, 116], [140, 70, 48], [34, 18, 14]],
    [-1.5, [56, 82, 126], [176, 128, 118], [216, 108, 46], [80, 40, 20]],
    [2, [78, 108, 152], [214, 166, 132], [226, 128, 48], [130, 72, 30]],
    [7, [98, 132, 168], [208, 190, 172], [150, 92, 40], [90, 60, 30]],
    [16, [111, 144, 173], [179, 201, 218], [36, 24, 10], [40, 32, 22]],
    [26, [111, 144, 173], [179, 201, 218], [0, 0, 0], [30, 26, 20]],
    [90, [111, 144, 173], [179, 201, 218], [0, 0, 0], [24, 22, 18]],
];

// The sun's light by its height: colour and strength. Strong and warm low
// down (it rakes the hills), gone a little after it sets.
const SUN = [
    [-3, [255, 110, 60], 0],
    [0, [255, 130, 70], 0.55],
    [4, [255, 164, 98], 1.6],
    [10, [255, 208, 160], 2.4],
    [24, [255, 246, 234], 3.0],
    [90, [255, 246, 234], 3.0],
];

// The light from the whole sky (three.js's hemisphere light: the sky's colour
// from above, the ground's from below) and its strength.
const AMBIENT = [
    [-90, [96, 116, 168], [32, 36, 50], 0.62],
    [-14, [96, 116, 168], [32, 36, 50], 0.62],
    [-10, [118, 128, 172], [50, 50, 62], 1.0],
    [-6, [146, 140, 172], [62, 58, 64], 1.2],
    [-2, [196, 164, 168], [80, 70, 66], 1.5],
    [3, [236, 204, 184], [104, 92, 78], 2.15],
    [12, [224, 233, 240], [106, 108, 90], 2.6],
    [90, [224, 233, 240], [106, 108, 90], 2.6],
];

function table(rows, alt, pick) {
    let k = 0;
    while (k < rows.length - 2 && rows[k + 1][0] <= alt) k++;
    const a = rows[k];
    const b = rows[k + 1];
    const t = clamp01((alt - a[0]) / (b[0] - a[0]));
    return pick(a, b, t);
}

const MOON_LIGHT = [168, 188, 226];
const MOON_STRENGTH = 1.7;   // a full moon high up
const MOONLIT_SKY = 0.6;     // how much a full moon lifts the night's sky and ambient
const GREY = [150, 156, 162]; // an overcast sky's horizon at noon

// Everything for a moment: `sunAlt` and `moonAlt` in radians, `lit` the
// moon's lit share (0 new .. 1 full), `overcast` 0..1. Returns
//   zenith, horizon, glow, halo    the sky (horizon is also the haze)
//   sun {color, intensity}         the sun's light (0 at night)
//   moon {color, intensity}        the moon's (0 by day, by phase at night)
//   sky, ground, ambient           the hemisphere light
//   stars                          how much the stars show (0..1)
//   disc                           the sun's disc colour (glare)
export function daylight(sunAlt, moonAlt = -1, lit = 0, overcast = 0) {
    const alt = sunAlt / DEG;
    const out = table(SKY, alt, (a, b, t) => ({
        zenith: mix3(a[1], b[1], t), horizon: mix3(a[2], b[2], t), glow: mix3(a[3], b[3], t), halo: mix3(a[4], b[4], t),
    }));
    // The moon: up, and lit, at night (it fades in as the sun's last light goes).
    const night = 1 - smoothstep(-8, -2, alt);
    const up = smoothstep(0, 0.2, Math.sin(moonAlt));
    const moonlit = lit * up * night;
    // A bright moon lifts the night's sky toward a moonlit blue.
    out.zenith = mix3(out.zenith, [24, 38, 72], MOONLIT_SKY * moonlit * night);
    out.horizon = mix3(out.horizon, [40, 54, 82], MOONLIT_SKY * moonlit * night);
    const sun = table(SUN, alt, (a, b, t) => ({ color: mix3(a[1], b[1], t), intensity: lerp(a[2], b[2], t) }));
    const amb = table(AMBIENT, alt, (a, b, t) => ({ sky: mix3(a[1], b[1], t), ground: mix3(a[2], b[2], t), ambient: lerp(a[3], b[3], t) }));
    amb.ambient *= 1 + MOONLIT_SKY * moonlit;
    // Clouds: a greyer, flatter sky, the sun veiled, no glow.
    if (overcast > 0) {
        const o = clamp01(overcast);
        const grey = (c, k) => {
            const l = (0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2]) * k;
            return mix3(c, [l * GREY[0] / 156, l * GREY[1] / 156, l * GREY[2] / 156], o);
        };
        out.zenith = grey(out.zenith, 0.85);
        out.horizon = grey(out.horizon, 0.9);
        out.glow = mix3(out.glow, [0, 0, 0], o * 0.85);
        out.halo = mix3(out.halo, [0, 0, 0], o);
        sun.intensity *= 1 - 0.75 * o;
        amb.ambient *= 1 - 0.12 * o;
        amb.sky = mix3(amb.sky, [200, 204, 208], o * 0.5);
    }
    out.sun = sun;
    out.moon = { color: MOON_LIGHT, intensity: MOON_STRENGTH * moonlit * (1 - 0.7 * overcast) };
    out.sky = amb.sky;
    out.ground = amb.ground;
    out.ambient = amb.ambient;
    out.stars = smoothstep(-5, -13, alt) * (1 - 0.55 * moonlit) * (1 - clamp01(overcast * 1.4));
    out.disc = mix3([255, 168, 92], [255, 242, 220], smoothstep(1, 16, alt));
    return out;
}
