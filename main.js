// Simulation configuration
let config = {
    run: true,
    canvas: null,

    visuals: {
        procreationAnimations: {
            enabled: true,
            radius: 10
        },
        drawTargets: true,
        energyBar: {
            enabled: true,
            width: 30,
            height: 2,
        },
    },

    world: {
        width: window.innerWidth,
        height: window.innerHeight
    },

    trees: {
        initialPopulation: [200, 300],
        energyGain: 0.001,
        procreatingChance: 0,
        energy: {
            initial: 1000,
            max: 1000,
        }
    },
    herbivores: {
        initialPopulation: [20, 100],
        energyGain: -0.25,
        procreatingChance: 0.00001,
        clockAction: 2,
        energy: {
            initial: [100, 500],
            max: 500,
        }
    },
    carnivores: {
        initialPopulation: [5, 10],
        energyGain: -0.1,
        procreatingChance: 0.001,
        clockAction: 0.1,
        energy: {
            initial: [50, 100],
            max: 100,
        }
    },

    energy: {
        defaultEnergy: 100,
        defaultMaxEnergy: 500,
    },

    images: {
        tree: './tree.png',
        herbivore: './herbivore.png',
        carnivore: './carnivore.png',
        background: './grass.png'
    }
};

// Utility functions
const randomInt = (min, max) => min + Math.floor((max - min) * Math.random()) + 1;

const removeDead = () => {
    animals = animals.filter(animal => animal.energy > 0);
};

const randomHexColor = () => {
    return `#${Math.floor(Math.random()*16777215).toString(16)}`;
};

// Animal array
let animals = [];

// Load images
const treeImage = new Image();
treeImage.src = config.images.tree;

const herbivoreImage = new Image();
herbivoreImage.src = config.images.herbivore;

const carnivoreImage = new Image();
carnivoreImage.src = config.images.carnivore;

class Animal {
    constructor(kind, energyGain, procriationChance, walkStrategy = 'static', image, initialEnergy, maxEnergy, clockAction) {
        this.kind = kind;
        this.positionX = randomInt(0, config.world.width);
        this.positionY = randomInt(0, config.world.height);
        this.clockAction = clockAction;
        this.clock = 0;
        this.energy = Array.isArray(initialEnergy) ? randomInt(...initialEnergy) : initialEnergy;
        this.maxEnergy = maxEnergy;
        this.energyGain = energyGain;
        this.procriationChance = procriationChance;
        this.walkStrategy = walkStrategy;
        this.currentTarget = null;
        this.consumes = [];
        this.family = randomHexColor();
        this.image = image;
    }

    getDistanceTo(animal) {
        return Math.hypot(this.positionX - animal.positionX, this.positionY - animal.positionY);
    }

    walk() {
        this.clock++;
        if (this.clock < this.clockAction) return;

        this.energy += this.energyGain;
        this.energy = Math.min(this.energy, this.maxEnergy);

        if (this.walkStrategy === 'static') return;

        if (this.walkStrategy === 'random') {
            this.positionX += randomInt(-1, 2);
            this.positionY += randomInt(-1, 2);
        } else if (this.walkStrategy === 'seekFood') {
            this.seekFood();
        } else if (this.walkStrategy === 'fleeing') {
            this.flee();
        }

        this.clock = 0;
    }

    seekFood() {
        let smallestDistance = Infinity;

        for (const animal of animals) {
            if (this.consumes.includes(animal.kind) && this !== animal && this.family !== animal.family) {
                const distance = this.getDistanceTo(animal);
                if (distance < smallestDistance) {
                    smallestDistance = distance;
                    this.currentTarget = animal;
                }
            }
        }

        if (this.currentTarget) {
            this.moveToTarget(this.currentTarget);
        }
    }

    flee() {
        this.currentTarget = null;

        let closestHunter = null;
        let closestHunterDistance = Infinity;

        for (const hunter of animals) {
            if (this !== hunter && hunter.consumes.includes(this.kind) && this.family !== hunter.family) {
                const distance = this.getDistanceTo(hunter);
                if (distance < closestHunterDistance) {
                    closestHunterDistance = distance;
                    closestHunter = hunter;
                }
            }
        }

        if (closestHunter) {
            this.moveAwayFromTarget(closestHunter);
        }
    }

    moveToTarget(target) {
        const angle = Math.atan2(target.positionY - this.positionY, target.positionX - this.positionX);
        this.positionX += 0.5 * Math.cos(angle);
        this.positionY += 0.5 * Math.sin(angle);
    }

    moveAwayFromTarget(target) {
        const angle = Math.atan2(this.positionY - target.positionY, this.positionX - target.positionX);
        this.positionX += 0.5 * Math.cos(angle);
        this.positionY += 0.5 * Math.sin(angle);
    }

    procriate() {
        if (Math.random() <= this.procriationChance) {
            this.energy -= this.energy / 3;

            const child = AnimalFactory.getAnimal(this.kind);
            child.positionX = this.positionX + randomInt(-10, 10);
            child.positionY = this.positionY + randomInt(-10, 10);
            child.family = this.family;

            animals.push(child);

            // Trigger the procreation animation
            if (config.visuals.procreationAnimations.enabled) createProcreationAnimation(child.positionX, child.positionY);
        }
    }

    feed() {
        for (const target of animals) {
            if (this.consumes.includes(target.kind) && this !== target && this.family !== target.family) {
                if (this.getDistanceTo(target) < 5) {
                    this.consume(target);
                }
            }
        }
    }

    analyze() {
        let closestHunterDistance = Infinity;

        for (const hunter of animals) {
            if (this !== hunter && hunter.consumes.includes(this.kind) && this.family !== hunter.family) {
                const distance = this.getDistanceTo(hunter);
                if (distance < closestHunterDistance) closestHunterDistance = distance;
            }
        }

        if (closestHunterDistance < 100) {
            this.walkStrategy = 'fleeing';
        } else if (this.energy / this.maxEnergy <= 0.5) {
            this.walkStrategy = 'seekFood';
        } else {
            this.walkStrategy = 'relax';
        }
    }

    consume(animal) {
        this.energy += animal.energy;
        animal.energy = 0;
    }

    live() {
        if (!config.run) return;

        if (this.walkStrategy !== 'static') this.analyze();

        this.walk();
        this.feed();
        this.procriate();
    }

    draw(ctx) {
        // Draw the animal image
        ctx.drawImage(this.image, this.positionX - 16, this.positionY - 16, 32, 32);

        if (this.walkStrategy !== 'static') {
            // Draw the family circle
            ctx.fillStyle = this.family;
            ctx.beginPath();
            ctx.arc(this.positionX - 20, this.positionY - 19, 2, 0, 2 * Math.PI);
            ctx.strokeStyle = "#000";
            ctx.stroke();
            ctx.fill();
        

            if (config.visuals.energyBar.enabled) {
                const energyPercentage = this.energy / this.maxEnergy;
                const barColor = energyPercentage > 0.2 ? 'green' : 'red';
                ctx.fillStyle = barColor;
                ctx.fillRect(this.positionX - config.visuals.energyBar.width / 2, this.positionY - 20, config.visuals.energyBar.width * energyPercentage, config.visuals.energyBar.height);
                ctx.strokeStyle = '#000';
                ctx.strokeRect(this.positionX - config.visuals.energyBar.width / 2, this.positionY - 20, config.visuals.energyBar.width, config.visuals.energyBar.height);
            }

            if (config.visuals.drawTargets && this.currentTarget) {
                ctx.beginPath();
                ctx.moveTo(this.positionX, this.positionY);
                ctx.lineTo(this.currentTarget.positionX, this.currentTarget.positionY);
                ctx.stroke();
            }
        }
    }
}

class Tree extends Animal {
    constructor() {
        super('tree', config.trees.energyGain, config.trees.procreatingChance, 'static', treeImage, config.trees.energy.initial, config.trees.energy.max);
    }
}

class Herbivore extends Animal {
    constructor() {
        super('herbivore', config.herbivores.energyGain, config.herbivores.procreatingChance, 'seekFood', herbivoreImage, config.herbivores.energy.initial, config.herbivores.energy.max, config.herbivores.clockAction);
        this.consumes = ['tree'];
    }
}

class Carnivore extends Animal {
    constructor() {
        super('carnivore', config.carnivores.energyGain, config.carnivores.procreatingChance, 'seekFood', carnivoreImage, config.carnivores.energy.initial, config.carnivores.energy.max, config.carnivores.clockAction);
        this.consumes = ['herbivore', 'carnivore'];
    }
}

class AnimalFactory {
    static getAnimal(kind) {
        switch (kind) {
            case 'tree':
                return new Tree();
            case 'herbivore':
                return new Herbivore();
            case 'carnivore':
                return new Carnivore();
        }
    }
}

// Population initialization
const populate = (kind, range) => {
    const [min, max] = range;
    const count = randomInt(min, max);
    for (let i = 0; i < count; i++) {
        animals.push(AnimalFactory.getAnimal(kind));
    }
};

populate('tree', config.trees.initialPopulation);
populate('herbivore', config.herbivores.initialPopulation);
populate('carnivore', config.carnivores.initialPopulation);

const stats = new Stats();
stats.showPanel(0);

const bg = new Image();
bg.src = config.images.background;

const drawBackground = () => {
    window.ctx.drawImage(bg, 0, 0);
};

let procreationAnimations = [];
const createProcreationAnimation = (x, y) => {
    const animation = {
        x,
        y,
        frames: 30,
    };
    procreationAnimations.push(animation);
};

const draw = () => {
    stats.begin();
    window.ctx.clearRect(0, 0, config.world.width, config.world.height);

    animals.forEach(animal => {
        animal.live();
        animal.draw(window.ctx);
    });

    removeDead();

    // Draw the procreation animations
    procreationAnimations.forEach((anim, index) => {
        if (anim.frames > 0) {
            window.ctx.beginPath();
            window.ctx.arc(anim.x, anim.y, 30 * (anim.frames / 30), 0, 2 * Math.PI);
            window.ctx.fillStyle = `rgba(255, 100, 0, ${anim.frames / 30})`;
            window.ctx.fill();
            anim.frames--;
        } else {
            procreationAnimations.splice(index, 1);
        }
    });

    // Draw the background
    drawBackground();

    stats.end();
    window.requestAnimationFrame(draw);
};

const fixCanvasSize = () => {
    config.world.width = window.innerWidth;
    config.world.height = window.innerHeight;

    config.canvas.width = config.world.width;
    config.canvas.height = config.world.height;
}

const init = () => {
    config.canvas = document.getElementById('canvas');

    fixCanvasSize();

    window.ctx = config.canvas.getContext('2d');
    window.ctx.globalCompositeOperation = 'destination-over';
    window.requestAnimationFrame(draw);

    new Tooltip();
};

window.onload = () => {
    document.body.appendChild(stats.dom);
    init();
};

class Tooltip {
    constructor() {
        this.tooltip = document.createElement('div');
        this.tooltip.id = 'tooltip';
        this.tooltip.style.position = 'absolute';
        this.tooltip.style.display = 'none';
        this.tooltip.style.font = '6px Helvetica, Arial';
        this.tooltip.style.backgroundColor = 'white';
        this.tooltip.style.border = '1px solid black';
        this.tooltip.style.borderRadius = '5px';
        this.tooltip.style.boxShadow = '0 5px 10px rgba(0,0,0,0.5)';
        this.tooltip.style.padding = '5px';
        this.tooltip.style.fontSize = '12px';
        this.tooltip.style.pointerEvents = 'none';
        this.tooltip.style.zIndex = '1';
        document.body.appendChild(this.tooltip);

        this.canvas = document.getElementById('canvas');
        this.canvasRect = this.canvas.getBoundingClientRect();

        this.canvas.addEventListener('mousemove', (event) => this.onMouseMove(event));
        this.canvas.addEventListener('mouseout', () => this.onMouseOut());
    }

    onMouseMove(event) {
        const mouseX = event.clientX - this.canvasRect.left;
        const mouseY = event.clientY - this.canvasRect.top;

        let hoveredAnimal = null;
        for (const animal of animals) {
            const distance = Math.hypot(animal.positionX - mouseX, animal.positionY - mouseY);
            if (distance < 16) {
                hoveredAnimal = animal;
                break;
            }
        }

        if (hoveredAnimal) {
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = `${event.pageX + 10}px`;
            this.tooltip.style.top = `${event.pageY + 10}px`;
            
            const properties = Object.entries(hoveredAnimal)
                .filter(([key, value]) => (key !== 'currentTarget' && key !== 'image' && key !== 'clock' && key !== 'kind'))
                .map(([key, value]) => {
                    if (typeof value === 'number') {
                        return `${key}: ${value.toFixed(2)}`;
                    }
                    return `${key}: ${JSON.stringify(value)}`;
                })
                .join('</br>');

            this.tooltip.innerHTML = `<strong>${hoveredAnimal.kind}</strong><br>${properties}`;
        } else {
            this.tooltip.style.display = 'none';
        }
    }

    onMouseOut() {
        this.tooltip.style.display = 'none';
    }
}