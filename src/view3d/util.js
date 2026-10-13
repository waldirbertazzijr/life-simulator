// Small helpers shared by the page: the 3D view, the flat one (render.js)
// and play/. No three.js here, so node tests can use it too. (The
// simulation's files keep their own copies.)
//
// The world is a torus: walk off the right edge and you come back on the left.
// The 3D view keeps a "floating origin": the point the camera looks at is
// always near three.js (0, 0, 0), and everything else is placed at its
// shortest wrapped offset from that point. So nothing is ever far from the
// origin (no float jitter) and the world's edge is never in sight.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Shortest signed difference on a ring of size `size`.
export const wrapDelta = (d, size) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);

// Bring a coordinate back into [0, size).
export const wrap = (v, size) => ((v % size) + size) % size;

// Shortest signed difference between two angles, in (-π, π].
export function angleDelta(a) {
    a %= TAU;
    if (a > Math.PI) a -= TAU;
    else if (a <= -Math.PI) a += TAU;
    return a;
}

// The ground height at a world position: the terrain's, or 0 on a flat world.
export function groundOf(terrain, width, height) {
    if (!terrain) return () => 0;
    return (x, y) => terrain.heightAt(wrap(x, width), wrap(y, height));
}

// The 0–255 red, green and blue of a CSS hex colour such as '#3e6840'.
export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// A 32-bit integer hash (lowbias32): neighbouring inputs give unrelated
// outputs. Scenery (tufts, trees) is placed by hashes, so it is the same
// every time it is built.
export function hash(n) {
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
}

// The ground's height where the ground mesh (terrain-mesh.js) really is: its
// triangles, not the bilinear heightAt, so what stands on it neither floats
// nor sinks. Also returns the slope (rise over run) of that triangle in `out[1]`.
export function meshHeight(T, x, y, out) {
    const { cols, rows, cellW, cellH, height: h } = T;
    const fx = x / cellW;
    const fy = y / cellH;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const i0 = ((i % cols) + cols) % cols;
    const j0 = ((j % rows) + rows) % rows;
    const i1 = i0 + 1 === cols ? 0 : i0 + 1;
    const j1 = j0 + 1 === rows ? 0 : j0 + 1;
    const a = h[i0 + j0 * cols];
    const b = h[i1 + j0 * cols];
    const c = h[i0 + j1 * cols];
    const d = h[i1 + j1 * cols];
    let gx;
    let gy;
    if (tx + ty <= 1) {
        out[0] = a + (b - a) * tx + (c - a) * ty; // triangle a, b, c
        gx = (b - a) / cellW;
        gy = (c - a) / cellH;
    } else {
        out[0] = d + (c - d) * (1 - tx) + (b - d) * (1 - ty); // triangle b, c, d
        gx = (d - c) / cellW;
        gy = (d - b) / cellH;
    }
    out[1] = Math.sqrt(gx * gx + gy * gy);
}

// A 3×3 box blur of `channels` interleaved values per cell over a wrapping
// cols × rows grid, in place, counting only cells where `skip` is 0 (a cell
// with skip set keeps its value and lends none to its neighbours).
export function blurGrid(data, channels, cols, rows, skip) {
    const src = Float32Array.from(data);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const k = c + r * cols;
            if (skip[k]) continue;
            let n = 0;
            for (let ch = 0; ch < channels; ch++) data[k * channels + ch] = 0;
            for (let dr = -1; dr <= 1; dr++) {
                const rr = (r + dr + rows) % rows;
                for (let dc = -1; dc <= 1; dc++) {
                    const j = ((c + dc + cols) % cols) + rr * cols;
                    if (skip[j]) continue;
                    for (let ch = 0; ch < channels; ch++) data[k * channels + ch] += src[j * channels + ch];
                    n++;
                }
            }
            for (let ch = 0; ch < channels; ch++) data[k * channels + ch] /= n;
        }
    }
}
