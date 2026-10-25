// Parseur W3D (Westwood 3D) — format binaire en chunks, little-endian.
// Chunk : type u32 | taille u32 (bit 31 = contient des sous-chunks) | données.
// Module pur (sans Three.js) : il rend des tableaux typés + hiérarchie + HLOD.

export const T = {
  MESH: 0x00, VERTICES: 0x02, VERTEX_NORMALS: 0x03, VERTEX_INFLUENCES: 0x0E,
  MESH_HEADER3: 0x1F, TRIANGLES: 0x20, SHADERS: 0x29, VERTEX_MATERIALS: 0x2A, VERTEX_MATERIAL: 0x2B,
  VERTEX_MATERIAL_NAME: 0x2C, VERTEX_MATERIAL_INFO: 0x2D,
  TEXTURES: 0x30, TEXTURE: 0x31, TEXTURE_NAME: 0x32,
  MATERIAL_PASS: 0x38, DCG: 0x39, SHADER_IDS: 0x3C, VERTEX_MATERIAL_IDS: 0x3D,
  TEXTURE_STAGE: 0x48, TEXTURE_IDS: 0x49, STAGE_TEXCOORDS: 0x4A,
  HIERARCHY: 0x100, HIERARCHY_HEADER: 0x101, PIVOTS: 0x102,
  ANIMATION: 0x200, ANIMATION_HEADER: 0x201, ANIMATION_CHANNEL: 0x202, BIT_CHANNEL: 0x203,
  COMPRESSED_ANIMATION: 0x280, COMPRESSED_ANIMATION_HEADER: 0x281, COMPRESSED_ANIMATION_CHANNEL: 0x282, COMPRESSED_ANIMATION_BIT_CHANNEL: 0x283,
  HLOD: 0x700, HLOD_HEADER: 0x701, HLOD_LOD_ARRAY: 0x702, HLOD_LOD_ARRAY_HEADER: 0x703, HLOD_SUB_OBJECT: 0x704,
};

function* chunks(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const type = dv.getUint32(p, true);
    const raw = dv.getUint32(p + 4, true);
    const size = raw & 0x7fffffff;
    const s = p + 8;
    yield { type, start: s, end: Math.min(s + size, end) };
    p = s + size;
  }
}

function str(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) { const c = dv.getUint8(off + i); if (!c) break; s += String.fromCharCode(c); }
  return s;
}
const bytes = (dv, a, b) => dv.buffer.slice(dv.byteOffset + a, dv.byteOffset + a + ((b - a) & ~3));
const f32 = (dv, a, b) => new Float32Array(bytes(dv, a, b));
const u32 = (dv, a, b) => new Uint32Array(bytes(dv, a, b));

function parseMesh(dv, start, end) {
  const m = { name: '', container: '', attributes: 0, vertices: null, normals: null, uvs: null,
              indices: null, influences: null, textures: [], textureIds: null,
              shaders: [], shaderIds: null, vertexMaterials: [], vertexMaterialIds: null, dcg: null, passes: [] };
  for (const c of chunks(dv, start, end)) {
    switch (c.type) {
      case T.MESH_HEADER3:
        m.attributes = dv.getUint32(c.start + 4, true);
        m.name = str(dv, c.start + 8, 16);
        m.container = str(dv, c.start + 24, 16);
        break;
      case T.VERTICES: m.vertices = f32(dv, c.start, c.end); break;
      case T.VERTEX_NORMALS: m.normals = f32(dv, c.start, c.end); break;
      case T.TRIANGLES: { // 32 octets / triangle : 3 indices u32, attributs, normale, distance
        const n = Math.floor((c.end - c.start) / 32);
        m.indices = new Uint32Array(n * 3);
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m.indices[i * 3 + k] = dv.getUint32(c.start + i * 32 + k * 4, true);
        break;
      }
      case T.VERTEX_INFLUENCES: { // 8 octets / sommet : os (u16) + padding
        const n = Math.floor((c.end - c.start) / 8);
        m.influences = new Uint16Array(n);
        for (let i = 0; i < n; i++) m.influences[i] = dv.getUint16(c.start + i * 8, true);
        break;
      }
      case T.SHADERS: { // 16 octets / shader (W3dShaderStruct)
        const n = Math.floor((c.end - c.start) / 16);
        for (let i = 0; i < n; i++) {
          const o = c.start + i * 16, b = k => dv.getUint8(o + k);
          m.shaders.push({ depthMask: b(1), destBlend: b(3), priGradient: b(5), srcBlend: b(7), texturing: b(8), alphaTest: b(12) });
        }
        break;
      }
      case T.VERTEX_MATERIALS:
        for (const vm of chunks(dv, c.start, c.end)) if (vm.type === T.VERTEX_MATERIAL) {
          const mat = { name: '', opacity: 1, diffuse: [255, 255, 255] };
          for (const x of chunks(dv, vm.start, vm.end)) {
            if (x.type === T.VERTEX_MATERIAL_NAME) mat.name = str(dv, x.start, x.end - x.start);
            if (x.type === T.VERTEX_MATERIAL_INFO) { // attributs u32, ambient/diffuse/specular/emissive (RGBA), brillance, opacité, translucidité
              mat.diffuse = [dv.getUint8(x.start + 8), dv.getUint8(x.start + 9), dv.getUint8(x.start + 10)];
              mat.opacity = dv.getFloat32(x.start + 24, true);
            }
          }
          m.vertexMaterials.push(mat);
        }
        break;
      case T.TEXTURES:
        for (const t of chunks(dv, c.start, c.end)) if (t.type === T.TEXTURE)
          for (const n of chunks(dv, t.start, t.end)) if (n.type === T.TEXTURE_NAME) m.textures.push(str(dv, n.start, n.end - n.start));
        break;
      case T.MATERIAL_PASS: { // la 1re passe donne le matériau principal ; les suivantes (calques) sont gardées dans `passes`
        const first = !m.passSeen; m.passSeen = true;
        const pass = { shaderIds: null, vertexMaterialIds: null, dcg: null, stages: [] };
        for (const st of chunks(dv, c.start, c.end)) {
          if (st.type === T.TEXTURE_STAGE) {
            const stage = { textureIds: null, uvs: null };
            for (const x of chunks(dv, st.start, st.end)) {
              if (x.type === T.STAGE_TEXCOORDS) { stage.uvs = f32(dv, x.start, x.end); if (!m.uvs) m.uvs = stage.uvs; }
              if (x.type === T.TEXTURE_IDS) { stage.textureIds = u32(dv, x.start, x.end); if (!m.textureIds) m.textureIds = stage.textureIds; }
            }
            pass.stages.push(stage);
          } else if (st.type === T.SHADER_IDS) pass.shaderIds = u32(dv, st.start, st.end);
          else if (st.type === T.VERTEX_MATERIAL_IDS) pass.vertexMaterialIds = u32(dv, st.start, st.end);
          else if (st.type === T.DCG) pass.dcg = new Uint8Array(bytes(dv, st.start, st.end)); // RGBA par sommet
        }
        if (first) { m.shaderIds = pass.shaderIds; m.vertexMaterialIds = pass.vertexMaterialIds; m.dcg = pass.dcg; }
        m.passes.push(pass);
        break;
      }
    }
  }
  return m;
}

function parseHierarchy(dv, start, end) {
  const h = { name: '', pivots: [] };
  for (const c of chunks(dv, start, end)) {
    if (c.type === T.HIERARCHY_HEADER) h.name = str(dv, c.start + 4, 16);
    if (c.type === T.PIVOTS) {
      const n = Math.floor((c.end - c.start) / 60);
      for (let i = 0; i < n; i++) {
        const o = c.start + i * 60;
        const parent = dv.getUint32(o + 16, true);
        h.pivots.push({
          name: str(dv, o, 16),
          parent: parent === 0xffffffff ? -1 : parent,
          translation: [0, 1, 2].map(k => dv.getFloat32(o + 20 + k * 4, true)),
          rotation: [0, 1, 2, 3].map(k => dv.getFloat32(o + 44 + k * 4, true)), // x y z w
        });
      }
    }
  }
  return h;
}

function parseHlod(dv, start, end) {
  const h = { name: '', hierarchyName: '', lods: [] };
  for (const c of chunks(dv, start, end)) {
    if (c.type === T.HLOD_HEADER) { h.name = str(dv, c.start + 8, 16); h.hierarchyName = str(dv, c.start + 24, 16); }
    if (c.type === T.HLOD_LOD_ARRAY) {
      const lod = { maxScreenSize: 0, subObjects: [] };
      for (const x of chunks(dv, c.start, c.end)) {
        if (x.type === T.HLOD_LOD_ARRAY_HEADER) lod.maxScreenSize = dv.getFloat32(x.start + 4, true);
        if (x.type === T.HLOD_SUB_OBJECT) lod.subObjects.push({ bone: dv.getUint32(x.start, true), name: str(dv, x.start + 4, 32) });
      }
      h.lods.push(lod);
    }
  }
  return h;
}

// ---------- Animations (squelette) ----------
// Une animation = des canaux par pivot (os) : translation X/Y/Z (types 0/1/2) ou quaternion (type 6).
// Valeurs absolues dans le repère du parent (elles remplacent la pose de repos de l'os).
const CH_TYPES = { 0: 'X', 1: 'Y', 2: 'Z', 6: 'Q' };

// Animation non compressée : un canal = une valeur (ou un vecteur) par image.
function parseAnimation(dv, start, end) {
  const a = { name: '', hierarchy: '', numFrames: 0, frameRate: 30, channels: [], skipped: 0, vis: [] };
  for (const c of chunks(dv, start, end)) {
    if (c.type === T.ANIMATION_HEADER) {
      a.name = str(dv, c.start + 4, 16); a.hierarchy = str(dv, c.start + 20, 16);
      a.numFrames = dv.getUint32(c.start + 36, true); a.frameRate = dv.getUint32(c.start + 40, true) || 30;
    } else if (c.type === T.ANIMATION_CHANNEL) {
      const first = dv.getUint16(c.start, true), last = dv.getUint16(c.start + 2, true);
      const len = dv.getUint16(c.start + 4, true), flags = dv.getUint16(c.start + 6, true), pivot = dv.getUint16(c.start + 8, true);
      const type = CH_TYPES[flags];
      if (!type || !len) { a.skipped++; continue; }
      const keys = [];
      for (let f = first; f <= last; f++) {
        const o = c.start + 12 + (f - first) * len * 4;
        keys.push({ t: f, v: Array.from({ length: len }, (_, k) => dv.getFloat32(o + k * 4, true)) });
      }
      a.channels.push({ pivot, type, keys });
    }
    else if (c.type === T.BIT_CHANNEL) { // W3dBitChannelStruct : First u16 | Last u16 | Flags u16 | Pivot u16 | DefaultVal u8 | bits (1 par image)
      const first = dv.getUint16(c.start, true), last = dv.getUint16(c.start + 2, true), pivot = dv.getUint16(c.start + 6, true), def = dv.getUint8(c.start + 8), keys = [];
      let prev = -1;
      for (let f = first; f <= last; f++) { const k = f - first, bit = (dv.getUint8(c.start + 9 + (k >> 3)) >> (k & 7)) & 1; if (bit !== prev) { keys.push({ t: f, v: bit }); prev = bit; } }
      if (keys.length) a.vis.push({ pivot, def, keys });
    }
  }
  return a;
}

// Animation compressée. Le Flavor de l'en-tête (u16 à +42) décide du format de TOUS les canaux 0x282 :
//   0 = "time coded"   : images clés [code temps u32 (bit 31 = pas d'interpolation), valeurs f32...]
//   1 = "adaptive delta": une valeur de départ puis des deltas sur 4 bits, par blocs de 16 images
// Les canaux 0x283 sont des canaux de bits (visibilité de sous-objets) : comptés dans `bitChannels`, pas décodés.
// Source : w3d_file.h (W3dAdaptiveDeltaAnimChannelStruct) et motchan.cpp (AdaptiveDeltaMotionChannelClass).
const FLAVOR_TIMECODED = 0, FLAVOR_ADAPTIVE_DELTA = 1;

// Table des filtres : 16 puissances de 10 (1e-8 .. 1e7) puis 240 valeurs 1 - sin(90° * i / 240).
const FILTER_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 16; i++) t[i] = Math.fround(10 ** (i - 8));
  for (let i = 0; i < 240; i++) t[16 + i] = Math.fround(1 - Math.sin((Math.PI / 2) * (i / 240)));
  return t;
})();

// Décode un canal adaptive delta -> une clé par image { t, v:[...] }.
// Disposition des données : VectorLen floats (image 0), puis pour chaque bloc de 16 images et chaque
// composante, un paquet de 9 octets = 1 octet d'indice de filtre + 16 quartets signés (octet bas d'abord).
export function decodeAdaptiveDelta(dv, start, end, numFrames, vectorLen, scale) {
  const keys = [];
  const vals = new Float32Array(vectorLen);
  for (let k = 0; k < vectorLen; k++) vals[k] = dv.getFloat32(start + k * 4, true);
  keys.push({ t: 0, v: Array.from(vals) });
  const packets = start + vectorLen * 4;
  for (let f = 1; f < numFrames; f++) {
    const block = (f - 1) >> 4, nib = (f - 1) & 15;
    for (let k = 0; k < vectorLen; k++) {
      const p = packets + (block * vectorLen + k) * 9;
      if (p + 9 > end) { vals[k] = keys[f - 1].v[k]; continue; } // données tronquées : on garde la dernière valeur
      const filter = FILTER_TABLE[dv.getUint8(p)] * scale;
      const byte = dv.getUint8(p + 1 + (nib >> 1));
      let q = (nib & 1) ? byte >> 4 : byte & 15;
      if (q & 8) q -= 16;
      vals[k] = Math.fround(vals[k] + q * filter);
    }
    keys.push({ t: f, v: Array.from(vals) });
  }
  return keys;
}

function parseCompressedAnimation(dv, start, end) {
  const a = { name: '', hierarchy: '', numFrames: 0, frameRate: 30, flavor: 0, channels: [], skipped: 0, bitChannels: 0, vis: [] };
  for (const c of chunks(dv, start, end)) {
    if (c.type === T.COMPRESSED_ANIMATION_HEADER) {
      a.name = str(dv, c.start + 4, 16); a.hierarchy = str(dv, c.start + 20, 16);
      a.numFrames = dv.getUint32(c.start + 36, true); a.frameRate = dv.getUint16(c.start + 40, true) || 30;
      a.flavor = dv.getUint16(c.start + 42, true);
    } else if (c.type === T.COMPRESSED_ANIMATION_CHANNEL) {
      if (a.flavor === FLAVOR_ADAPTIVE_DELTA) {
        // NumFrames u32 | Pivot u16 | VectorLen u8 | Flags u8 | Scale f32 | données
        const n = dv.getUint32(c.start, true), pivot = dv.getUint16(c.start + 4, true);
        const len = dv.getUint8(c.start + 6), type = CH_TYPES[dv.getUint8(c.start + 7)];
        const scale = dv.getFloat32(c.start + 8, true);
        if (!type || !len || !n) { a.skipped++; continue; }
        a.channels.push({ pivot, type, keys: decodeAdaptiveDelta(dv, c.start + 12, c.end, n, len, scale) });
      } else {
        // NumTimeCodes u32 | Pivot u16 | VectorLen u8 | Flags u8 | [code u32, valeurs f32...] * N
        const n = dv.getUint32(c.start, true), pivot = dv.getUint16(c.start + 4, true);
        const len = dv.getUint8(c.start + 6), type = CH_TYPES[dv.getUint8(c.start + 7)];
        if (!type || !len || !n) { a.skipped++; continue; }
        const keys = [];
        for (let i = 0; i < n; i++) {
          const o = c.start + 8 + i * (len + 1) * 4, code = dv.getUint32(o, true);
          keys.push({ t: code & 0x7fffffff, step: !!(code & 0x80000000), v: Array.from({ length: len }, (_, k) => dv.getFloat32(o + 4 + k * 4, true)) });
        }
        a.channels.push({ pivot, type, keys });
      }
    } else if (c.type === T.COMPRESSED_ANIMATION_BIT_CHANNEL) {
      // Canal de visibilité (W3dTimeCodedBitChannelStruct) : NumTimeCodes u32 | Pivot u16 | Flags u8 | DefaultVal u8 | codes u32.
      // Chaque code : bit de poids fort = visible (1) ou non (0) à partir de l'image donnée par les 31 autres bits. (hcanim.cpp : Get_Visibility)
      a.bitChannels++;
      const n = dv.getUint32(c.start, true), pivot = dv.getUint16(c.start + 4, true), def = dv.getUint8(c.start + 7);
      const keys = [];
      for (let i = 0; i < n; i++) { const code = dv.getUint32(c.start + 8 + i * 4, true); keys.push({ t: code & 0x7fffffff, v: (code >>> 31) & 1 }); }
      if (keys.length) a.vis.push({ pivot, def, keys });
    }
  }
  return a;
}

export function parseW3D(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const out = { meshes: [], hierarchies: [], hlods: [], animations: [] };
  for (const c of chunks(dv, 0, dv.byteLength)) {
    if (c.type === T.MESH) out.meshes.push(parseMesh(dv, c.start, c.end));
    else if (c.type === T.HIERARCHY) out.hierarchies.push(parseHierarchy(dv, c.start, c.end));
    else if (c.type === T.HLOD) out.hlods.push(parseHlod(dv, c.start, c.end));
    else if (c.type === T.ANIMATION) out.animations.push(parseAnimation(dv, c.start, c.end));
    else if (c.type === T.COMPRESSED_ANIMATION) out.animations.push(parseCompressedAnimation(dv, c.start, c.end));
  }
  return out;
}

// Transformation monde (repère du modèle : Z haut, +X devant) de chaque pivot, par composition parent -> enfant.
// Rend { NOM_EN_MAJUSCULES: { pos: [x, y, z], yaw } } ; yaw = rotation autour de Z (Matrix3D::Get_Z_Rotation du moteur).
// Sert à lire les os "logiques" (parking, piste, point de sortie...) côté serveur, sans Three.js.
export function pivotWorld(h) {
  const mul = (a, b) => [ // quaternions [x, y, z, w] : a * b
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const rot = (q, v) => { // q * v
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  };
  const world = [], out = {};
  h.pivots.forEach((p, i) => {
    const par = p.parent >= 0 ? world[p.parent] : null;
    const t = par ? rot(par.q, p.translation).map((v, k) => v + par.pos[k]) : [...p.translation];
    const q = par ? mul(par.q, p.rotation) : [...p.rotation];
    world[i] = { pos: t, q };
    const [x, y, z, w] = q;
    out[p.name.toUpperCase()] = { pos: t, yaw: Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z)) };
  });
  return out;
}

// Niveau de détail le plus fin = plus grand MaxScreenSize.
export function chooseLod(hlod) {
  return hlod.lods.reduce((a, b) => (b.maxScreenSize > a.maxScreenSize ? b : a), hlod.lods[0]);
}
