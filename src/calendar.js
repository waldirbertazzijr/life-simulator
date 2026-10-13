// The calendar (stage 4): days, seasons and years, read from the world's step
// count alone. The simulation and the page both use it (the page with the
// Mirror's time), so the sun the page draws and the night the simulation
// lives by are the same night. Nothing here draws a random number: a year's
// winter comes from a hash of the seed and the year.
//
// A day begins at the first light of dawn (step 0 of a world is dawn on the
// first day of spring, year 1) and runs dawn, daylight, dusk, night. With the
// defaults (params.calendar) a day is 5 minutes at 1× (15 steps a second): 30 s
// of dawn, 2.5 min of daylight, 30 s of dusk and 1.5 min of night; a season is
// 6 days, a year 4 seasons (about 2 hours).

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
export const WINTERS = ['mild', 'normal', 'hard'];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// Everything about the moment `time` (a step count; the page may pass a
// fractional one), by the calendar `c` (params.calendar):
//   day        days since the world began (0 on the first)
//   year       1, 2, ...
//   season     0..3 (SEASONS), and seasonT, how far into it (0..1)
//   dayOfSeason  1..seasonDays
//   yearT      how far into the year (0..1; 0 is the first dawn of spring)
//   t          how far into the day (0..1; 0 is the first light of dawn)
//   part       'dawn' | 'day' | 'dusk' | 'night'
//   light      daylight, 0 at night .. 1 from the end of dawn to the start of dusk
//   sun        {alt, az}: its height (radians; below 0 under the horizon) and
//              bearing (radians, 0 = east, rising in the east and setting in
//              the west); it rises halfway through dawn and sets halfway
//              through dusk, and climbs higher in summer than in winter
//   moon       {phase, alt, az}: phase 0 new .. 0.5 full .. 1 new; new, it
//              rides with the sun; full, opposite it all night
export function when(c, time) {
    const day = Math.floor(time / c.day);
    const t = (time - day * c.day) / c.day;
    const yearDays = c.seasonDays * 4;
    const dayOfYear = day % yearDays;
    const yearT = (dayOfYear + t) / yearDays;
    const season = Math.floor(dayOfYear / c.seasonDays);
    const seasonT = (dayOfYear - season * c.seasonDays + t) / c.seasonDays;
    const dawn = c.dawn / c.day;
    const dusk0 = (c.dawn + c.light) / c.day; // dusk begins
    const night0 = (c.dawn + c.light + c.dusk) / c.day; // night begins
    const part = t < dawn ? 'dawn' : t < dusk0 ? 'day' : t < night0 ? 'dusk' : 'night';
    const light = t < dawn ? smooth(t / dawn) : t < dusk0 ? 1 : t < night0 ? 1 - smooth((t - dusk0) / (night0 - dusk0)) : 0;
    // The sun: up from the middle of dawn to the middle of dusk, its noon
    // height following the year (highest at midsummer, lowest at midwinter).
    const rise = dawn / 2;
    const set = (dusk0 + night0) / 2;
    const peak = (c.noon + c.tilt * Math.cos(TAU * (yearT - 0.375))) * DEG;
    const u = t < rise ? t + 1 - rise : t - rise; // time since sunrise (wrapping past midnight)
    const span = set - rise;
    const alt = u <= span ? Math.sin((Math.PI * u) / span) * peak : -Math.sin((Math.PI * (u - span)) / (1 - span)) * peak;
    const az = u <= span ? (Math.PI * u) / span : Math.PI + (Math.PI * (u - span)) / (1 - span);
    // The moon: new with the sun, falling behind it a little more each day,
    // so the full moon rides opposite it all night.
    const phase = (((day + t) / c.moonDays) % 1 + 1) % 1;
    const maz = (((az - TAU * phase) % TAU) + TAU) % TAU;
    return {
        day, year: Math.floor(day / yearDays) + 1, season, seasonT, dayOfSeason: dayOfYear - season * c.seasonDays + 1,
        yearT, t, part, light,
        sun: { alt, az: az % TAU },
        moon: { phase, alt: Math.sin(maz) * c.noon * DEG, az: maz },
    };
}

// "Spring · day 3 · year 2".
export function dateLabel(c, time) {
    const w = when(c, time);
    const name = SEASONS[w.season];
    return `${name[0].toUpperCase()}${name.slice(1)} · day ${w.dayOfSeason} · year ${w.year}`;
}

// Is it night (from the end of dusk to the first light of dawn)?
export function isNight(c, time) {
    const t = (((time / c.day) % 1) + 1) % 1;
    return t >= (c.dawn + c.light + c.dusk) / c.day;
}

// How hard the winter of `year` is, for the world of `seed`: 0 mild, 1 normal,
// 2 hard (WINTERS). The same seed always has the same winters, and the odds
// are c.winterOdds ([mild, normal], the rest hard).
export function winterOf(c, seed, year) {
    let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(year | 0, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    const u = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    return u < c.winterOdds[0] ? 0 : u < c.winterOdds[0] + c.winterOdds[1] ? 1 : 2;
}
