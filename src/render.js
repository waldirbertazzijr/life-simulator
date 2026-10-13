// Canvas renderer. It only reads the world; it never changes it.
//
// Grass is painted as one tiny image (one pixel per patch) stretched over the
// world with smoothing, so it reads as a soft field. Each species is drawn as
// one batched path, so a thousand animals cost two fill() calls.
//
// Everything is drawn relative to a camera that glides between three views:
//   map    — the whole world
//   follow — zoomed in on one animal, north up
//   first  — zoomed further, rotated so the animal always faces up
// The world wraps around (a torus), so each animal is drawn at its copy
// nearest the camera, and the grass image is tiled as needed.
import { drawFlag } from './flag.js';
import { TAU, wrapDelta } from './view3d/util.js';

export const COLORS = {
    background: '#101211',
    bare: [27, 29, 25],    // grass at 0
    lush: [62, 104, 64],   // grass at 1
    rock: [98, 94, 86],    // barren mountain
    shallow: [36, 54, 66], // water at the shore...
    deep: [20, 30, 42],    // ...and at its deepest
    herbivore: '#ece6d6',
    carnivore: '#e4664f',
};

// How many world units fit across the shorter side of the screen.
const VIEW_SPAN = { follow: 380, first: 220 };
// Where on screen (fraction of height) the followed animal sits.
const ANCHOR_Y = { map: 0.5, follow: 0.5, first: 0.66 };

// How far along from bare ground to lush grass a patch with grass g looks,
// indexed by g × 255 (a gentle curve, so thin grass already shows).
const GREEN = Float64Array.from({ length: 256 }, (_, i) => Math.pow(i / 255, 0.8));

function grassPalette() {
    const lut = new Uint32Array(256);
    const [r0, g0, b0] = COLORS.bare;
    const [r1, g1, b1] = COLORS.lush;
    for (let i = 0; i < 256; i++) {
        const t = GREEN[i];
        const r = Math.round(r0 + (r1 - r0) * t);
        const g = Math.round(g0 + (g1 - g0) * t);
        const b = Math.round(b0 + (b1 - b0) * t);
        lut[i] = (255 << 24) | (b << 16) | (g << 8) | r; // RGBA bytes, little-endian
    }
    return lut;
}

// Flags are painted by flag.js (shared with the 3D view and the panel).
export { drawFlag };

// How much of the grass a biome's own cover hides in the 2D view, seen from
// above: a forest canopy keeps the ground dark whatever grows beneath it.
const CANOPY = { forest: 0.55 };

// With biomes: each land patch's bare-ground colour and how much of its grass
// shows (1 − canopy), as [r, g, b, show] per patch. Averaged over the land
// patches around it, so the edges between biomes blend instead of following
// the patch grid in steps.
function biomeGround(T, water, cols, rows) {
    const n = cols * rows;
    const raw = new Float32Array(4 * n);
    for (let k = 0; k < n; k++) {
        const b = T.biomes[T.biomeGrid[k]];
        raw.set(b.color, 4 * k);
        raw[4 * k + 3] = 1 - (CANOPY[b.name] ?? 0);
    }
    const out = new Float32Array(4 * n);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const k = c + r * cols;
            if (water[k] !== 0) continue;
            let count = 0;
            for (let dr = -1; dr <= 1; dr++) {
                const rr = (r + dr + rows) % rows;
                for (let dc = -1; dc <= 1; dc++) {
                    const j = ((c + dc + cols) % cols) + rr * cols;
                    if (water[j] !== 0) continue;
                    for (let ch = 0; ch < 4; ch++) out[4 * k + ch] += raw[4 * j + ch];
                    count++;
                }
            }
            for (let ch = 0; ch < 4; ch++) out[4 * k + ch] /= count;
        }
    }
    return out;
}

// The land under the grass, one entry per grass patch (display only): water
// colour, hill shading, and the ground the grass grows on. With biomes that is
// each biome's own bare ground (terrain.biomes[k].color), so a grazed-down
// steppe reads as dry earth and a forest stays dark. Without, it is how rocky
// the ground looks, so bare peaks read as rock rather than as grazed-out
// meadow. Cliffs show through the shading.
function groundLayer(world) {
    const T = world.terrain;
    const { cols, rows, cellW, cellH } = world.grass;
    const n = cols * rows;
    const water = new Uint32Array(n); // packed colour; 0 = land
    const shade = new Float32Array(n);
    const rock = new Float32Array(n);
    const pack = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;
    const LZ = 1.5; // light from the north-west, fairly high
    const flat = LZ / Math.sqrt(2 + LZ * LZ);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const k = c + r * cols;
            const x = (c + 0.5) * cellW;
            const y = (r + 0.5) * cellH;
            const h = T.heightAt(x, y);
            if (h < T.seaLevel) {
                const t = h / T.seaLevel; // 0 deepest .. 1 at the shore
                const [r0, g0, b0] = COLORS.deep;
                const [r1, g1, b1] = COLORS.shallow;
                water[k] = pack(Math.round(r0 + (r1 - r0) * t), Math.round(g0 + (g1 - g0) * t), Math.round(b0 + (b1 - b0) * t));
                continue;
            }
            const gx = (T.heightAt(x + cellW, y) - T.heightAt(x - cellW, y)) / (2 * cellW);
            const gy = (T.heightAt(x, y + cellH) - T.heightAt(x, y - cellH)) / (2 * cellH);
            const lit = (gx + gy + LZ) / (Math.sqrt(gx * gx + gy * gy + 1) * Math.sqrt(2 + LZ * LZ));
            const s = 1 + 0.85 * (lit / flat - 1); // gentle: flat ground keeps its colour
            shade[k] = s < 0.55 ? 0.55 : s > 1.3 ? 1.3 : s;
            if (!T.biomeGrid) rock[k] = T.rockiness(x, y);
        }
    }
    return { water, shade, rock, bare: T.biomeGrid ? biomeGround(T, water, cols, rows) : null };
}


export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.grassCanvas = document.createElement('canvas');
        this.grassCtx = this.grassCanvas.getContext('2d');
        this.palette = grassPalette();
        this.mode = 'map';
        this.cam = { x: 0, y: 0, angle: 0, scale: 1, anchor: 0.5 };
    }

    resize(world) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.w = window.innerWidth;
        this.h = window.innerHeight;
        this.dpr = dpr;
        this.canvas.width = Math.round(this.w * dpr);
        this.canvas.height = Math.round(this.h * dpr);
        this.canvas.style.width = `${this.w}px`;
        this.canvas.style.height = `${this.h}px`;
        this.fit = Math.min(this.w / world.width, this.h / world.height);
    }

    attach(world) {
        const { cols, rows } = world.grass;
        // One extra pixel on every side holds the wrapped-around neighbour, so
        // smoothing blends across the world's edge instead of leaving a seam.
        this.grassCanvas.width = cols + 2;
        this.grassCanvas.height = rows + 2;
        this.grassImage = this.grassCtx.createImageData(cols + 2, rows + 2);
        this.grassPixels = new Uint32Array(this.grassImage.data.buffer);
        this.blurA = new Float32Array(cols * rows);
        this.blurB = new Float32Array(cols * rows);
        this.ground = world.terrain ? groundLayer(world) : null;
        this.resize(world);
        // Start on the overview.
        this.cam = { x: world.width / 2, y: world.height / 2, angle: 0, scale: this.fit, anchor: 0.5 };
    }

    // Glide the camera toward where the current mode wants it. `target` is
    // { pop, i } for the followed animal (or null); `dt` is real seconds.
    updateCamera(world, target, dt) {
        const cam = this.cam;
        const W = world.width;
        const H = world.height;
        let tx = W / 2;
        let ty = H / 2;
        let ta = 0;
        let ts = this.fit;
        let anchor = ANCHOR_Y.map;
        if (this.mode !== 'map') {
            if (target) {
                tx = target.pop.x[target.i];
                ty = target.pop.y[target.i];
                if (this.mode === 'first') ta = -target.pop.heading[target.i] - Math.PI / 2;
            } else {
                tx = cam.x; // the animal is gone: hold still where it was
                ty = cam.y;
                ta = this.mode === 'first' ? cam.angle : 0;
            }
            ts = Math.min(this.w, this.h) / VIEW_SPAN[this.mode];
            anchor = ANCHOR_Y[this.mode];
        }

        const k = 1 - Math.exp(-dt / 0.18);  // position & zoom smoothing
        const ka = 1 - Math.exp(-dt / 0.35); // rotation is calmer
        cam.x += wrapDelta(tx - cam.x, W) * k;
        cam.y += wrapDelta(ty - cam.y, H) * k;
        cam.x = (cam.x + W) % W;
        cam.y = (cam.y + H) % H;
        let da = (ta - cam.angle) % TAU;
        if (da > Math.PI) da -= TAU;
        else if (da < -Math.PI) da += TAU;
        cam.angle += da * ka;
        cam.scale *= Math.pow(ts / cam.scale, k);
        cam.anchor += (anchor - cam.anchor) * k;
    }

    // Screen pixel → world coordinates (for clicking on animals).
    screenToWorld(world, px, py) {
        const { cam } = this;
        const dx = px - this.w / 2;
        const dy = py - this.h * cam.anchor;
        const c = Math.cos(-cam.angle);
        const s = Math.sin(-cam.angle);
        const x = cam.x + (dx * c - dy * s) / cam.scale;
        const y = cam.y + (dx * s + dy * c) / cam.scale;
        return { x: (x % world.width + world.width) % world.width, y: (y % world.height + world.height) % world.height };
    }

    // Who is under this screen pixel? The nearest individual within 16 pixels
    // of it, or 0.
    pick(world, px, py) {
        const p = this.screenToWorld(world, px, py);
        const reach = 16 / this.cam.scale; // 16 screen pixels
        let best = 0;
        let bestD2 = reach * reach;
        for (const pop of [world.herbivores, world.carnivores, world.humans]) {
            for (let i = 0; i < pop.n; i++) {
                let dx = Math.abs(pop.x[i] - p.x);
                let dy = Math.abs(pop.y[i] - p.y);
                dx = Math.min(dx, world.width - dx);
                dy = Math.min(dy, world.height - dy);
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = pop.id[i];
                }
            }
        }
        return best;
    }

    // Each patch is grazed on its own, so the raw field is speckled. A 3×3 box
    // blur (wrapping, like the world) turns it into a soft meadow. Display only.
    softGrass(g, cols, rows) {
        const a = this.blurA;
        const b = this.blurB;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                const l = x === 0 ? cols - 1 : x - 1;
                const r = x === cols - 1 ? 0 : x + 1;
                a[row + x] = (g[row + l] + g[row + x] + g[row + r]) / 3;
            }
        }
        for (let y = 0; y < rows; y++) {
            const up = (y === 0 ? rows - 1 : y - 1) * cols;
            const down = (y === rows - 1 ? 0 : y + 1) * cols;
            const row = y * cols;
            for (let x = 0; x < cols; x++) b[row + x] = (a[up + x] + a[row + x] + a[down + x]) / 3;
        }
        return b;
    }

    // `target`: the followed animal ({ kind, pop, i }) or null.
    // `focus`: what it is reacting to ({ pop, i }) or null.
    draw(world, target, focus, senseRadius) {
        const { ctx, cam, dpr } = this;
        const W = world.width;
        const H = world.height;
        const sx = this.w / 2;
        const sy = this.h * cam.anchor;
        const scale = cam.scale;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.translate(sx, sy);
        ctx.rotate(cam.angle);
        ctx.scale(scale, scale);

        // Half-extents of the (rotated) screen in world units around the camera.
        const c = Math.cos(-cam.angle);
        const s = Math.sin(-cam.angle);
        let ex = 0;
        let ey = 0;
        for (const [qx, qy] of [[-sx, -sy], [this.w - sx, -sy], [-sx, this.h - sy], [this.w - sx, this.h - sy]]) {
            ex = Math.max(ex, Math.abs(qx * c - qy * s));
            ey = Math.max(ey, Math.abs(qx * s + qy * c));
        }
        ex /= scale;
        ey /= scale;
        const near = (dx, dy) => dx > -ex - 8 && dx < ex + 8 && dy > -ey - 8 && dy < ey + 8;

        // Grass field, tiled around the camera.
        const { cols, rows } = world.grass;
        const g = this.softGrass(world.grass.g, cols, rows);
        const px = this.grassPixels;
        const lut = this.palette;
        const stride = cols + 2;
        const ground = this.ground;
        const [rr, rg, rb] = COLORS.rock;
        const [lr, lg, lb] = COLORS.lush;
        const bare = ground !== null ? ground.bare : null;
        for (let y = -1; y <= rows; y++) {
            const gy = (y + rows) % rows;
            for (let x = -1; x <= cols; x++) {
                const gx = (x + cols) % cols;
                const k = gy * cols + gx;
                let c = lut[(g[k] * 255) | 0];
                if (ground !== null) {
                    // Water, or grass over its biome's ground (or over rock), lit by the slope.
                    if (ground.water[k] !== 0) {
                        c = ground.water[k];
                    } else if (bare !== null) {
                        const s = ground.shade[k];
                        const q = 4 * k;
                        const t = GREEN[(g[k] * 255) | 0] * bare[q + 3];
                        const r = (bare[q] + (lr - bare[q]) * t) * s;
                        const gg = (bare[q + 1] + (lg - bare[q + 1]) * t) * s;
                        const b = (bare[q + 2] + (lb - bare[q + 2]) * t) * s;
                        c = (255 << 24) | ((b > 255 ? 255 : b) << 16) | ((gg > 255 ? 255 : gg) << 8) | (r > 255 ? 255 : r);
                    } else {
                        const s = ground.shade[k];
                        const t = ground.rock[k];
                        const r = ((c & 255) * (1 - t) + rr * t) * s;
                        const gg = (((c >> 8) & 255) * (1 - t) + rg * t) * s;
                        const b = (((c >> 16) & 255) * (1 - t) + rb * t) * s;
                        c = (255 << 24) | ((b > 255 ? 255 : b) << 16) | ((gg > 255 ? 255 : gg) << 8) | (r > 255 ? 255 : r);
                    }
                }
                px[(y + 1) * stride + x + 1] = c;
            }
        }
        this.grassCtx.putImageData(this.grassImage, 0, 0);
        ctx.imageSmoothingEnabled = true;
        // Each tile reaches half a patch into the wrapped border, so neighbouring
        // tiles overlap with identical pixels and no hairline shows between them.
        const padX = 0.5 * world.grass.cellW;
        const padY = 0.5 * world.grass.cellH;
        for (const ox of [-W, 0, W]) {
            for (const oy of [-H, 0, H]) {
                const x0 = ox - cam.x;
                const y0 = oy - cam.y;
                if (x0 >= ex || x0 + W <= -ex || y0 >= ey || y0 + H <= -ey) continue;
                ctx.drawImage(this.grassCanvas, 0.5, 0.5, cols + 1, rows + 1, x0 - padX, y0 - padY, W + 2 * padX, H + 2 * padY);
            }
        }

        const minWorld = 1.1 / scale; // keep animals at least ~1px on small screens

        // Herbivores: dots.
        const hp = world.herbivores;
        const r = Math.max(2.3, minWorld);
        ctx.fillStyle = COLORS.herbivore;
        ctx.beginPath();
        for (let i = 0; i < hp.n; i++) {
            const x = wrapDelta(hp.x[i] - cam.x, W);
            const y = wrapDelta(hp.y[i] - cam.y, H);
            if (!near(x, y)) continue;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, TAU);
        }
        ctx.fill();

        // Carnivores: small triangles pointing where they are heading.
        const cp = world.carnivores;
        const L = Math.max(7, 3 * minWorld);
        const back = L * 0.75;
        ctx.fillStyle = COLORS.carnivore;
        ctx.beginPath();
        for (let i = 0; i < cp.n; i++) {
            const x = wrapDelta(cp.x[i] - cam.x, W);
            const y = wrapDelta(cp.y[i] - cam.y, H);
            if (!near(x, y)) continue;
            const h = cp.heading[i];
            ctx.moveTo(x + Math.cos(h) * L, y + Math.sin(h) * L);
            ctx.lineTo(x + Math.cos(h + 2.5) * back, y + Math.sin(h + 2.5) * back);
            ctx.lineTo(x + Math.cos(h - 2.5) * back, y + Math.sin(h - 2.5) * back);
            ctx.closePath();
        }
        ctx.fill();

        if (world.humans.n || world.tribes.length) this.drawPeople(world, near, scale);
        if (target) this.drawTarget(world, target, focus, senseRadius, scale);
    }

    // Camps (a flag on a pole) and people (small diamonds in their tribe's
    // colour; children smaller).
    drawPeople(world, near, scale) {
        const { ctx, cam } = this;
        const W = world.width;
        const H = world.height;
        const px = 1 / scale;
        const campRadius = world.p.human.campRadius;

        for (const tribe of world.tribes) {
            const x = wrapDelta(tribe.camp.x - cam.x, W);
            const y = wrapDelta(tribe.camp.y - cam.y, H);
            if (!near(x, y)) continue;
            ctx.beginPath();
            ctx.arc(x, y, campRadius, 0, TAU);
            ctx.fillStyle = 'rgba(16, 18, 17, 0.35)';
            ctx.fill();
            // Pole and flag keep a constant size on screen.
            const fw = Math.max(16 * px, 9);
            const fh = fw * 0.66;
            const pole = fh * 1.9;
            ctx.fillStyle = '#d9dcd6';
            ctx.fillRect(x - 0.6 * px, y - pole, 1.2 * px, pole);
            drawFlag(ctx, tribe.flag, x, y - pole, fw, fh);
            ctx.lineWidth = px;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.strokeRect(x, y - pole, fw, fh);
        }

        const pop = world.humans;
        const maturity = world.p.human.maturity;
        const adult = Math.max(3.4, 2.8 * px);
        const child = adult * 0.65;
        ctx.lineWidth = Math.max(0.8, px);
        ctx.strokeStyle = '#101211';
        for (const tribe of world.tribes) {
            ctx.fillStyle = tribe.color;
            ctx.beginPath();
            for (let i = 0; i < pop.n; i++) {
                if (pop.tribe[i] !== tribe.id) continue;
                const x = wrapDelta(pop.x[i] - cam.x, W);
                const y = wrapDelta(pop.y[i] - cam.y, H);
                if (!near(x, y)) continue;
                const r = pop.age[i] < maturity ? child : adult;
                ctx.moveTo(x, y - r);
                ctx.lineTo(x + r, y);
                ctx.lineTo(x, y + r);
                ctx.lineTo(x - r, y);
                ctx.closePath();
            }
            ctx.fill();
            ctx.stroke();
        }
    }

    // The followed animal: a ring, what it can sense, and what it is reacting to.
    drawTarget(world, target, focus, senseRadius, scale) {
        const { ctx, cam } = this;
        const x = wrapDelta(target.pop.x[target.i] - cam.x, world.width);
        const y = wrapDelta(target.pop.y[target.i] - cam.y, world.height);
        const px = 1 / scale; // one screen pixel, in world units
        ctx.lineWidth = 1.5 * px;

        if (this.mode !== 'map') {
            ctx.beginPath();
            ctx.arc(x, y, senseRadius, 0, TAU);
            ctx.setLineDash([4 * px, 4 * px]);
            ctx.strokeStyle = 'rgba(236, 230, 214, 0.35)';
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (focus) {
            const fx = x + wrapDelta(focus.pop.x[focus.i] - target.pop.x[target.i], world.width);
            const fy = y + wrapDelta(focus.pop.y[focus.i] - target.pop.y[target.i], world.height);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(fx, fy);
            ctx.strokeStyle = focus.kind === 'carnivore' ? COLORS.carnivore
                : focus.kind === 'herbivore' ? COLORS.herbivore
                : world.tribeById.get(focus.pop.tribe[focus.i])?.color ?? COLORS.herbivore;
            ctx.globalAlpha = 0.8;
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        ctx.beginPath();
        ctx.arc(x, y, Math.max(7, 9 * px), 0, TAU);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.stroke();
    }
}
