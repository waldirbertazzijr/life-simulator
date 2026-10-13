// The sky, the light and the seasons as the page sees them (src/view3d/
// daylight.js, almanac.js): colours by the sun's height, the moon, snow by
// season, day and winter, foliage by season, the weather, and the dev
// `?at=` moments. Pure: no three.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { params } from '../src/config.js';
import { when, winterOf } from '../src/calendar.js';
import { daylight } from '../src/view3d/daylight.js';
import {
    seasonLook, snowLine, snowAt, iceDepth, leafOf, foliage, weatherAt, atMoment, moonOf, nightDone, keyed, TREE_KINDS, FOLIAGE,
} from '../src/view3d/almanac.js';

const C = params.calendar;
const DEG = Math.PI / 180;
const DAY = C.day;
const SEASON = DAY * C.seasonDays;
const YEAR = SEASON * 4;
const luma = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

// ---- Sky and light ----

test('by day the sky is the 3D view\'s own: a hazy blue horizon, a muted blue zenith, a warm white sun', () => {
    const d = daylight(40 * DEG);
    assert.ok(near(d.horizon, [179, 201, 218]), `horizon ${d.horizon}`);
    assert.ok(near(d.zenith, [111, 144, 173]), `zenith ${d.zenith}`);
    assert.ok(near(d.sun.color, [255, 246, 234]));
    assert.equal(d.sun.intensity, 3);
    assert.equal(d.ambient, 2.6);
    assert.equal(d.stars, 0);
    assert.ok(near(d.glow, [0, 0, 0]), 'no glow at midday');
});

test('sky colours follow the sun down: gold and rose at the horizon, then blue, then deep night', () => {
    const noon = daylight(40 * DEG);
    const golden = daylight(3 * DEG);
    const sunset = daylight(-1 * DEG);
    const blue = daylight(-8 * DEG);
    const night = daylight(-30 * DEG);
    // Warm at the horizon low down: red over blue, unlike midday.
    assert.ok(golden.horizon[0] > golden.horizon[2] + 40, `golden horizon ${golden.horizon}`);
    assert.ok(sunset.horizon[0] > sunset.horizon[2], `sunset horizon ${sunset.horizon}`);
    assert.ok(noon.horizon[2] > noon.horizon[0]);
    // A glow toward the sun at sunset, more than at noon or at night.
    assert.ok(luma(sunset.glow) > 60 && luma(noon.glow) === 0 && luma(night.glow) < 5);
    // Darker and darker, and blue at night.
    assert.ok(luma(noon.zenith) > luma(golden.zenith) && luma(golden.zenith) > luma(blue.zenith) && luma(blue.zenith) > luma(night.zenith));
    assert.ok(night.zenith[2] > night.zenith[0] * 2, 'a deep blue night');
    // The light: warm and weaker low down, none from the sun at night.
    assert.ok(golden.sun.color[2] < noon.sun.color[2] - 40 && golden.sun.intensity < noon.sun.intensity);
    assert.equal(night.sun.intensity, 0);
    assert.ok(night.ambient < golden.ambient && golden.ambient < noon.ambient);
    assert.ok(night.ambient > 0.3, 'dark, but readable');
    // Stars come out as it darkens.
    assert.ok(night.stars > 0.9 && blue.stars < night.stars && sunset.stars === 0);
    // Everything moves smoothly with the sun (no jumps between rows).
    let last = daylight(-40 * DEG);
    for (let a = -39.5; a <= 60; a += 0.5) {
        const d = daylight(a * DEG);
        assert.ok(Math.abs(luma(d.horizon) - luma(last.horizon)) < 12, `a jump at ${a}°`);
        assert.ok(Math.abs(d.ambient - last.ambient) < 0.15, `ambient jumps at ${a}°`);
        last = d;
    }
});

test('moonlight follows the phase: a full moon high up lights the night, a new one not at all', () => {
    const night = -40 * DEG;
    const full = daylight(night, 50 * DEG, 1);
    const half = daylight(night, 50 * DEG, 0.5);
    const none = daylight(night, 50 * DEG, 0);
    const down = daylight(night, -10 * DEG, 1);
    assert.ok(full.moon.intensity > 1.2, `full ${full.moon.intensity}`);
    assert.ok(half.moon.intensity > 0.4 * full.moon.intensity && half.moon.intensity < full.moon.intensity);
    assert.equal(none.moon.intensity, 0);
    assert.equal(down.moon.intensity, 0, 'set');
    assert.ok(full.ambient > none.ambient, 'a full moon lifts the whole night');
    assert.ok(full.stars < none.stars, 'and hides the fainter stars');
    assert.equal(daylight(40 * DEG, 50 * DEG, 1).moon.intensity, 0, 'no moonlight by day');
});

test('clouds grey the sky, veil the sun and hide the stars', () => {
    const clear = daylight(20 * DEG);
    const grey = daylight(20 * DEG, -1, 0, 1);
    const sat = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(sat(grey.zenith) < sat(clear.zenith) / 2);
    assert.ok(grey.sun.intensity < clear.sun.intensity / 2);
    assert.equal(daylight(-30 * DEG, -1, 0, 1).stars, 0);
});

test('the moon rides with its phase: full opposite the sun all night, new with it', () => {
    const at = (day, t) => {
        const w = when(C, (day + t) * DAY);
        return { w, moon: moonOf(w, C) };
    };
    const night0 = (C.dawn + C.light + C.dusk) / DAY;
    const midnight = (night0 + 1) / 2;
    // Full (day 4 of an 8-day moon): high at midnight.
    const full = at(3, midnight);
    assert.ok(Math.abs(full.moon.phase - 0.5) < 0.07);
    assert.ok(full.moon.alt > 30 * DEG, `full moon at midnight: ${full.moon.alt / DEG}°`);
    assert.ok(full.moon.lit > 0.95);
    // New: down at midnight, up by day near the sun.
    const fresh = at(0, midnight);
    assert.ok(fresh.moon.alt < 0);
    assert.ok(at(0, 0.35).moon.alt > 0);
    // A waxing quarter is high at sunset; a waning one at sunrise.
    const set = ((C.dawn + C.light) / DAY + night0) / 2;
    assert.ok(at(2, set).moon.alt > 30 * DEG);
    assert.ok(at(6, C.dawn / DAY / 2 + 0.01).moon.alt > 30 * DEG);
});

// ---- Snow and ice ----

test('snow comes down the mountains in late autumn, settles over the first days of winter, melts in early spring', () => {
    const look = (season, t, year = 2) => {
        const w = when(C, (year - 1) * YEAR + season * SEASON + t * SEASON);
        return snowLine(w, 1, 1);
    };
    // Summer and early autumn: no snow but the snowfields'.
    assert.equal(snowAt(look(1, 0.5), 1), 0);
    assert.equal(snowAt(look(2, 0.2), 1), 0);
    // Late autumn: the high tops whiten, the valleys do not.
    assert.ok(snowAt(look(2, 0.95), 1) > 0.5 && snowAt(look(2, 0.95), 0.2) === 0);
    // Winter: lower day by day.
    const days = [0.02, 0.15, 0.3, 0.5, 0.9].map((t) => look(3, t));
    for (let k = 1; k < days.length; k++) assert.ok(days[k] < days[k - 1], `the line comes down: ${days}`);
    assert.ok(snowAt(days[4], 0.1) > 0.9, 'a normal winter whitens the lowlands');
    // Spring: it melts away, from where the winter left it.
    const melt = [0.01, 0.2, 0.4, 0.8].map((t) => look(0, t, 3));
    for (let k = 1; k < melt.length; k++) assert.ok(melt[k] >= melt[k - 1]);
    assert.ok(Math.abs(melt[0] - look(3, 0.999)) < 0.02, 'no jump from winter to spring');
    assert.equal(snowAt(melt[3], 1), 0, 'gone by late spring');
    // A world's first spring follows no winter.
    assert.equal(snowAt(snowLine(when(C, 0), 1, -1), 0.5), 0);
});

test('a hard winter brings the snow lower and sooner; a mild one leaves the lowlands green', () => {
    const w = (t) => when(C, 3 * SEASON + t * SEASON);
    for (const t of [0.1, 0.3, 0.6, 0.9]) {
        assert.ok(snowLine(w(t), 2, 1) < snowLine(w(t), 1, 1) && snowLine(w(t), 1, 1) < snowLine(w(t), 0, 1), `at ${t}`);
    }
    assert.ok(snowAt(snowLine(w(0.9), 0, 1), 0.15) === 0, 'mild: green valleys');
    assert.equal(snowAt(snowLine(w(0.9), 2, 1), 0), 1, 'hard: white to the shore');
    // Snow lies thicker higher up.
    const line = snowLine(w(0.4), 1, 1);
    for (let h = 0.05; h <= 1; h += 0.05) assert.ok(snowAt(line, h) >= snowAt(line, h - 0.05));
});

test('lakes freeze in from the shore through the winter, harder winters further, and thaw in spring', () => {
    const w = (season, t) => when(C, YEAR + season * SEASON + t * SEASON);
    assert.equal(iceDepth(w(1, 0.5), 1, 1), 0);
    assert.equal(iceDepth(w(3, 0.05), 1, 1), 0, 'not on the first day');
    assert.ok(iceDepth(w(3, 0.8), 1, 1) > iceDepth(w(3, 0.3), 1, 1));
    assert.ok(iceDepth(w(3, 0.8), 2, 1) > iceDepth(w(3, 0.8), 1, 1) && iceDepth(w(3, 0.8), 1, 1) > iceDepth(w(3, 0.8), 0, 1));
    assert.ok(iceDepth(w(0, 0.05), 1, 1) > 0 && iceDepth(w(0, 0.4), 1, 1) === 0);
});

// ---- Foliage ----

test('foliage by season: green summer, red and gold autumn, bare birches and dry oaks in winter, blossom in spring', () => {
    const yearT = (season, t) => (season + t) / 4;
    const green = (c) => c[1] > c[0] && c[1] > c[2];
    for (const kind of ['birch', 'oak', 'fruit']) assert.ok(green(leafOf(kind, yearT(1, 0.5), 0.5).color), `${kind} in summer`);
    // Autumn: yellow birches, red-brown and gold oaks; each tree its own.
    const birch = leafOf('birch', yearT(2, 0.5), 0.3).color;
    assert.ok(birch[0] > birch[1] && birch[1] > birch[2] + 60, `a yellow birch: ${birch}`);
    const oakA = leafOf('oak', yearT(2, 0.5), 0).color;
    const oakB = foliage('oak', yearT(2, 0.5));
    assert.ok(oakA[0] > oakA[1] && oakB.to[1][0] > oakB.to[1][1] * 1.8, 'oaks turn russet');
    assert.notDeepEqual(leafOf('oak', yearT(2, 0.3), 0).color, leafOf('oak', yearT(2, 0.3), 1).color, 'not all at once');
    // Winter: birches bare, oaks keep a few dry leaves, pines green.
    assert.equal(leafOf('birch', yearT(3, 0.5), 0.5).amount, 0);
    const oak = leafOf('oak', yearT(3, 0.5), 0.5);
    assert.ok(oak.amount > 0.1 && oak.amount < 0.4 && !green(oak.color));
    assert.ok(green(leafOf('pine', yearT(3, 0.5), 0.5).color) && leafOf('pine', 0.9, 0.5).amount === 1);
    // Spring: fruit trees in blossom, pale, before their leaves.
    const blossom = leafOf('fruit', yearT(0, 0.3), 0.5);
    assert.ok(blossom.amount > 0.8 && Math.min(...blossom.color) > 180, `blossom ${blossom.color}`);
    assert.ok(green(leafOf('fruit', yearT(1, 0.2), 0.5).color), 'then leaves');
    // Every kind's year closes on itself.
    for (const kind of TREE_KINDS) {
        const a = leafOf(kind, 0, 0.5);
        const b = leafOf(kind, 0.99999, 0.5);
        assert.ok(near(a.color, b.color, 0.5) && Math.abs(a.amount - b.amount) < 0.01, `${kind} wraps`);
        assert.ok(FOLIAGE[kind].every((key, i, all) => i === 0 || key[0] > all[i - 1][0]), `${kind} keys in order`);
    }
});

test('grass: fresh in spring, golden in autumn; flowers in spring', () => {
    const at = (season, t, year = 2) => seasonLook(C, 7, (year - 1) * YEAR + (season + t) * SEASON);
    const autumn = at(2, 0.6).lush;
    const summer = at(1, 0.5).lush;
    assert.ok(autumn[0] > summer[0] + 30, 'golden');
    assert.ok(at(0, 0.5).lush[1] > summer[1], 'fresher in spring');
    assert.ok(at(0, 0.5).bloom > 0.8 && at(2, 0.5).bloom === 0 && at(3, 0.5).bloom === 0);
    assert.ok(at(2, 0.9).gold > 0.8 && at(1, 0.5).gold === 0);
    assert.equal(keyed([[0, 1], [0.5, 3]], 0.25), 2);
});

// ---- Weather, and the dev moments ----

test('weather: spring showers now and then, snow in winter, none in summer; the same every time', () => {
    const sample = (season) => Array.from({ length: 300 }, (_, k) => weatherAt(C, 7, YEAR + season * SEASON + k * (SEASON / 300)));
    const spring = sample(0);
    const summer = sample(1);
    const winter = sample(3);
    assert.ok(spring.some((w) => w.rain > 0.2), 'it rains in spring');
    assert.ok(spring.filter((w) => w.rain > 0).length < 0.6 * spring.length, 'now and then');
    assert.ok(Math.max(...spring.map((w) => w.rain)) <= 0.6, 'lightly');
    assert.ok(summer.every((w) => w.rain === 0 && w.snow === 0));
    assert.ok(winter.some((w) => w.snow > 0.3) && winter.every((w) => w.rain === 0));
    assert.deepEqual(weatherAt(C, 7, 12345), weatherAt(C, 7, 12345));
    // Clouds before the shower, and a shower comes in and goes out gently.
    const wet = spring.findIndex((w) => w.rain > 0);
    assert.ok(spring[wet].overcast > 0);
});

test('?at= finds the moment asked for', () => {
    const at = (text, seed = 7) => when(C, atMoment(C, seed, text));
    const dusk = at('winter-dusk');
    assert.equal(dusk.season, 3);
    assert.equal(dusk.part, 'dusk');
    const full = at('full-midnight');
    assert.equal(full.part, 'night');
    assert.ok(Math.abs(full.moon.phase - 0.5) < 1 / 16);
    const hard = at('winter-noon-hard');
    assert.equal(winterOf(C, 7, hard.year), 2);
    assert.ok(weatherAt(C, 7, atMoment(C, 7, 'spring-rain')).rain >= 0.25);
    assert.equal(weatherAt(C, 7, atMoment(C, 7, 'autumn-noon-clear')).overcast, 0);
    assert.equal(at('summer-d3-sunrise').dayOfSeason, 3);
    assert.ok(when(C, atMoment(C, 7, 'spring-sunrise')).sun.alt > 0);
    assert.equal(atMoment(C, 7, ''), null);
});

test('the night goes by for a sleeper: none of it at its start, all of it at first light', () => {
    const night0 = C.dawn + C.light + C.dusk;
    assert.equal(nightDone(C, night0), 0);
    assert.ok(Math.abs(nightDone(C, night0 + (DAY - night0) / 2) - 0.5) < 1e-9);
    assert.equal(nightDone(C, DAY / 2), -1, 'by day');
});
