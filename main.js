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
    this.energyGain = -1;
    this.procriationChance = 0.0001;

    // Follow target
    this.walkStrategy = 'static';
    this.currentTarget = null;
    this.consumes = [];

    // Heritage
    this.family = '_' + Math.random().toString(36).substr(2, 9);
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
        let variantion_y = Math.abs(Math.sin(angle));
        let variantion_x = Math.abs(Math.cos(angle));

        if (this.positionX > this.currentTarget.positionX) {
          this.positionX -= 0.5 * variantion_x;
        } else {
          this.positionX += 0.5 * variantion_x;
        }

        if (this.positionY > this.currentTarget.positionY) {
          this.positionY -= 0.5 * variantion_y;
        } else {
          this.positionY += 0.5 * variantion_y;
        }
      }
    }

    this.clock = 0;
  }

  procriate() {
    if(Math.random() <= this.procriationChance){
      this.energy -= this.energy/3;

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
        if (distance < 5) {
          this.consume(target);
        }
      } else {
        continue;
      }

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
    if(!config.run) return;

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
    this.color = 'green';
    this.clockAction = 1.25;
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
    this.color = '#ff0033';
    this.width = 2;
    this.energyGain = -0.5;
    
    this.clockAction = 1.2;

    this.maxEnergy = 100000000;
    this.procriationChance = 0.0001;
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

function draw() {
  window.ctx.clearRect(0, 0, window.config.worldWidth, window.config.worldHeight); // clear canvas

  animals.forEach(animal => {
    animal.live();

    var width = animal.getWidth();

    window.ctx.beginPath();
    window.ctx.arc(animal.positionX, animal.positionY, width, 0, 2 * Math.PI);
    window.ctx.fillStyle = animal.color;
    window.ctx.fill();

    if (window.config.drawTargets && animal.currentTarget !== null) {
      ctx.beginPath();
      ctx.moveTo(animal.positionX, animal.positionY);
      ctx.lineTo(animal.currentTarget.positionX, animal.currentTarget.positionY);
      ctx.stroke();
    }

    removeDead();
  });

  window.requestAnimationFrame(draw);
}

window.onload = function () {
  this.init();
};