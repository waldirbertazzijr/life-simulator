// The down slot of the equipment cross: the pouch, shown as Elden Ring
// shows its quick items. One kind of what you carry at a time (food, wood
// or flint), with its count inside the slot and a hairline along its foot of
// how full that carry is; ↓ goes on to the next kind you carry (food is
// always there), and the slot turns by itself to whatever you pick up. Dots
// under it tell the other kinds you carry. R eats food whatever it shows.
//
// Pure: what you carry comes from the simulation's report (contents), and
// what the slot shows is the page's own choice (Pouch).
export const POUCH = ['food', 'wood', 'flint'];
const NAMES = { food: 'Food', wood: 'Wood', flint: 'Flint' };
const EPS = 1e-9;

// What you carry of each kind, and the most you can: `p` the simulation's
// report on you (wood, flint, loadMax: the most wood and flint together),
// `food` what is in the pouch (hands.js carried). Food goes up to
// human.carryMax, wood and flint to loadMax (items.load until it says),
// both × a basket's carry (items.js carryOf: loadMax over items.load).
export function contents(world, p, food) {
    const per = world.p.items?.load ?? 0;
    const loadMax = p?.loadMax ?? per;
    const bag = loadMax > 0 && per > 0 ? loadMax / per : 1;
    const wood = p?.wood ?? 0;
    const flint = p?.flint ?? 0;
    return { food, wood, flint, max: { food: world.p.human.carryMax * bag, wood: loadMax, flint: loadMax }, load: wood + flint };
}

// Is there some of `kind` in `c` (contents) to show? Food always is.
const carries = (c, kind) => kind === 'food' || c[kind] > EPS;

export class Pouch {
    constructor() {
        this.kind = 'food'; // the kind in the slot
        this.who = 0;       // whose pouch it is (a new person starts on food)
        this.seen = null;   // what they carried at the last look
    }

    reset() {
        this.kind = 'food';
        this.who = 0;
        this.seen = null;
    }

    // ↓: the next kind you carry after the one shown (empty ones passed by).
    cycle(c) {
        const at = POUCH.indexOf(this.kind);
        for (let k = 1; k <= POUCH.length; k++) {
            const next = POUCH[(at + k) % POUCH.length];
            if (carries(c, next)) {
                this.kind = next;
                break;
            }
        }
        return this.kind;
    }

    // Each frame, with person `id`'s contents `c` (once the simulation
    // reports on them): turn to a kind that has just grown (picked up: food
    // gathered or cut, wood chopped, flint knapped), and back to food from a
    // kind gone empty (stored at the rack).
    keep(id, c) {
        if (id !== this.who) {
            this.reset();
            this.who = id;
        } else if (this.seen) {
            for (const k of POUCH) if (c[k] > this.seen[k] + EPS) this.kind = k;
        }
        if (!carries(c, this.kind)) this.kind = 'food';
        this.seen = { food: c.food, wood: c.wood, flint: c.flint };
    }

    // What the slot shows (hud.js showPouch): the kind, its count and the
    // most (whole ones), how full that carry is (0..1), whether no more
    // fits (wood and flint share one load), the other kinds carried, and
    // how the name under the cross reads it ('Wood 5 / 8').
    view(c) {
        const kind = carries(c, this.kind) ? this.kind : 'food';
        const most = c.max[kind];
        const count = Math.floor(c[kind] + EPS);
        const max = Math.floor(most + EPS);
        const fill = most > 0 ? Math.min(1, c[kind] / most) : 0;
        const full = kind === 'food' ? most > 0 && c.food >= most - EPS : most > 0 && c.load >= most - EPS;
        const others = POUCH.filter((k) => k !== kind && (k === 'food' ? c.food >= 1 : c[k] > EPS));
        return { kind, count, max, fill, full, others, name: `${NAMES[kind]} ${count} / ${max}` };
    }
}
