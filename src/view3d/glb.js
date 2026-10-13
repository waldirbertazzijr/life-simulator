// A small reader for binary glTF (.glb) files: just enough to turn a model
// into our bodies (models.js). No three.js and no DOM, so node reads the
// same files in the tests.
//
// It reads the JSON and BIN chunks, the accessors (any component type,
// normalized or not, interleaved or not), the node tree (TRS or a matrix),
// and each mesh's primitives: triangles (strips and fans are turned into
// triangles; points and lines are skipped, and said so in `skipped`). Out
// comes every primitive in the scene's space:
//
//   { node, mesh, position, normal, color, uv, indices, material }
//
// position and normal are Float32Arrays (xyz, already moved by their node);
// color is RGBA floats as the file stores them (COLOR_0, or null); uv is the
// first texture coordinates (or null); part is our rig part per vertex (the
// attribute _PART, which tools/bake.mjs writes, or null); indices a
// Uint32Array of triangles (or null: every three vertices are one). material is
// { name, color: [r, g, b, a], texture } with the base colour factor (linear)
// and, if there is one, the base colour texture { image, texCoord }, where
// image indexes `images` ({ mimeType, bytes, uri }). Textures are not
// decoded here.
//
// Compressed geometry (Draco, meshopt) and other extensions a file requires
// but this reader does not know are refused with an error naming them, as
// are sparse accessors.

const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENTS = {
    5120: { bytes: 1, get: 'getInt8', max: 127 },
    5121: { bytes: 1, get: 'getUint8', max: 255 },
    5122: { bytes: 2, get: 'getInt16', max: 32767 },
    5123: { bytes: 2, get: 'getUint16', max: 65535 },
    5125: { bytes: 4, get: 'getUint32', max: 4294967295 },
    5126: { bytes: 4, get: 'getFloat32', max: 1 },
};

// Extensions a file may require that change nothing for us (quantized
// accessors are read like any other; we draw no textures or lighting models).
const HARMLESS = new Set([
    'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_unlit', 'KHR_materials_emissive_strength',
    'KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif',
]);
const WHY = {
    KHR_draco_mesh_compression: 'Draco-compressed geometry: export the .glb without Draco compression',
    EXT_meshopt_compression: 'meshopt-compressed geometry: export the .glb without meshopt compression',
    KHR_meshopt_compression: 'meshopt-compressed geometry: export the .glb without meshopt compression',
    EXT_mesh_gpu_instancing: 'GPU instancing of nodes: export the copies as plain meshes',
};

export class GlbError extends Error {}

// bytes: an ArrayBuffer, or any typed array over one (a node Buffer too).
export function readGlb(bytes) {
    const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new GlbError('not a binary glTF (.glb) file');
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new GlbError(`glTF version ${version}: only 2 is read`);
    const length = Math.min(dv.getUint32(8, true), u8.byteLength);
    let json = null;
    let bin = null;
    for (let at = 12; at + 8 <= length;) {
        const size = dv.getUint32(at, true);
        const type = dv.getUint32(at + 4, true);
        const body = u8.subarray(at + 8, at + 8 + size);
        if (type === JSON_CHUNK && !json) json = JSON.parse(new TextDecoder().decode(body));
        else if (type === BIN_CHUNK && !bin) bin = body;
        at += 8 + size + ((4 - (size % 4)) % 4);
    }
    if (!json) throw new GlbError('no JSON chunk');
    return parse(json, bin);
}

function parse(json, bin) {
    const unknown = (json.extensionsRequired ?? []).filter((e) => !HARMLESS.has(e));
    if (unknown.length) throw new GlbError(`unsupported: ${unknown.map((e) => WHY[e] ?? `the extension ${e}`).join('; ')}`);

    const buffers = (json.buffers ?? []).map((b, i) => {
        if (b.uri === undefined && i === 0 && bin) return bin;
        if (typeof b.uri === 'string' && b.uri.startsWith('data:')) return dataUri(b.uri);
        throw new GlbError(`buffer ${i} is outside the file (${b.uri ?? 'missing'}): export a self-contained .glb`);
    });
    const view = (i) => {
        const v = json.bufferViews[i];
        const buf = buffers[v.buffer];
        return { bytes: buf.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), stride: v.byteStride ?? 0 };
    };
    const cache = new Map();
    // An accessor as plain numbers (Float32Array, normalized integers mapped to
    // 0..1 or −1..1), or (`asIndex`) as a Uint32Array.
    const accessor = (i, asIndex = false) => {
        const key = `${i}${asIndex}`;
        if (cache.has(key)) return cache.get(key);
        const a = json.accessors[i];
        if (a.sparse) throw new GlbError(`accessor ${i} is sparse: export without sparse accessors`);
        const size = SIZES[a.type];
        const c = COMPONENTS[a.componentType];
        if (!size || !c) throw new GlbError(`accessor ${i}: unknown type ${a.type} / ${a.componentType}`);
        const out = asIndex ? new Uint32Array(a.count * size) : new Float32Array(a.count * size);
        if (a.bufferView !== undefined) {
            const { bytes, stride } = view(a.bufferView);
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const step = stride || size * c.bytes;
            const norm = a.normalized && !asIndex && a.componentType !== 5126;
            for (let n = 0; n < a.count; n++) {
                const base = (a.byteOffset ?? 0) + n * step;
                for (let k = 0; k < size; k++) {
                    let v = dv[c.get](base + k * c.bytes, true);
                    if (norm) v = Math.max(v / c.max, -1);
                    out[n * size + k] = v;
                }
            }
        }
        cache.set(key, out);
        return out;
    };

    const images = (json.images ?? []).map((im) => ({
        mimeType: im.mimeType ?? null,
        bytes: im.bufferView !== undefined ? view(im.bufferView).bytes : null,
        uri: im.uri ?? null,
    }));
    const materials = (json.materials ?? []).map((m) => {
        const pbr = m.pbrMetallicRoughness ?? {};
        const tex = pbr.baseColorTexture;
        return {
            name: m.name ?? '',
            color: pbr.baseColorFactor ?? [1, 1, 1, 1],
            texture: tex ? { image: json.textures?.[tex.index]?.source ?? null, texCoord: tex.texCoord ?? 0 } : null,
        };
    });
    const plain = { name: '', color: [1, 1, 1, 1], texture: null };

    const primitives = [];
    const skipped = [];
    const scene = json.scenes?.[json.scene ?? 0];
    const roots = scene ? scene.nodes : (json.nodes ?? []).map((_, i) => i);
    const visit = (n, parent) => {
        const node = json.nodes[n];
        const m = multiply(parent, local(node));
        if (node.mesh !== undefined) {
            const mesh = json.meshes[node.mesh];
            mesh.primitives.forEach((p, k) => {
                const mode = p.mode ?? 4;
                const name = `${node.name ?? `node ${n}`} / ${mesh.name ?? `mesh ${node.mesh}`}${mesh.primitives.length > 1 ? ` #${k}` : ''}`;
                if (mode < 4 || mode > 6) {
                    skipped.push(`${name}: points or lines (mode ${mode})`);
                    return;
                }
                const at = p.attributes;
                if (at.POSITION === undefined) {
                    skipped.push(`${name}: no positions`);
                    return;
                }
                const position = transform(accessor(at.POSITION), m, 1);
                const normal = at.NORMAL !== undefined ? transform(accessor(at.NORMAL), normalMatrix(m), 0) : null;
                let color = null;
                if (at.COLOR_0 !== undefined) {
                    const c = accessor(at.COLOR_0);
                    color = json.accessors[at.COLOR_0].type === 'VEC3' ? rgba(c) : c;
                }
                const material = p.material !== undefined ? materials[p.material] : plain;
                const uvAt = at[`TEXCOORD_${material.texture?.texCoord ?? 0}`];
                const uv = uvAt !== undefined ? accessor(uvAt) : null;
                const part = at._PART !== undefined ? accessor(at._PART) : null;
                let indices = p.indices !== undefined ? accessor(p.indices, true) : null;
                if (mode !== 4) indices = triangles(indices ?? Uint32Array.from({ length: position.length / 3 }, (_, i) => i), mode);
                // A mirrored node (negative determinant) turns its triangles inside out.
                if (det3(m) < 0) indices = flip(indices ?? Uint32Array.from({ length: position.length / 3 }, (_, i) => i));
                primitives.push({ node: node.name ?? `node ${n}`, mesh: mesh.name ?? `mesh ${node.mesh}`, position, normal, color, uv, part, indices, material });
            });
        }
        for (const child of node.children ?? []) visit(child, m);
    };
    for (const r of roots) visit(r, IDENTITY);
    return { asset: json.asset ?? {}, primitives, images, skipped };
}

// ---- Small helpers ----

function dataUri(uri) {
    const comma = uri.indexOf(',');
    if (!uri.slice(0, comma).endsWith(';base64')) throw new GlbError('a data URI buffer that is not base64');
    const s = atob(uri.slice(comma + 1));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

function rgba(rgb) {
    const out = new Float32Array((rgb.length / 3) * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        out[j] = rgb[i];
        out[j + 1] = rgb[i + 1];
        out[j + 2] = rgb[i + 2];
        out[j + 3] = 1;
    }
    return out;
}

// Strips (5) and fans (6) as plain triangles.
function triangles(ix, mode) {
    const out = [];
    for (let i = 2; i < ix.length; i++) {
        if (mode === 5) out.push(...(i % 2 ? [ix[i - 1], ix[i - 2], ix[i]] : [ix[i - 2], ix[i - 1], ix[i]]));
        else out.push(ix[0], ix[i - 1], ix[i]);
    }
    return Uint32Array.from(out);
}

function flip(ix) {
    const out = Uint32Array.from(ix);
    for (let i = 0; i + 2 < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]];
    return out;
}

// 4×4 matrices, column-major as glTF writes them.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function local(node) {
    if (node.matrix) return node.matrix;
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

function multiply(a, b) {
    const out = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

// The inverse transpose of the upper 3×3, as a 4×4 without translation.
function normalMatrix(m) {
    const d = det3(m) || 1;
    const [a, b, c, e, f, g, h, i, j] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    return [
        (f * j - g * i) / d, (g * h - e * j) / d, (e * i - f * h) / d, 0,
        (c * i - b * j) / d, (a * j - c * h) / d, (b * h - a * i) / d, 0,
        (b * g - c * f) / d, (c * e - a * g) / d, (a * f - b * e) / d, 0,
        0, 0, 0, 1,
    ];
}

// Points (w = 1) or directions (w = 0, renormalized) through a matrix.
function transform(v, m, w) {
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i += 3) {
        const x = v[i];
        const y = v[i + 1];
        const z = v[i + 2];
        let ox = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
        let oy = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
        let oz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
        if (!w) {
            const l = Math.hypot(ox, oy, oz) || 1;
            ox /= l;
            oy /= l;
            oz /= l;
        }
        out[i] = ox;
        out[i + 1] = oy;
        out[i + 2] = oz;
    }
    return out;
}
