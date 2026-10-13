// How each person looks: a body (one of the three BODIES), a
// hair style and colour, and a skin tone; and the colour their clothes are
// dyed, which is their tribe's.
//
// Like a name (play/names.js), a look is made from the person's id alone, so
// it is the same in every view and on every visit, and nothing is drawn from
// the simulation's random numbers. A child's hair takes after its parent's
// (as the parent looks now: the Mirror's `parent` column); grey creeps in
// with age, and elders are grey.
//
// The player can choose a look (the editor, play/editor.js): the choices are
// kept in this browser, per world (its seed) and person id, and take the
// place of the made one at once.
//
// Colours are sRGB hex here and in what is kept; the bodies' shader takes
// them linear. `paint` is the shader's colour per vertex (animate.js
// VERTEX_COLOR), written out for the tests.
//
// Pure: no three.js and no DOM (node tests it).
import { hash, smoothstep, hexToRgb } from './util.js';
import { yearOf } from '../play/names.js';

// A vertex's colour role (models.js gives each piece one): its own colour,
// the skin's, the clothes', or hair (DYE.hair + its style).
export const DYE = Object.freeze({ own: 0, skin: 1, cloth: 2, hair: 10 });

// The bodies (models.js has their files), and the hair styles (hair.js builds them).
export const BODIES = ['man_sturdy', 'woman_slender', 'woman_stocky'];
export const HAIR_STYLES = ['short', 'long', 'braids', 'bun', 'topknot', 'shaved'];
export const SHAVED = HAIR_STYLES.indexOf('shaved');
export const STUBBLE = 0.45; // how much of the hair's colour a shaved head shows over the skin

// Natural colours: skin tones from light to dark; hair colours, mostly dark;
// and the grey of age.
export const SKIN_TONES = ['#ecc6a6', '#dcab84', '#c69069', '#a97a58', '#8e6144', '#714b34', '#553727'];
export const HAIR_COLOURS = ['#1c1714', '#2d211a', '#45301f', '#5e3e26', '#7b4c2b', '#8b3f23', '#a07f55', '#6d5d4e'];
const HAIR_ODDS = [5, 6, 5, 4, 2, 1, 1, 1];
const GREY = '#bdb8b0';
const GREYING = [40, 64]; // years: grey starts, and is as grey as it gets (most of it)
const GREYEST = 0.85;

// Hair styles by body (men a little more often short, tied up or shaved).
const STYLE_ODDS = [
    [4, 1, 1, 1, 3, 3], // man_sturdy
    [1, 4, 4, 3, 1, 0.3],
    [1, 4, 4, 3, 1, 0.3],
];

// Clothes are dyed in the tribe's colour, muted: its hue, less saturated and
// in a narrower band of lightness, as plant dyes on hide would be.
const CLOTH = { sat: [0.14, 0.26], light: [0.22, 0.3] }; // s' = a + b·s, l' = a + b·l

export const STORE_KEY = 'life-simulator.looks';
const KEEP = { worlds: 20, people: 400 }; // at most this many worlds kept, and people in each
const FORGET = 7200; // frames unseen before a look is let go (the dead keep theirs a while)

// ---- Colours ----

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// '#rrggbb' as linear [r, g, b].
export function linear(hex) {
    return hexToRgb(hex).map((c) => toLinear(c / 255));
}

function hsl([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function rgb([h, s, l]) {
    const f = (n) => {
        const k = (n + h * 12) % 12;
        const a = s * Math.min(l, 1 - l);
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
}

// The clothes' colour for a tribe's colour (sRGB hex): linear [r, g, b].
export function clothOf(hex) {
    const [h, s, l] = hsl(hexToRgb(hex).map((c) => c / 255));
    return rgb([h, CLOTH.sat[0] + CLOTH.sat[1] * s, CLOTH.light[0] + CLOTH.light[1] * l]).map(toLinear);
}

// How grey a person's hair is at `age` (steps), by people's `maturity`
// (human-style years: names.js): 0..GREYEST.
export const greyAt = (age, maturity) => GREYEST * smoothstep(GREYING[0] * yearOf(maturity), GREYING[1] * yearOf(maturity), age);

// ---- Looks made from the id ----

// A number 0..1 from an id and a salt, and a pick by odds with it.
const unit = (id, salt) => hash((id | 0) * 7 + salt) / 2 ** 32;
function pick(odds, u) {
    let t = u * odds.reduce((a, b) => a + b, 0);
    for (let k = 0; k < odds.length; k++) if ((t -= odds[k]) < 0) return k;
    return odds.length - 1;
}

// The look made from an id alone: { body, style, hair, skin } (indices into
// BODIES and HAIR_STYLES; colours as sRGB hex).
export function natural(id) {
    const body = Math.floor(unit(id, 0x51ed) * BODIES.length);
    return {
        body,
        style: pick(STYLE_ODDS[body] ?? STYLE_ODDS[0], unit(id, 0x2c1b)),
        hair: HAIR_COLOURS[pick(HAIR_ODDS, unit(id, 0x7a3d))],
        skin: SKIN_TONES[Math.floor(unit(id, 0x13f7) * SKIN_TONES.length)],
    };
}

// ---- Choices kept in the browser ----

function defaultStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null; // (storage refused: choices last this visit only)
    }
}

// A choice as kept (and as the editor makes it): { body, style, hair, skin },
// any of them, checked.
function clean(c) {
    if (!c || typeof c !== 'object') return null;
    const out = {};
    if (Number.isInteger(c.body) && c.body >= 0 && c.body < BODIES.length) out.body = c.body;
    if (Number.isInteger(c.style) && c.style >= 0 && c.style < HAIR_STYLES.length) out.style = c.style;
    if (typeof c.hair === 'string' && /^#[0-9a-f]{6}$/i.test(c.hair)) out.hair = c.hair.toLowerCase();
    if (typeof c.skin === 'string' && /^#[0-9a-f]{6}$/i.test(c.skin)) out.skin = c.skin.toLowerCase();
    return Object.keys(out).length ? out : null;
}

// ---- Everyone's looks, for drawing ----

export class Looks {
    constructor(storage = defaultStorage()) {
        this.storage = storage;
        this.seed = 0;
        this.world = null;
        this.kept = this.load();  // seed → (id → choice), the latest last
        this.cache = new Map();   // id → the look drawn: { body, style, hair, skin, hairRgb, skinRgb, made, seen, age }
        this.frame = 0;
    }

    // A new world (the Mirror: its seed, and who is whose child): its own
    // choices; the old looks are let go.
    attach(world) {
        this.world = world;
        this.seed = world.seed;
        this.cache.clear();
    }

    // A new frame: now and then, let go of looks not asked for in a while.
    tick() {
        if (++this.frame % 600 !== 0) return;
        for (const [id, look] of this.cache) if (this.frame - look.seen > FORGET) this.cache.delete(id);
    }

    // The parent of a living person (the Mirror's `parent` column), or 0.
    parentOf(id) {
        const pop = this.world?.humans;
        if (!pop?.parent) return 0;
        for (let i = 0; i < pop.n; i++) if (pop.id[i] === id) return pop.parent[i];
        return 0;
    }

    // The look of person `id` (`parent`: its parent's id, 0 for none; looked
    // up if not given), as drawn: { body, style, hair, skin } and linear
    // hairRgb, skinRgb. A child's hair is its parent's, as the parent looks.
    of(id, parent) {
        let look = this.cache.get(id);
        if (!look) {
            const p = parent ?? this.parentOf(id);
            look = natural(id);
            if (p && p !== id) look.hair = this.of(p).hair;
            look.made = { ...look };
            Object.assign(look, this.chosen(id));
            this.colour(look);
            this.cache.set(id, look);
        }
        look.seen = this.frame;
        return look;
    }

    colour(look) {
        look.hairRgb = linear(look.hair);
        look.skinRgb = linear(look.skin);
        look.greyRgb = linear(GREY);
    }

    // The hair's colour at `age` (steps; people's `maturity` makes the years),
    // grey creeping in: into out (linear). (The age is kept, for the hair of
    // the dead.)
    hairAt(look, age, maturity, out) {
        look.age = age;
        const t = greyAt(age, maturity);
        for (let k = 0; k < 3; k++) out[k] = look.hairRgb[k] + (look.greyRgb[k] - look.hairRgb[k]) * t;
        return out;
    }

    // What the player chose for `id` in this world, or null.
    chosen(id) {
        return this.kept.get(this.seed)?.get(id) ?? null;
    }

    // The player's choice for `id` ({ body, style, hair, skin }, any of
    // them): kept, and drawn from now on. null: back to the look made for it.
    choose(id, choice) {
        const c = clean(choice);
        const world = this.kept.get(this.seed) ?? new Map();
        const had = world.get(id);
        // (The latest last, worlds and people alike: the oldest go first.)
        this.kept.delete(this.seed);
        this.kept.set(this.seed, world);
        world.delete(id);
        if (c) world.set(id, { ...had, ...c });
        else if (!world.size) this.kept.delete(this.seed);
        this.trim();
        this.save();
        const look = this.cache.get(id);
        if (look) {
            for (const k of ['body', 'style', 'hair', 'skin']) look[k] = world.get(id)?.[k] ?? look.made[k];
            this.colour(look);
        }
    }

    // Keep at most KEEP.worlds worlds and KEEP.people people in each.
    trim() {
        for (const s of [...this.kept.keys()].slice(0, Math.max(0, this.kept.size - KEEP.worlds))) this.kept.delete(s);
        for (const world of this.kept.values()) {
            for (const id of [...world.keys()].slice(0, Math.max(0, world.size - KEEP.people))) world.delete(id);
        }
    }

    // What is kept: [[seed, [[id, choice], ...]], ...], oldest first.
    load() {
        const out = new Map();
        try {
            const raw = this.storage?.getItem(STORE_KEY);
            const all = raw ? JSON.parse(raw) : [];
            for (const [seed, people] of Array.isArray(all) ? all : []) {
                const world = new Map();
                for (const [id, c] of Array.isArray(people) ? people : []) {
                    const ok = clean(c);
                    if (ok && Number.isFinite(id)) world.set(id, ok);
                }
                if (world.size && Number.isFinite(seed)) out.set(seed, world);
            }
        } catch {
            // (unreadable: start afresh)
        }
        return out;
    }

    save() {
        try {
            this.storage?.setItem(STORE_KEY, JSON.stringify([...this.kept].map(([seed, world]) => [seed, [...world]])));
        } catch {
            // (storage full or refused: the choice holds for this visit)
        }
    }
}

// ---- The shader's colour, for the tests ----

// A vertex's colour (linear): its role `dye`, its colour as models.js left
// it, and the person's { cloth, skin, hair (linear), style, tribe, look }.
// (animate.js VERTEX_COLOR does the same on the graphics card.)
export function paint(dye, color, p) {
    let c;
    if (dye >= DYE.hair) {
        const style = dye - DYE.hair;
        const hair = style === SHAVED ? p.skin.map((s, k) => s + (p.hair[k] - s) * STUBBLE) : p.hair;
        c = color.map((v, k) => v * hair[k]);
    } else if (dye === DYE.cloth) c = color.map((v, k) => v * p.cloth[k]);
    else if (dye === DYE.skin) c = color.map((v, k) => v * p.skin[k]);
    else c = [...color];
    return c.map((v, k) => v + (p.tribe[k] - v) * (p.look ?? 0));
}
