// Minimal single-run driver for CPU profiling (node --prof / --cpu-prof).
import { config } from '../config.js';
import { setAnimals, populate } from '../Animal.js';
import { step } from '../Engine.js';
import { DayNightCycle } from '../DayNightCycle.js';
import { seedRandom } from './rng.mjs';

const frames = parseInt(process.argv[2] || '3000', 10);
const w = parseInt(process.argv[3] || '2716', 10); // sqrt(1920*1080*~3.5) ~ bigger world
const h = parseInt(process.argv[4] || '1527', 10);

seedRandom(1);
config.run = true;
config.world.width = w;
config.world.height = h;
config.world.areaScale = (w * h) / (config.world.referenceWidth * config.world.referenceHeight);
config.visuals.procreationAnimations.enabled = false;

setAnimals([]);
populate('tree', config.trees.initialPopulation);
populate('herbivore', config.herbivores.initialPopulation);
populate('carnivore', config.carnivores.initialPopulation);

const dnc = new DayNightCycle();
for (let f = 0; f < frames; f++) {
    dnc.update();
    step(dnc);
}
console.log('done', frames, 'frames at', w + 'x' + h);
