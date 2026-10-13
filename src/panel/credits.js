// The credits (src/credits.js), opened by the quiet "credits" link at the
// foot of the panel: per entry its title and author, what it is for, links
// to its source and its licence, and what we changed.
import { CREDITS } from '../credits.js';

export function fillCredits(list) {
    list.replaceChildren(...CREDITS.map((c) => {
        const row = document.createElement('div');
        row.className = 'credit';
        const line = (cls, ...parts) => {
            const div = document.createElement('div');
            div.className = cls;
            div.append(...parts);
            return div;
        };
        const link = (text, href) => {
            const a = document.createElement('a');
            a.textContent = text;
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener';
            return a;
        };
        const title = document.createElement('span');
        title.className = 't';
        title.textContent = `“${c.title}”`;
        row.append(
            line('by', title, ` by ${c.author}`),
            line('use', `${c.for} · `, link('source', c.url), ' · ', link(c.licence, c.licenceUrl)),
        );
        if (c.changes) row.append(line('changed', `changes: ${c.changes}`));
        return row;
    }));
}

// Wire the link: it opens and closes the list.
export function wireCredits($) {
    const open = $('credits-open');
    const section = $('credits');
    const list = $('credit-list');
    open.addEventListener('click', () => {
        if (!list.childElementCount) fillCredits(list);
        section.hidden = !section.hidden;
        open.setAttribute('aria-expanded', String(!section.hidden));
    });
}
