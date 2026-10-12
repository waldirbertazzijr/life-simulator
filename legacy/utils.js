// Utility functions

export const randomInt = (min, max) => min + Math.floor((max - min) * Math.random()) + 1;

export const randomHexColor = () => {
    return `#${Math.floor(Math.random() * 16777215).toString(16)}`;
};

const animalNames = [
    "Fluffy McFlufferson", "Whisker Doodle", "Captain Paws", "Sir Wiggles", "Mittens the Great",
    "Fuzzy Snuggles", "Bark Twain", "Purrlock Holmes", "Mr. Cuddles", "Snickers", "Waffles",
    "Nibbles", "Tickles", "Bubbles", "Snuggles", "Scooter", "Peanut", "Sprinkles", "Giggles",
    "Coco Puff", "Jellybean", "Chirpy", "Wigglebutt", "Doodles", "Muffin", "Zippy", "Puddles",
    "Chipper", "Wobbles", "Fizzy", "Boopsie", "Noodles", "Scruffles", "Squeaky", "Tater Tot",
    "Pepper", "Snugglebug", "Pip Squeak", "Cupcake", "Chubby Cheeks", "Pipsqueak", "Tootsie",
    "Pickles", "Button", "Twinkle Toes", "Hopsalot", "Skippy", "Dandy Lion", "Fizzgig", "Sunny",
    "Puffball", "Snickers", "Winkie", "Binky", "Frodo", "Gizmo", "Snickersnack", "Twix",
    "Bubblegum", "Tango", "Peppy", "Fudge", "Marshmallow", "Snuggle Muffin", "Purrfect",
    "Chirpy Cheeks", "Snickerdoodle", "Wiggly", "Fizzy Wizzy", "Snuggle Puff", "Mr. Fluffington",
    "Tickle Monster", "Munchkin", "Buttercup", "Sprout", "Poppet", "Puffy", "Twinkie", "Squishy",
    "Furball", "Wriggles", "Twist", "Slinky", "Puppykins", "Hugster", "Cottonball", "Giggle Puff",
    "Pancake", "Sugarplum", "Snugglekins", "Bubblewrap", "Gummybear", "Cheeseball", "Zigzag",
    "Snuggle Bean", "Poppin", "Scootie", "Tater"
];

export const getRandomName = () => animalNames[randomInt(0, animalNames.length - 1)];
