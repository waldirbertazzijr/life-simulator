// The calendar (src/calendar.js): days, seasons, years, the sun and the moon,
// and each year's winter, from the step count alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { when, dateLabel, isNight, winterOf, SEASONS } from '../src/calendar.js';
import { params } from '../src/config.js';

const C = params.calendar;
const DAY = C.day;
const YEAR = DAY * C.seasonDays * 4;

test('a day runs dawn, daylight, dusk, night', () => {
    assert.equal(C.dawn + C.light + C.dusk < DAY, true, 'some night is left');
    assert.equal(when(C, 0).part, 'dawn');
    assert.equal(when(C, C.dawn).part, 'day');
    assert.equal(when(C, C.dawn + C.light).part, 'dusk');
    assert.equal(when(C, C.dawn + C.light + C.dusk).part, 'night');
    assert.equal(when(C, DAY).part, 'dawn', 'a new day');
    assert.equal(when(C, 0).light, 0);
    assert.equal(when(C, C.dawn + 10).light, 1);
    assert.equal(when(C, DAY - 1).light, 0);
    assert.equal(isNight(C, DAY - 1), true);
    assert.equal(isNight(C, DAY / 3), false);
});

test('the sun rises in dawn, is highest at midday, sets in dusk, and is higher in summer', () => {
    assert.ok(when(C, 0).sun.alt < 0, 'below the horizon at first light');
    assert.ok(when(C, C.dawn).sun.alt > 0, 'up by the end of dawn');
    assert.ok(when(C, C.dawn + C.light + C.dusk).sun.alt < 0, 'down by night');
    const noon = (C.dawn / 2 + (C.dawn + C.light + C.dusk / 2)) / 2;
    const at = (season) => when(C, season * C.seasonDays * DAY + 2 * DAY + noon).sun.alt;
    assert.ok(at(1) > at(0) && at(0) > at(3), 'summer > spring > winter');
    for (let s = 0; s < DAY; s += 37) {
        const { alt } = when(C, s).sun;
        assert.ok(Number.isFinite(alt) && Math.abs(alt) < Math.PI / 2);
    }
});

test('seasons and years', () => {
    assert.equal(dateLabel(C, 0), 'Spring · day 1 · year 1');
    assert.equal(dateLabel(C, 2 * DAY + 5), 'Spring · day 3 · year 1');
    assert.equal(dateLabel(C, C.seasonDays * DAY), 'Summer · day 1 · year 1');
    assert.equal(dateLabel(C, YEAR + C.seasonDays * DAY * 3 + DAY), 'Winter · day 2 · year 2');
    const w = when(C, YEAR * 3 + 0.5 * YEAR);
    assert.equal(w.year, 4);
    assert.equal(SEASONS[w.season], 'autumn');
    assert.ok(Math.abs(w.yearT - 0.5) < 1e-9);
});

test('the moon goes round its phases', () => {
    assert.equal(when(C, 0).moon.phase, 0);
    assert.ok(Math.abs(when(C, (C.moonDays / 2) * DAY).moon.phase - 0.5) < 1e-9, 'full halfway');
    assert.ok(when(C, C.moonDays * DAY).moon.phase < 1e-9, 'new again');
});

test('each year has its winter, the same for the same seed', () => {
    const years = Array.from({ length: 400 }, (_, y) => winterOf(C, 7, y + 1));
    assert.deepEqual(years, Array.from({ length: 400 }, (_, y) => winterOf(C, 7, y + 1)));
    const share = (k) => years.filter((v) => v === k).length / years.length;
    assert.ok(Math.abs(share(0) - C.winterOdds[0]) < 0.08, `mild ${share(0)}`);
    assert.ok(Math.abs(share(1) - C.winterOdds[1]) < 0.08, `normal ${share(1)}`);
    assert.ok(share(2) > 0.1, 'some hard winters');
    assert.notDeepEqual(years.slice(0, 40), Array.from({ length: 40 }, (_, y) => winterOf(C, 8, y + 1)), 'another seed, other winters');
});
