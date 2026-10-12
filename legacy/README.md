![Sample Run](./screenshot.png?raw=true)


# Life Simulator
An interactive ecosystem simulation built with JavaScript and HTML5 Canvas, featuring evolutionary mechanics, dynamic environments, and real-time population analytics.

## Features

### Core Ecosystem
- **Trees**: Static energy producers that grow gradually
- **Herbivores**: Seek and consume trees, flee from predators
- **Carnivores**: Hunt herbivores and other carnivores

### Advanced Mechanics
- **Age-Based Life Stages**:
  - 👶 **Baby** (0-1000 frames): 50% size/speed, follows parent, vulnerable, cannot reproduce
  - 🧒 **Juvenile** (1000-2500 frames): 75% size, 85% speed, learning behaviors, braver
  - 💪 **Adult** (2500-8000 frames): Full size/speed, can reproduce, prime of life
  - 👴 **Elderly** (8000+ frames): 90% size, 70% speed, wiser (flee earlier from danger)

- **Pack/Herd Behavior**:
  - Animals group with same species
  - Family members have stronger bonds
  - Herbivores form protective herds
  - When relaxed, move toward herd center
  - Babies stay close to parents

- **Sleep Cycles**:
  - Sleep when energy drops below 30%
  - Restore energy while sleeping (0.5/frame)
  - Sleeping animals are more transparent and show "Zzz"
  - Vulnerable while sleeping (easier to catch, larger catch radius)
  - Wake up when energy restored to 70% or when attacked

- **Genetics & Evolution with Trade-offs**:
  - Offspring inherit traits from parents with ±10% mutations
  - **⚡ Speed**: Faster movement BUT burns more energy (fast metabolism)
  - **📏 Size**: Increases max energy capacity BUT costs energy to maintain large body
  - **💪 Max Energy**: Pure energy storage with no drawbacks
  - Initial population has varied genetics (0.7x-1.3x range)
  - Natural selection drives evolution - traits have real consequences!

- **Day/Night Cycle**:
  - 24-hour cycle with realistic color transitions
  - Beautiful sunrises (purple → pink → golden) and sunsets (golden → orange → purple)
  - Carnivores more active at night (30% boost)
  - Herbivores more active during day (20% boost)
  - Real-time clock display

### Performance
- **Quadtree Spatial Partitioning**: Dramatically improves performance with large populations (O(n²) → O(n log n))
- Supports 1000+ entities without lag

### Analytics
- **Real-time Statistics Dashboard**:
  - Live population charts for each species
  - Total births and deaths tracking
  - Historical population trends (last 200 data points)

- **🧬 Evolution Tracker**:
  - Track genetic trait evolution in real-time
  - Three traits monitored: Speed ⚡, Size 📏, Energy 💪
  - Separate graphs for herbivores and carnivores
  - Shows percentage change from baseline (↑/↓)
  - Displays trade-off explanations
  - Visualize natural selection and survival of the fittest
  - See which traits help survival over generations
  - Initial population shows genetic diversity from start

### Controls
- **Pause/Play**: Stop and resume simulation
- **Speed Control**: 0.5x, 1x, 2x, 5x speed multipliers
- **Interactive Placement**: Click to add animals to specific locations
- **Hover Tooltips**: View detailed animal stats

### Code Architecture
- **Modular ES6 Structure**:
  - `Animal.js` - Entity classes and behaviors
  - `Quadtree.js` - Spatial partitioning
  - `Renderer.js` - Canvas rendering
  - `Simulation.js` - Main game loop
  - `UI.js` - User interface
  - `StatsDashboard.js` - Population analytics
  - `EvolutionTracker.js` - Genetic evolution tracking
  - `DayNightCycle.js` - Time system
  - `config.js` - Configuration
  - `utils.js` - Helper functions

## How to run
Open `index.html` in a modern web browser (requires ES6 module support).

## Assets
- Carnivores and Herbivores: [Aldo](https://www.reddit.com/r/PixelArt/comments/103bznv/just_started_my_pixel_art_journey_i_heard_it_was/)
- Tree: [AlbertoV](https://www.deviantart.com/albertov/art/PIXEL-ART-Tree-894991754)
