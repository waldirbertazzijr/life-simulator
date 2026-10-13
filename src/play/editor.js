// The character editor: how your person looks. A body (one of three), a hair
// style, a hair colour and a skin tone, with a small turning preview of them
// in their tribe's colours (view3d/preview.js). Each choice is kept at once,
// per person (view3d/looks.js: in this browser, per world and id) and the
// world draws them so from the next frame.
//
// It opens from the panel's "look" button (your person, on the map), with L
// in a body (or on the map), and for your heir from the line that says your
// line continues. Esc or L closes it, as does "done". While it is open the
// pointer is let go and keys are not the body's or the page's (input.js
// `blocked`, as the admin console does); the world goes on as it was.
//
// The markup and styles are in index.html. No DOM is touched without `doc`
// (node tests).
import { BODIES, HAIR_STYLES, HAIR_COLOURS, SKIN_TONES, linear, clothOf } from '../view3d/looks.js';
import { personName } from './names.js';

// The bodies, as the editor names them.
export const BODY_NAMES = { man_sturdy: 'sturdy', woman_slender: 'slender', woman_stocky: 'stocky' };

export class Editor {
    // env = {
    //   looks       view3d/looks.js Looks (the 3D view's)
    //   world       the Mirror (who it is, their tribe and age)
    //   input       play/input.js (blocked while open)
    //   preview(canvas)   a view3d/preview.js Preview, or null
    //   doc, win    the DOM (none in tests)
    // }
    constructor(env) {
        this.env = env;
        this.looks = env.looks;
        this.id = 0;
        this.heir = false;
        this.isOpen = false;
        this.openedAt = 0; // (performance.now() when it opened)
        this.preview = null;
        this.root = null;
        if (env.doc) this.bind(env.doc, env.win);
    }

    bind(doc, win) {
        this.doc = doc;
        const $ = (id) => doc.getElementById(id);
        this.root = $('editor');
        this.el = {
            title: $('ed-title'), sub: $('ed-sub'), canvas: $('ed-preview'),
            body: $('ed-body'), style: $('ed-style'), hair: $('ed-hair'), skin: $('ed-skin'),
        };
        const option = (into, field, value, text, colour) => {
            const b = doc.createElement('button');
            b.type = 'button';
            b.dataset.field = field;
            b.dataset.value = String(value);
            if (colour) {
                b.className = 'swatch';
                b.style.background = colour;
                b.title = text;
                b.setAttribute('aria-label', text);
            } else b.textContent = text;
            into.appendChild(b);
        };
        BODIES.forEach((body, k) => option(this.el.body, 'body', k, BODY_NAMES[body]));
        HAIR_STYLES.forEach((style, k) => option(this.el.style, 'style', k, style));
        HAIR_COLOURS.forEach((c, k) => option(this.el.hair, 'hair', c, `hair ${k + 1}`, c));
        SKIN_TONES.forEach((c, k) => option(this.el.skin, 'skin', c, `skin ${k + 1}`, c));
        this.root.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-field]');
            if (!b) return;
            const { field, value } = b.dataset;
            this.pick(field, field === 'body' || field === 'style' ? Number(value) : value);
        });
        $('ed-reset').addEventListener('click', () => this.reset());
        $('ed-done').addEventListener('click', () => this.close());
        // While open, every key on its way in is the editor's: Esc and L close it.
        // (Not the key that opened it, whoever heard that first.)
        win.addEventListener('keydown', (e) => {
            if (!this.isOpen || e.ctrlKey || e.metaKey || e.timeStamp <= this.openedAt) return;
            e.stopPropagation();
            if (e.key === 'Escape' || e.code === 'KeyL') {
                e.preventDefault();
                if (!e.repeat) this.close();
            }
        }, true);
    }

    // Open for person `id` (`heir`: you have just become them).
    open(id, heir = false) {
        if (!id) return false;
        this.id = id;
        this.heir = heir;
        this.isOpen = true;
        this.openedAt = typeof performance !== 'undefined' ? performance.now() : 0;
        const input = this.env.input;
        if (input) {
            input.clear();
            input.unlock();
            input.blocked = true;
        }
        if (this.root) {
            this.root.hidden = false;
            if (!this.preview && this.el.canvas) this.preview = this.env.preview?.(this.el.canvas) ?? null;
            this.preview?.start();
        }
        this.refresh();
        return true;
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.env.input) this.env.input.blocked = false;
        if (this.root) this.root.hidden = true;
        this.preview?.stop();
    }

    toggle(id) {
        if (this.isOpen) this.close();
        else this.open(id);
    }

    // The look being edited (looks.js: body, style, hair, skin).
    get look() {
        return this.looks.of(this.id);
    }

    // A choice: `field` (body, style, hair, skin) set to `value`.
    pick(field, value) {
        if (!this.isOpen) return;
        this.looks.choose(this.id, { [field]: value });
        this.refresh();
    }

    // Back to the look the person was born with.
    reset() {
        if (!this.isOpen) return;
        this.looks.choose(this.id, null);
        this.refresh();
    }

    // The person as shown: their tribe's colours and their hair at their age.
    person() {
        const look = this.look;
        const w = this.env.world;
        const f = w?.find(this.id) ?? null;
        const tribe = f ? w.tribeById.get(f.pop.tribe[f.i]) : null;
        const hex = tribe?.color ?? '#9aa9bd';
        return {
            body: look.body,
            style: look.style,
            hair: f ? this.looks.hairAt(look, f.pop.age[f.i], w.p.human.maturity, [0, 0, 0]) : this.looks.hairAt(look, 0, 1, [0, 0, 0]),
            skin: look.skinRgb,
            cloth: clothOf(hex),
            tribe: linear(hex),
            tribeName: tribe?.name ?? null,
        };
    }

    refresh() {
        const p = this.person();
        this.preview?.show(p);
        if (!this.root) return;
        this.el.title.textContent = personName(this.id);
        this.el.sub.textContent = this.heir ? 'your heir' : p.tribeName ? `of the ${p.tribeName}` : '';
        const look = this.look;
        for (const b of this.root.querySelectorAll('button[data-field]')) {
            const v = look[b.dataset.field];
            b.setAttribute('aria-pressed', String(String(v) === b.dataset.value));
        }
    }
}
