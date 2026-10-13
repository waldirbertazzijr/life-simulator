// The wiring between play and the rest of the page: the `env` that
// modes.js reaches the page through, and `window.play`, through which the
// browser's console (or a headless browser) plays. main.js owns what they
// wire: the frame loop, the speed, pause, who is followed, the view.
//
// `page` (main.js) = { world (the Mirror), renderer, canvas, panel, input,
// hud, follow(id, keepView), followed(), setView(v), setSpeed(s),
// getSpeed(), setPaused(p), getPaused(), changed() (the panel's play bar
// is out of date), editLook(id, heir) (the character editor), pauseMenu() (P: the
// save menu, paused), succession() (your heir took over: an autosave), hints (the
// first steps: home/hints.js) and beginLife() (the home screen's Begin a life) }.
import { personName } from './names.js';

// What modes.js is given as `env`.
export function modesEnv(page) {
    const { world, renderer, panel } = page;
    return {
        world,
        input: page.input,
        hud: page.hud,
        rig: () => renderer.rig ?? null,
        follow: page.follow,
        followed: page.followed,
        setView: page.setView,
        setSpeed: page.setSpeed,
        getSpeed: page.getSpeed,
        setPaused: page.setPaused,
        getPaused: page.getPaused,
        inBody(on) {
            document.body.classList.toggle('in-body', on);
            panel.suspend(on);
            // The panel's buttons would otherwise keep the keyboard's focus.
            if (on && document.activeElement instanceof HTMLElement) document.activeElement.blur();
        },
        // Play again (the story's button): Begin a life on the home screen, or the panel's picker.
        openPicker: () => (page.beginLife ? page.beginLife() : panel.openPicker(world)),
        changed: page.changed,
        // P in a body: pause, with the save menu (panel/saves.js); and your heir has taken over (an autosave).
        pauseMenu: page.pauseMenu,
        succession: page.succession,
        // First steps (home/hints.js), or null.
        hints: page.hints ?? null,
        // The character editor (editor.js) for a person (`heir`: just become them).
        editLook: (id, heir) => page.editLook?.(id, heir),
        // Poses on bodies (the 3D view's; the flat one has none).
        pose: (id, code, seconds) => renderer.pose?.(id, code, seconds),
        hold: (id, code) => renderer.hold?.(id, code),
        release: (id) => renderer.release?.(id),
        // Where a call goes in a body: the ground under the crosshair (the
        // middle of the view), or null for the sky.
        crosshair: () => renderer.groundAt?.(window.innerWidth / 2, window.innerHeight / 2) ?? null,
        // What a shot goes for: whoever is drawn under the crosshair (within
        // `radius` px; skip(id) true passes someone over), or 0.
        aimed: (radius, skip) => renderer.pick?.(world, window.innerWidth / 2, window.innerHeight / 2, radius, skip) ?? 0,
    };
}

// For playing from the console, or a headless browser (which cannot lock
// the pointer: it drags, or sets the look here):
//   play.become(id)      step into a person (default: the first one)
//   play.start(tribeId)  Play: lead a tribe (default: the biggest)
//   play.leave(), play.back(), play.stop()   to the map, back in, let go
//   play.picker()        Play's choice of tribes
//   play.view('first' | 'shoulder'), play.look(yaw, pitch)
//   play.hold(code, ms)  hold a key (e.g. 'KeyW') for ms; resolves when let go
//   play.press(code)     tap a key
//   play.attack({heavy, power})   left click (a headless browser has no pointer lock to click with)
//   play.banner(kind, text), play.over()   show a banner; end the line now
//   play.call(kind)      put a call in the slot (G gives it: play.press('KeyG'))
//   play.arm(kind), play.mapClick(x, y)    on the map: ready a call, and click
//                        the world point (x, y) through the view
//   play.cycle('weapon' | 'tool' | 'pouch'), play.tool(), play.skill(), play.craft()
//                        →, ← or ↓, right click, Shift + right click, C (keys
//                        in the craft menu: play.press('ArrowDown'), ...)
//   play.editor          the character editor (open(id), pick(field, value), close())
//   play.state           who, where, stamina, snaps (moves turned down), the hands, the items,
//                        the hint shown...
//   play.modes
export function windowPlay(page, modes) {
    const { world, renderer, canvas, panel, hud } = page;
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
    return {
        // (Only in the 3D view: the flat one has no over-the-shoulder camera.)
        become(id = world.humans.id[0]) {
            return !!renderer.rig && modes.become(id);
        },
        start(tribeId = [...world.tribes].sort((a, b) => b.members - a.members)[0]?.id) {
            return !!renderer.rig && modes.startPlay(tribeId);
        },
        leave: () => modes.leave(),
        back: () => modes.back(),
        stop: () => modes.stop(),
        picker: () => panel.openPicker(world),
        view(v) {
            if (modes.inBody && v !== modes.view) modes.action('view');
        },
        look(yaw, pitch) {
            modes.body.yaw = yaw;
            if (pitch !== undefined) modes.body.pitch = pitch;
        },
        hold(code, ms) {
            key('keydown', code);
            return new Promise((resolve) => setTimeout(() => {
                key('keyup', code);
                resolve();
            }, ms));
        },
        press(code) {
            key('keydown', code);
            key('keyup', code);
        },
        attack: (info = {}) => modes.action('attack', info),
        banner: (kind, text) => hud.banner(kind, text),
        over: () => modes.gameOver(),
        call: (kind) => modes.calls.select(kind),
        arm: (kind) => modes.armCall(kind),
        cycle: (slot = 'weapon') => modes.action(slot === 'tool' ? 'cycle-tool' : slot === 'pouch' ? 'cycle-pouch' : 'cycle-weapon'),
        tool: () => modes.action('tool'),
        skill: () => modes.action('skill'),
        craft: () => modes.action('craft'),
        mapClick(x, y) {
            const at = { x: 0, y: 0 };
            if (!renderer.rig?.project(x, y, world.terrain ? world.terrain.heightAt(x, y) : 0, at)) return false;
            const rect = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + at.x, clientY: rect.top + at.y, bubbles: true }));
            return true;
        },
        get state() {
            const p = world.player;
            return {
                game: modes.game, self: modes.self, name: modes.self ? personName(modes.self) : null,
                inBody: modes.inBody, view: modes.view, mode: renderer.mode, resting: modes.resting, lock: modes.lock,
                stamina: Math.round(modes.body.stamina), x: +modes.body.x.toFixed(2), y: +modes.body.y.toFixed(2),
                snaps: modes.stats.snaps, placed: modes.stats.placed, speed: page.getSpeed(), paused: page.getPaused(),
                call: modes.calls.call.kind, armed: modes.calls.armed,
                hint: modes.hints?.current?.id ?? null,
                player: p ? { id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), auto: p.auto, spirit: +p.spirit.toFixed(1), resting: p.resting } : null,
                hands: p ? {
                    carry: +p.carry.toFixed(1), energy: +p.energy.toFixed(1), reload: p.reload, gathering: p.gathering, butchering: p.butchering,
                    wood: +(p.wood ?? 0).toFixed(2), flint: +(p.flint ?? 0).toFixed(2),
                    doing: modes.doing?.kind ?? null, can: modes.interaction()?.kind ?? null,
                } : null,
                items: p && world.items ? {
                    weapon: p.weapon, tool: p.tool, kit: p.kit, crafting: p.crafting, skill: p.skill,
                    menu: modes.menu ? { ...modes.menu } : null, legends: world.legends?.length ?? 0,
                } : null,
            };
        },
        // The character editor (editor.js), or null in the flat view.
        get editor() {
            return page.editor ?? null;
        },
        modes,
    };
}
