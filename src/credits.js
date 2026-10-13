// Who made what the game borrows, as their licences ask: listed by the
// panel's "credits" (panel/credits.js). A new asset is one more entry:
// its title, author, where it came from, its licence, and what we changed.
const CC_BY = 'http://creativecommons.org/licenses/by/4.0/';
const BAKED = 'colours flattened, simplified, re-rigged';

export const CREDITS = [
    {
        title: 'Sheep', author: 'kenchoo', for: 'the grazers',
        url: 'https://sketchfab.com/3d-models/sheep-08b05ae799d947f1a68c49b2d661eb53',
        licence: 'CC BY 4.0', licenceUrl: CC_BY, changes: BAKED,
    },
    {
        title: 'Nz Inbred Sheep', author: 'MightyGangsta13', for: 'which the sheep is based on',
        url: 'https://skfb.ly/oMADr',
        licence: 'CC BY 4.0', licenceUrl: CC_BY, changes: BAKED,
    },
    {
        title: 'Wolf with Animations', author: '3DHaupt', for: 'the predators',
        url: 'https://sketchfab.com/3d-models/wolf-with-animations-f3769a474a714ebbbaca0d97f9b0a5a0',
        licence: 'CC BY-NC-SA 4.0', licenceUrl: 'http://creativecommons.org/licenses/by-nc-sa/4.0/',
        changes: `${BAKED}; this adapted model is shared under CC BY-NC-SA 4.0`,
    },
    {
        title: 'EB Garamond', author: 'The EB Garamond Project Authors', for: 'the type',
        url: 'https://github.com/octaviopardo/EBGaramond12',
        licence: 'SIL Open Font License 1.1', licenceUrl: 'https://openfontlicense.org',
    },
    {
        title: 'three.js', author: 'the three.js authors', for: 'the 3D view',
        url: 'https://threejs.org',
        licence: 'MIT', licenceUrl: 'https://github.com/mrdoob/three.js/blob/dev/LICENSE',
    },
];
