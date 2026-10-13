// What people carry, as the page sees it (spec §8): the kinds of items and
// what they cost, their names and rarities, the HUD's equipment cross, the
// craft menu's choices, cycling the spares, what lies within reach, and the
// god view's list of legends. Pure: no DOM, no three.js (tested in node).
//
// The simulation's side is src/items.js. What reaches the page (the
// Mirror): `items`, a Map id → {id, kind, rarity, trait, mult, maker, tribe,
// made, legend, bearer, x, y, wear (0..1), kills}; `byBearer`, person id →
// {weapon, tool}; `legends`, the legendary items, newest first; each tribe's
// `wood`, `flint` and `hide`; and on `player`: `weapon` and `tool` (ids),
// `kit: {weapons, tools}` (the spares' ids), `crafting: {kind, until} |
// null` (done at world time `until`) and `skill` (the held weapon's skill's
// Spirit cost). Kinds are KIND codes (indices into ITEM_KINDS). A world
// without items (items.enabled off) shows what it always did: a plain spear
// in every hand.
import { personName } from './names.js';
import { ITEM_KINDS, SKILLS, costOf as costOfCode, affords } from '../items.js';

export { ITEM_KINDS };
export const RARITY = ['normal', 'rare', 'legendary'];
export const MATERIALS = ['wood', 'flint', 'hide'];

// A kind's name, from its KIND code (or a name already).
export const kindName = (k) => (typeof k === 'number' ? ITEM_KINDS[k] ?? '' : k ?? '');
export const kindCode = (k) => (typeof k === 'number' ? k : ITEM_KINDS.indexOf(k));
export const rarityName = (r) => RARITY[r] ?? 'normal';
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// What each kind costs to make (the simulation's params.items.costs, by
// name here); adding one flint gives a chance of rare.
export const CRAFT_ORDER = ['spear', 'bow', 'club', 'knife', 'basket', 'torch'];
export const costOf = (p, kind) => costOfCode(p, kindCode(kind));

// A rare item is named for what it does better (`trait`); a legend by its
// own name.
const TRAITS = { range: 'Long', accuracy: 'True', reload: 'Swift', durability: 'Stout' };
const EFFECT = { knife: 'Keen', basket: 'Deep', torch: 'Bright' };

export function itemName(item) {
    if (!item) return '';
    const kind = kindName(item.kind);
    if (item.rarity >= 2 && item.legend?.name) return item.legend.name;
    if (item.rarity >= 1) return `${TRAITS[item.trait] ?? (item.trait === 'effect' ? EFFECT[kind] : null) ?? 'Fine'} ${kind}`;
    return `Plain ${kind}`;
}

// The skill of a weapon, {name, cost}, or null: its kind's (items.js's
// SKILLS), a legend's under its own name (legend.skill). `cost`: the
// simulation's word for it, if it has said.
export function skillOf(item, cost = 0) {
    const s = item ? SKILLS[kindCode(item.kind)] : null;
    if (!s) return null;
    const name = item.rarity >= 2 && item.legend?.skill ? item.legend.skill : s.name;
    return { name, cost: cost > 0 ? cost : s.cost };
}

// Are items in this world (the simulation sends them, and they are on)?
export const itemsOn = (world) => world.items instanceof Map && world.p?.items?.enabled !== false;

export const itemById = (world, id) => (id && world.items instanceof Map ? world.items.get(id) ?? null : null);

// ---- The equipment cross (hud.js) ----

// One slot: {id, kind, rarity, wear (0..1), spares, name}, or null if empty.
function slotOf(item, spares) {
    if (!item) return null;
    return {
        id: item.id, kind: kindName(item.kind), rarity: rarityName(item.rarity),
        wear: item.rarity >= 2 ? 1 : Math.min(1, Math.max(0, item.wear ?? 1)), spares, name: itemName(item),
    };
}
const LEGACY = Object.freeze({ id: 0, kind: 'spear', rarity: 'normal', wear: 1, spares: 0, name: 'Plain spear', legacy: true });

// What the cross shows for the controlled person `p` (the simulation's
// report, or null): the weapon (→) and the tool (←) with their spares, the
// weapon's skill, and what is being crafted ({kind, progress 0..1}).
export function equipment(world, p) {
    if (!itemsOn(world)) return { on: false, weapon: LEGACY, tool: null, skill: null, crafting: null };
    const kit = p?.kit ?? null;
    const weapon = itemById(world, p?.weapon);
    const tool = itemById(world, p?.tool);
    let crafting = null;
    if (p?.crafting) {
        const left = (p.crafting.until ?? 0) - (world.time ?? 0);
        const steps = world.p?.items?.craftSteps ?? 150;
        crafting = { kind: kindName(p.crafting.kind), progress: Math.min(1, Math.max(0, 1 - left / steps)) };
    }
    return {
        on: true,
        weapon: slotOf(weapon, kit?.weapons?.length ?? 0),
        tool: slotOf(tool, kit?.tools?.length ?? 0),
        skill: skillOf(weapon, p?.skill ?? 0),
        crafting,
    };
}

// The weapon in hand's kind ('spear' when the world has no items), or ''
// for none.
export function weaponKind(world, p) {
    if (!itemsOn(world)) return 'spear';
    return kindName(itemById(world, p?.weapon)?.kind ?? '');
}

// ---- Cycling (← →) ----

// Swapping the held item with the next spare: the act to send, or null
// when there is no spare to swap with.
export function cycleAct(p, slot) {
    const spares = p?.kit?.[slot === 'weapon' ? 'weapons' : 'tools'] ?? [];
    return spares.length ? { action: 'cycle', slot } : null;
}

// What a swap leaves: the next spare in hand, the held one at the back of
// the spares. (The simulation's rule; the page only predicts it.)
export function cycled(held, spares) {
    if (!spares.length) return { held, spares };
    return { held: spares[0], spares: held ? [...spares.slice(1), held] : spares.slice(1) };
}

// ---- The craft menu (C at camp) ----

// '2 wood · 1 hide'
export const costText = (c) => MATERIALS.filter((m) => c[m] > 0).map((m) => `${c[m]} ${m}`).join(' · ');

// Each kind with its cost and whether the store `tribe` ({wood, flint,
// hide}) has it (items.js's affords); `flint`: one flint more for a chance
// of rare.
export function craftRows(tribe, p, flint = false) {
    return CRAFT_ORDER.map((kind) => {
        const cost = { ...costOf(p, kind) };
        if (flint) cost.flint = (cost.flint ?? 0) + 1;
        const can = !!tribe && affords(p, tribe, kindCode(kind)) && (!flint || tribe.flint >= cost.flint);
        return { kind, name: cap(kind), cost, text: costText(cost), can };
    });
}

// ---- On the ground ----

const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);

// The nearest item lying within `reach` of (x, y): {item, d}, or null.
export function nearestLying(world, x, y, reach) {
    if (!(world.items instanceof Map)) return null;
    let best = null;
    let bestD = reach;
    for (const item of world.items.values()) {
        if (item.bearer) continue;
        const d = Math.hypot(wrapDelta(item.x - x, world.width), wrapDelta(item.y - y, world.height));
        if (d <= bestD) {
            best = item;
            bestD = d;
        }
    }
    return best ? { item: best, d: bestD } : null;
}

// E's words for picking `item` up, naming it and its rarity.
export function pickupText(item) {
    const kind = kindName(item.kind);
    if (item.rarity >= 2) return `Pick up ${itemName(item)} (legendary ${kind})`;
    if (item.rarity >= 1) return `Pick up ${itemName(item)} (rare)`;
    return `Pick up ${itemName(item).toLowerCase()}`;
}

// ---- Legends (the god view's panel) ----

// One row per legendary item, newest first: its name and kind, who bears
// it (and that one's id, to follow) or that it lies on the ground, the
// tribe (the bearer's, else the one that made it), kills and generations.
export function legendRows(world) {
    const rows = [];
    for (const item of world.legends ?? []) {
        const found = item.bearer ? world.find?.(item.bearer) : null;
        const tribeId = found ? found.pop.tribe[found.i] : item.tribe;
        const tribe = world.tribeById?.get(tribeId) ?? world.fallen?.find((t) => t.id === tribeId) ?? null;
        rows.push({
            id: item.id,
            name: item.legend?.name ?? itemName(item),
            kind: kindName(item.kind),
            bearer: found ? item.bearer : 0,
            bearerName: found ? personName(item.bearer) : '',
            where: found ? personName(item.bearer) : item.bearer ? 'lost' : 'lying',
            tribe,
            kills: item.kills ?? 0,
            // (Generations of one line that have borne it: in its description.)
            gens: item.gens ?? item.legend?.gens ?? 0,
        });
    }
    return rows;
}
