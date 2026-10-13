// The body you are in, moved here on the page so it answers at once (spec
// §3.2): each frame it walks, sprints, creeps or rolls from the held keys,
// relative to where you look, at the simulation's own speeds, over the
// page's own copy of the land (the Mirror's terrain, the same one the engine
// uses), and the page sends the simulation where it got to. The simulation
// checks each move and, when it will not have it, says so (`snap`); then the
// body jumps back to where the simulation has it.
//
// Speeds are per step of the simulation at 1× (STEPS_PER_SECOND a second),
// whatever the frame rate:
//
//   walk     cruise × top     (0.6 × 0.7 × the speed gene, as people walk)
//   sprint   top              (Space held; costs stamina)
//   crouch   0.35 × top       (X; hard to notice)
//   roll     1.2 for 5 steps  (Space tapped: about six units; costs stamina)
//
// Stamina only limits what you can do: it is the page's alone.
import { STEPS_PER_SECOND } from '../sim.js';
import { wrap, angleDelta } from '../view3d/util.js';

// Spec §5: per step at 1×; regeneration starts half a second after the
// last spending.
export const STAMINA = { max: 100, sprint: 1, roll: 20, light: 10, heavy: 25, regen: 2, delay: 0.5 };

// s: a longer frame (a hidden tab, a stall) counts as this: 1.5 steps, well
// within what the simulation accepts in one move (about 4 steps' worth).
const MAX_DT = 0.1;
const TURN = 12;      // per second: how quickly the body turns to face its way
const SLIDE = Math.SQRT1_2;

export class Body {
    constructor() {
        this.seq = 0; // numbers every input and act this page sends, for good
        this.reset();
    }

    // Stand the body at (x, y), facing `heading`, looking the same way.
    reset(x = 0, y = 0, heading = 0) {
        this.x = x;
        this.y = y;
        this.heading = heading;
        this.yaw = heading;      // where you look: the camera's turn...
        this.pitch = 0;          // ...and tilt (positive looks down)
        this.stamina = STAMINA.max;
        this.idle = STAMINA.delay; // seconds since stamina was last spent
        this.crouch = false;
        this.rollLeft = 0;       // steps of a roll still to go
        this.rollX = 0;
        this.rollY = 0;
        this.speed = 0;          // units per step it moved at, this frame
        this.sent = null;        // what the last input message said
    }

    get rolling() {
        return this.rollLeft > 0;
    }

    nextSeq() {
        return ++this.seq;
    }

    // The direction (unit vector) the held axes ask for, relative to the
    // look: y forward, x to the right. Null when no key is held.
    wanted(ctl) {
        if (!ctl.x && !ctl.y) return null;
        const c = Math.cos(this.yaw);
        const s = Math.sin(this.yaw);
        const dx = c * ctl.y - s * ctl.x;
        const dy = s * ctl.y + c * ctl.x;
        const d = Math.hypot(dx, dy);
        return { x: dx / d, y: dy / d };
    }

    // Start a roll the way the keys point (or ahead, with none held), if
    // there is stamina and the world is not paused. True if it started.
    roll(ctl, env) {
        if (env.paused || env.still || this.rolling || this.stamina <= 0) return false;
        const dir = this.wanted(ctl) ?? { x: Math.cos(this.heading), y: Math.sin(this.heading) };
        this.spend(STAMINA.roll);
        this.rollLeft = env.rollSteps;
        this.rollX = dir.x;
        this.rollY = dir.y;
        this.heading = Math.atan2(dir.y, dir.x);
        return true;
    }

    spend(amount) {
        this.stamina = Math.max(0, this.stamina - amount);
        this.idle = 0;
    }

    // Advance `dt` seconds of real time. ctl: { x, y, sprint }: the held axes
    // (see wanted) and Space held. env: { terrain, W, H, top, cruise,
    // crouchSpeed, rollSpeed, rollSteps, paused, still, face }; `still` keeps
    // the body where it is (resting, dying), `face` says which way it turns:
    // 'move' (the way it goes), 'look' (where you look) or a bearing (a
    // locked-on target).
    update(dt, ctl, env) {
        this.speed = 0;
        if (env.paused) return;
        if (dt > MAX_DT) dt = MAX_DT;
        const steps = dt * STEPS_PER_SECOND;
        let spent = false;
        if (!env.still) {
            if (this.rolling) {
                const n = Math.min(steps, this.rollLeft);
                this.rollLeft -= n;
                this.go(this.rollX, this.rollY, env.rollSpeed * n, env);
                this.speed = env.rollSpeed;
            } else {
                const dir = this.wanted(ctl);
                if (dir) {
                    const sprint = ctl.sprint && !this.crouch && this.stamina > 0;
                    const v = sprint ? env.top : this.crouch ? env.crouchSpeed * env.top : env.cruise * env.top;
                    if (this.go(dir.x, dir.y, v * steps, env)) this.speed = v;
                    if (sprint) {
                        this.spend(STAMINA.sprint * steps);
                        spent = true;
                    }
                    if (env.face === 'move') this.turnTo(Math.atan2(dir.y, dir.x), dt);
                }
            }
        }
        if (env.face === 'look') this.heading = this.yaw;
        else if (typeof env.face === 'number' && !this.rolling) this.turnTo(env.face, dt);
        if (spent) return;
        this.idle += dt;
        if (this.idle >= STAMINA.delay) this.stamina = Math.min(STAMINA.max, this.stamina + STAMINA.regen * steps);
    }

    turnTo(angle, dt) {
        this.heading = angleDelta(this.heading + angleDelta(angle - this.heading) * (1 - Math.exp(-dt * TURN)));
    }

    // Move `d` along (ux, uy). Onto water or a cliff it does not go: it
    // turns 45° to whichever side is open (and slower, as along a wall), or
    // stays. True if it moved.
    go(ux, uy, d, env) {
        const { terrain, W, H } = env;
        let nx = wrap(this.x + ux * d, W);
        let ny = wrap(this.y + uy * d, H);
        if (terrain !== null && terrain.blocked(nx, ny)) {
            let moved = false;
            for (const side of [1, -1]) {
                const rx = (ux - side * uy) * SLIDE;
                const ry = (uy + side * ux) * SLIDE;
                const sx = wrap(this.x + rx * d * SLIDE, W);
                const sy = wrap(this.y + ry * d * SLIDE, H);
                if (!terrain.blocked(sx, sy)) {
                    nx = sx;
                    ny = sy;
                    moved = true;
                    break;
                }
            }
            if (!moved) return false;
        }
        this.x = nx;
        this.y = ny;
        return true;
    }

    // The simulation has the body elsewhere: go there.
    snap(x, y) {
        this.x = x;
        this.y = y;
        this.rollLeft = 0;
    }

    // The `input` message for this frame: where the body is, which way it
    // faces, how fast it moved and its posture. Null when nothing has changed
    // since the last one (standing still sends nothing).
    message() {
        const s = this.sent;
        if (s && Math.abs(s.x - this.x) < 1e-4 && Math.abs(s.y - this.y) < 1e-4 && Math.abs(s.heading - this.heading) < 1e-4
            && s.speed === this.speed && s.crouch === this.crouch) return null;
        const msg = { seq: this.nextSeq(), x: this.x, y: this.y, heading: this.heading, speed: this.speed, crouch: this.crouch };
        this.sent = msg;
        return msg;
    }
}
