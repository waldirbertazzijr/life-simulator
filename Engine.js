// Simulation engine — the pure, render-free heart of the simulation.
//
// This is deliberately decoupled from the DOM/canvas so the exact same update
// logic runs in the browser (via Renderer.draw) AND in a headless Node process
// (via the headless/ runner used for parameter search). Keeping a single step()
// means the balance we find headlessly transfers 1:1 to what you see on screen.
import { config } from './config.js';
import { animals, removeDead, refreshCounts, decaySoil } from './Animal.js';
import { Quadtree, Rectangle } from './Quadtree.js';

const noop = () => {};

// Advance the simulation by exactly one frame:
//   1. refresh cached population counts (used by carrying-capacity checks)
//   2. build the spatial index for this frame
//   3. let every animal perceive, move, feed and reproduce
//   4. reap the dead
export const step = (dayNightCycle, createProcreationAnimation = noop) => {
    if (!config.run) return null;

    refreshCounts();

    const boundary = new Rectangle(0, 0, config.world.width, config.world.height);
    const quadtree = new Quadtree(boundary, 4);
    for (const animal of animals) {
        quadtree.insert(animal);
    }

    for (const animal of animals) {
        animal.live(createProcreationAnimation, quadtree, dayNightCycle);
    }

    removeDead();
    decaySoil(); // soil nutrients slowly leach away
    return quadtree;
};
