// The HUD you see while in a body (spec §7), laid out as in Elden Ring and
// nothing else on screen: top left, your tribe's flag and three thin bars
// (red Life, blue Spirit, green Stamina) with a trailing segment for what
// was just lost; top centre, a compass strip with your camp, your tribe's
// standing order and your locked target; bottom left, the equipment cross
// (→ the weapon, swept over while it comes back, ← the tool, each in its
// rarity's colour with its wear and spares; ↓ the pouch, one kind of what
// you carry at a time with its count and how full, and dots for the others;
// the top slot, your call; above, the weapon's skill and its Spirit; below,
// its name, or the pouch's while it shows wood or flint); bottom centre,
// what E and R (or P) would do, above it the work under way (butchering,
// crafting, chopping...) with a bar filling, and above that your tribe's
// answer to a call (or a word about your items); bottom right, your
// tribe's store, food and (with items) wood, flint and hide; a dot in the
// middle, a ring on the locked target, and a red edge when you are bitten;
// the craft menu (craft.js) in the middle when open. Banners (YOU DIED,
// your line continuing, LEGEND FORGED, your line ended, with the story)
// sit in a layer of their own, also seen from the map, as are the answers
// to calls.
//
// The markup and styles are in index.html; this fills them in. What it
// shows comes each frame from hud-state.js as one plain object.
import { drawFlag } from '../flag.js';

// Trailing segments: what was lost stays for `hold` seconds, then shrinks at
// `rate` (a bar's length a second). Drops smaller than `step` in a frame (a
// sprint's steady drain) do not restart the hold.
const TRAIL = { hold: 0.6, rate: 0.5, step: 0.02 };
export const COMPASS_SPAN = 180; // degrees across the compass strip

const BANNER_MS = { died: 3400, line: 4800, legend: 5200 };
const TITLES = { died: 'YOU DIED', ended: 'YOUR LINE HAS ENDED', legend: 'LEGEND FORGED' };
const SUBTITLED = new Set(['died', 'legend']); // (their text goes under the title)
const NOTICE_MS = 3200; // a call's answer stays this long (calls.js)

// The calls' signs in the top slot (36 × 36, drawn like the others): a horn,
// a mark on the ground, a sprig, a shield, a flag on the move, a log, a
// knapped stone.
const CALL_ICONS = {
    rally: '<path d="M7 15.5h3.5L25 9v18l-14.5-6.5H7z"/><path d="M12 21c0 3.6 3.4 5.6 7.5 5"/><path d="M28.5 13.5c1.6 2.6 1.6 6.4 0 9"/>',
    hunt: '<circle cx="18" cy="18" r="7"/><path d="M18 5v6M18 25v6M5 18h6M25 18h6"/><circle cx="18" cy="18" r="0.8"/>',
    gather: '<path d="M18 30V13"/><path d="M18 22c-5 0-8.5-3-8.5-8 5 0 8.5 3 8.5 8z"/><path d="M18 17.5c4.5 0 7.5-2.6 7.5-7-4.5 0-7.5 2.6-7.5 7z"/>',
    defend: '<path d="M18 6.5 27.5 10v7.5c0 6.5-4.2 10.6-9.5 12.5-5.3-1.9-9.5-6-9.5-12.5V10z"/><path d="M18 11v15"/>',
    move: '<path d="M11 30V7"/><path d="M11 8h13l-3.5 4 3.5 4H11"/><path d="M16 26h11m-3-3 3 3-3 3"/>',
    wood: '<path d="M6.3 24.3 23.4 7.2"/><path d="M12.6 30.6 29.7 13.5"/><circle cx="26.55" cy="10.35" r="4.45"/><circle cx="9.45" cy="27.45" r="4.45"/><circle cx="9.45" cy="27.45" r="1.6"/>',
    flint: '<path d="M7.2 24.3 13.5 9l11.7-2.7 5.4 12.6-8.1 11.7H10.8z"/><path d="M13.5 9l3.6 10.8 8.1-13.5M17.1 19.8l5.4 10.8"/>',
};

// The items' signs (36 × 36, drawn like the others): a spear, a bow with its
// arrow, a club, a knife, a basket, a torch.
export const ITEM_ICONS = {
    spear: '<path d="M7 29 25.5 10.5"/><path d="M25.5 10.5 30 6l-1.2 5.8-3.3-1.3z"/><path d="M9.5 24.5l2 2"/>',
    bow: '<path d="M11 5c10.5 3.5 15 8.5 15 13s-4.5 9.5-15 13"/><path d="M11 5v26"/><path d="M7 18h22.5"/><path d="M30 18l-3.2-2.2v4.4z"/><path d="M7 18l-1.8-2M7 18l-1.8 2"/>',
    club: '<path d="M7 30.5l8.6-8.6"/><path d="M15.2 23.6C13.6 20 17.4 12.6 22.6 8.4c3-2.4 6.6-2.2 6.8 1 .2 3.8-5.4 10-9.6 12.8-2 1.4-3.8 2.1-4.6 1.4z"/><path d="M21 13.5l1.4.4M24.5 12.6l.6 1.2M19.6 17.8l1.3.3"/>',
    knife: '<path d="M6.6 27.4l3.4-3.4 2 2-3.4 3.4z"/><path d="M9.6 21.4l5 5"/><path d="M12.6 24 29.2 7.6c.9 5.6-3.6 12-12.6 18.4z"/>',
    basket: '<path d="M7.5 15.5h21l-2.8 13.5H10.3z"/><path d="M12 15.5c0-5.2 2.7-8.5 6-8.5s6 3.3 6 8.5"/><path d="M8.8 21.5h18.4"/><path d="M14 15.5l1 13.5M22 15.5l-1 13.5"/>',
    torch: '<path d="M13.6 31.5l4.8-14"/><path d="M16.6 19.8l5.8 2M17.5 17.2l5.8 2"/><path d="M20.6 15.8c-3.8-2-4-7-.4-10.8 0 2.8 2.1 3.4 3 1.3 2.8 3 2.6 8-1 9.6"/>',
};

// What the pouch's slot can show (pouch.js): a pouch of food, a log, a
// knapped stone (the calls' own signs for the last two).
const POUCH_ICONS = {
    food: '<path d="M13 11.5c-4 3.5-6 8-5 12.5 1 4.2 5.2 6 10 6s9-1.8 10-6c1-4.5-1-9-5-12.5"/><path d="M12.5 11.5h11"/><path d="M14.5 11.5 13 7.5h10l-1.5 4"/>',
    wood: CALL_ICONS.wood,
    flint: CALL_ICONS.flint,
};

export class TrailBar {
    constructor() {
        this.value = 1;
        this.trail = 1;
        this.wait = 0;
    }

    // The bar now shows `v` (0..1), `dt` seconds after the last time.
    set(v, dt) {
        if (v >= this.trail) {
            this.trail = v;
            this.wait = 0;
        } else {
            if (this.value - v > TRAIL.step) this.wait = TRAIL.hold;
            if (this.wait > 0) this.wait -= dt;
            else this.trail = Math.max(v, this.trail - TRAIL.rate * dt);
        }
        this.value = v;
    }
}

// The compass bearing, in degrees (0 north, 90 east), of a direction in the
// world (an angle as atan2(dy, dx) gives it). North is up the map: −y.
export const bearing = (angle) => ((((angle * 180) / Math.PI + 90) % 360) + 360) % 360;

// Where the bearing `b` falls on a strip `width` wide that shows `span`
// degrees around the bearing `facing` (from its left edge), or null when it
// is off the strip.
export function stripX(b, facing, width, span = COMPASS_SPAN) {
    const d = ((((b - facing) % 360) + 540) % 360) - 180;
    if (Math.abs(d) > span / 2) return null;
    return width / 2 + (d / span) * width;
}

const LETTERS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

export class Hud {
    constructor(doc = document) {
        this.doc = doc;
        const $ = (id) => doc.getElementById(id);
        this.$ = $;
        this.root = $('hud');
        this.weapon = $('hud-weapon');
        this.flagCanvas = $('hud-flag');
        this.compass = $('hud-compass');
        this.flashEl = $('hud-flash');
        this.layer = $('banners');
        this.story = $('story');
        this.bars = {};
        for (const k of ['life', 'spirit', 'stamina']) {
            const el = this.root.querySelector(`.vbar.${k}`);
            this.bars[k] = { bar: new TrailBar(), fill: el.querySelector('.fill'), trail: el.querySelector('.trail') };
        }
        this.shown = { name: null, age: null, date: null, flag: null, store: null, prompt: null, reload: null, charge: null, call: null, gear: null, item: null, mats: null, pouch: null, work: null };
        this.toolSlot = $('hud-tool');
        this.pouchSlot = $('hud-pouch');
        this.workEl = $('hud-work');
        this.callSlot = this.root.querySelector('.slot.up');
        this.callName = $('hud-call');
        this.noticeEl = $('notice');
        this.noticeTimer = 0;
        // The compass draws text in the HUD's face: ask for it now.
        try {
            doc.fonts?.load('500 14px "EB Garamond"').catch(() => {});
        } catch {
            // (no font loading here)
        }
        $('story-again').addEventListener('click', () => this.storyActions?.again());
        $('story-watch').addEventListener('click', () => this.storyActions?.watch());
    }

    show(on) {
        this.root.hidden = !on;
        if (!on) this.flashEl.classList.remove('on');
    }

    // A frame's worth of what to show (hud-state.js, by way of modes.js's drawHud).
    update(s, dt) {
        const $ = this.$;
        const shown = this.shown;
        if (s.name !== shown.name) $('hud-name').textContent = shown.name = s.name;
        if (s.age !== shown.age) $('hud-age').textContent = shown.age = s.age;
        if (s.date !== shown.date) $('hud-date').textContent = shown.date = s.date ?? '';
        if (s.tribe?.flag !== shown.flag) {
            shown.flag = s.tribe?.flag ?? null;
            const c = this.flagCanvas;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, c.width, c.height);
            if (shown.flag) drawFlag(ctx, shown.flag, 0, 0, c.width, c.height);
            $('hud-tribe').textContent = s.tribe ? `of the ${s.tribe.name}` : '';
        }
        this.bar('life', s.life, dt);
        this.bar('spirit', s.spirit, dt);
        this.bar('stamina', s.stamina, dt);
        const store = Math.round(s.store);
        if (store !== shown.store) $('hud-store').textContent = shown.store = store;
        // The prompt: each key with what it would do ([['E', 'Gather'], ['R', 'Eat']]),
        // and maybe the colour it reads in (an item's rarity: ['E', 'Pick up…', 'rare']).
        const prompt = s.prompt ? s.prompt.map((p) => p.join(' ')).join(' / ') : '';
        if (prompt !== shown.prompt) {
            shown.prompt = prompt;
            const el = $('hud-prompt');
            el.hidden = !s.prompt;
            el.replaceChildren(...(s.prompt ?? []).map(([key, what, tint]) => {
                const pair = this.doc.createElement('span');
                pair.className = 'pair';
                const kbd = this.doc.createElement('kbd');
                kbd.textContent = key;
                const label = this.doc.createElement('span');
                label.textContent = what;
                if (tint) label.className = tint;
                pair.append(kbd, label);
                return pair;
            }));
        }
        // The weapon: a dark sweep over it while the spear comes back, a warm
        // glow inside it while a throw is charged.
        const reload = Math.round((s.reload ?? 0) * 200) / 200;
        if (reload !== shown.reload) this.weapon.style.setProperty('--reload', String((shown.reload = reload)));
        const charge = Math.round((s.charge ?? 0) * 50) / 50;
        if (charge !== shown.charge) this.weapon.style.setProperty('--charge', String((shown.charge = charge)));
        const ring = $('hud-ring');
        ring.hidden = !s.ring;
        if (s.ring) ring.style.transform = `translate(${s.ring.x.toFixed(1)}px, ${s.ring.y.toFixed(1)}px)`;
        this.showCall(s.call);
        this.showGear(s.gear);
        this.showPouch(s.pouch);
        this.showItem(s.item);
        this.showMaterials(s.materials);
        this.work(s.work);
        this.drawCompass(s);
    }

    // The work bar, centred just above the prompt: what your person is at
    // (hud-state.js workOf), as { label, progress (0..1) }, or null when
    // nothing is. It shows only while the work goes on, and fades out with
    // what it last showed. Any timed act can use it: give its label and how
    // far along it is.
    work(w) {
        const key = w ? `${w.label}:${Math.round(w.progress * 500)}` : '';
        if (key === this.shown.work) return;
        this.shown.work = key;
        const el = this.workEl;
        el.classList.toggle('on', !!w);
        if (!w) return;
        const what = el.querySelector('.what');
        if (what.textContent !== w.label) what.textContent = w.label;
        el.style.setProperty('--done', Math.min(1, Math.max(0, w.progress)).toFixed(3));
    }

    // The pouch, the cross's down slot (pouch.js view): the kind it shows,
    // with its count in the corner and a hairline along its foot of how
    // full that carry is (gold when no more fits), and under it a dot for
    // each other kind you carry.
    showPouch(pc) {
        if (!pc) return;
        const key = `${pc.kind}:${pc.count}:${pc.max}:${Math.round(pc.fill * 100)}:${pc.full}:${pc.others.join(',')}`;
        if (key === this.shown.pouch) return;
        this.shown.pouch = key;
        const el = this.pouchSlot;
        const icon = el.querySelector('.icon');
        if (icon.dataset.kind !== pc.kind) {
            icon.dataset.kind = pc.kind;
            icon.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true">${POUCH_ICONS[pc.kind] ?? ''}</svg>`;
        }
        el.querySelector('.count').textContent = pc.count;
        const fill = el.querySelector('.fill');
        fill.style.setProperty('--fill', pc.fill.toFixed(3));
        fill.classList.toggle('full', pc.full);
        el.title = `${pc.name} — Pouch (↓ to change, R to eat)`;
        this.$('hud-pouch-dots').replaceChildren(...pc.others.map((kind) => {
            const dot = this.doc.createElement('span');
            dot.className = kind;
            return dot;
        }));
    }

    // The name under the cross (hud-state.js crossName): { text, tint }, the
    // tint a rarity's colour or ''.
    showItem(item) {
        if (!item) return;
        const key = `${item.text}|${item.tint}`;
        if (key === this.shown.item) return;
        this.shown.item = key;
        const el = this.$('hud-item');
        el.textContent = item.text;
        el.className = `item ${item.tint}`;
    }

    // ---- Items (play/gear.js's equipment()) ----

    // The cross's weapon (→) and tool (←) slots, and the skill above.
    // (What is being crafted shows on the work bar.)
    showGear(g) {
        if (!g) return;
        const slotKey = (x) => (x ? `${x.id}:${x.kind}:${x.rarity}:${Math.round(x.wear * 50)}:${x.spares}:${x.name}` : '-');
        const key = `${slotKey(g.weapon)}|${slotKey(g.tool)}|${g.skill?.name}:${g.skill?.cost}`;
        if (key === this.shown.gear) return;
        this.shown.gear = key;
        this.showSlot(this.weapon, g.weapon, 'Weapon (→ to change)');
        this.showSlot(this.toolSlot, g.tool, 'Tool (← to change, right click to use)');
        const skill = this.$('hud-skill');
        skill.classList.toggle('none', !g.skill);
        if (g.skill) {
            skill.textContent = g.skill.name;
            const cost = this.doc.createElement('span');
            cost.className = 'cost';
            cost.title = 'Spirit (Shift + right click)';
            cost.textContent = g.skill.cost;
            skill.appendChild(cost);
        } else skill.textContent = 'no skill';
    }

    // One slot: its sign in its rarity's colour, its wear, its spares.
    showSlot(el, slot, title) {
        const icon = el.querySelector('.icon');
        const kind = slot ? slot.kind : '';
        if (icon.dataset.kind !== kind) {
            icon.dataset.kind = kind;
            icon.innerHTML = slot ? `<svg viewBox="0 0 36 36" aria-hidden="true">${ITEM_ICONS[kind] ?? ''}</svg>` : '';
        }
        el.classList.remove('normal', 'rare', 'legendary');
        if (slot && !slot.legacy) el.classList.add(slot.rarity);
        el.querySelector('.spares').textContent = slot?.spares ? `+${slot.spares}` : '';
        const wear = el.querySelector('.wear');
        wear.hidden = !slot || !!slot.legacy;
        if (slot) {
            wear.style.setProperty('--wear', slot.wear.toFixed(2));
            wear.classList.toggle('low', slot.rarity !== 'legendary' && slot.wear < 0.2);
        }
        el.title = slot ? `${slot.name}${slot.legacy ? '' : `, ${slot.rarity}`} — ${title}` : title;
    }

    // The craft menu (play/craft.js, given by main.js as `menu`): open with
    // a model, closed with null.
    craftMenu(model, actions) {
        this.menu?.show(model, actions);
    }

    // The store's wood, flint and hide beside its food (when items exist).
    showMaterials(m) {
        const key = m ? `${Math.floor(m.wood)}:${Math.floor(m.flint)}:${Math.floor(m.hide)}` : '';
        if (key === this.shown.mats) return;
        this.shown.mats = key;
        const el = this.$('hud-mats');
        el.hidden = !m;
        if (!m) return;
        this.$('hud-wood').textContent = Math.floor(m.wood);
        this.$('hud-flint').textContent = Math.floor(m.flint);
        this.$('hud-hide').textContent = Math.floor(m.hide);
    }

    // The call in the top slot (calls.js): its sign, and its name beside
    // it, lit up for a moment when it changes.
    showCall(call) {
        if (!call || call === this.shown.call) return;
        const first = this.shown.call === null;
        this.shown.call = call;
        this.callSlot.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true">${CALL_ICONS[call.kind] ?? ''}</svg>`;
        this.callSlot.title = `Call: ${call.name} (↑ to change, G to give)`;
        const el = this.callName;
        el.textContent = call.name;
        el.classList.remove('lit');
        if (first) return;
        void el.offsetWidth; // (restart the animation)
        el.classList.add('lit');
    }

    // Your tribe's answer to a call, for a few seconds above the prompt; a
    // refusal reads in a muted red. Seen from the map too.
    notice(text, refused = false) {
        if (!text) return;
        const el = this.noticeEl;
        el.querySelector('span').textContent = text;
        el.classList.toggle('refused', refused);
        el.hidden = false;
        el.classList.remove('on');
        void el.offsetWidth;
        el.classList.add('on');
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => {
            el.hidden = true;
        }, NOTICE_MS);
    }

    bar(k, v, dt) {
        const b = this.bars[k];
        b.bar.set(Math.min(1, Math.max(0, v)), dt);
        b.fill.style.width = `${(b.bar.value * 100).toFixed(2)}%`;
        b.trail.style.width = `${(b.bar.trail * 100).toFixed(2)}%`;
    }

    // N, E, S and W, ticks every 15°, a mark straight ahead, your camp's flag
    // and the locked target, for the half of the horizon you face; and the
    // sun, or at night the moon in its phase, where it stands (held at the
    // strip's end, dimmed, while it is behind you): the time of day at a
    // glance.
    drawCompass(s) {
        const c = this.compass;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = c.clientWidth;
        const h = c.clientHeight;
        if (!w) return;
        if (c.width !== Math.round(w * dpr)) {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
        }
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const facing = bearing(s.yaw);
        const mid = h / 2 + 1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '500 14px "EB Garamond", Georgia, serif';
        // (Fading out toward the ends, as the band does.)
        const fade = (x) => Math.min(1, Math.min(x, w - x) / (w * 0.14));
        for (let b = 0; b < 360; b += 15) {
            const x = stripX(b, facing, w);
            if (x === null) continue;
            ctx.globalAlpha = fade(x);
            const letter = LETTERS[b];
            if (letter) {
                ctx.fillStyle = 'rgba(238, 232, 218, 0.95)';
                ctx.fillText(letter, x, mid);
            } else {
                const major = b % 45 === 0;
                ctx.fillStyle = major ? 'rgba(238, 232, 218, 0.6)' : 'rgba(238, 232, 218, 0.32)';
                const len = major ? 7 : 4;
                ctx.fillRect(Math.round(x) - 0.5, mid - len / 2, 1, len);
            }
        }
        ctx.globalAlpha = 1;
        if (s.sky) this.skyMark(ctx, s.sky, facing, w, mid);
        // Straight ahead.
        ctx.fillStyle = 'rgba(238, 232, 218, 0.8)';
        ctx.fillRect(Math.round(w / 2) - 0.5, 0, 1, 3);
        if (s.camp !== null && s.tribe) {
            const x = stripX(bearing(s.camp), facing, w);
            if (x !== null) {
                ctx.fillStyle = 'rgba(238, 232, 218, 0.7)';
                ctx.fillRect(Math.round(x) - 0.5, mid - 7, 1, 14);
                drawFlag(ctx, s.tribe.flag, Math.round(x) + 0.5, mid - 7, 11, 7);
            }
        }
        if (s.order != null && s.tribe) {
            const x = stripX(bearing(s.order), facing, w);
            if (x !== null) this.orderMark(ctx, Math.round(x) + 0.5, mid, s.tribe.color);
        }
        if (s.target !== null) {
            const x = stripX(bearing(s.target), facing, w);
            if (x !== null) {
                ctx.strokeStyle = 'rgba(238, 232, 218, 0.9)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, mid - 5);
                ctx.lineTo(x + 4, mid);
                ctx.lineTo(x, mid + 5);
                ctx.lineTo(x - 4, mid);
                ctx.closePath();
                ctx.stroke();
            }
        }
    }

    // The sun (a disc with short rays) or the moon (lit on the side toward
    // the sun, as it is in the sky) on the compass: hud-state.js skyMarks.
    skyMark(ctx, sky, facing, w, mid) {
        const b = bearing(sky.angle);
        let x = stripX(b, facing, w);
        const behind = x === null;
        if (behind) {
            const d = ((((b - facing) % 360) + 540) % 360) - 180;
            x = d > 0 ? w * 0.9 : w * 0.1;
        }
        ctx.save();
        ctx.globalAlpha = behind ? 0.45 : 1;
        const y = mid - 1;
        if (sky.body === 'sun') {
            ctx.fillStyle = 'rgba(243, 212, 140, 0.95)';
            ctx.strokeStyle = 'rgba(243, 212, 140, 0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            for (let k = 0; k < 8; k++) {
                const a = (k / 8) * Math.PI * 2;
                ctx.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
                ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
            }
            ctx.stroke();
        } else {
            const r = 4.5;
            // The dark face, faint; then the lit part, toward the sun (half
            // a turn round the sky from the moon's phase).
            ctx.fillStyle = 'rgba(238, 232, 218, 0.16)';
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            const e = Math.PI * 2 * Math.min(sky.phase, 1 - sky.phase); // the sun's angle from the moon: 0 new .. π full
            const s = ((((bearing(sky.sun) - b) % 360) + 540) % 360) - 180 > 0 ? 1 : -1; // the sun's side on the strip
            const crescent = Math.cos(e) > 0;
            ctx.fillStyle = 'rgba(236, 232, 218, 0.95)';
            ctx.beginPath();
            ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, s < 0);
            ctx.ellipse(x, y, r * Math.abs(Math.cos(e)), r, 0, Math.PI / 2, -Math.PI / 2, s > 0 ? crescent : !crescent);
            ctx.fill();
        }
        ctx.restore();
    }

    // Your tribe's standing order on the compass: a pole with a pennant in
    // the tribe's colour, flying the other way from the camp's flag (an
    // order at the camp shows beside it).
    orderMark(ctx, x, mid, color) {
        ctx.fillStyle = 'rgba(238, 232, 218, 0.85)';
        ctx.fillRect(x - 0.5, mid - 8, 1, 15);
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(8, 9, 9, 0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 0.5, mid - 8);
        ctx.lineTo(x - 9.5, mid - 5);
        ctx.lineTo(x - 0.5, mid - 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // The red edge of a bite.
    flash() {
        const el = this.flashEl;
        el.classList.remove('on');
        void el.offsetWidth; // (restart the animation)
        el.classList.add('on');
    }

    // A banner: 'died', 'line' (with its text), 'ended', 'legend' (LEGEND
    // FORGED, with the legend's name under it). Each replaces the one
    // before; all but the end go by themselves.
    // `link` ({ text, act }): a quiet link under it (your heir's line: shape them).
    banner(kind, text = '', link = null) {
        for (const old of [...this.layer.children]) old.remove();
        const el = this.doc.createElement('div');
        el.className = `banner ${kind}`;
        const band = this.doc.createElement('div');
        band.className = 'band';
        const title = this.doc.createElement('div');
        title.className = 'title';
        title.textContent = TITLES[kind] ?? text;
        band.appendChild(title);
        if (SUBTITLED.has(kind) && text) {
            const sub = this.doc.createElement('div');
            sub.className = 'sub';
            sub.textContent = text;
            band.appendChild(sub);
        }
        if (link) {
            const a = this.doc.createElement('button');
            a.className = 'shape';
            a.type = 'button';
            a.textContent = link.text;
            a.addEventListener('click', () => link.act());
            band.appendChild(a);
        }
        el.appendChild(band);
        this.layer.appendChild(el);
        const ms = BANNER_MS[kind];
        if (ms) setTimeout(() => el.remove(), ms);
    }

    // YOUR LINE HAS ENDED: the story, and what next.
    summary(n, actions) {
        const $ = this.$;
        this.storyActions = actions;
        $('story-people').textContent = n.people;
        $('story-generations').textContent = n.generations;
        $('story-years').textContent = n.years;
        $('story-kills').textContent = n.kills;
        $('story-children').textContent = n.children;
        $('story-line').textContent = n.line.join(' · ');
        this.story.hidden = false;
    }

    hideSummary() {
        this.story.hidden = true;
        this.storyActions = null;
        for (const old of [...this.layer.querySelectorAll('.banner.ended')]) old.remove();
    }

    // A new world: nothing of the last one stays on screen.
    clear() {
        for (const old of [...this.layer.children]) old.remove();
        this.hideSummary();
        this.flashEl.classList.remove('on');
        this.noticeEl.hidden = true;
        this.menu?.show(null);
        for (const b of Object.values(this.bars)) b.bar = new TrailBar();
        for (const k of Object.keys(this.shown)) this.shown[k] = null;
    }
}
