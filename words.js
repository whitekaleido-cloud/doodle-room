'use strict';

// Built-in words, grouped by difficulty. You can edit these lists freely.
// Keep each word or phrase under 30 characters, in lowercase.
// If a word appears in more than one list, the easier list wins.

const easy = [
  // animals
  'cat', 'dog', 'fish', 'bird', 'horse', 'cow', 'pig', 'sheep', 'duck', 'chicken', 'rabbit', 'mouse',
  'lion', 'tiger', 'bear', 'elephant', 'giraffe', 'monkey', 'zebra', 'penguin', 'snake', 'frog',
  'turtle', 'spider', 'butterfly', 'bee', 'ant', 'shark', 'whale', 'dolphin', 'octopus', 'crab',
  'owl', 'parrot', 'kangaroo', 'panda', 'camel', 'snail', 'dinosaur', 'dragon', 'unicorn',
  'crocodile', 'squirrel', 'bat', 'flamingo', 'hedgehog', 'peacock', 'seahorse', 'jellyfish', 'starfish',
  // food
  'apple', 'banana', 'grapes', 'orange', 'strawberry', 'watermelon', 'pineapple', 'cherry', 'lemon',
  'carrot', 'corn', 'tomato', 'potato', 'mushroom', 'broccoli', 'pizza', 'burger', 'hot dog',
  'sandwich', 'ice cream', 'cake', 'cookie', 'donut', 'popcorn', 'egg', 'cheese', 'bread', 'pancake',
  'sushi', 'noodles', 'french fries', 'candy', 'lollipop', 'cupcake', 'chocolate', 'coffee', 'taco',
  'pie', 'pretzel', 'honey', 'popsicle', 'cherry pie', 'banana split',
  // vehicles and buildings
  'house', 'car', 'bus', 'train', 'bicycle', 'airplane', 'boat', 'helicopter', 'rocket', 'truck',
  'tractor', 'motorcycle', 'submarine', 'balloon', 'bridge', 'castle', 'tent', 'lighthouse',
  'windmill', 'fountain', 'school', 'hospital', 'church', 'tower',
  // objects
  'umbrella', 'key', 'lock', 'clock', 'watch', 'phone', 'laptop', 'camera', 'television', 'lamp',
  'chair', 'table', 'bed', 'door', 'window', 'ladder', 'scissors', 'hammer', 'saw', 'broom', 'bucket',
  'bottle', 'cup', 'spoon', 'fork', 'knife', 'plate', 'bowl', 'candle', 'mirror', 'book', 'pencil',
  'pen', 'backpack', 'hat', 'shoe', 'sock', 'glasses', 'crown', 'ring', 'necklace', 'guitar', 'piano',
  'drum', 'violin', 'trumpet', 'microphone', 'headphones', 'flag', 'bell', 'battery', 'magnet',
  'anchor', 'compass', 'map', 'kite', 'trophy', 'gift', 'envelope', 'toothbrush', 'soap', 'towel',
  'bathtub', 'refrigerator', 'oven', 'fan', 'light bulb', 'flashlight', 'calculator', 'keyboard',
  'wheel', 'skateboard', 'surfboard', 'football', 'basketball', 'tennis racket', 'swing', 'slide',
  'treasure chest', 'sword', 'shield', 'bow and arrow', 'telescope', 'lantern',
  // nature
  'sun', 'moon', 'star', 'cloud', 'rainbow', 'lightning', 'snowflake', 'tornado', 'mountain',
  'volcano', 'river', 'waterfall', 'island', 'beach', 'desert', 'forest', 'tree', 'flower', 'cactus',
  'leaf', 'rose', 'sunflower', 'palm tree', 'igloo', 'cave',
  // characters and body
  'pirate', 'ghost', 'robot', 'alien', 'wizard', 'witch', 'mermaid', 'snowman', 'scarecrow',
  'vampire', 'knight', 'astronaut', 'cowboy', 'clown', 'ninja', 'king', 'queen', 'angel', 'zombie',
  'skeleton', 'eye', 'nose', 'ear', 'hand', 'foot', 'heart', 'tooth', 'skull', 'brain', 'bone',
];

const medium = [
  'ambulance', 'aquarium', 'arcade', 'avocado', 'bakery', 'bandage', 'barbecue', 'barn', 'beehive',
  'binoculars', 'blender', 'bookshelf', 'boomerang', 'bouquet', 'bulldozer', 'campfire', 'candy cane',
  'canoe', 'carousel', 'chandelier', 'chimney', 'circus', 'cliff', 'coconut', 'cookie jar', 'crossbow',
  'cupboard', 'dentist', 'detective', 'diamond', 'doghouse', 'drawbridge', 'dumbbell', 'earthquake',
  'eclipse', 'elevator', 'escalator', 'fairy', 'fence', 'ferris wheel', 'fire truck', 'fireplace',
  'firework', 'fishing rod', 'fossil', 'frying pan', 'garden', 'gingerbread man', 'globe', 'goldfish',
  'gorilla', 'graveyard', 'greenhouse', 'hammock', 'harbor', 'hedge', 'helmet', 'hippo', 'hockey',
  'hourglass', 'hurricane', 'iceberg', 'jigsaw puzzle', 'jungle', 'kettle', 'kitchen', 'ladybug',
  'lawn mower', 'library', 'lifeguard', 'lobster', 'locker', 'mailbox', 'maze', 'medal', 'microscope',
  'milkshake', 'mountain bike', 'mummy', 'nest', 'newspaper', 'ostrich', 'paintbrush', 'pajamas',
  'parachute', 'passport', 'peanut', 'pelican', 'photograph', 'picnic', 'pillow', 'pinwheel',
  'pirate ship', 'plumber', 'polar bear', 'porcupine', 'postman', 'pumpkin', 'puppet', 'pyramid',
  'raccoon', 'rattlesnake', 'reindeer', 'rhinoceros', 'roller coaster', 'sailboat', 'sandcastle',
  'satellite', 'scarf', 'scoreboard', 'seesaw', 'shipwreck', 'shovel', 'skyscraper', 'sleeping bag',
  'slingshot', 'snorkel', 'snowboard', 'soldier', 'spaceship', 'sprinkler', 'stethoscope', 'stopwatch',
  'suitcase', 'sundae', 'swimming pool', 'tambourine', 'teapot', 'thermometer', 'tightrope', 'toaster',
  'tombstone', 'tooth fairy', 'traffic light', 'trampoline', 'tunnel', 'turkey', 'typewriter',
  'vacuum cleaner', 'vending machine', 'volleyball', 'waffle', 'wagon', 'wardrobe', 'weightlifter',
  'wheelchair', 'wheelbarrow', 'woodpecker', 'yo-yo', 'zipper', 'zookeeper', 'accordion', 'bagpipes',
  'bowling', 'cactus garden', 'cash register', 'clothesline', 'cuckoo clock', 'drive-in movie',
  'fire hydrant', 'garden gnome', 'hot tub', 'jack in the box', 'jukebox', 'kayak', 'lava lamp',
  'lemonade stand', 'lunchbox', 'mailman', 'marching band', 'mousetrap', 'ninja star', 'octagon',
  'paper plane', 'piggy bank', 'rubber duck', 'scuba tank', 'snow globe', 'tea party', 'tire swing',
];

const hard = [
  'democracy', 'gravity', 'jealousy', 'nostalgia', 'recycling', 'inflation', 'pollution', 'teamwork',
  'deadline', 'procrastination', 'camouflage', 'chameleon', 'claustrophobia', 'constellation',
  'electricity', 'evolution', 'fingerprint', 'geography', 'hibernation', 'illusion', 'immigration',
  'invention', 'jet lag', 'karaoke', 'labyrinth', 'lullaby', 'magnetism', 'migration', 'mirage',
  'monopoly', 'mythology', 'obstacle', 'orchestra', 'paradox', 'photosynthesis', 'quarantine',
  'rehearsal', 'reflection', 'renaissance', 'scholarship', 'silhouette', 'sleepwalking', 'stampede',
  'stereotype', 'superstition', 'symmetry', 'telepathy', 'time travel', 'traffic jam', 'translation',
  'tsunami', 'unemployment', 'vegetarian', 'weightless', 'zodiac',
  // sayings and phrases
  'piece of cake', 'spill the beans', 'under the weather', 'bucket list', 'butterfly effect',
  'black hole', 'solar system', 'ice age', 'gold rush', 'fire drill', 'blind date', 'bad habit',
  'stage fright', 'brain freeze', 'goosebumps', 'hiccups', 'sunburn', 'sneeze', 'yawn', 'daydream',
  'nightmare', 'sleepover', 'birthday party', 'graduation', 'couch potato', 'early bird', 'night owl',
  'dark horse', 'busy bee', 'cold shoulder', 'green thumb', 'hot potato', 'lone wolf', 'sweet tooth',
  'funny bone', 'head over heels', 'elephant in the room', 'rain check', 'sour grapes', 'cat nap',
  'butterflies in stomach', 'break the ice', 'cold feet', 'hit the jackpot',
  // scenes and ideas
  'fortune teller', 'magic trick', 'hide and seek', 'tug of war', 'musical chairs', 'treasure map',
  'secret agent', 'mad scientist', 'time machine', 'flying carpet', 'haunted house', 'crystal ball',
  'sea monster', 'bermuda triangle', 'northern lights', 'shooting star', 'solar eclipse', 'milky way',
  'dust storm', 'gold medal', 'world record', 'hot air balloon', 'bungee jumping', 'scuba diving',
  'skydiving', 'rock climbing', 'synchronized swimming', 'pole vault', 'marathon', 'relay race',
  'tightrope walker', 'fire breather', 'human cannonball', 'puppet show', 'ventriloquist', 'magician',
  'conductor', 'sculptor', 'architect', 'archaeologist', 'astronomer', 'paramedic', 'lumberjack',
  'blacksmith', 'beekeeper', 'scuba diver', 'janitor', 'referee', 'honeymoon', 'reunion',
  'ancient ruins', 'lost city', 'buried treasure', 'message in a bottle', 'castaway',
  'lighthouse keeper', 'double rainbow', 'power outage', 'traffic cone', 'speed limit',
  'one way street', 'dead end', 'roundabout', 'pedestrian crossing', 'parking ticket', 'heartbeat',
];

module.exports = { easy, medium, hard };
