// Camera work for the home screen (home/home.js): the map camera
// (camera.js) steered frame by frame, as a film camera is. A shot is where
// the camera should be at a moment, { fx, fz (the point looked at), yaw,
// pitch (the map's own tilt: camera.js flattens it near the ground), dist };
// the shots:
//
//   dawn     a slow drift over a valley at dawn, looking toward the sunrise
//   camp     a camp, held above the cards, the camera slowly circling it
//   person   someone, followed as they go, circling slowly
//   overview the whole world, as a new world's map starts (then let go)
//
// Going from one shot to the next is a flight: eased in and out, rising on
// the way when the way is long, so the land passes under. Once there the
// camera keeps to the shot. The camera's own glide (camera.js) smooths
// whatever is left. No three.js and no DOM: node tests it.
import { TAU, DEG, wrap, wrapDelta, angleDelta, clamp01 } from './util.js';

// The shots' framing: how far, how steep, how fast they turn (radians a
// second) and, for the dawn, how far it drifts and how slowly.
export const SHOTS = {
    dawn: { dist: 210, pitch: 15 * DEG, sway: 0.22, swayPeriod: 150, wander: 45, wanderPeriod: 110, breathe: 0.08 },
    camp: { dist: 125, pitch: 24 * DEG, turn: 0.035, lift: 0.3 },
    person: { dist: 48, pitch: 22 * DEG, turn: 0.05, lift: 0.22, keep: 0.6 },
    overview: { pitch: 52 * DEG, yaw: -Math.PI / 2 },
};
export const FLIGHT = { seconds: 2.4, rise: 1.4, riseOver: 700 };

// Smoother than smoothstep: still at both ends, in speed and in pace.
export const ease = (u) => {
    const t = clamp01(u);
    return t * t * t * (t * (t * 6 - 15) + 10);
};

export class Cinema {
    // rig: camera.js's CameraRig (its `map`, W, H); world: the Mirror.
    constructor(rig) {
        this.rig = rig;
        this.shot = null;   // (t, world) → the wanted camera, or null: let go
        this.final = false; // the shot lets go once reached (the overview)
        this.t = 0;         // seconds into the shot
        this.flight = null; // { from, seconds, lift } while flying to it
        this.cur = { fx: 0, fz: 0, yaw: 0, pitch: 0, dist: 1 };
        this.want = { fx: 0, fz: 0, yaw: 0, pitch: 0, dist: 1 };
        this.held = null;   // the person shot's smoothed focus
    }

    get active() {
        return this.shot !== null;
    }

    // Which way the camera looks now.
    get yaw() {
        return this.shot ? this.cur.yaw : this.rig.map.yaw;
    }

    // Cut to a shot (no flight), or fly to it over `seconds`.
    cut(shot) {
        this.shot = shot;
        this.final = false;
        this.t = 0;
        this.flight = null;
    }

    fly(shot, seconds = FLIGHT.seconds, final = false) {
        const m = this.rig.map;
        const from = this.shot ? { ...this.cur } : { fx: m.fx, fz: m.fz, yaw: m.yaw, pitch: m.pitch, dist: m.dist };
        this.shot = shot;
        this.final = final;
        this.t = 0;
        this.flight = { from, seconds, lift: null };
    }

    // Let go: the map is the user's again, as it is now.
    release() {
        this.shot = null;
        this.flight = null;
    }

    // ---- The shots ----

    // Over (x, y), looking along `yaw` (toward the sunrise), drifting.
    dawn(x, y, yaw) {
        const S = SHOTS.dawn;
        return (t, out) => {
            const side = yaw + Math.PI / 2;
            const along = S.wander * Math.sin((TAU * t) / S.wanderPeriod);
            out.fx = x + Math.cos(side) * along;
            out.fz = y + Math.sin(side) * along;
            out.yaw = yaw + S.sway * Math.sin((TAU * t) / S.swayPeriod);
            out.pitch = S.pitch;
            out.dist = S.dist * (1 + S.breathe * Math.sin((TAU * t) / (S.wanderPeriod * 1.7)));
            return out;
        };
    }

    // A camp at (x, y), first seen along `yaw`, circling; the camp sits
    // above the middle (the cards are below it): the point looked at is
    // short of it.
    camp(x, y, yaw) {
        const S = SHOTS.camp;
        return (t, out) => this.around(x, y, yaw + S.turn * t, S, out);
    }

    // The person `id`, followed (smoothly: they walk, and the camera does
    // not jitter with each step), circling. Where they are gone, it holds.
    person(id, yaw, world) {
        const S = SHOTS.person;
        this.held = null;
        let last = 0;
        return (t, out) => {
            const f = world.find(id);
            if (f) {
                const x = f.pop.x[f.i];
                const y = f.pop.y[f.i];
                if (!this.held) this.held = { x, y };
                else {
                    const k = 1 - Math.exp(-(t - last) / S.keep);
                    this.held.x = wrap(this.held.x + wrapDelta(x - this.held.x, world.width) * k, world.width);
                    this.held.y = wrap(this.held.y + wrapDelta(y - this.held.y, world.height) * k, world.height);
                }
            }
            last = t;
            const h = this.held ?? { x: this.cur.fx, y: this.cur.fz };
            return this.around(h.x, h.y, yaw + S.turn * t, S, out);
        };
    }

    // The whole world, as camera.js frames a new one.
    overview() {
        const S = SHOTS.overview;
        const { rig } = this;
        return (t, out) => {
            out.fx = rig.W / 2;
            out.fz = rig.H / 2;
            out.yaw = S.yaw;
            out.pitch = S.pitch;
            out.dist = rig.map.fit;
            return out;
        };
    }

    around(x, y, yaw, S, out) {
        const short = S.dist * S.lift;
        out.fx = x - Math.cos(yaw) * short;
        out.fz = y - Math.sin(yaw) * short;
        out.yaw = yaw;
        out.pitch = S.pitch;
        out.dist = S.dist;
        return out;
    }

    // ---- Each frame (before camera.js's update) ----

    update(dt) {
        if (!this.shot) return;
        const { rig } = this;
        // A last flight (to the overview) gives way to a hand on the map.
        if (this.final && (rig.pointers?.size || rig.keys?.any)) {
            this.release();
            return;
        }
        const W = rig.W;
        const H = rig.H;
        this.t += dt;
        const want = this.shot(this.t, this.want);
        const cur = this.cur;
        const fl = this.flight;
        if (fl) {
            const { from } = fl;
            const dx = wrapDelta(want.fx - from.fx, W);
            const dz = wrapDelta(want.fz - from.fz, H);
            if (fl.lift === null) fl.lift = FLIGHT.rise * clamp01(Math.hypot(dx, dz) / FLIGHT.riseOver);
            const u = ease(this.t / fl.seconds);
            cur.fx = wrap(from.fx + dx * u, W);
            cur.fz = wrap(from.fz + dz * u, H);
            cur.yaw = from.yaw + angleDelta(want.yaw - from.yaw) * u;
            cur.pitch = from.pitch + (want.pitch - from.pitch) * u;
            cur.dist = Math.exp(Math.log(from.dist) + (Math.log(want.dist) - Math.log(from.dist)) * u) * (1 + fl.lift * Math.sin(Math.PI * u));
            if (this.t >= fl.seconds) {
                this.flight = null;
                Object.assign(cur, want); // (there, exactly)
            }
        } else Object.assign(cur, want);
        const m = rig.map;
        m.fx = cur.fx;
        m.fz = cur.fz;
        m.yaw = cur.yaw;
        m.pitch = cur.pitch;
        m.dist = cur.dist;
        m.track = false;
        if (this.final && !this.flight) this.release();
    }
}

// Where the home screen's dawn is filmed: the camp lying deepest in its
// valley, wet ground counting for it (`land`: words.js landOf per camp,
// [{ camp, land }]); null with none.
export function valleyOf(camps) {
    let best = null;
    let bestScore = -Infinity;
    for (const c of camps) {
        if (!c.land) continue;
        const score = c.land.below + 0.5 * c.land.wet + 0.2 * c.land.forest;
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }
    return best;
}
