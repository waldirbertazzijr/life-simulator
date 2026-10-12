// Simulation engine — the pure, render-free heart of the simulation.
//
// This is deliberately decoupled from the DOM/canvas so the exact same update
// logic runs in the browser (via Renderer.draw) AND in a headless Node process
// (via the headless/ runner used for parameter search). Keeping a single step()
// means the balance we find headlessly transfers 1:1 to what you see on screen.
import { config } from './config.js';
import { animals, removeDead, refreshCounts, decaySoil, maybeRescue } from './Animal.js';
import { Quadtree, Rectangle } from './Quadtree.js';
import { SpatialGrid } from './SpatialGrid.js';

const noop = () => {};

// Which spatial index backs the neighbour queries. Both return the SAME set of
// neighbours; they differ only in iteration ORDER, which — in a chaotic sim —
// eventually diverges the exact per-seed trajectory (though not the statistical
// ecology). The grid is markedly faster (O(1) alloc-free insert, no recursion).
// Default is 'quadtree' so existing byte-identical baselines still hold; flip to
// 'grid' via setSpatialIndex() or the SPATIAL_INDEX=grid env var.
let indexKind = (typeof process !== 'undefined' && process.env && process.env.SPATIAL_INDEX)
    ? process.env.SPATIAL_INDEX
    : 'quadtree';
export const setSpatialIndex = (kind) => { indexKind = kind; grid = null; };
export const getSpatialIndex = () => indexKind;

// The grid is persistent across frames: clear() truncates its cell arrays without
// freeing them, so after warm-up a frame allocates essentially nothing. We only
// rebuild it when the world is resized (browser window change).
// Cell size for the uniform hash. A larger cell = fewer cells to walk but more
// animals per cell to distance-test; a smaller cell = the reverse. The sweet spot
// is a fraction of the query radius (SENSE_RADIUS=200). Tunable via env for sweeps.
const CELL_SIZE = (typeof process !== 'undefined' && process.env && process.env.CELL_SIZE)
    ? parseInt(process.env.CELL_SIZE, 10)
    : 120;
let grid = null;
let gridW = 0, gridH = 0;

const buildIndex = () => {
    if (indexKind === 'grid') {
        if (!grid || gridW !== config.world.width || gridH !== config.world.height) {
            grid = new SpatialGrid(config.world.width, config.world.height, CELL_SIZE);
            gridW = config.world.width;
            gridH = config.world.height;
        } else {
            grid.clear();
        }
        for (const animal of animals) grid.insert(animal);
        return grid;
    }

    // quadtree (default)
    const boundary = new Rectangle(0, 0, config.world.width, config.world.height);
    const quadtree = new Quadtree(boundary, 4);
    for (const animal of animals) quadtree.insert(animal);
    return quadtree;
};

// Advance the simulation by exactly one frame:
//   1. refresh cached population counts (used by carrying-capacity checks)
//   2. build the spatial index for this frame
//   3. let every animal perceive, move, feed and reproduce
//   4. reap the dead
export const step = (dayNightCycle, createProcreationAnimation = noop) => {
    if (!config.run) return null;

    refreshCounts();

    const index = buildIndex();

    for (const animal of animals) {
        animal.live(createProcreationAnimation, index, dayNightCycle);
    }

    removeDead();
    maybeRescue(); // metapopulation immigration keeps a near-extinct species alive
    decaySoil();   // soil nutrients slowly leach away
    return index;
};
