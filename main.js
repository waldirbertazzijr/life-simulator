// Simulation configuration
const config = {
    drawTargets: false,
    
    energyBar: {
        enabled: true,
        width: 30,
        height: 2,
    },

    procreationAnimations: {
        enabled: true,
        radius: 10
    },

    worldWidth: 1200,
    worldHeight: 600,
    treePopulation: [200, 300],
    herbivorePopulation: [20, 30],
    carnivorePopulation: [5, 10],
    run: true,
};

// Utility functions
const randomInt = (min, max) => min + Math.floor((max - min) * Math.random());

const removeDead = () => {
    animals = animals.filter(animal => animal.energy > 0);
};

// Animal array
let animals = [];

// Load images
const treeImage = new Image();
treeImage.src = './tree.png'; // Replace with actual path

const herbivoreImage = new Image();
herbivoreImage.src = './herbivore.png'; // Replace with actual path

const carnivoreImage = new Image();
carnivoreImage.src = './carnivore.png'; // Replace with actual path

class Animal {
    constructor(kind, energyGain, procriationChance, walkStrategy = 'static', image) {
        this.kind = kind;
        this.positionX = randomInt(0, config.worldWidth);
        this.positionY = randomInt(0, config.worldHeight);
        this.clockAction = 1;
        this.clock = 0;
        this.energy = 100;
        this.maxEnergy = 500;
        this.energyGain = energyGain;
        this.procriationChance = procriationChance;
        this.walkStrategy = walkStrategy;
        this.currentTarget = null;
        this.consumes = [];
        this.family = `_${Math.random().toString(36).substring(2, 9)}`;
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
            if(config.procreationAnimations.enabled) createProcreationAnimation(child.positionX, child.positionY);
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

        if (closestHunterDistance < 50) {
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
        ctx.drawImage(this.image, this.positionX - 16, this.positionY - 16, 32, 32);
        ctx.font = '8px Monaco';
        ctx.fillStyle = '#000';
        
        if (this.walkStrategy !== 'static') ctx.fillText(`${this.walkStrategy}`, this.positionX - 16, this.positionY + 16);

        if (config.energyBar.enabled && this.walkStrategy !== 'static') {
            const energyPercentage = this.energy / this.maxEnergy;
            const barColor = energyPercentage > 0.2 ? 'green' : 'red';
            ctx.fillStyle = barColor;
            ctx.fillRect(this.positionX - config.energyBar.width / 2, this.positionY - 20, config.energyBar.width * energyPercentage, config.energyBar.height);
            ctx.strokeStyle = '#000';
            ctx.strokeRect(this.positionX - config.energyBar.width / 2, this.positionY - 20, config.energyBar.width, config.energyBar.height);
        }

        if (config.drawTargets && this.currentTarget) {
            ctx.beginPath();
            ctx.moveTo(this.positionX, this.positionY);
            ctx.lineTo(this.currentTarget.positionX, this.currentTarget.positionY);
            ctx.stroke();
        }
    }
}

class Tree extends Animal {
    constructor() {
        super('tree', 0.01, 0.00005, 'static', treeImage);
        this.energy = 1000;
        this.maxEnergy = 1000;
    }
}

class Herbivore extends Animal {
    constructor() {
        super('herbivore', -0.25, 0.00001, 'seekFood', herbivoreImage);
        this.consumes = ['tree'];
        this.clockAction = 2;
        this.energy = randomInt(100, 500);
        this.maxEnergy = 500;
    }
}

class Carnivore extends Animal {
    constructor() {
        super('carnivore', -0.1, 0.001, 'seekFood', carnivoreImage);
        this.consumes = ['herbivore', 'carnivore'];
        this.clockAction = 0.1;
        this.energy = randomInt(50, 100);
        this.maxEnergy = 100;
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

populate('tree', config.treePopulation);
populate('herbivore', config.herbivorePopulation);
populate('carnivore', config.carnivorePopulation);

const stats = new Stats();
stats.showPanel(0);

const bg = new Image();
bg.src = './grass.png';

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
    window.ctx.clearRect(0, 0, config.worldWidth, config.worldHeight);

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

const init = () => {
    window.ctx = document.getElementById('canvas').getContext('2d');
    window.ctx.globalCompositeOperation = 'destination-over';
    window.requestAnimationFrame(draw);
};

window.onload = () => {
    document.body.appendChild(stats.dom);
    init();
};