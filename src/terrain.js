// Terrain: a height field over the torus, and what it means for life on it.
//
// Interface shared with the renderers (docs/stage2/README.md):
//
//   cols, rows       grid NODES; node (i, j) sits at world (i·cellW, j·cellH).
//                    The grid wraps: node (cols, j) is node (0, j).
//   cellW, cellH     node spacing in world units
//   height           Float32Array(cols·rows), index i + j·cols, world units (≥ 0)
//   seaLevel         nodes/points below this height are water
//   heightAt(x, y)   bilinear height at any world position (wraps)
//   isWater(x, y)    heightAt(x, y) < seaLevel
//   blocked(x, y)    true where land creatures and people cannot go (water, cliffs)
//
// The engine also uses:
//
//   spawnable(x, y)  open ground connected to the main body of land (no
//                    stranded islands or plateaus walled in by cliffs)
//   fertility(x, y)  0..1: how much grass the ground can hold (0 on water, cliffs)
//   rockiness(x, y)  0..1: how bare the land is with altitude (the 2D view's rock)
//   slopeAt(x, y)    steepness (rise over run) of the node cell under (x, y)
//   move(...)        a step that turns aside rather than enter blocked ground
//   pathField(x, y)  how far (x, y) is by land from everywhere: a camp's way home
//   way(...)         which way to walk to a camp, using its path field
//
// Biomes (params.biomes; null when biomes are off). For renderers:
//
//   biome(x, y)      biome index at a world position (BIOME.WATER on water)
//   biomes           [{ name, color: [r, g, b], fertility }, ...] in index order.
//                    `color` is the bare ground, what shows where the grass is
//                    grazed down; `fertility` is the grass it can hold, 0..1.
//   biomeGrid        Uint8Array, the biome of every grass patch (same layout as
//                    world.grass.g), filled in by fertilityGrid()
//   moisture, temperature   Float32Array(cols·rows), the climate at each node, 0..1-ish
//
// How biomes are made. Two smooth fields over the nodes, a little like a
// Whittaker diagram (climate → vegetation):
//   moisture     high beside water and fading with distance from it, plus broad
//                "weather" noise that makes whole regions wetter or drier;
//   temperature  falling with altitude (a lapse rate), plus broad noise.
// Each point is classed from the two: snow on the coldest summits, bare rock
// and then tundra below them, steppe where it is dry, wetland where it is wet
// and warm, forest on the cooler, moist mid-slopes, meadow in the warm, moist
// rest. Each class grows its own amount of grass (its fertility).
//
// How it is made. The heights are *periodic* gradient noise: each octave is a
// lattice of random directions whose size divides the world exactly, and the
// lattice wraps around, so the land is seamless where the world joins itself.
// A broad noise lays out basins and uplands; a "ridged" noise (1 − |n|, which
// peaks along the noise's zero lines) raises mountain ranges, but only on the
// uplands. The lowest `water` fraction of the land is flooded.
//
// Why blocked() is a mask and not a height test: it sits in the hottest loop
// (every moving animal, every step), so it is one array lookup. The mask has
// four cells per node cell along each side. A mask cell counts as water if ANY
// of its corners is below sea level. Inside one node cell the bilinear height
// is linear along each axis, so its lowest point over a mask cell is a corner;
// hence open ground is never water: blocked(x, y) false ⇒ isWater(x, y) false.
// Creatures never stand in the lake, in any renderer.
const TAU = Math.PI * 2;
const SUB = 4; // mask cells per node cell, along each side

// Mask values.
const OPEN = 0;
const WATER = 1;
const CLIFF = 2;

const smoothstep = (a, b, v) => {
    const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
    return t * t * (3 - 2 * t);
};
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10); // Perlin's quintic: smooth at the lattice

// Add one octave of periodic gradient noise (≈ −0.7..0.7) to `out`. The lattice
// has nx × ny cells over the whole world and wraps, so the result tiles.
// `ridged` folds it into ridges: 1 − |n|, sharpened.
function addOctave(out, cols, rows, nx, ny, amp, rng, ridged) {
    const gx = new Float64Array(nx * ny);
    const gy = new Float64Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) {
        const a = rng.next() * TAU;
        gx[k] = Math.cos(a);
        gy[k] = Math.sin(a);
    }
    for (let j = 0; j < rows; j++) {
        const v = (j * ny) / rows;
        const b0 = Math.floor(v);
        const fv = v - b0;
        const b1 = b0 + 1 === ny ? 0 : b0 + 1;
        const sv = fade(fv);
        for (let i = 0; i < cols; i++) {
            const u = (i * nx) / cols;
            const a0 = Math.floor(u);
            const fu = u - a0;
            const a1 = a0 + 1 === nx ? 0 : a0 + 1;
            const su = fade(fu);
            const k00 = a0 + b0 * nx;
            const k10 = a1 + b0 * nx;
            const k01 = a0 + b1 * nx;
            const k11 = a1 + b1 * nx;
            const n00 = gx[k00] * fu + gy[k00] * fv;
            const n10 = gx[k10] * (fu - 1) + gy[k10] * fv;
            const n01 = gx[k01] * fu + gy[k01] * (fv - 1);
            const n11 = gx[k11] * (fu - 1) + gy[k11] * (fv - 1);
            const top = n00 + (n10 - n00) * su;
            const bottom = n01 + (n11 - n01) * su;
            let n = top + (bottom - top) * sv;
            if (ridged) {
                n = 1 - Math.abs(n) / 0.7;
                n *= n;
            }
            out[i + j * cols] += amp * n;
        }
    }
}

// Fractal noise: octaves of halving size and shrinking weight, scaled to 0..1,
// one value per node of a cols × rows grid over a W × H torus. Exported so other
// fields laid over the land (moisture, temperature for biomes) can reuse it.
export function fractal(cols, rows, W, H, wavelength, octaves, roughness, rng, ridged = false) {
    const out = new Float64Array(cols * rows);
    let amp = 1;
    for (let o = 0; o < octaves; o++) {
        const wl = wavelength / 2 ** o;
        addOctave(out, cols, rows, Math.max(1, Math.round(W / wl)), Math.max(1, Math.round(H / wl)), amp, rng, ridged);
        amp *= roughness;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of out) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    for (let k = 0; k < out.length; k++) out[k] = (out[k] - lo) / (hi - lo || 1);
    return out;
}

// Path fields: "unreachable", and the eight neighbours of a cell.
const FAR = 0x3fffffff;
const NEIGHBOUR_A = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_B = [0, 0, 1, -1, 1, -1, 1, -1];
const wrapCell = (v, n) => (v < 0 ? v + n : v >= n ? v - n : v);

// Distance from the nearest seed cell to every cell of a wrapping grid, moving
// only through cells where open[c] is 1: 8 neighbours, step costs 2 and 3
// (≈ 1 : √2), never cutting diagonally between two closed cells. FAR where
// unreachable. Dial's algorithm: the step costs are small integers, so a ring
// of four buckets replaces the priority queue.
function dial(cols, rows, open, seeds) {
    const dist = new Int32Array(cols * rows).fill(FAR);
    const buckets = [[], [], [], []];
    for (const s of seeds) {
        dist[s] = 0;
        buckets[0].push(s);
    }
    let pending = seeds.length;
    for (let d = 0; pending > 0; d++) {
        const bucket = buckets[d & 3];
        while (bucket.length) {
            const c = bucket.pop();
            pending--;
            if (dist[c] !== d) continue; // a shorter way was found since
            const a = c % cols;
            const b = (c - a) / cols;
            for (let k = 0; k < 8; k++) {
                const da = NEIGHBOUR_A[k];
                const db = NEIGHBOUR_B[k];
                const n = wrapCell(a + da, cols) + wrapCell(b + db, rows) * cols;
                if (!open[n]) continue;
                if (da !== 0 && db !== 0
                    && (!open[wrapCell(a + da, cols) + b * cols] || !open[a + wrapCell(b + db, rows) * cols])) continue;
                const nd = d + (da !== 0 && db !== 0 ? 3 : 2);
                if (nd < dist[n]) {
                    dist[n] = nd;
                    buckets[nd & 3].push(n);
                    pending++;
                }
            }
        }
    }
    return dist;
}

// Biomes, in index order (terrain.biomes adds each one's fertility from
// params.biomes.fertility). Colours are the bare ground under the grass:
// muted, in the family of the 2D view's greens, rock grey and water blue.
export const BIOME = { WATER: 0, WETLAND: 1, MEADOW: 2, FOREST: 3, STEPPE: 4, TUNDRA: 5, ROCK: 6, SNOW: 7 };
const BIOME_LOOK = [
    { name: 'water', color: [36, 54, 66] },
    { name: 'wetland', color: [34, 58, 46] },
    { name: 'meadow', color: [32, 35, 26] },
    { name: 'forest', color: [16, 38, 24] },
    { name: 'steppe', color: [80, 72, 48] },
    { name: 'tundra', color: [76, 80, 68] },
    { name: 'rock', color: [98, 94, 86] },
    { name: 'snow', color: [168, 172, 170] },
];

// Turning aside: the wanted heading first, then 45°, 90°, 135° to one side and
// the other, and finally straight back. cos/sin of k·45° for k = −4..4.
const TURNS = [0, 1, -1, 2, -2, 3, -3, 4];
const R = Math.SQRT1_2;
const TURN_COS = [-1, -R, 0, R, 1, R, 0, -R, -1];
const TURN_SIN = [0, -R, -1, -R, 0, R, 1, R, 0];

export class Terrain {
    constructor(width, height, P, rng) {
        this.W = width;
        this.H = height;
        this.cols = Math.max(4, Math.round(width / P.spacing));
        this.rows = Math.max(4, Math.round(height / P.spacing));
        this.cellW = width / this.cols;
        this.cellH = height / this.rows;
        this.invW = 1 / this.cellW;
        this.invH = 1 / this.cellH;
        this.seaLevel = P.seaLevel;
        this.peak = P.peak;
        this.P = P;

        this.height = this.makeHeights(P, rng);
        this.slope = this.makeSlopes();
        this.makeMask(P);
        this.makeReach();

        // Biomes come later, from makeBiomes(), if they are on.
        this.biomes = null;
        this.biomeGrid = null;
        this.biomeParams = null;
        this.moisture = null;
        this.temperature = null;
    }

    // ---- generation -----------------------------------------------------------

    makeHeights(P, rng) {
        const { cols, rows, W, H } = this;
        const n = cols * rows;
        // Basins and uplands, then ranges that rise only on the uplands.
        const base = fractal(cols, rows, W, H, P.wavelength, P.octaves, P.roughness, rng, false);
        const ridge = fractal(cols, rows, W, H, P.wavelength * 0.7, 3, 0.45, rng, true);
        const e = new Float64Array(n);
        for (let k = 0; k < n; k++) e[k] = base[k] + P.ranges * smoothstep(0.45, 0.8, base[k]) * ridge[k];

        // Flood the lowest `water` fraction. Below the shore, depth runs down to
        // 0; above it, land rises to `peak`, with `relief` > 1 keeping the
        // lowlands gentle and the summits steep.
        const sorted = Float64Array.from(e).sort();
        const lo = sorted[0];
        const shore = sorted[Math.min(n - 1, Math.floor(P.water * n))];
        const hi = sorted[n - 1];
        const height = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            height[k] = e[k] < shore
                ? P.seaLevel * (e[k] - lo) / (shore - lo || 1)
                : P.seaLevel + (P.peak - P.seaLevel) * ((e[k] - shore) / (hi - shore || 1)) ** P.relief;
        }
        return height;
    }

    // Steepness of each node cell (between nodes i..i+1, j..j+1).
    makeSlopes() {
        const { cols, rows, height: h, cellW, cellH } = this;
        const slope = new Float32Array(cols * rows);
        for (let j = 0; j < rows; j++) {
            const j1 = j + 1 === rows ? 0 : j + 1;
            for (let i = 0; i < cols; i++) {
                const i1 = i + 1 === cols ? 0 : i + 1;
                const h00 = h[i + j * cols];
                const h10 = h[i1 + j * cols];
                const h01 = h[i + j1 * cols];
                const h11 = h[i1 + j1 * cols];
                const gx = (h10 - h00 + h11 - h01) / (2 * cellW);
                const gy = (h01 - h00 + h11 - h10) / (2 * cellH);
                slope[i + j * cols] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        return slope;
    }

    // The movement mask: water (conservatively, see the header) and cliffs.
    makeMask(P) {
        const { cols, rows } = this;
        const mcols = cols * SUB;
        const mrows = rows * SUB;
        this.mcols = mcols;
        this.mrows = mrows;
        this.minvW = mcols / this.W;
        this.minvH = mrows / this.H;
        // Height at every mask-cell corner (corner (a, b) is shared by four cells).
        const corner = new Float32Array(mcols * mrows);
        const dx = this.W / mcols;
        const dy = this.H / mrows;
        for (let b = 0; b < mrows; b++) {
            for (let a = 0; a < mcols; a++) corner[a + b * mcols] = this.heightAt(a * dx, b * dy);
        }
        const mask = new Uint8Array(mcols * mrows);
        const sea = this.seaLevel;
        for (let b = 0; b < mrows; b++) {
            const b1 = b + 1 === mrows ? 0 : b + 1;
            for (let a = 0; a < mcols; a++) {
                const a1 = a + 1 === mcols ? 0 : a + 1;
                const h00 = corner[a + b * mcols];
                const h10 = corner[a1 + b * mcols];
                const h01 = corner[a + b1 * mcols];
                const h11 = corner[a1 + b1 * mcols];
                if (h00 < sea || h10 < sea || h01 < sea || h11 < sea) {
                    mask[a + b * mcols] = WATER;
                    continue;
                }
                // A cliff: too steep to climb, measured over this small cell so
                // the cliff line follows the slope rather than the node grid.
                const gx = (h10 - h00 + h11 - h01) / (2 * dx);
                const gy = (h01 - h00 + h11 - h10) / (2 * dy);
                if (gx * gx + gy * gy > P.cliff * P.cliff) mask[a + b * mcols] = CLIFF;
            }
        }
        this.mask = mask;
    }

    // Label the open ground into connected pieces (8-neighbour, wrapping) and
    // keep the largest as the place where life may be put down. Smaller pieces
    // (islands, plateaus ringed by cliffs) can be seen but not reached.
    makeReach() {
        const { mask, mcols, mrows } = this;
        const n = mcols * mrows;
        const label = new Int32Array(n).fill(-1);
        const queue = new Int32Array(n);
        let best = -1;
        let bestSize = 0;
        let next = 0;
        for (let s = 0; s < n; s++) {
            if (mask[s] !== OPEN || label[s] >= 0) continue;
            const id = next++;
            let head = 0;
            let tail = 0;
            queue[tail++] = s;
            label[s] = id;
            while (head < tail) {
                const c = queue[head++];
                const a = c % mcols;
                const b = (c - a) / mcols;
                for (let db = -1; db <= 1; db++) {
                    let bb = b + db;
                    if (bb < 0) bb += mrows; else if (bb >= mrows) bb -= mrows;
                    for (let da = -1; da <= 1; da++) {
                        let aa = a + da;
                        if (aa < 0) aa += mcols; else if (aa >= mcols) aa -= mcols;
                        const m = aa + bb * mcols;
                        if (mask[m] === OPEN && label[m] < 0) {
                            label[m] = id;
                            queue[tail++] = m;
                        }
                    }
                }
            }
            if (tail > bestSize) {
                bestSize = tail;
                best = id;
            }
        }
        const reach = new Uint8Array(n);
        for (let k = 0; k < n; k++) reach[k] = label[k] === best ? 1 : 0;
        this.reach = reach;
        this.reachFraction = bestSize / n;
    }

    // Climate and biomes (see the header). `rng` is a random stream of their
    // own, so turning biomes on changes only the climate laid over the land:
    // the same heights, and the same animals put down in the same places.
    makeBiomes(P, rng) {
        const { cols, rows, W, H, height: h, seaLevel: sea, peak } = this;
        const n = cols * rows;
        // How far each node is from the nearest water node, in world units.
        const water = [];
        for (let k = 0; k < n; k++) if (h[k] < sea) water.push(k);
        const steps = dial(cols, rows, new Uint8Array(n).fill(1), water);
        const unit = (this.cellW + this.cellH) / 4; // steps count 2 per node spacing
        const weather = fractal(cols, rows, W, H, P.weatherSize, 3, 0.5, rng);
        const climate = fractal(cols, rows, W, H, P.climateSize, 2, 0.5, rng);
        this.moisture = new Float32Array(n);
        this.temperature = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const near = steps[k] === FAR ? 0 : Math.exp(-(steps[k] * unit) / P.wetReach);
            this.moisture[k] = P.waterShare * near + (1 - P.waterShare) * weather[k];
            const up = h[k] < sea ? 0 : (h[k] - sea) / (peak - sea); // 0 at the shore, 1 at the top
            this.temperature[k] = 1 - P.climateSpread * climate[k] - P.lapse * up;
        }
        this.biomeParams = P;
        this.biomes = BIOME_LOOK.map((b) => ({ name: b.name, color: b.color, fertility: P.fertility[b.name] }));
    }

    // A climate field (moisture or temperature) at any world position, bilinear
    // between the nodes like heightAt.
    fieldAt(field, x, y) {
        const { cols, rows } = this;
        let fx = x * this.invW;
        let fy = y * this.invH;
        if (fx < 0 || fx >= cols) fx = ((fx % cols) + cols) % cols;
        if (fy < 0 || fy >= rows) fy = ((fy % rows) + rows) % rows;
        const i0 = fx | 0;
        const j0 = fy | 0;
        const tx = fx - i0;
        const ty = fy - j0;
        const i1 = i0 + 1 >= cols ? 0 : i0 + 1;
        const r0 = j0 * cols;
        const r1 = (j0 + 1 >= rows ? 0 : j0 + 1) * cols;
        const a = field[i0 + r0];
        const b = field[i1 + r0];
        const c = field[i0 + r1];
        const d = field[i1 + r1];
        return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }

    // The biome at a world position: water, then by temperature (the cold
    // classes, whatever the moisture), then by moisture.
    biome(x, y) {
        if (this.isWater(x, y)) return BIOME.WATER;
        const P = this.biomeParams;
        const t = this.fieldAt(this.temperature, x, y);
        if (t < P.snowBelow) return BIOME.SNOW;
        if (t < P.rockBelow) return BIOME.ROCK;
        if (t < P.tundraBelow) return BIOME.TUNDRA;
        const m = this.fieldAt(this.moisture, x, y);
        if (m < P.dryBelow) return BIOME.STEPPE;
        if (t < P.forestBelow) return BIOME.FOREST; // the cooler, moist mid-slopes
        return m > P.wetAbove ? BIOME.WETLAND : BIOME.MEADOW;
    }

    // Share of the grass patches in each biome (for the checks).
    biomeShares() {
        const shares = new Array(this.biomes.length).fill(0);
        for (const b of this.biomeGrid) shares[b]++;
        return shares.map((s) => s / this.biomeGrid.length);
    }

    // Share of the world that is water and cliff, and how much of the rest is
    // the main body of land (for the checks).
    coverage() {
        let water = 0;
        let cliff = 0;
        for (const m of this.mask) {
            if (m === WATER) water++;
            else if (m === CLIFF) cliff++;
        }
        const n = this.mask.length;
        return { water: water / n, cliff: cliff / n, reach: this.reachFraction };
    }

    // ---- queries ----------------------------------------------------------------

    heightAt(x, y) {
        const { cols, rows, height: h } = this;
        let fx = x * this.invW;
        let fy = y * this.invH;
        if (fx < 0 || fx >= cols) fx = ((fx % cols) + cols) % cols;
        if (fy < 0 || fy >= rows) fy = ((fy % rows) + rows) % rows;
        const i0 = fx | 0;
        const j0 = fy | 0;
        const tx = fx - i0;
        const ty = fy - j0;
        const i1 = i0 + 1 >= cols ? 0 : i0 + 1;
        const r0 = j0 * cols;
        const r1 = (j0 + 1 >= rows ? 0 : j0 + 1) * cols;
        const a = h[i0 + r0];
        const b = h[i1 + r0];
        const c = h[i0 + r1];
        const d = h[i1 + r1];
        return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }

    isWater(x, y) {
        return this.heightAt(x, y) < this.seaLevel;
    }

    // Index into the mask for a world position (wrapping, if needed).
    maskIndex(x, y) {
        if (x < 0 || x >= this.W) x = ((x % this.W) + this.W) % this.W;
        if (y < 0 || y >= this.H) y = ((y % this.H) + this.H) % this.H;
        let a = (x * this.minvW) | 0;
        let b = (y * this.minvH) | 0;
        if (a >= this.mcols) a = this.mcols - 1;
        if (b >= this.mrows) b = this.mrows - 1;
        return a + b * this.mcols;
    }

    blocked(x, y) {
        return this.mask[this.maskIndex(x, y)] !== OPEN;
    }

    isCliff(x, y) {
        return this.mask[this.maskIndex(x, y)] === CLIFF;
    }

    spawnable(x, y) {
        return this.reach[this.maskIndex(x, y)] === 1;
    }

    slopeAt(x, y) {
        let i = (x * this.invW) | 0;
        let j = (y * this.invH) | 0;
        if (i < 0 || i >= this.cols) i = ((i % this.cols) + this.cols) % this.cols;
        if (j < 0 || j >= this.rows) j = ((j % this.rows) + this.rows) % this.rows;
        return this.slope[i + j * this.cols];
    }

    // How bare the land is with altitude alone, 0..1: 0 in the lowlands, rising
    // up the mountains to 1 (rock) near the summits. 0 on water.
    rockiness(x, y) {
        const h = this.heightAt(x, y);
        if (h < this.seaLevel) return 0;
        const up = (h - this.seaLevel) / (this.peak - this.seaLevel); // 0 at the shore, 1 at the top
        return smoothstep(this.P.fertileBelow, this.P.barrenAbove, up);
    }

    // How much grass the ground can hold, 0..1: none in water or on cliffs.
    // With biomes, whatever the biome holds (lush wetland, full meadow, thinner
    // forest, sparse steppe, thin tundra, nothing on rock and snow). Without,
    // full in the lowlands, thinning out up the mountains to bare rock near the
    // summits. The one place fertility is decided: Grass gets it per patch
    // through fertilityGrid().
    fertility(x, y) {
        if (this.isWater(x, y) || this.isCliff(x, y)) return 0;
        if (this.biomes !== null) return this.biomes[this.biome(x, y)].fertility;
        return 1 - this.rockiness(x, y);
    }

    // Fertility at the centre of every patch of a grass grid. (Float32: the
    // regrowth loop reads it every step, so half the memory traffic counts.)
    // With biomes, also notes each patch's biome in biomeGrid.
    fertilityGrid(grass) {
        const f = new Float32Array(grass.cols * grass.rows);
        if (this.biomes !== null) this.biomeGrid = new Uint8Array(f.length);
        for (let r = 0; r < grass.rows; r++) {
            for (let c = 0; c < grass.cols; c++) {
                const x = (c + 0.5) * grass.cellW;
                const y = (r + 0.5) * grass.cellH;
                f[c + r * grass.cols] = this.fertility(x, y);
                if (this.biomeGrid !== null) this.biomeGrid[c + r * grass.cols] = this.biome(x, y);
            }
        }
        return f;
    }

    // A random spot on the main body of land.
    randomSpot(rng) {
        for (;;) {
            const x = rng.next() * this.W;
            const y = rng.next() * this.H;
            if (this.spawnable(x, y)) return { x, y };
        }
    }

    // ---- finding the way home ---------------------------------------------------
    //
    // Veering is enough for animals, which have no fixed destination. People
    // do: they carry food back to camp. Heading straight for camp across a lake
    // walks them into the shore of whatever bay faces home, and turning aside
    // only ever slides them back into it (a dead end). So each camp gets a map
    // of how far home is by land from every 10-unit cell (Dijkstra over the
    // open cells, 8 neighbours, step costs 2 and 3 ≈ 1 : √2), made once when the
    // camp is founded.

    // The coarse grid: 2 × 2 mask cells, open only if all four are.
    makeWayGrid() {
        if (this.wayOpen) return;
        const { mask, mcols } = this;
        const wcols = mcols / 2;
        const wrows = this.mrows / 2;
        this.wcols = wcols;
        this.wrows = wrows;
        this.wayW = this.W / wcols;
        this.wayH = this.H / wrows;
        this.wayOpen = new Uint8Array(wcols * wrows);
        for (let b = 0; b < wrows; b++) {
            for (let a = 0; a < wcols; a++) {
                const m = 2 * a + 2 * b * mcols;
                this.wayOpen[a + b * wcols] = mask[m] === OPEN && mask[m + 1] === OPEN
                    && mask[m + mcols] === OPEN && mask[m + mcols + 1] === OPEN ? 1 : 0;
            }
        }
    }

    wayIndex(x, y) {
        if (x < 0 || x >= this.W) x = ((x % this.W) + this.W) % this.W;
        if (y < 0 || y >= this.H) y = ((y % this.H) + this.H) % this.H;
        let a = (x / this.wayW) | 0;
        let b = (y / this.wayH) | 0;
        if (a >= this.wcols) a = this.wcols - 1;
        if (b >= this.wrows) b = this.wrows - 1;
        return a + b * this.wcols;
    }

    // Distance home (in half-cells) from every cell, toward the point (x, y).
    pathField(x, y) {
        this.makeWayGrid();
        return dial(this.wcols, this.wrows, this.wayOpen, [this.wayIndex(x, y)]);
    }

    // Which way to walk from (x, y) to a camp (ddx, ddy) away, at distance d,
    // given its path field. Straight there if that gets closer by land (it
    // usually does); otherwise toward the neighbouring cell nearest home. The
    // unit direction is left in this.ux, this.uy.
    way(field, x, y, ddx, ddy, d) {
        const ux = ddx / d;
        const uy = ddy / d;
        this.ux = ux;
        this.uy = uy;
        const look = 1.5 * this.wayW;
        if (d < look) return;
        const { wcols, wrows, wayW, wayH } = this;
        const a = Math.min(wcols - 1, (x / wayW) | 0);
        const b = Math.min(wrows - 1, (y / wayH) | 0);
        let here = field[a + b * wcols];
        // Straight on if it gets closer by land and nothing closed lies on the way.
        let ahead = field[this.wayIndex(x + ux * look, y + uy * look)];
        if (field[this.wayIndex(x + ux * look / 3, y + uy * look / 3)] === FAR
            || field[this.wayIndex(x + ux * look * 2 / 3, y + uy * look * 2 / 3)] === FAR) ahead = FAR;
        if (here !== FAR && ahead < here) return; // the usual case
        let best = FAR;
        let bx = 0;
        let by = 0;
        for (let k = 0; k < 8; k++) {
            const da = NEIGHBOUR_A[k];
            const db = NEIGHBOUR_B[k];
            const n = wrapCell(a + da, wcols) + wrapCell(b + db, wrows) * wcols;
            if (field[n] >= best) continue;
            // No cutting diagonally between two closed cells (as in pathField).
            if (da !== 0 && db !== 0
                && (field[wrapCell(a + da, wcols) + b * wcols] === FAR || field[a + wrapCell(b + db, wrows) * wcols] === FAR)) continue;
            best = field[n];
            bx = (a + da + 0.5) * wayW - x;
            by = (b + db + 0.5) * wayH - y;
        }
        if (best === FAR) return; // cut off from home: just head for it
        if (here === FAR) here = best + 2; // on the shore, a step beyond its best neighbour
        if (best >= here || ahead < here) return; // at home already, or straight on
        const len = Math.sqrt(bx * bx + by * by) || 1;
        this.ux = bx / len;
        this.uy = by / len;
    }

    // Which way to veer (±1) when the wanted direction (ux, uy) is blocked: the
    // side the creature was already heading to (`heading`, last step's), so it
    // keeps following a shore instead of dithering left and right along it,
    // which would leave it stuck there. Straight on, either side will do.
    side(ux, uy, heading, rng) {
        const cross = ux * Math.sin(heading) - uy * Math.cos(heading);
        return cross > 1e-6 ? 1 : cross < -1e-6 ? -1 : rng.next() < 0.5 ? 1 : -1;
    }

    // Step from (x, y) along the unit vector (ux, uy) by v. If that ends on
    // blocked ground, turn 45°, 90°, 135° (to `side` first, ±1), then back, and
    // take the first heading that is open. Returns false if every heading is
    // blocked (the caller stays put). The result is left in this.x, this.y and
    // the heading actually taken in this.ux, this.uy.
    move(x, y, ux, uy, v, side) {
        const { W, H } = this;
        for (let t = 0; t < TURNS.length; t++) {
            const k = TURNS[t] * side + 4;
            const c = TURN_COS[k];
            const s = TURN_SIN[k];
            const rx = ux * c - uy * s;
            const ry = ux * s + uy * c;
            let nx = x + rx * v;
            let ny = y + ry * v;
            if (nx < 0) nx += W; else if (nx >= W) nx -= W;
            if (ny < 0) ny += H; else if (ny >= H) ny -= H;
            if (this.mask[this.maskIndex(nx, ny)] === OPEN) {
                this.x = nx;
                this.y = ny;
                this.ux = rx;
                this.uy = ry;
                return true;
            }
        }
        this.x = x;
        this.y = y;
        this.ux = ux;
        this.uy = uy;
        return false;
    }
}
