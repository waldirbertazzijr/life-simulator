// The page side of tools/bake.mjs: a heavy model flattened into our format.
//
// 1. Read it with three's GLTFLoader (Chromium decodes the textures), in the
//    pose its file stands in (the skeleton's rest, no animation).
// 2. Every triangle where the skinned body puts it, turned into our axes
//    (+X forward, +Y up, the left side at −Z): `up` is the file's, and
//    `forward` the way it faces, or found from the head's bones.
// 3. A flat colour per face: the base colour texture (or a spec-gloss
//    diffuse texture) averaged over the face (21 points spread over it), in
//    linear light, times the material's colour and any vertex colours.
//    Faces of a see-through material where the texture is all but clear go.
// 4. Each vertex's rig part from the bone that moves it most: by the bone's
//    name (head, neck, jaw, ear... legs, paws... spine, tail...; English
//    and German), else by where the bone is (models.js's quadruped rule).
//    A leg's corner is where its bone is. Joints: the root of the head's
//    bones (the neck), and the highest joint of each leg's (hip, shoulder).
// 5. Simplified to the budget if over (models.js simplify: positions, then
//    the old faces' colours carried over).
// 6. Written as a small .glb: per mesh POSITION, COLOR_0 (16-bit, linear)
//    and _PART, with asset.extras.lifeSim = { up, forward, srgb, joints }.
//    Textures, normals, skins and animations are left behind. A model
//    without a skeleton is written mesh by mesh with no _PART, and the
//    game sorts its pieces itself.
//
// Then the original and the bake are drawn side by side for a screenshot.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { axis, basis, quadrupedRule, simplify, PART_NAME } from '../src/view3d/models.js';
import { PART } from '../src/view3d/animate.js';

// Bone names → parts. A name is cut into words (at case changes, digits and
// punctuation); a word matches a stem of four letters or more anywhere in it
// (German runs words together: Vorderpfote), a shorter stem only whole.
const NAMES = [
    ['leg', ['leg', 'legs', 'thigh', 'shin', 'calf', 'knee', 'foot', 'feet', 'hoof', 'paw', 'toe', 'toes', 'ankle', 'heel', 'arm', 'upperarm', 'forearm', 'elbow', 'wrist', 'hand', 'finger', 'femur', 'tibia', 'humerus', 'carpal', 'tarsal', 'phalanx', 'digit', 'pfote', 'schenkel', 'oberarm', 'unterarm', 'bein', 'fuss', 'zeh', 'knie']],
    ['head', ['head', 'neck', 'skull', 'jaw', 'ear', 'ears', 'horn', 'nose', 'mouth', 'eye', 'eyes', 'eyelid', 'lid', 'tongue', 'chin', 'snout', 'muzzle', 'lip', 'teeth', 'brow', 'kopf', 'hals', 'kiefer', 'maul', 'ohr', 'aug', 'augen', 'mund', 'braun', 'lied', 'nase', 'zunge']],
    ['torso', ['spine', 'chest', 'pelvis', 'hips', 'hip', 'root', 'body', 'torso', 'tail', 'belly', 'clavicle', 'shoulder', 'scapula', 'rib', 'back', 'abdomen', 'becken', 'bauch', 'brust', 'schwanz', 'schalterplatte', 'schulter', 'ruecken', 'wirbel']],
];
const words = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
function nameKind(name, extra) {
    for (const [re, kind] of extra) if (re.test(name)) return kind;
    const ws = words(name);
    for (const [kind, stems] of NAMES) {
        if (ws.some((w) => stems.some((s) => (s.length >= 4 ? w.includes(s) : w === s)))) return kind;
    }
    return null;
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// 21 points spread evenly inside a triangle (barycentric), kept off its edges
// so that a face does not pick up its neighbours across a texture seam.
const GRID = [];
for (let i = 0; i <= 5; i++) for (let j = 0; i + j <= 5; j++) GRID.push([(i + 1 / 3) / 6, (j + 1 / 3) / 6, (5 - i - j + 1 / 3) / 6]);

// A texture's pixels, once each.
const pixels = new Map();
function pixelsOf(texture) {
    if (!pixels.has(texture)) {
        const img = texture.image;
        const w = img.width;
        const h = img.height;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        texture.updateMatrix();
        pixels.set(texture, { w, h, data: ctx.getImageData(0, 0, w, h).data });
    }
    return pixels.get(texture);
}
const uvTmp = new THREE.Vector2();
// The texture at (u, v): linear RGB and alpha.
function sample(texture, u, v) {
    const { w, h, data } = pixelsOf(texture);
    texture.transformUv(uvTmp.set(u, v)); // wrapping, offset/repeat, flipY: then rows from the top
    const x = Math.min(w - 1, Math.max(0, Math.floor(uvTmp.x * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(uvTmp.y * h)));
    const i = (y * w + x) * 4;
    return [linear(data[i] / 255), linear(data[i + 1] / 255), linear(data[i + 2] / 255), data[i + 3] / 255];
}

// What colours a mesh: { texture, factor (linear RGB), clear (see-through) }.
async function paintOf(mesh, parser) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const index = parser.associations.get(m)?.materials;
    const def = index !== undefined ? parser.json.materials[index] : null;
    const sg = def?.extensions?.KHR_materials_pbrSpecularGlossiness;
    if (sg) {
        const texture = sg.diffuseTexture ? await parser.getDependency('texture', sg.diffuseTexture.index) : null;
        if (texture) texture.colorSpace = THREE.SRGBColorSpace;
        const f = sg.diffuseFactor ?? [1, 1, 1, 1];
        return { texture, factor: [f[0], f[1], f[2]], clear: def.alphaMode === 'BLEND' || def.alphaMode === 'MASK', specGloss: true };
    }
    return { texture: m.map ?? null, factor: [m.color.r, m.color.g, m.color.b], clear: m.transparent || m.alphaTest > 0 };
}

// The bake. opts: see tools/bake.mjs.
export async function bake(opts) {
    const report = [];
    const say = (s) => report.push(s);
    const bytes = await (await fetch(opts.input)).arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    const { scene, parser } = gltf;
    scene.updateMatrixWorld(true);
    const drop = opts.drop ? new RegExp(opts.drop, 'i') : null;
    const extra = Object.entries(opts.parts ?? {}).map(([re, kind]) => [new RegExp(re, 'i'), kind]);
    say(`${opts.name}: ${(bytes.byteLength / 1048576).toFixed(1)} MB, made by ${parser.json.asset?.generator ?? '?'}`);

    // The meshes, their triangles where the body puts them (the file's axes).
    const meshes = [];
    const dropped = [];
    scene.traverse((o) => {
        if (!o.isMesh) return;
        const material = Array.isArray(o.material) ? o.material[0] : o.material;
        if (drop && (drop.test(o.name) || drop.test(material?.name ?? ''))) dropped.push(o);
        else meshes.push(o);
    });
    for (const o of dropped) {
        o.removeFromParent();
        say(`  dropped mesh ${o.name} (${o.material?.name ?? ''})`);
    }
    const bones = new Set();
    const v = new THREE.Vector3();
    const raw = [];
    for (const mesh of meshes) {
        const g = mesh.geometry;
        const pos = g.attributes.position;
        const n = pos.count;
        const at = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            v.fromBufferAttribute(pos, i);
            if (mesh.isSkinnedMesh) mesh.applyBoneTransform(i, v);
            v.applyMatrix4(mesh.matrixWorld);
            at.set([v.x, v.y, v.z], i * 3);
        }
        // The bone that moves each vertex most.
        let lead = null;
        if (mesh.isSkinnedMesh && g.attributes.skinIndex) {
            lead = new Array(n).fill(null);
            const si = g.attributes.skinIndex;
            const sw = g.attributes.skinWeight;
            for (let i = 0; i < n; i++) {
                let best = -1;
                let wBest = 0;
                for (let k = 0; k < 4; k++) {
                    const w = sw.getComponent(i, k);
                    if (w > wBest) {
                        wBest = w;
                        best = si.getComponent(i, k);
                    }
                }
                if (best >= 0) {
                    lead[i] = mesh.skeleton.bones[best];
                    bones.add(lead[i]);
                }
            }
        }
        const index = g.index ? g.index.array : null;
        const tris = (index ? index.length : n) / 3;
        const paint = await paintOf(mesh, parser);
        raw.push({ mesh, at, lead, index, tris, paint, uv: g.attributes.uv ?? null, color: g.attributes.color ?? null });
        const tex = paint.texture?.image ? `${paint.texture.image.width}×${paint.texture.image.height} texture` : 'no texture';
        say(`  mesh ${mesh.name} (${mesh.material?.name ?? ''}): ${tris} triangles, ${mesh.isSkinnedMesh ? 'skinned' : 'static'}, ${tex}${paint.specGloss ? ' (spec-gloss)' : ''}${paint.clear ? ', see-through' : ''}`);
    }

    // Bones by name (or later by place).
    const boneKind = new Map();
    for (const b of bones) boneKind.set(b, nameKind(b.name, extra));
    const world = (b) => b.getWorldPosition(new THREE.Vector3());
    const mean = (list) => {
        const s = new THREE.Vector3();
        for (const b of list) s.add(world(b));
        return list.length ? s.divideScalar(list.length) : null;
    };

    // Our axes.
    let forward = opts.forward;
    if (forward === 'auto') {
        const head = mean([...bones].filter((b) => boneKind.get(b) === 'head'));
        const body = mean([...bones].filter((b) => boneKind.get(b) === 'torso'));
        if (!head || !body) throw new Error('--forward auto needs bones named for the head and the body: give --forward');
        const d = head.sub(body);
        const up = axis(opts.up);
        let best = null;
        for (const a of ['+x', '-x', '+y', '-y', '+z', '-z']) {
            const f = axis(a);
            if (Math.abs(f[0] * up[0] + f[1] * up[1] + f[2] * up[2]) > 0.5) continue;
            const s = f[0] * d.x + f[1] * d.y + f[2] * d.z;
            if (!best || s > best.s) best = { a, s };
        }
        forward = best.a;
        say(`  faces ${forward} (from its head's bones)`);
    }
    const [F, U, S] = basis(opts.up, forward);
    const turn = (p) => [F[0] * p.x + F[1] * p.y + F[2] * p.z, U[0] * p.x + U[1] * p.y + U[2] * p.z, S[0] * p.x + S[1] * p.y + S[2] * p.z];
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const r of raw) {
        for (let i = 0; i < r.at.length; i += 3) {
            const [x, y, z] = turn(v.set(r.at[i], r.at[i + 1], r.at[i + 2]));
            r.at.set([x, y, z], i);
            box.minX = Math.min(box.minX, x);
            box.maxX = Math.max(box.maxX, x);
            box.minY = Math.min(box.minY, y);
            box.maxY = Math.max(box.maxY, y);
            box.minZ = Math.min(box.minZ, z);
            box.maxZ = Math.max(box.maxZ, z);
        }
    }
    const rule = quadrupedRule(box);

    // Each bone's part; legs' corners by where their bones are.
    const place = new Map([...bones].map((b) => [b, turn(world(b))]));
    for (const b of bones) {
        if (boneKind.get(b)) continue;
        const [x, y, z] = place.get(b);
        boneKind.set(b, rule.isLeg(y, z) ? 'leg' : rule.isHead(x, y) ? 'head' : 'torso');
    }
    const legX = [...bones].filter((b) => boneKind.get(b) === 'leg').map((b) => place.get(b)[0]);
    const mid = (Math.min(...legX) + Math.max(...legX)) / 2;
    const corner = { leg_fl: PART.LEG_FL, leg_fr: PART.LEG_FR, leg_bl: PART.LEG_BL, leg_br: PART.LEG_BR };
    const partOfBone = new Map();
    for (const b of bones) {
        const k = boneKind.get(b);
        const [x, , z] = place.get(b);
        partOfBone.set(b, k === 'head' ? PART.HEAD : k === 'torso' ? PART.TORSO : corner[k] ?? rule.legOf(x > mid, z));
    }
    const skinned = raw.some((r) => r.lead);
    if (skinned) {
        const byPart = {};
        for (const b of bones) (byPart[PART_NAME[partOfBone.get(b)]] ??= []).push(b.name);
        for (const [p, names] of Object.entries(byPart)) say(`  ${p.toLowerCase()}: ${names.join(', ')}`);
    }

    // Joints: the root of the head's bones (the fewest parents), and the
    // highest of each leg's (IK targets and feet sit lower).
    const depth = (b) => {
        let d = 0;
        for (let p = b.parent; p; p = p.parent) d++;
        return d;
    };
    const joints = {};
    for (const [name, part] of Object.entries({ head: PART.HEAD, ...corner })) {
        let root = null;
        const better = name === 'head'
            ? (b, r) => depth(b) < depth(r) || (depth(b) === depth(r) && place.get(b)[0] < place.get(r)[0])
            : (b, r) => place.get(b)[1] > place.get(r)[1];
        for (const b of bones) if (partOfBone.get(b) === part && (!root || better(b, root))) root = b;
        if (root) joints[name] = place.get(root).map((c) => +c.toFixed(5));
        if (root) say(`  joint ${name}: ${root.name}`);
    }

    // Faces: flat colours, parts per vertex.
    const pieces = [];
    let cleared = 0;
    let total = 0;
    for (const r of raw) {
        const pos = [];
        const col = [];
        const part = [];
        const corners = [0, 0, 0];
        for (let t = 0; t < r.tris; t++) {
            for (let k = 0; k < 3; k++) corners[k] = r.index ? r.index[t * 3 + k] : t * 3 + k;
            let rgb = r.paint.factor.map((c) => c * opts.gain);
            if (r.paint.texture && r.uv) {
                const uv = corners.map((i) => [r.uv.getX(i), r.uv.getY(i)]);
                const points = GRID.map(([a, b, c]) => [a * uv[0][0] + b * uv[1][0] + c * uv[2][0], a * uv[0][1] + b * uv[1][1] + c * uv[2][1]]);
                const s = [0, 0, 0, 0];
                for (const [u, w] of points) sample(r.paint.texture, u, w).forEach((c, k) => (s[k] += c / points.length));
                if (r.paint.clear && s[3] < opts.alpha) {
                    cleared++;
                    continue;
                }
                rgb = rgb.map((c, k) => c * s[k]);
            }
            if (r.color) rgb = rgb.map((c, k) => c * (corners.reduce((a, i) => a + r.color.getComponent(i, k), 0) / 3));
            for (const i of corners) {
                pos.push(r.at[i * 3], r.at[i * 3 + 1], r.at[i * 3 + 2]);
                col.push(...rgb);
                if (r.lead) {
                    const b = r.lead[i];
                    part.push(b ? partOfBone.get(b) : ((x, y, z) => (rule.isLeg(y, z) ? rule.legOf(x > mid, z) : rule.isHead(x, y) ? PART.HEAD : PART.TORSO))(r.at[i * 3], r.at[i * 3 + 1], r.at[i * 3 + 2]));
                } else part.push(0);
            }
        }
        if (!pos.length) continue;
        total += pos.length / 9;
        pieces.push({ name: r.mesh.name || 'mesh', pos: Float32Array.from(pos), col: Float32Array.from(col), part: Uint8Array.from(part), static: !r.lead });
    }
    if (cleared) say(`  ${cleared} see-through faces left out`);

    // To the budget.
    let out = pieces;
    if (opts.budget > 0 && total > opts.budget) {
        out = [];
        for (const p of pieces) out.push({ ...(await simplify(p, opts.budget / total, 4)), static: p.static });
    }
    const after = out.reduce((n, p) => n + p.pos.length / 9, 0);
    say(`  triangles: ${raw.reduce((n, r) => n + r.tris, 0)} in, ${total} kept, ${after} out (budget ${opts.budget})`);
    const lifeSim = { up: '+y', forward: '+x', srgb: false, plan: opts.plan, joints: skinned ? joints : undefined };
    const glb = writeGlb(out, { lifeSim, bakedFrom: opts.name, generator: 'life-simulator tools/bake.mjs' }, skinned);
    preview(scene, out, F, U, S, box, raw, opts);
    return { glb: base64(glb), report: report.join('\n') };
}

// ---- Writing the .glb ----

function writeGlb(pieces, extras, withParts) {
    const chunks = [];
    let length = 0;
    const views = [];
    const accessors = [];
    const add = (array, extra) => {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
        chunks.push(bytes);
        length += bytes.length + ((4 - (bytes.length % 4)) % 4);
        if (bytes.length % 4) chunks.push(new Uint8Array((4 - (bytes.length % 4)) % 4));
        accessors.push({ bufferView: views.length - 1, ...extra });
        return accessors.length - 1;
    };
    const meshes = [];
    for (const p of pieces) {
        const n = p.pos.length / 3;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.pos.length; i++) {
            min[i % 3] = Math.min(min[i % 3], p.pos[i]);
            max[i % 3] = Math.max(max[i % 3], p.pos[i]);
        }
        const color = new Uint16Array(n * 4);
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) color[i * 4 + k] = Math.round(Math.min(1, Math.max(0, p.col[i * 3 + k])) * 65535);
            color[i * 4 + 3] = 65535;
        }
        const attributes = {
            POSITION: add(p.pos, { componentType: 5126, count: n, type: 'VEC3', min, max }),
            COLOR_0: add(color, { componentType: 5123, normalized: true, count: n, type: 'VEC4' }),
        };
        if (withParts && !p.static) attributes._PART = add(Float32Array.from(p.part), { componentType: 5126, count: n, type: 'SCALAR' });
        meshes.push({ name: p.name, primitives: [{ attributes, mode: 4 }] });
    }
    const json = {
        asset: { version: '2.0', generator: extras.generator, extras: { lifeSim: extras.lifeSim, bakedFrom: extras.bakedFrom } },
        scene: 0,
        scenes: [{ nodes: meshes.map((_, i) => i) }],
        nodes: meshes.map((m, i) => ({ name: m.name, mesh: i })),
        meshes,
        accessors,
        bufferViews: views,
        buffers: [{ byteLength: length }],
    };
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jl = text.length + ((4 - (text.length % 4)) % 4);
    const total = 12 + 8 + jl + 8 + length;
    const glb = new Uint8Array(total);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jl, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.set(text, 20);
    glb.fill(0x20, 20 + text.length, 20 + jl);
    dv.setUint32(20 + jl, length, true);
    dv.setUint32(24 + jl, 0x004e4942, true);
    let o = 28 + jl;
    for (const c of chunks) {
        glb.set(c, o);
        o += c.length;
    }
    return glb;
}

function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

// ---- The picture: the original (left) and the bake (right) ----

function preview(scene, pieces, F, U, S, box, raw, opts) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    document.body.appendChild(renderer.domElement);
    const world = new THREE.Scene();
    world.background = new THREE.Color('#b3c9da');
    const sun = new THREE.DirectionalLight('#fff6ea', 3.0);
    sun.position.set(-0.6, 0.62, -0.45);
    world.add(new THREE.HemisphereLight('#e0e9f0', '#6a6c5a', 2.6), sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: '#5d7448' }));
    ground.rotation.x = -Math.PI / 2;
    world.add(ground);
    const L = box.maxX - box.minX;
    const k = 5 / L;
    // The original, turned into our axes.
    const turnM = new THREE.Matrix4().set(F[0], F[1], F[2], 0, U[0], U[1], U[2], 0, S[0], S[1], S[2], 0, 0, 0, 0, 1);
    const left = new THREE.Group();
    left.add(scene);
    left.matrixAutoUpdate = false;
    const centre = (dx) => new THREE.Matrix4().makeTranslation(dx - ((box.minX + box.maxX) / 2) * k, -box.minY * k, -((box.minZ + box.maxZ) / 2) * k);
    left.matrix.copy(centre(-3.4).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(turnM));
    scene.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false;
        // (three no longer reads spec-gloss materials: show their diffuse texture.)
        const r = raw.find((x) => x.mesh === o);
        if (r?.paint.specGloss) o.material = new THREE.MeshLambertMaterial({ map: r.paint.texture, color: new THREE.Color(...r.paint.factor).multiplyScalar(opts.gain), alphaTest: r.paint.clear ? 0.5 : 0 });
    });
    world.add(left);
    // The bake, flat-shaded as the game draws it.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pieces.flatMap((p) => [...p.pos])), 3));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(pieces.flatMap((p) => [...p.col])), 3));
    g.computeVertexNormals();
    const right = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    right.matrixAutoUpdate = false;
    right.matrix.copy(centre(3.4).multiply(new THREE.Matrix4().makeScale(k, k, k)));
    world.add(right);
    const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 500);
    camera.position.set(1.5, 3.2, 15);
    camera.lookAt(0, 1.4, 0);
    renderer.render(world, camera);
}
