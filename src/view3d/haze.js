// What every surface in the 3D view shares, whoever drew it: the haze, the
// light of torches, and the sky's light on the few unlit things.
//
// - The haze. three.js's fog has one colour. Here (by patching its shader
//   chunks, before any material is compiled) it also glows toward the sun:
//   the haze's colour is the horizon's, plus the sun's glow by how nearly the
//   line of sight looks its way. The sky dome (sky.js) paints its horizon by
//   the same rule, so at dawn and dusk the far hills melt into the gold of
//   the sky behind them, and on the other side into its blue.
// - Torchlight: the flames (items.js) light the ground, the trees and the
//   people about them, a warm pool that matters at night. It is worked out
//   per pixel for the nearest few (TORCHES), not by three.js's lights, which
//   would cost every surface in the scene (`?torchlight` still makes two real
//   lights: items.js).
// - skyLit(material): an unlit material (a flag) dims with the sky's light,
//   so it does not glow at night.
//
// The numbers live in HAZE and are shared by every material: three.js clones
// a material's uniforms when it compiles it, but keeps plain objects and typed
// arrays by reference, so the values below reach every program each frame.
import * as THREE from 'three';
import { SNOW } from './biomes.js';

export const TORCHES = 8;
export const TORCH_REACH = 18;

export const HAZE = {
    sun: { x: 0, y: 0, z: -1, w: 4 },   // the sun's bearing (x, z, a unit vector) and the glow's tightness (w)
    glow: { x: 0, y: 0, z: 0 },          // the glow's colour (linear), added to the haze toward the sun
    sky: { x: 1, y: 1, z: 1 },           // the sky's light, for skyLit materials (linear)
    torches: new Float32Array(TORCHES * 4), // x, y, z (render coordinates), strength
    torchInfo: { x: 0, y: TORCH_REACH, z: 0, w: 0 }, // how many torches are lit; their reach
};

const C = THREE.ShaderChunk;
C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogView;
#endif`;
C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogView = mvPosition.xyz;
#endif`;
C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogView;
    uniform vec4 hazeSun;
    uniform vec3 hazeGlow;
    #ifdef FOG_EXP2
        uniform float fogDensity;
    #else
        uniform float fogNear;
        uniform float fogFar;
    #endif
#endif`;
// The line of sight, turned back from the view's axes to the world's (the
// view matrix is a rotation and a move: its transpose undoes the rotation).
// The fog is mixed in after the colour is put in the screen's sRGB, and
// fogColor comes in sRGB; the glow (linear, like the dome's) is added in
// linear light, as the dome adds it.
C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
    #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    vec3 hazeColor = fogColor;
    if ( fogFactor > 0.0 && hazeGlow.r + hazeGlow.g + hazeGlow.b > 0.0 ) {
        vec3 hazeDir = ( vec4( vFogView, 0.0 ) * viewMatrix ).xyz;
        float hazeLen = length( hazeDir.xz );
        float toward = hazeLen > 1e-5 ? max( dot( hazeDir.xz / hazeLen, hazeSun.xz ), 0.0 ) : 0.0;
        hazeColor = sRGBTransferOETF( vec4( sRGBTransferEOTF( vec4( fogColor, 1.0 ) ).rgb + hazeGlow * pow( toward, hazeSun.w ), 1.0 ) ).rgb;
    }
    gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColor, fogFactor );
#endif`;
// Torchlight, after the lights three.js knows (lit materials only). A soft
// wrap so a pool of light reads on every side of what it touches.
C.lights_fragment_end = `${C.lights_fragment_end}
#ifdef USE_FOG
    for ( int k = 0; k < ${TORCHES}; k ++ ) {
        if ( float( k ) >= hazeTorchInfo.x ) break;
        vec4 torch = hazeTorch[ k ];
        vec3 toTorch = ( viewMatrix * vec4( torch.xyz, 1.0 ) ).xyz - geometryPosition;
        float d = length( toTorch );
        float fall = clamp( 1.0 - d / hazeTorchInfo.y, 0.0, 1.0 );
        float facing = 0.3 + 0.7 * max( dot( geometryNormal, toTorch / max( d, 1e-3 ) ), 0.0 );
        reflectedLight.directDiffuse += BRDF_Lambert( material.diffuseColor ) * vec3( 1.0, 0.56, 0.24 ) * ( torch.w * fall * fall * facing );
    }
#endif`;
C.lights_pars_begin = `${C.lights_pars_begin}
#ifdef USE_FOG
    uniform vec4 hazeTorch[ ${TORCHES} ];
    uniform vec4 hazeTorchInfo;
#endif`;

for (const shader of Object.values(THREE.ShaderLib)) {
    if (!shader.uniforms?.fogColor) continue;
    shader.uniforms.hazeSun = { value: HAZE.sun };
    shader.uniforms.hazeGlow = { value: HAZE.glow };
    shader.uniforms.hazeTorch = { value: HAZE.torches };
    shader.uniforms.hazeTorchInfo = { value: HAZE.torchInfo };
}
THREE.ShaderLib.basic.uniforms.hazeSky = { value: HAZE.sky };
THREE.ShaderLib.basic.fragmentShader = THREE.ShaderLib.basic.fragmentShader
    .replace('#include <common>', '#include <common>\n#ifdef SKY_LIT\n    uniform vec3 hazeSky;\n#endif')
    .replace('#include <opaque_fragment>', '#ifdef SKY_LIT\n    outgoingLight *= hazeSky;\n#endif\n#include <opaque_fragment>');

// An unlit (MeshBasic) material that should still darken with the sky.
export function skyLit(material) {
    material.defines = { ...material.defines, SKY_LIT: '' };
    return material;
}

// The snow line (almanac.js snowLine), shared by what snow lies on: the
// ground (terrain-mesh.js), the trees (forest.js), the tufts (tufts.js).
// x: the line (0 the shore .. 1 the highest peak), y: the sea's height, z:
// the highest peak's, w: the fade (almanac.js SNOW_FADE). The ground sets it.
export const SNOW_LINE = { value: new THREE.Vector4(1.2, 0, 100, 0.14) };
export const SNOW_COLOR = { value: new THREE.Color().setRGB(SNOW[0] / 255, SNOW[1] / 255, SNOW[2] / 255, THREE.SRGBColorSpace) };

// How much snow lies at a height (world units), a level face, give or take
// `jitter` (noise); none on the lake beds.
export const SNOW_GLSL = /* glsl */ `
uniform vec4 uSnowLine;
uniform vec3 uSnowColor;
float snowAt( float height, float jitter ) {
    float hn = ( height - uSnowLine.y ) / max( uSnowLine.z - uSnowLine.y, 1.0 );
    return clamp( ( hn - uSnowLine.x ) / uSnowLine.w + 0.5 + jitter, 0.0, 1.0 ) * smoothstep( uSnowLine.y - 0.3, uSnowLine.y + 0.5, height );
}
// How much a face looks up (view-space normal), for snow to settle on it.
float upward( vec3 n ) {
    return dot( n, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
}
`;
