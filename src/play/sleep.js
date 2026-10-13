// Resting at camp, and at night sleeping until dawn (stage 4, §1.3). By day
// "Rest at camp" sits you down and runs the world at REST_SPEED; at night it
// reads "Sleep until dawn", lays you down, and runs it at SLEEP_SPEED until
// the first light, when you rise and it is back to 1× (any move wakes you
// sooner). It is the same rest act either way; the simulation knows the
// night too, and puts the sleeper in STATE.SLEEPING.
//
// Pure: it reads the world (the Mirror) and the page's clock (almanac.js).
import { isNight } from '../calendar.js';
import { clockOf, nightDone } from '../view3d/almanac.js';

export const REST_SPEED = 16;
export const SLEEP_SPEED = 64;

// Is it night, as the page shows it?
export const nightNow = (world) => !!world.p?.calendar && isNight(world.p.calendar, clockOf(world));

// The world's speed while resting: asleep at night, or sitting by day.
export const restSpeed = (asleep) => (asleep ? SLEEP_SPEED : REST_SPEED);

// The work bar while asleep (hud-state.js): how much of the night is gone.
export function sleepWork(world) {
    const done = nightDone(world.p.calendar, clockOf(world));
    return { label: 'Sleeping', progress: done < 0 ? 1 : done };
}
