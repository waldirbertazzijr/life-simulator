// The graphics setting, and the numbers the light's effects are made from.
//
// One switch, three steps (the panel shows it in the god view):
//   high    shadows (a large map), and the light's diffusion: the bloom
//           of what gives light (the sun, the moon, flames, legends), the
//           light rays, the soft darkness where things meet the ground;
//   medium  shadows only (a smaller map), drawn straight to the screen;
//   low     none of it: the view exactly as it was before any of them.
// A desktop starts on High, a phone on Low; the choice is kept by the
// browser (localStorage, which may be missing or refuse: then it lasts the
// visit).
//
// Who casts what (shadows.js), the passes (post.js) and the darkness on the
// ground (contact.js) read PRESETS. Here too, pure and tested in node: how
// dark the shadows are by the sun's height (and the moon's), and how strong
// the light rays are by where the sun (or the moon) stands on the screen.
import { smoothstep, clamp01, DEG } from './util.js';

export const QUALITIES = ['high', 'medium', 'low'];
export const GRAPHICS_KEY = 'life-simulator.graphics';

// Per setting: the shadow map's size (0: no shadows), and whether the
// light's diffusion is drawn (post.js, contact.js, sky.js glare).
export const PRESETS = {
    high: { shadowMap: 2048, diffusion: true },
    medium: { shadowMap: 1024, diffusion: false },
    low: { shadowMap: 0, diffusion: false },
};

// A phone (or a tablet): a touch screen and no mouse. `matches(query)` is
// the browser's matchMedia(query).matches.
export const phoneLike = (matches) => matches('(pointer: coarse)') && !matches('(any-pointer: fine)');

export const defaultQuality = (phone) => (phone ? 'low' : 'high');

// The setting this browser keeps, or the default.
export function loadQuality(storage, phone) {
    try {
        const kept = storage?.getItem(GRAPHICS_KEY);
        if (QUALITIES.includes(kept)) return kept;
    } catch {
        // (no storage here)
    }
    return defaultQuality(phone);
}

// Keep a setting; false if the browser would not.
export function saveQuality(storage, quality) {
    try {
        storage.setItem(GRAPHICS_KEY, quality);
        return true;
    } catch {
        return false;
    }
}

// The setting now, for the whole page: the panel's buttons, and any screen
// of settings, change it here; whoever draws listens (onQuality). main.js
// starts it with the browser's storage (or null) and whether this is a phone.
const now = { storage: null, quality: 'low' };
const listeners = new Set();

export function initQuality(storage, phone) {
    now.storage = storage;
    now.quality = loadQuality(storage, phone);
    return now.quality;
}

export const getQuality = () => now.quality;

// Change the setting (kept by the browser, and told to every listener);
// false for no such setting.
export function setQuality(quality) {
    if (!QUALITIES.includes(quality)) return false;
    now.quality = quality;
    saveQuality(now.storage, quality);
    for (const fn of listeners) fn(quality);
    return true;
}

// fn(quality) on every change; returns the way to stop listening.
export function onQuality(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// ---- Shadows ----

// The sky's light is the sun's while it gives more than this (sky.js), the
// moon's after.
export const SUN_LIGHT_MIN = 0.002;
const MOON_FULL = 1.7;   // daylight.js MOON_STRENGTH: a full moon high up
const MOON_SHADOW = 0.55; // how dark the moon's shadows get, at its brightest

// How dark the shadows are (0 none .. 1 the direct light all blocked), and
// whose they are. `d`: daylight.js's moment; `sunAlt` in radians. The sun's
// are full while it stands even a little above the horizon, so its long
// shadows at dawn and dusk show, and fade out as it touches the horizon:
// gone at dusk. Clouds veil them. At night the moon's, faint, as bright as
// its phase and height allow (its light, daylight.js, already says so).
export function shadowStrength(d, sunAlt, overcast = 0) {
    if (d.sun.intensity > SUN_LIGHT_MIN) {
        return { by: 'sun', strength: smoothstep(-1.2 * DEG, 2.5 * DEG, sunAlt) * (1 - 0.85 * clamp01(overcast)) };
    }
    return { by: 'moon', strength: MOON_SHADOW * clamp01(d.moon.intensity / MOON_FULL) };
}

// ---- Light rays ----

// How strong the rays are (0..1), from the light's height (`alt`, radians),
// where it is on the screen (`x`, `y`: -1..1 across it, `front`: ahead of
// the camera), whose (`by`), the moon's lit share and the clouds. Strongest
// at dawn and dusk, through the trees and over the ridges; weaker with the
// sun high; the moon's faint. They show while the light is on the screen,
// and fade out as it moves off past the edge.
export function rayStrength({ by, alt, x, y, front, lit = 1, overcast = 0 }) {
    if (!front) return 0;
    const off = Math.max(Math.abs(x), Math.abs(y)); // 1 at the screen's edge
    const seen = 1 - smoothstep(0.95, 1.55, off);
    const high = by === 'sun'
        ? smoothstep(-3 * DEG, 0.5 * DEG, alt) * (0.3 + 0.7 * (1 - smoothstep(8 * DEG, 30 * DEG, alt)))
        : 0.3 * clamp01(lit) * smoothstep(0, 8 * DEG, alt);
    return seen * high * (1 - clamp01(overcast * 1.25));
}
