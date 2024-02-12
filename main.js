// Simulation configuration
var config = {
	'drawTargets': true,
	'worldWidth': 1200,
	'worldHeight': 600,

	'tree_population': [200, 300],
	'herbivore_population': [20, 30],
	'carnivore_poulation': [5, 10],

	'run': true
}

// Some helpers
function randomInt(min, max) {
	return min + Math.floor((max - min) * Math.random());
}
function removeDead() {
	for (let i = 0; i < animals.length; i++) {
		const element = animals[i];
		if (element.energy <= 0) {
			animals.splice(i, 1);
		}
	}
}


// Animal array
var animals = [];

class animal {
	constructor() {
		this.kind = 'animal'; // Kind (can be 3: tree, herbivore, carnivore)

		this.positionX = randomInt(0, window.config.worldWidth);
		this.positionY = randomInt(0, window.config.worldHeight);

		// Clock stuff
		this.clockAction = 1; // Clocks until action is done.
		this.clock = 0; // Internal clock.

		// Width and energy
		this.width = 5;
		this.energy = 100;
		this.maxEnergy = 500;
		this.energyGain = -1; // Energy expenditure rate
		this.procriationChance = 0.0001;

		// Follow target
		this.walkStrategy = 'static'; // Current survival strategy
		this.currentTarget = null;
		this.consumes = [];

		// Heritage
		this.family = '_' + Math.random().toString(36).substring(2, 9);
	}

	getDistanceTo(animal) {
		return Math.sqrt(
			Math.pow(this.positionX - animal.positionX, 2) + Math.pow(this.positionY - animal.positionY, 2)
		);
	}

	walk() {

		this.clock++;
		if (this.clock < (this.clockAction)) return;

		this.energy += this.energyGain;
		this.energy = Math.min(this.energy, this.maxEnergy);

		if (this.walkStrategy == 'static') return;
		if (this.walkStrategy == 'random') {
			this.positionX += randomInt(-1, 2);
			this.positionY += randomInt(-1, 2);
			return;
		}
		if (this.walkStrategy == 'seekFood') {
			var smallestDistance = 1000000;

			for (let i = 0; i < window.animals.length; i++) {
				const animal = window.animals[i];

				if (this.consumes.includes(animal.kind) && this != animal && this.family != animal.family) {
					var distance = this.getDistanceTo(animal);
					if (distance < smallestDistance) {
						smallestDistance = distance;
						this.currentTarget = animal;
					}
				} else {
					continue;
				}

			}

			if (this.currentTarget != null) {
				let angle = Math.atan2(this.currentTarget.positionY - this.positionY, this.currentTarget.positionX - this.positionX);
				let var_y = Math.abs(Math.sin(angle));
				let var_x = Math.abs(Math.cos(angle));

				if (this.positionX > this.currentTarget.positionX) {
					this.positionX -= 0.5 * var_x;
				} else {
					this.positionX += 0.5 * var_x;
				}

				if (this.positionY > this.currentTarget.positionY) {
					this.positionY -= 0.5 * var_y;
				} else {
					this.positionY += 0.5 * var_y;
				}
			}
		}
		if (this.walkStrategy == 'fleeing') {
			// Calculate the total danger from nearby animals
			let closestHunterDistance = 9999999;
			let closestHunter = null;
			for (let i = 0; i < window.animals.length; i++) {
				const hunter = window.animals[i];
				if (this != hunter && hunter.consumes.includes(this.kind) && this.family != hunter.family) {
					const distance = this.getDistanceTo(hunter);
					if (distance < closestHunterDistance) {
						closestHunterDistance = distance;
						closestHunter = hunter;
					}
				}
			}
			
			let angle = Math.atan2(this.positionY - closestHunter.positionY, this.positionX - closestHunter.positionX);
			let var_y = Math.abs(Math.sin(angle));
			let var_x = Math.abs(Math.cos(angle));

			if (this.positionX > closestHunter.positionX) {
				this.positionX += 0.5 * var_x;
			} else {
				this.positionX -= 0.5 * var_x;
			}

			if (this.positionY > closestHunter.positionY) {
				this.positionY += 0.5 * var_y;
			} else {
				this.positionY -= 0.5 * var_y;
			}
		}
		if (this.walkStrategy == 'relax') {
			return;
		}

		this.clock = 0;
	}

	procriate() {
		if (Math.random() <= this.procriationChance) {
			this.energy -= this.energy / 3;

			let child = animalFactory.getAnimal(this.kind);
			child.positionX = this.positionX + randomInt(-10, 10);
			child.positionY = this.positionY + randomInt(-10, 10);
			child.family = this.family;

			animals.push(child);
		}

	}

	feed() {
		for (let i = 0; i < window.animals.length; i++) {
			const target = window.animals[i];

			if (this.consumes.includes(target.kind) && this != target && this.family != target.family) {
				var distance = this.getDistanceTo(target);
				if (distance < 5) this.consume(target);
			} else {
				continue;
			}

		}
	}

	analyze() {

		// Calculate the total danger from nearby animals
		let closestHunter = 9999999;
		for (let i = 0; i < window.animals.length; i++) {
			const hunter = window.animals[i];
			if (this != hunter && hunter.consumes.includes(this.kind) && this.family != hunter.family) {
				const distance = this.getDistanceTo(hunter);
				if (distance < closestHunter) closestHunter = distance;
			}
		}

		// Decide whether to flee or hunt based on the danger threshold
		if (closestHunter < 50) {
			this.walkStrategy = 'fleeing';
		} else if (this.energy < 400) {
			this.walkStrategy = 'seekFood';
		} else {
			this.walkStrategy = 'relax';
		}
	}

	consume(animal) {
		this.energy += animal.energy;
		animal.energy = 0;
	}

	getWidth() {
		return (this.energy / 100) + this.width;
	}

	live() {
		if (!config.run) return;

		if (this.walkStrategy != 'static') this.analyze();

		this.walk();
		this.feed();
		this.procriate();
	}
}

class tree extends animal {
	constructor() {
		super();
		this.kind = 'tree';
		this.color = 'brown';
		this.energyGain = 0.01;

		this.maxEnergy = 100000000;
		this.procriationChance = 0.0005;
	}
}

class vegetarian extends animal {
	constructor() {
		super();
		this.kind = 'veg';
		this.consumes = ['tree'];
		this.walkStrategy = 'seekFood';
		this.color = '#33aa00aa';
		this.clockAction = 2;
		this.energyGain = -0.25;

		this.maxEnergy = 100000000;
		this.procriationChance = 0.00001;
	}
}

class carnivore extends animal {
	constructor() {
		super();
		this.kind = 'carn';
		this.consumes = ['veg', 'carn'];
		this.walkStrategy = 'seekFood';
		this.color = '#ff0033aa';
		this.width = 2;
		this.energyGain = -0.1;
		this.energy = 100;

		this.clockAction = 0.1;

		this.maxEnergy = 100000000;
		this.procriationChance = 0.001;
	}
}

class animalFactory {
	static getAnimal(kind) {
		switch (kind) {
			case 'tree':
				return new tree();
			case 'veg':
				return new vegetarian();
			case 'carn':
				return new carnivore();
		}
	}
}

// Tree population
for (let i = 0; i < randomInt(config.tree_population[0], config.tree_population[1]); i++) {
	animals.push(animalFactory.getAnimal('tree'));
}

// Vegs population
for (let i = 0; i < randomInt(config.herbivore_population[0], config.herbivore_population[1]); i++) {
	animals.push(animalFactory.getAnimal('veg'));
}

// Carns population
for (let i = 0; i < randomInt(config.carnivore_poulation[0], config.carnivore_poulation[1]); i++) {
	animals.push(animalFactory.getAnimal('carn'));
}

function init() {
	window.ctx = document.getElementById('canvas').getContext('2d');
	window.ctx.globalCompositeOperation = 'destination-over';

	window.requestAnimationFrame(draw);
}

const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom

function draw() {
	stats.begin();

	window.ctx.clearRect(0, 0, window.config.worldWidth, window.config.worldHeight); // clear canvas

	animals.forEach(animal => {
		animal.live();

		var width = animal.getWidth();

		window.ctx.beginPath();
		window.ctx.arc(animal.positionX, animal.positionY, width, 0, 2 * Math.PI);
		window.ctx.fillStyle = animal.color;
		window.ctx.fill();

		window.ctx.font ='8px Monaco';
		window.ctx.fillStyle = '#000';
		window.ctx.fillText(animal.family + "-" + animal.walkStrategy, animal.positionX, animal.positionY);

		if (window.config.drawTargets && animal.currentTarget !== null) {
			ctx.beginPath();
			ctx.moveTo(animal.positionX, animal.positionY);
			ctx.lineTo(animal.currentTarget.positionX, animal.currentTarget.positionY);
			ctx.stroke();
		}

		removeDead();
	});

	stats.end();

	window.requestAnimationFrame(draw);
}

// function draw() {
//     const ctx = window.ctx;
//     const config = window.config;
//     const twoPi = 2 * Math.PI;
//     const buffer = document.createElement('canvas');
//     buffer.width = config.worldWidth;
//     buffer.height = config.worldHeight;
//     const bufferCtx = buffer.getContext('2d');

//     bufferCtx.clearRect(0, 0, config.worldWidth, config.worldHeight); // clear buffer

//     animals.forEach(animal => {
//         animal.live();

//         var width = animal.getWidth();

//         bufferCtx.beginPath();
//         bufferCtx.arc(animal.positionX, animal.positionY, width, 0, twoPi);
//         bufferCtx.fillStyle = animal.color;
//         bufferCtx.fill();

//         bufferCtx.font ='8px Monaco';
//         bufferCtx.fillStyle = '#000';
//         bufferCtx.fillText(animal.family + "-" + animal.walkStrategy, animal.positionX, animal.positionY);

//         if (config.drawTargets && animal.currentTarget !== null) {
//             bufferCtx.beginPath();
//             bufferCtx.moveTo(animal.positionX, animal.positionY);
//             bufferCtx.lineTo(animal.currentTarget.positionX, animal.currentTarget.positionY);
//             bufferCtx.stroke();
//         }

//         removeDead();
//     });

//     // Copy the image from the buffer to the visible canvas
//     ctx.drawImage(buffer, 0, 0);

//     window.requestAnimationFrame(draw);
// }

window.onload = function () {
	document.body.appendChild( stats.dom );
	
	this.init();
};