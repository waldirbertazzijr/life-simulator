// What E does where you stand, and the words the HUD's prompt gives it.
// Pure: it reads the world (the Mirror) and what you carry, and sends
// nothing; hands.js does what it says (interact), hud-state.js shows it.
//
// One rule, in this order: butcher a kill of yours within reach; pick up an
// item lying at your feet; at the rack (by the camp's centre), store what
// you carry (food, wood, flint), or with empty hands take food for the road;
// pick up an item a little farther off; in camp, rest; outside it, in forest
// chop wood and on rock or tundra knap flint (while the load has room: the
// simulation's own test of the ground, items.js handWork, on the Mirror's
// land); elsewhere, on grass worth it, gather.
//
// A new context: its place in contextAt, its words in SAY, and what E does
// with it in hands.js (interact).
import { TASK, handWork } from '../items.js';
import { itemsOn, nearestLying, pickupText, rarityName } from './gear.js';
import { HANDS, ITEMS } from './aim.js';
import { wrapDelta } from '../view3d/util.js';

// Chopping and knapping are gathering to the simulation (act 'gather': it
// decides by the ground underfoot, as contextAt does), and what each
// gathers.
const WORK = { [TASK.WOOD]: 'chop', [TASK.FLINT]: 'knap' };
export const GATHERS = { gather: 'food', chop: 'wood', knap: 'flint' };

// What E would do at `at` = { x, y, tribe (its id), carry (food), load:
// { wood, flint, max } }: { kind, id?, item?, amount?, wood?, flint? }, or
// null.
export function contextAt(world, at) {
    const w = world;
    const P = w.p.human;
    const Q = w.p.play ?? HANDS;
    let best = null;
    let bestD = Q.butcherReach ?? HANDS.butcherReach;
    for (const c of w.carcasses ?? []) {
        const d = Math.hypot(wrapDelta(c.x - at.x, w.width), wrapDelta(c.y - at.y, w.height));
        if (d <= bestD) {
            best = c;
            bestD = d;
        }
    }
    if (best) return { kind: 'butcher', id: best.id };
    // An item lying at your feet comes next; one a little farther off,
    // only where the rack has nothing to offer.
    const lying = itemsOn(w) ? nearestLying(w, at.x, at.y, w.p.items?.pickReach ?? ITEMS.reach) : null;
    const pick = lying ? { kind: 'pickup', id: lying.item.id, item: lying.item } : null;
    if (pick && lying.d <= ITEMS.feet) return pick;
    const { carry, load } = at;
    const t = w.tribeById.get(at.tribe);
    if (t) {
        const d2 = wrapDelta(t.camp.x - at.x, w.width) ** 2 + wrapDelta(t.camp.y - at.y, w.height) ** 2;
        if (d2 <= (Q.rackReach ?? HANDS.rackReach) ** 2) {
            if (carry >= 1 || load.wood > 0 || load.flint > 0) {
                const what = { kind: 'store', amount: Math.floor(carry) };
                if (load.wood > 0) what.wood = load.wood;
                if (load.flint > 0) what.flint = load.flint;
                return what;
            }
            const amount = Math.floor(Math.min(Q.takeMax ?? HANDS.takeMax, t.store, P.carryMax - carry));
            if (amount >= 1) return { kind: 'take', amount };
        }
        if (pick) return pick;
        if (d2 < P.campRadius * P.campRadius) return { kind: 'rest' };
    }
    if (pick) return pick;
    const work = WORK[handWork(w, at.x, at.y, t)];
    if (work) return load.wood + load.flint < load.max - 1e-9 ? { kind: work } : null;
    const g = w.grass;
    if (g && g.g[g.index(at.x, at.y)] >= P.gatherMin && carry < P.carryMax) return { kind: 'gather' };
    return null;
}

// The prompt at the rack with something to store: 'Store 30 food, 3 wood'
// (a material less than one is named without a number).
function storeText({ amount, wood = 0, flint = 0 }) {
    const parts = amount >= 1 ? [`${amount} food`] : [];
    for (const [name, v] of [['wood', wood], ['flint', flint]]) if (v > 0) parts.push(v >= 1 ? `${Math.floor(v)} ${name}` : name);
    return `Store ${parts.join(', ')}`;
}

// E's words for each context (a word, or one made from it).
const SAY = {
    butcher: 'Butcher',
    store: storeText,
    take: (what) => `Take ${what.amount} food`,
    rest: 'Rest at camp',
    pickup: (what) => pickupText(what.item),
    chop: 'Chop wood',
    knap: 'Knap flint',
    gather: 'Gather',
};

// And while the hands are at it: how to stop (the work bar above names
// what they are at). Held acts stop when E is let go; gathering, with E again.
export const DOING = { butcher: 'Let go to stop', gather: 'Stop', chop: 'Let go to stop', knap: 'Let go to stop' };

// The prompt's E for a context: ['E', its words], and the colour they read
// in for an item's rarity.
export function sayE(what) {
    const say = SAY[what.kind] ?? SAY.gather;
    const text = typeof say === 'function' ? say(what) : say;
    return what.kind === 'pickup' && what.item.rarity > 0 ? ['E', text, rarityName(what.item.rarity)] : ['E', text];
}
