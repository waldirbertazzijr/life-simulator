// The HUD you see while in a body (spec §7), laid out as in Elden Ring and
// nothing else on screen: top left, your tribe's flag and three thin bars
// (red Life, blue Spirit, green Stamina) with a trailing segment for what
// was just lost; top centre, a compass strip with your camp, your tribe's
// standing order and your locked target; bottom left, the equipment cross
// (its top slot: your call); bottom centre, what E (or P) would do, and
// above it your tribe's answer to a call; bottom right, your tribe's store;
// a dot in the middle, a ring on the locked target, and a red edge when you
// are bitten. Banners (YOU DIED, your line continuing, your line ended,
// with the story) sit in a layer of their own, also seen from the map, as
// are the answers to calls.
//
// The markup and styles are in index.html; this fills them in. What it
// shows comes each frame from modes.js (drawHud) as one plain object.
import { drawFlag } from '../flag.js';

// Trailing segments: what was lost stays for `hold` seconds, then shrinks at
// `rate` (a bar's length a second). Drops smaller than `step` in a frame (a
// sprint's steady drain) do not restart the hold.
const TRAIL = { hold: 0.6, rate: 0.5, step: 0.02 };
export const COMPASS_SPAN = 180; // degrees across the compass strip

const BANNER_MS = { died: 3400, line: 4800 };
const TITLES = { died: 'YOU DIED', ended: 'YOUR LINE HAS ENDED' };
const NOTICE_MS = 3200; // a call's answer stays this long (calls.js)

// The calls' signs in the top slot (36 × 36, drawn like the others): a horn,
// a mark on the ground, a sprig, a shield, a flag on the move.
const CALL_ICONS = {
    rally: '<path d="M7 15.5h3.5L25 9v18l-14.5-6.5H7z"/><path d="M12 21c0 3.6 3.4 5.6 7.5 5"/><path d="M28.5 13.5c1.6 2.6 1.6 6.4 0 9"/>',
    hunt: '<circle cx="18" cy="18" r="7"/><path d="M18 5v6M18 25v6M5 18h6M25 18h6"/><circle cx="18" cy="18" r="0.8"/>',
    gather: '<path d="M18 30V13"/><path d="M18 22c-5 0-8.5-3-8.5-8 5 0 8.5 3 8.5 8z"/><path d="M18 17.5c4.5 0 7.5-2.6 7.5-7-4.5 0-7.5 2.6-7.5 7z"/>',
    defend: '<path d="M18 6.5 27.5 10v7.5c0 6.5-4.2 10.6-9.5 12.5-5.3-1.9-9.5-6-9.5-12.5V10z"/><path d="M18 11v15"/>',
    move: '<path d="M11 30V7"/><path d="M11 8h13l-3.5 4 3.5 4H11"/><path d="M16 26h11m-3-3 3 3-3 3"/>',
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
        this.shown = { name: null, age: null, flag: null, carry: null, store: null, prompt: null, call: null };
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

    // A frame's worth of what to show (modes.js, drawHud).
    update(s, dt) {
        const $ = this.$;
        const shown = this.shown;
        if (s.name !== shown.name) $('hud-name').textContent = shown.name = s.name;
        if (s.age !== shown.age) $('hud-age').textContent = shown.age = s.age;
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
        const carry = Math.floor(s.carry);
        if (carry !== shown.carry) $('hud-carry').textContent = shown.carry = carry;
        const store = Math.round(s.store);
        if (store !== shown.store) $('hud-store').textContent = shown.store = store;
        const prompt = s.prompt ? s.prompt.join(' ') : '';
        if (prompt !== shown.prompt) {
            shown.prompt = prompt;
            const el = $('hud-prompt');
            el.hidden = !s.prompt;
            if (s.prompt) {
                el.querySelector('kbd').textContent = s.prompt[0];
                el.querySelector('span').textContent = s.prompt[1];
            }
        }
        const ring = $('hud-ring');
        ring.hidden = !s.ring;
        if (s.ring) ring.style.transform = `translate(${s.ring.x.toFixed(1)}px, ${s.ring.y.toFixed(1)}px)`;
        this.showCall(s.call);
        this.drawCompass(s);
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
    // and the locked target, for the half of the horizon you face.
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

    // A banner: 'died', 'line' (with its text), 'ended'. Each replaces the
    // one before; YOU DIED and the line's go by themselves, the end stays.
    banner(kind, text = '') {
        for (const old of [...this.layer.children]) old.remove();
        const el = this.doc.createElement('div');
        el.className = `banner ${kind}`;
        const band = this.doc.createElement('div');
        band.className = 'band';
        const title = this.doc.createElement('div');
        title.className = 'title';
        title.textContent = TITLES[kind] ?? text;
        band.appendChild(title);
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
        for (const b of Object.values(this.bars)) b.bar = new TrailBar();
        for (const k of Object.keys(this.shown)) this.shown[k] = null;
    }
}
