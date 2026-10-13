// The card for the one being followed, in the panel (ui.js): its name and
// tribe, "become them" when play offers it, its state and biography while
// alive, and how its story ended once it is not. The markup is in
// index.html (#follow); a new row there is filled in here.
import { drawFlag } from '../flag.js';
import { STATE, STATE_LABEL } from '../world.js';
import { personName, ageText, years } from '../play/names.js';
import { SLEEPING, SLEEPING_LABEL } from '../view3d/animate.js';

// States shown in the alarm colour.
const ALARM = new Set([STATE.FLEEING, STATE.CHASING, STATE.FIGHTING, STATE.RAIDING]);

// How a life ended (world.fate's cause), in words.
function howItEnded(fate) {
    return {
        eaten: `Eaten by carnivore #${fate.by}`,
        hunted: `Speared by ${personName(fate.by)}`,
        killed: fate.by ? `Killed by ${personName(fate.by)}` : 'Killed by defenders while raiding',
        starvation: 'Starved',
        'old age': 'Died of old age',
        admin: 'Struck down by the gods', // (the admin console: admin.js)
    }[fate.cause];
}

// Fill the card for `id`: `target` is where the world has it (world.find),
// or null once it is dead. `$` finds an element by id; `actions` are the
// panel's (becomeLabel).
export function fillCard($, world, id, target, actions) {
    const fate = world.fate && world.fate.id === id ? world.fate : null;
    const kind = target ? target.kind : fate ? fate.kind : 'herbivore';
    const P = world.p[kind];
    const person = kind === 'human';
    $('f-swatch').className = `swatch ${kind}`;
    $('f-name').textContent = person ? personName(id) : `${kind} #${id}`;
    // Become them.
    const become = $('f-become');
    const label = person && target ? actions.becomeLabel(id) : null;
    become.hidden = !label;
    if (label && become.textContent !== label) {
        become.textContent = label;
        become.title = 'Play as this person';
    }
    for (const k of ['f-kills-k', 'f-kills-m', 'f-kills']) $(k).hidden = kind === 'herbivore';
    for (const k of ['f-carry-k', 'f-carry-m', 'f-carry']) $(k).hidden = !person || !target;
    $('f-fate').hidden = !!target;

    // A person's tribe: flag, name and culture.
    const tribeId = person ? (target ? target.pop.tribe[target.i] : fate?.tribe) : 0;
    const tribe = tribeId ? world.tribeById.get(tribeId) ?? world.fallen.find((t) => t.id === tribeId) : null;
    $('f-tribe').hidden = !tribe;
    if (tribe) {
        const flag = $('f-flag');
        const ctx = flag.getContext('2d');
        ctx.clearRect(0, 0, flag.width, flag.height);
        drawFlag(ctx, tribe.flag, 0, 0, flag.width, flag.height);
        $('f-tribe-name').textContent = `of the ${tribe.name}${tribe.alive ? '' : ' (gone)'}`;
        $('f-culture').textContent = `aggr ${tribe.aggression.toFixed(2)} · social ${tribe.sociality.toFixed(2)}`;
    }

    if (target) {
        const { pop, i } = target;
        const state = pop.state[i];
        $('f-gen').textContent = `generation ${pop.generation[i]}`;
        $('f-state').textContent = STATE_LABEL[state] ?? (state === SLEEPING ? SLEEPING_LABEL : '');
        $('f-state').className = ALARM.has(state) ? 'alarm' : '';
        $('f-carry').textContent = Math.round(pop.carry[i]);
        const e = pop.energy[i];
        $('f-energy').textContent = Math.round(e);
        $('f-energy-bar').style.width = `${Math.min(100, (e / P.maxEnergy) * 100)}%`;
        const life = pop.age[i] / pop.lifespan[i];
        $('f-age').textContent = ageText(pop.age[i], P.maturity);
        $('f-age-bar').style.width = `${Math.min(100, life * 100)}%`;
        const avg = world.meanGenes(pop);
        $('f-speed').textContent = pop.speedGene[i].toFixed(2);
        $('f-speed-avg').textContent = `avg ${avg.speed.toFixed(2)}`;
        $('f-sense').textContent = pop.senseGene[i].toFixed(2);
        $('f-sense-avg').textContent = `avg ${avg.sense.toFixed(2)}`;
        $('f-children').textContent = pop.children[i];
        $('f-kills').textContent = pop.kills[i];
        return;
    }

    // It died (or the world was reset under it).
    $('f-state').className = '';
    $('f-state').textContent = 'dead';
    $('f-energy').textContent = '0';
    $('f-energy-bar').style.width = '0%';
    if (!fate) {
        $('f-fate-text').textContent = 'Gone.';
        $('f-descendant').disabled = true;
        return;
    }
    const how = howItEnded(fate);
    const kids = `${fate.children} ${fate.children === 1 ? 'child' : 'children'}`;
    const kills = kind !== 'herbivore' ? `, ${fate.kills} ${fate.kills === 1 ? 'kill' : 'kills'}` : '';
    const when = `aged ${years(fate.age, P.maturity)}`;
    $('f-fate-text').textContent = `${how} ${when}. Left ${kids}${kills}.`;
    $('f-children').textContent = fate.children;
    $('f-kills').textContent = fate.kills;
    $('f-descendant').disabled = !world.descendant(id);
}
