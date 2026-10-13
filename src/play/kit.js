// Items in hand (package 3): the arrows swap in a spare, right click uses
// the tool, Shift + right click the weapon's skill (for Spirit), C at camp
// opens the craft menu (craft.js draws it); LEGEND FORGED when one of yours
// becomes a legend, a word when one breaks or is made.
//
// What you hold is the simulation's word (its report: weapon, tool, kit,
// crafting, skill; the Mirror's items): the page asks and shows. gear.js
// reads it (pure); this does what the keys ask. In a world without items,
// your weapon is the plain spear it always was.
//
// `m` is modes.js's Modes: who you are, your body, the world, the page.
import { POSE } from '../view3d/keyframes.js';
import { itemsOn, itemById, kindName, itemName, skillOf, weaponKind, cycleAct, craftRows, CRAFT_ORDER } from './gear.js';
import { HANDS, ITEMS, AIMED } from './aim.js';
import { GATHERS } from './context.js';
import { ACK_WAIT, ATTACK_POSE } from './hands.js';

const TOOL_POSE = { knife: POSE.JAB, torch: POSE.SWING };

export class Kit {
    constructor(m) {
        this.m = m;
        // The craft menu while it is open, and when a craft was asked for,
        // until the simulation shows it under way (m.clock).
        this.menu = null;        // { index, flint }
        this.craftAsked = -1;
        this.craftActions = null; // the menu's clicks (craft.js), made once
    }

    // A new world: nothing asked for, no menu.
    reset() {
        this.craftAsked = -1;
        this.menu = null;
    }

    // Put it all down (with the hands): no craft waited for, the menu shut.
    drop() {
        this.craftAsked = -1;
        this.closeCraft();
    }

    // The kind of weapon in your hand ('' for none).
    weapon() {
        return weaponKind(this.m.world, this.m.mine());
    }

    // → and ←: swap the weapon (or the tool) in hand for the next spare.
    cycle(slot) {
        const m = this.m;
        if (!itemsOn(m.world)) return false;
        const act = cycleAct(m.mine(), slot);
        if (!act) return false;
        m.world.act({ seq: m.body.nextSeq(), ...act });
        return true;
    }

    // Right click: the tool in hand. A knife cuts what is in front, a torch
    // is brandished (predators near are driven off), a basket gathers (as E
    // does: on, or off again).
    useTool() {
        const m = this.m;
        const w = m.world;
        const hands = m.hands;
        if (!itemsOn(w)) return false;
        const tool = itemById(w, m.mine()?.tool);
        const kind = tool ? kindName(tool.kind) : '';
        if (!kind) {
            m.hud.notice?.('No tool in hand', true);
            return false;
        }
        if (kind === 'basket') {
            const what = hands.doing ? null : hands.interaction()?.kind;
            if (hands.doing?.kind in GATHERS) hands.stop();
            else if (what in GATHERS) {
                m.standUp();
                hands.start(what, 0);
            }
            return true;
        }
        m.standUp();
        hands.stop();
        this.closeCraft();
        const yaw = m.body.yaw;
        const dx = Math.cos(yaw);
        const dy = Math.sin(yaw);
        const target = m.lock || (kind === 'knife' ? hands.nearest(dx, dy, ITEMS.cut, w.p.play?.jabArc ?? HANDS.jabArc) : 0);
        w.act({ seq: m.body.nextSeq(), action: 'tool', dx, dy, target });
        m.body.heading = yaw;
        m.env.pose?.(m.self, TOOL_POSE[kind] ?? POSE.JAB);
        return true;
    }

    // Shift + right click: the weapon's skill, for Spirit (spec §8.6). Turned
    // down here, with a word, when there is no skill or too little Spirit.
    useSkill() {
        const m = this.m;
        const w = m.world;
        if (!itemsOn(w)) return false;
        const p = m.mine();
        const weapon = itemById(w, p?.weapon);
        const skill = skillOf(weapon, p?.skill ?? 0);
        const f = w.find(m.self);
        if (!skill || !f) {
            m.hud.notice?.('No weapon skill', true);
            return false;
        }
        if (f.pop.age[f.i] < w.p.human.maturity) {
            m.hud.notice?.('A child cannot', true);
            return false;
        }
        if (!((p?.spirit ?? 0) >= skill.cost)) {
            m.hud.notice?.(`Not enough Spirit for ${skill.name}`, true);
            return false;
        }
        m.standUp();
        m.hands.stop();
        this.closeCraft();
        const yaw = m.body.yaw;
        const kind = kindName(weapon.kind);
        const { dx, dy, sighted } = kind === 'club' ? { dx: Math.cos(yaw), dy: Math.sin(yaw), sighted: 0 } : m.hands.sight();
        const target = m.lock || sighted || m.hands.nearest(dx, dy, kind === 'club' ? 8 : w.p.play?.heavyRange ?? HANDS.heavyRange, kind === 'club' ? Math.PI : AIMED);
        w.act({ seq: m.body.nextSeq(), action: 'skill', dx, dy, target, lock: m.lock !== 0 || (sighted !== 0 && target === sighted) });
        m.body.heading = yaw;
        m.env.pose?.(m.self, ATTACK_POSE[kind] ?? POSE.THROW);
        return true;
    }

    // Is something being crafted? (The simulation says so, or a craft was
    // just asked for and it has not answered yet.)
    crafting() {
        const m = this.m;
        const p = m.mine();
        if (p?.crafting) {
            this.craftAsked = -1;
            return true;
        }
        if (this.craftAsked >= 0 && m.clock - this.craftAsked <= ACK_WAIT) return true;
        this.craftAsked = -1;
        return false;
    }

    // C: the craft menu, at your camp only, for an adult not already at it.
    // While it is open the pointer is free, and its keys are the menu's.
    openCraft() {
        const m = this.m;
        const w = m.world;
        const f = w.find(m.self);
        if (!itemsOn(w) || !f) return false;
        const no = f.pop.age[f.i] < w.p.human.maturity ? 'A child cannot craft'
            : !m.atCamp() ? 'Craft at your camp'
            : this.crafting() ? 'Already crafting'
            : null;
        if (no) {
            m.hud.notice?.(no, true);
            return false;
        }
        m.standUp();
        m.hands.stop();
        const rows = craftRows(w.tribeById.get(m.tribe), w.p, false);
        this.menu = { index: Math.max(0, rows.findIndex((r) => r.can)), flint: false };
        m.input.capture = (code, repeat) => this.craftKey(code, repeat);
        m.input.unlock?.();
        this.showCraft();
        return true;
    }

    // Shut the menu (relock: the pointer is taken again, for a key or click
    // that counts as the user's gesture).
    closeCraft(relock = false) {
        if (!this.menu) return;
        const m = this.m;
        this.menu = null;
        m.input.capture = null;
        m.hud.craftMenu?.(null);
        if (relock) m.input.lock?.();
    }

    showCraft() {
        const m = this.m;
        const menu = this.menu;
        const rows = craftRows(m.world.tribeById.get(m.tribe), m.world.p, menu.flint);
        m.hud.craftMenu?.({ rows, index: menu.index, flint: menu.flint }, this.craftActions ??= {
            pick: (kind) => this.craftKind(kind),
            hover: (index) => {
                if (this.menu && this.menu.index !== index) {
                    this.menu.index = index;
                    this.showCraft();
                }
            },
            flint: () => {
                if (!this.menu) return;
                this.menu.flint = !this.menu.flint;
                this.showCraft();
            },
        });
    }

    // The menu's keys: ↑ ↓ choose, Enter crafts, F (or ← →) adds a flint,
    // 1–6 craft at once, Esc or C close. Others pass (a move closes it).
    craftKey(code, repeat) {
        const menu = this.menu;
        if (!menu) return false;
        const n = CRAFT_ORDER.length;
        if (code === 'ArrowUp' || code === 'ArrowDown') {
            menu.index = (menu.index + (code === 'ArrowUp' ? n - 1 : 1)) % n;
            this.showCraft();
            return true;
        }
        if (repeat) return code === 'Enter' || code === 'NumpadEnter';
        if (code === 'Enter' || code === 'NumpadEnter') {
            this.craftKind(CRAFT_ORDER[menu.index]);
            return true;
        }
        if (code === 'KeyF' || code === 'ArrowLeft' || code === 'ArrowRight') {
            menu.flint = !menu.flint;
            this.showCraft();
            return true;
        }
        if (code === 'Escape' || code === 'KeyC') {
            this.closeCraft();
            return true;
        }
        const digit = /^Digit([1-9])$/.exec(code);
        if (digit && Number(digit[1]) <= n) {
            this.craftKind(CRAFT_ORDER[Number(digit[1]) - 1]);
            return true;
        }
        return false;
    }

    // Craft `kind` (with the menu's flint), if the store can pay for it.
    craftKind(kind) {
        const m = this.m;
        const menu = this.menu;
        if (!menu) return false;
        const row = craftRows(m.world.tribeById.get(m.tribe), m.world.p, menu.flint).find((r) => r.kind === kind);
        if (!row) return false;
        if (!row.can) {
            m.hud.notice?.(`The store lacks ${row.text}`, true);
            return false;
        }
        m.world.act({ seq: m.body.nextSeq(), action: 'craft', kind, flint: menu.flint });
        this.craftAsked = m.clock;
        this.closeCraft(true);
        return true;
    }

    // What happened to items of yours ('legend', 'broke' and 'crafted'
    // events): LEGEND FORGED; a word when one breaks, or is made.
    itemEvent(e) {
        const m = this.m;
        if (!m.self) return;
        const item = itemById(m.world, e.item);
        if (e.type === 'legend' && e.bearer === m.self) m.hud.banner('legend', e.name ?? itemName(item));
        else if (e.type === 'broke' && e.bearer === m.self) {
            m.hud.notice?.(`Your ${item ? itemName(item).replace(/^Plain /, '').toLowerCase() : kindName(e.kind)} broke`, true);
        } else if (e.type === 'crafted' && e.by === m.self) {
            const name = item ? itemName(item) : kindName(e.kind);
            m.hud.notice?.(e.rarity >= 1 ? `Made: ${name} (rare)` : `Made: ${name.replace(/^Plain /, 'a ').toLowerCase()}`);
        }
    }
}
