// The light's diffusion on the screen (the High setting, graphics.js):
// the scene is drawn into a render target (linear, half float, 4× MSAA, its
// depth kept as a texture), then
//   1. the light rays (RaysPass, screen-space radial scattering as in
//      Crysis and GPU Gems 3): where the sky shows near the sun (or the
//      moon), the depth says (nothing drawn there), a soft glow about it is
//      the mask, at a quarter of the screen's size; three passes of radial
//      blur toward the light, each finer than the last (8 taps each: 512 in
//      all), draw it out into shafts, which the land, the trees and the
//      bodies between cut; they are added over the scene in the light's
//      colour, strongest near it (graphics.js rayStrength: dawn and dusk);
//   2. a subtle bloom (three.js's UnrealBloomPass) of only what gives light
//      of its own: the sun's disc and the moon's (sky.js), torches' flames
//      and legends' glints (items.js). Not by brightness: a white flower or
//      a snowfield lit by the noon sun is about as bright as a flame at
//      night, so a threshold either blooms the lit land (in squares, at
//      every speck) or misses the flames. Instead each light marks itself
//      (the glow mark, below) and the bloom takes only what is marked;
//   3. the output: to the screen's sRGB (OutputPass).
// The haze is mixed as on the screen (haze.js), so it looks the same; the
// HUD and the panel are the page's, over the canvas, and untouched.
// Medium and Low draw straight to the screen and never come here.
//
// The glow mark: in the render target, a pixel's alpha above 1 is its own
// light (its luminance, linear). Everything else leaves alpha at 1: opaque
// surfaces write 1 and the clear is 1, see-through ones blend toward 1 (so
// a pane of water or smoke in front dims a mark, and anything solid in
// front hides it), and additive ones that do not glow (stars, a spear's
// streak, the light rays) leave it as it is (`unmarked`). What glows adds
// its own light to it (`glowing`, glowOf). On the screen, alpha is never
// seen: Medium and Low look the same.
import * as THREE from 'three';
import { EffectComposer } from '../../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from '../../vendor/three/examples/jsm/postprocessing/Pass.js';

// The bloom: how strong, and how wide. A pixel blooms by its own light (its
// mark, up to 1: from then on the whole pixel), and none brighter than
// `most` (linear; 1 is white).
export const BLOOM = { strength: 0.38, radius: 0.55, most: 6 };

// The glow mark's GLSL: how much light a colour (linear) is.
export const GLOW_GLSL = 'float glowOf( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }';

// An additive material that glows: its colour is added as before (it writes
// alpha = its own light, glowOf, which is added to the mark).
export function glowing(material) {
    return Object.assign(material, {
        transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
}

// An additive material that does not: its colour is added as three.js's
// AdditiveBlending adds it (times its alpha), the mark left as it was.
export function unmarked(material) {
    return Object.assign(material, {
        transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
}

// The bloom's bright pass: the marked pixels only, by their mark. (A pixel
// gone wrong, NaN or past half float, is left out: in the blurs it would
// spread into a square.)
const BRIGHT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
${GLOW_GLSL}
void main() {
    vec4 texel = texture2D( tDiffuse, vUv );
    float own = texel.a - 1.0;
    float light = glowOf( texel.rgb );
    vec3 glow = vec3( 0.0 );
    if ( own > 0.001 && light >= 0.0 && light < 60000.0 ) glow = min( texel.rgb * min( own, 1.0 ), vec3( ${BLOOM.most.toFixed(1)} ) );
    gl_FragColor = vec4( glow, 1.0 );
}`;
// The rays: how bright at full strength (times the light's colour), the
// mask's glow about the light (a share of the screen's height), and how far
// from the light they fade (the same).
export const RAYS = { bright: 0.9, glow: 0.9, fall: 1.1, scale: 4 };

const FULL_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// The mask: the sky (nothing drawn: the depth is at its far end), glowing
// about the light.
const MASK_FRAGMENT = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uLight;   // the light on the screen (uv)
uniform float uAspect;
uniform float uGlow;
varying vec2 vUv;
void main() {
    float sky = step( 0.99999, texture2D( tDepth, vUv ).r );
    vec2 d = ( vUv - uLight ) * vec2( uAspect, 1.0 );
    float glow = 1.0 - clamp( length( d ) / uGlow, 0.0, 1.0 );
    gl_FragColor = vec4( vec3( sky * glow ), 1.0 );
}`;

// One pass of the radial blur: the mean of TAPS samples on the way to the
// light, `uSpan` of the way (the first pass all of it; each next a TAPS-th
// of the last, filling in between: Sousa's three passes).
const TAPS = 8;
const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uLight;
uniform float uSpan;
varying vec2 vUv;
void main() {
    vec2 step = ( uLight - vUv ) * ( uSpan / ${TAPS}.0 );
    vec2 uv = vUv;
    float sum = 0.0;
    for ( int i = 0; i < ${TAPS}; i ++ ) {
        sum += texture2D( tInput, uv ).r;
        uv += step;
    }
    gl_FragColor = vec4( vec3( sum / ${TAPS}.0 ), 1.0 );
}`;

// The shafts, added over the scene: the light's colour, fading away from it.
const COMBINE_FRAGMENT = /* glsl */ `
uniform sampler2D tRays;
uniform vec3 uColor;
uniform vec2 uLight;
uniform float uAspect;
uniform float uFall;
varying vec2 vUv;
void main() {
    vec2 d = ( vUv - uLight ) * vec2( uAspect, 1.0 );
    float fall = 1.0 - smoothstep( 0.0, uFall, length( d ) );
    float rays = texture2D( tRays, vUv ).r;
    gl_FragColor = vec4( uColor * rays * rays * fall, 1.0 );
}`;

class RaysPass extends Pass {
    constructor() {
        super();
        this.needsSwap = false; // (added over the scene, in place)
        this.strength = 0;
        this.light = new THREE.Vector2(0.5, 0.5);
        this.color = new THREE.Color();
        const target = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.a = target();
        this.b = target();
        this.mask = new THREE.ShaderMaterial({
            uniforms: { tDepth: { value: null }, uLight: { value: this.light }, uAspect: { value: 1 }, uGlow: { value: RAYS.glow } },
            vertexShader: FULL_VERTEX, fragmentShader: MASK_FRAGMENT, depthTest: false, depthWrite: false,
        });
        this.blur = new THREE.ShaderMaterial({
            uniforms: { tInput: { value: null }, uLight: { value: this.light }, uSpan: { value: 1 } },
            vertexShader: FULL_VERTEX, fragmentShader: BLUR_FRAGMENT, depthTest: false, depthWrite: false,
        });
        this.combine = unmarked(new THREE.ShaderMaterial({
            uniforms: { tRays: { value: null }, uColor: { value: this.color }, uLight: { value: this.light }, uAspect: { value: 1 }, uFall: { value: RAYS.fall } },
            vertexShader: FULL_VERTEX, fragmentShader: COMBINE_FRAGMENT, depthTest: false, depthWrite: false,
        }));
        this.quad = new FullScreenQuad(null);
    }

    setSize(width, height) {
        const w = Math.max(1, Math.ceil(width / RAYS.scale));
        const h = Math.max(1, Math.ceil(height / RAYS.scale));
        this.a.setSize(w, h);
        this.b.setSize(w, h);
        this.mask.uniforms.uAspect.value = width / height;
        this.combine.uniforms.uAspect.value = width / height;
    }

    render(renderer, writeBuffer, readBuffer) {
        if (this.strength <= 0.003) return;
        const auto = renderer.autoClear;
        renderer.autoClear = false;
        const q = this.quad;
        this.mask.uniforms.tDepth.value = readBuffer.depthTexture;
        q.material = this.mask;
        renderer.setRenderTarget(this.a);
        q.render(renderer);
        // Three passes of radial blur, each finer than the last.
        const u = this.blur.uniforms;
        q.material = this.blur;
        let from = this.a;
        let to = this.b;
        for (let pass = 0; pass < 3; pass++) {
            u.tInput.value = from.texture;
            u.uSpan.value = TAPS ** -pass;
            renderer.setRenderTarget(to);
            q.render(renderer);
            [from, to] = [to, from];
        }
        this.combine.uniforms.tRays.value = from.texture;
        q.material = this.combine;
        renderer.setRenderTarget(readBuffer);
        q.render(renderer);
        renderer.autoClear = auto;
    }

    dispose() {
        this.a.dispose();
        this.b.dispose();
        this.mask.dispose();
        this.blur.dispose();
        this.combine.dispose();
    }
}

export class Post {
    constructor(gl, scene, camera) {
        this.gl = gl;
        const size = gl.getDrawingBufferSize(new THREE.Vector2());
        this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
            type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(size.x, size.y),
        });
        this.composer = new EffectComposer(gl, this.target);
        this.rays = new RaysPass();
        this.bloom = new UnrealBloomPass(size, BLOOM.strength, BLOOM.radius, 0);
        // Its bright pass takes the glow mark instead of a brightness.
        this.bloom.materialHighPassFilter.fragmentShader = BRIGHT_FRAGMENT;
        this.composer.addPass(new RenderPass(scene, camera));
        this.composer.addPass(this.rays);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.passes = 0; // the full-screen passes drawn last frame (for the cost)
        this.resize();
    }

    // The target the scene is drawn into (for compiling its programs ahead).
    get scene() {
        return this.composer.readBuffer;
    }

    resize() {
        const size = this.gl.getSize(new THREE.Vector2());
        this.composer.setPixelRatio(this.gl.getPixelRatio());
        this.composer.setSize(size.x, size.y);
    }

    // The rays this frame: their strength (graphics.js rayStrength), the
    // light on the screen (uv) and its colour (linear).
    aim(strength, u, v, color) {
        const r = this.rays;
        r.strength = strength;
        r.light.set(u, v);
        r.color.copy(color).multiplyScalar(RAYS.bright * strength);
    }

    render() {
        this.composer.render();
        // The scene, the rays' mask, blur (3) and sum, bloom's bright pass,
        // blurs (2 × 5), mix and sum, the output.
        this.passes = 1 + (this.rays.strength > 0.003 ? 5 : 0) + 14 + 1;
    }

    dispose() {
        this.composer.dispose();
        this.rays.dispose();
        this.bloom.dispose();
    }
}
