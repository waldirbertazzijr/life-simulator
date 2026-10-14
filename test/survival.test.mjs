// Stage 4, package 2 (survival), the simulation's side: snow and how it
// slows walking, chill and warmth, the cold's cost and death by freezing,
// the cloak, the camp fire, wild berries and fruit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params as defaults } from '../src/config.js';
import { when } from '../src/calendar.js';
import { snowLine, snowAt, snowLineAt, depthAt, snowDepth, snowPace, NO_SNOW, SNOW_FADE } from '../src/snow.js';
import * as almanac from '../src/view3d/almanac.js';
import { CHILL, WARMTH, coldNow, chillAt, chill, chillHere, cloakWarmth, warmthOf } from '../src/warmth.js';
import { BIOME } from '../src/terrain.js';

const C = defaults.calendar;
const DAY = C.day;
const SEASON = DAY * C.seasonDays;
const YEAR = SEASON * 4;
const NOON = C.dawn + C.light / 2;            // into a day
const MIDNIGHT = C.dawn + C.light + C.dusk + (C.day - C.dawn - C.light - C.dusk) / 2;
// A moment: year y (1, 2, ...), season s (0..3), day d of it (0..5), and an hour into the day.
const moment = (y, s, d, hour) => (y - 1) * YEAR + s * SEASON + d * DAY + hour;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, msg ?? `${a} ≉ ${b}`);

// ---- Snow ---------------------------------------------------------------------------------

test('snow.js: the snow line moved from the almanac, unchanged, and the almanac still has it', () => {
    assert.equal(almanac.snowLine, snowLine);
    assert.equal(almanac.snowAt, snowAt);
    assert.equal(almanac.SNOW_FADE, SNOW_FADE);
    // The same numbers as before the move (view3d/almanac.js at 0c3cf35).
    assert.equal(snowLine(when(C, moment(2, 1, 3, NOON)), 1, 1), NO_SNOW, 'none in summer');
    assert.equal(snowLine(when(C, moment(1, 0, 0, 0)), 1, -1), NO_SNOW, 'none in the first spring');
    const deep = snowLine(when(C, moment(2, 3, 5, NOON)), 2, 1);
    assert.ok(deep < -0.3, `a hard winter's line goes below the shore: ${deep}`);
    assert.equal(snowAt(0.5, 0.5), 0.5);
    assert.equal(snowAt(0.5, 0.5 + SNOW_FADE / 2), 1);
});

test('snow depth: none in summer, on the peaks in late autumn, deep in a hard winter, a snowfield always', () => {
    const line = (y, s, d, hard, last) => snowLine(when(C, moment(y, s, d, NOON)), hard, last);
    assert.equal(depthAt(line(2, 1, 3, 1, 1), 0.9), 0, 'summer: bare even on the peaks');
    assert.equal(depthAt(line(2, 1, 3, 1, 1), 0.9, true), 1, 'a snowfield lies all year');
    const autumn = line(2, 2, 5, 1, 1);
    assert.ok(depthAt(autumn, 0.95) > 0.5 && depthAt(autumn, 0.2) === 0, 'late autumn: the first snow on the high tops');
    const hard = line(2, 3, 4, 2, 1);
    assert.ok(depthAt(hard, 0.05) > 0.3 && depthAt(hard, 0.05) < 0.4, 'a hard winter: shallow snow in the valleys');
    assert.ok(depthAt(hard, 0.8) > 0.8, 'deep on the mountains');
    assert.ok(depthAt(line(2, 3, 4, 0, 1), 0.1) === 0, 'a mild winter leaves the valleys green');
    for (let h = 0.05; h <= 1; h += 0.05) assert.ok(depthAt(hard, h) >= depthAt(hard, h - 0.05) - 1e-12, 'deeper higher up');
    // The pace: × 1 on bare ground, × slow in the deepest.
    assert.equal(snowPace(0.7, 0), 1);
    assert.equal(snowPace(0.7, 1), 0.7);
    assert.ok(Math.abs(snowPace(0.7, 0.5) - 0.85) < 1e-12);
    // snowLineAt: the line of the world's own winters.
    const t = moment(3, 3, 2, NOON);
    assert.ok(Math.abs(snowLineAt(C, 7, t) - almanac.seasonLook(C, 7, t).line) < 1e-12, 'the page and the simulation agree');
});

test('snowDepth on a world: 0 on a flat world and on water, by the height and the line elsewhere', () => {
    const flat = { p: defaults, seed: 1, time: 0, terrain: null };
    assert.equal(snowDepth(flat, 10, 10), 0);
    // A stand-in land: a slope from the sea (x 0) to the peak (x 100).
    const T = {
        seaLevel: 8, peak: 120, biomes: [], heightAt: (x) => 8 + (112 * x) / 100,
        biome: (x) => (x > 95 ? BIOME.SNOW : BIOME.MEADOW),
    };
    const w = { p: defaults, seed: 7, time: 0, terrain: T };
    const t = moment(2, 3, 5, NOON);
    const L = snowLineAt(C, 7, t);
    assert.equal(snowDepth(w, 50, 0, t), depthAt(L, 0.5));
    assert.equal(snowDepth(w, 99, 0, moment(2, 1, 1, NOON)), 1, 'the snowfield, in summer too');
    assert.equal(snowDepth({ ...w, terrain: { ...T, heightAt: () => 2 } }, 50, 0, t), 0, 'water: none');
});

// ---- Chill and warmth ---------------------------------------------------------------------

test('chill: never on a summer day; bitter on a hard winter night; colder by night, up high, on tundra', () => {
    // Seed 7's winters (calendar winterOf): find a hard one and a mild one.
    const lowland = (t) => chill(C, 7, t, 0.05, BIOME.MEADOW);
    assert.equal(lowland(moment(2, 1, 3, NOON)), 0, 'a summer day');
    assert.equal(lowland(moment(2, 1, 3, MIDNIGHT)), 0, 'a summer night in the valleys');
    assert.ok(chill(C, 7, moment(2, 1, 3, MIDNIGHT), 0.5, BIOME.TUNDRA) > 0.05, 'a summer night on the tundra is cool');
    assert.ok(chill(C, 7, moment(2, 2, 3, MIDNIGHT), 0.5, BIOME.TUNDRA) > 0.5, 'an autumn night on the tundra is cold');
    for (let y = 2; y < 12; y++) {
        const night = moment(y, 3, 3, MIDNIGHT);
        const day = moment(y, 3, 3, NOON);
        assert.ok(lowland(night) > lowland(day), 'colder by night');
        assert.ok(chill(C, 7, day, 0.6, BIOME.TUNDRA) > lowland(day), 'colder up high, on tundra');
        assert.ok(lowland(night) >= CHILL.winters[0] * 0.99, 'every winter night is cold');
    }
    // A hard winter's night is bitter (seed and year found by search).
    let found = false;
    for (let y = 2; y < 30 && !found; y++) {
        const k = coldNow(C, 7, moment(y, 3, 3, MIDNIGHT));
        if (k.air > 0.99) found = chillAt(k.air, k.high, 0.05, BIOME.MEADOW) === 1;
    }
    assert.ok(found, 'a hard winter night: chill 1 in the valleys');
    // chill() is coldNow() and chillAt() together.
    const t = moment(4, 2, 5, MIDNIGHT);
    const k = coldNow(C, 3, t);
    assert.equal(chill(C, 3, t, 0.3, BIOME.FOREST), chillAt(k.air, k.high, 0.3, BIOME.FOREST));
    const w = { p: defaults, seed: 3, time: t, terrain: null };
    assert.equal(chillHere(w, 1, 1), chill(C, 3, t, 0, -1), 'a flat world is all lowland');
});

test('warmth: a cloak, the fire, a shelter, a torch, each keeping off its share of what the rest let through', () => {
    assert.equal(warmthOf({}), 0);
    near(warmthOf({ cloak: true }), WARMTH.cloak);
    near(warmthOf({ nearFire: true }), WARMTH.fire);
    assert.ok(Math.abs(warmthOf({ nearFire: 0.5 }) - WARMTH.fire * 0.5) < 1e-12, 'a fire burning low warms less');
    near(warmthOf({ inShelter: true }), WARMTH.shelter);
    near(warmthOf({ torch: true }), WARMTH.torch);
    const all = warmthOf({ cloak: true, nearFire: 1, torch: true });
    assert.ok(Math.abs(all - (1 - (1 - WARMTH.cloak) * (1 - WARMTH.fire) * (1 - WARMTH.torch))) < 1e-12);
    assert.ok(all < 1);
    // Cloaks: a rare or legendary one (trait warmth) is warmer.
    const plain = { kind: 7, trait: '', mult: 1 };
    const rare = { kind: 7, trait: 'warmth', mult: defaults.items.rare };
    const legend = { kind: 7, trait: 'warmth', mult: defaults.items.legendary };
    assert.equal(cloakWarmth(null), 0);
    assert.equal(cloakWarmth(plain), WARMTH.cloak);
    assert.ok(cloakWarmth(rare) > cloakWarmth(plain) && cloakWarmth(legend) > cloakWarmth(rare) && cloakWarmth(legend) < 1);
    near(warmthOf({ cloak: cloakWarmth(rare) }), cloakWarmth(rare));
});
