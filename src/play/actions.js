// What the keys do. input.js names each one-off action (KeyE is
// 'interact', a left click 'attack' with how heavy it was...); this says
// what each does. On the map only M (back into your body), G (ready a
// call) and L (the editor) count; in a body everything does, unless you are dying.
//
// A new key: name its action in input.js (ACTIONS), and say here what it
// does, as a line in IN_BODY that hands it to the part it is about
// (m.hands, m.kit, m.lead, m.pouch, or modes.js itself).
//
// `m` is modes.js's Modes: who you are, your body, the world, the page.
import { PITCH, lockTarget } from './aim.js';
import { clamp } from '../view3d/util.js';

// In a body: an action's name → what it does (`info`, input.js's, for an attack).
const IN_BODY = {
    move(m) {
        m.standUp();
        m.hands.stop();
        m.kit.closeCraft();
    },
    roll(m) {
        m.standUp();
        m.hands.stop();
        const f = m.world.find(m.self);
        if (f && m.body.roll(m.input, m.envFor(f))) m.world.act({ seq: m.body.nextSeq(), action: 'roll' });
    },
    crouch(m) {
        m.standUp();
        m.body.crouch = !m.body.crouch;
    },
    interact: (m) => m.hands.interact(),
    'interact-end': (m) => m.hands.letGo(),
    attack: (m, info) => m.hands.attack(info),
    eat: (m) => m.hands.eat(),
    lock(m) {
        m.lock = m.lock ? 0 : lockTarget(m.world, m.body.x, m.body.y, m.body.yaw, m.self);
    },
    view(m) {
        m.view = m.view === 'shoulder' ? 'first' : 'shoulder';
        m.body.pitch = clamp(m.body.pitch, ...PITCH[m.view]);
        m.env.setView(m.view);
    },
    pause: (m) => m.env.setPaused(!m.env.getPaused()),
    'cycle-call': (m) => m.calls.cycle(m.world.p.items?.enabled === true),
    call: (m) => m.lead.callHere(),
    'cycle-weapon': (m) => m.kit.cycle('weapon'),
    'cycle-tool': (m) => m.kit.cycle('tool'),
    'cycle-pouch': (m) => m.pouch.cycle(m.hands.contents()), // (↓: what the pouch's slot shows)
    tool: (m) => m.kit.useTool(),
    skill: (m) => m.kit.useSkill(),
    craft(m) {
        if (m.kit.menu) m.kit.closeCraft();
        else m.kit.openCraft();
    },
};

// Do what the action `name` asks of `m`.
export function act(m, name, info) {
    if (name === 'map') {
        if (m.inBody) m.leave();
        else m.back();
        return;
    }
    if (name === 'call' && !m.inBody) {
        m.armCall(); // G on the map
        return;
    }
    if (name === 'look') {
        if (m.self && !m.dying) m.env.editLook?.(m.self); // L: how your person looks (editor.js), in a body or on the map
        return;
    }
    if (!m.inBody || m.dying) return;
    if (Object.hasOwn(IN_BODY, name)) IN_BODY[name](m, info);
}
