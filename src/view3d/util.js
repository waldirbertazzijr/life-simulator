// Small helpers shared by the 3D view.
//
// The world is a torus: walk off the right edge and you come back on the left.
// The 3D view keeps a "floating origin": the point the camera looks at is
// always near three.js (0, 0, 0), and everything else is placed at its
// shortest wrapped offset from that point. So nothing is ever far from the
// origin (no float jitter) and the world's edge is never in sight.
export const TAU = Math.PI * 2;

// Shortest signed difference on a ring of size `size` (as in render.js).
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
