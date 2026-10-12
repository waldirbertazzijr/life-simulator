// DEV ONLY: a stand-in for the engine's terrain, so the 3D view can be
// checked on hills and lakes before the engine has them. Turned on with
// `?stubterrain` in the URL, and only when the world has no terrain of its own.
//
// It implements the documented `world.terrain` interface (docs/stage2/README.md)
// but lives only inside the 3D view: the simulation knows nothing about it,
// so animals will happily walk across its lakes. Delete it once the engine
// provides world.terrain.
import { wrap } from './util.js';

export function stubTerrain(world, seed = 7) {
    const W = world.width;
    const H = world.height;
    const cols = Math.max(4, Math.round(W / 20));
    const rows = Math.max(4, Math.round(H / 20));
    const cellW = W / cols;
    const cellH = H / rows;

    // Periodic value noise: random values on a lattice that repeats every
    // (px, py) points, smoothly interpolated, so the result wraps like the world.
    const hash = (i, j, o) => {
        let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(o + seed * 31, 1442695041);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const ease = (t) => t * t * (3 - 2 * t);
    const noise = (u, v, px, py, o) => {
        const i0 = Math.floor(u);
        const j0 = Math.floor(v);
        const fu = ease(u - i0);
        const fv = ease(v - j0);
        const a = hash(i0 % px, j0 % py, o);
        const b = hash((i0 + 1) % px, j0 % py, o);
        const c = hash(i0 % px, (j0 + 1) % py, o);
        const d = hash((i0 + 1) % px, (j0 + 1) % py, o);
        return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
    };

    const scale = Math.sqrt(W * H);
    const height = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            let n = 0;
            let sum = 0;
            for (let o = 0; o < 4; o++) {
                const px = Math.max(1, Math.round((4 * W / scale) * 2 ** o));
                const py = Math.max(1, Math.round((4 * H / scale) * 2 ** o));
                const amp = 0.5 ** o;
                n += amp * noise((i / cols) * px, (j / rows) * py, px, py, o);
                sum += amp;
            }
            n /= sum;
            height[i + j * cols] = 150 * Math.pow(Math.max(0, n - 0.2) / 0.8, 2.2);
        }
    }
    const sorted = [...height].sort((a, b) => a - b);
    const seaLevel = sorted[Math.floor(sorted.length * 0.12)] + 0.5;

    const heightAt = (x, y) => {
        const gx = wrap(x, W) / cellW;
        const gy = wrap(y, H) / cellH;
        const i0 = Math.floor(gx) % cols;
        const j0 = Math.floor(gy) % rows;
        const i1 = (i0 + 1) % cols;
        const j1 = (j0 + 1) % rows;
        const fx = gx - Math.floor(gx);
        const fy = gy - Math.floor(gy);
        const a = height[i0 + j0 * cols];
        const b = height[i1 + j0 * cols];
        const c = height[i0 + j1 * cols];
        const d = height[i1 + j1 * cols];
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    const isWater = (x, y) => heightAt(x, y) < seaLevel;
    return { cols, rows, cellW, cellH, height, seaLevel, heightAt, isWater, blocked: isWater };
}
