// The craft menu (C at camp, spec §8.4): every kind with what it costs,
// dimmed when the camp's store cannot pay for it, the one chosen lit, and a
// switch to add a flint for a chance of rare. Keys and choices are modes.js's
// (craftKey, craftKind); this only shows them and hears the mouse. The
// markup and styles are in index.html.
import { ITEM_ICONS } from './hud.js';

export class CraftMenu {
    constructor(doc = document) {
        this.doc = doc;
        this.el = doc.getElementById('craft');
        this.list = doc.getElementById('craft-rows');
        this.flintButton = doc.getElementById('craft-flint');
        this.actions = null;
        this.key = '';
        this.list.addEventListener('click', (e) => {
            const row = e.target.closest('[data-kind]');
            if (row) this.actions?.pick(row.dataset.kind);
        });
        this.list.addEventListener('pointerover', (e) => {
            const row = e.target.closest('[data-index]');
            if (row) this.actions?.hover(Number(row.dataset.index));
        });
        this.flintButton.addEventListener('click', () => this.actions?.flint());
    }

    // Show the menu: `model` = {rows (gear.js's craftRows), index, flint}, and
    // `actions` = {pick(kind), hover(index), flint()}; null closes it.
    show(model, actions = null) {
        this.actions = actions;
        if (!model) {
            this.el.hidden = true;
            this.key = '';
            return;
        }
        const key = `${model.index}:${model.flint}:${model.rows.map((r) => `${r.kind}${r.can ? 1 : 0}${r.text}`).join(',')}`;
        this.el.hidden = false;
        if (key === this.key) return;
        this.key = key;
        this.list.replaceChildren(...model.rows.map((r, i) => {
            const b = this.doc.createElement('button');
            b.type = 'button';
            b.className = `row${i === model.index ? ' on' : ''}${r.can ? '' : ' lacking'}`;
            b.dataset.kind = r.kind;
            b.dataset.index = i;
            b.title = r.can ? `Craft a ${r.kind} (${i + 1})` : `The store lacks ${r.text}`;
            b.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true">${ITEM_ICONS[r.kind] ?? ''}</svg><span class="name"></span><span class="cost"></span>`;
            b.querySelector('.name').textContent = r.name;
            b.querySelector('.cost').textContent = r.text;
            return b;
        }));
        this.flintButton.setAttribute('aria-pressed', String(!!model.flint));
    }
}
