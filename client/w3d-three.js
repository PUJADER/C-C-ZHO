// Construit un THREE.Group à partir d'un W3D parsé + sa hiérarchie (squelette) :
//  - os (THREE.Bone) : les meshes rigides sont rattachés à leur os, les meshes "skin" sont skinnés ;
//  - animations (drapeaux, ventilateurs...) converties en AnimationClip ;
//  - shaders W3D (opaque / alpha / additif), textures par face, couleurs de sommets (dégradés) ;
//  - visibilité des sous-objets (INI + drapeaux W3D) ; muzzle flashes marqués pour le tir.
import * as THREE from 'three';
import { chooseLod } from '/shared/w3d.js';

// Bits de MESH_HEADER3.Attributes (valeurs de w3d_file.h, à confirmer avec le rapport du visualiseur)
const A_HIDDEN = 0x00001000;
const GEOM_MASK = 0x00FF0000, GEOM_AABOX = 0x00040000, GEOM_OBBOX = 0x00050000;

const flag = key => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
// Réglages de diagnostic : inversent l'orientation par défaut des textures.
export const texOptions = () => ({ invertV: flag('texInvertV'), mirrorU: flag('texMirrorU') });

// Mode de fusion d'un mesh à partir de son shader W3D et de son matériau de sommets.
function blendOf(mesh) {
  const sh = mesh.shaders[mesh.shaderIds?.[0] ?? 0];
  const vm = mesh.vertexMaterials[mesh.vertexMaterialIds?.[0] ?? 0];
  const o = { mode: 'opaque', alphaTest: false, depthWrite: true, textured: true, opacity: 1 };
  if (sh) {
    const { srcBlend: sb, destBlend: db } = sh; // src : 0 zéro, 1 un, 2 alpha, 3 1-alpha — dest : 0 zéro, 1 un, 2 couleur, 3 1-couleur, 4 alpha, 5 1-alpha
    if (db === 1 && (sb === 1 || sb === 2)) o.mode = 'add';
    else if (sb === 2 && db === 5) o.mode = 'alpha';
    else if (sb === 0 && db === 2) o.mode = 'mul';
    o.alphaTest = sh.alphaTest === 1;
    o.depthWrite = sh.depthMask !== 0;
    o.textured = sh.texturing !== 0;
  }
  if (vm && vm.opacity < 0.99) { o.opacity = Math.max(0.05, vm.opacity); if (o.mode === 'opaque') o.mode = 'alpha'; }
  return o;
}

function makeMaterial(b, hasVertexColors) {
  if (b.mode === 'opaque') {
    const m = new THREE.MeshStandardMaterial({
      color: 0xb0b0b0, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide,
      alphaTest: b.alphaTest ? 0.5 : 0, // l'alpha d'une texture opaque sert souvent d'autre chose (couleur d'équipe, brillance)
    });
    // Couleur d'équipe (HouseColor) : l'alpha de la texture sert de masque (alpha bas = zone à teinter).
    // Pas pour les matériaux à alpha-test : là l'alpha est une vraie transparence (grillages...).
    m.userData.house = !b.alphaTest;
    return m;
  }
  return new THREE.MeshBasicMaterial({ // effets : flammes, cônes de lumière, verre... non éclairés
    color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: b.opacity,
    depthWrite: b.mode === 'alpha' ? b.depthWrite : false,
    blending: b.mode === 'add' ? THREE.AdditiveBlending : b.mode === 'mul' ? THREE.MultiplyBlending : THREE.NormalBlending,
    vertexColors: hasVertexColors, alphaTest: b.alphaTest ? 0.05 : 0,
  });
}

// Couleur d'équipe, comme le moteur (W3DAssetManager::Recolor_Mesh) :
//  1. mesh dont le nom (après "Conteneur.") commence par HOUSECOLOR : matériau teinté de la couleur d'équipe ;
//  2. texture dont le nom commence par ZHC : 4e lettre A = la teinte (HSV) est remplacée là où l'alpha < 1,
//     4e lettre D = les 16 pixels de palette de la 1re ligne sont remplacés par un dégradé de la couleur.
// Tout le reste n'est pas recoloré (l'alpha d'une texture ordinaire ne sert pas à ça).
export const zhcMode = name => {
  const n = (name ?? '').replace(/\.[^.]+$/, '');
  const c = /^zhc/i.test(n) ? n[3]?.toUpperCase() : null;
  return c === 'A' || c === 'D' ? c : null;
};
export const isHouseMesh = label => /^HOUSECOLOR/i.test(String(label).split('#')[0].split('.').pop());

const HOUSE_SCALE = [255, 239, 223, 211, 195, 174, 167, 151, 135, 123, 107, 91, 79, 63, 47, 35];
const palCache = new Map();
// Copie de la texture dont la palette (16 pixels du haut de l'image) est remplacée par le dégradé de `hex`.
// Impossible sur une texture compressée (DDS) : on la rend telle quelle.
function recolorPalette(tex, hex) {
  const d = tex.image?.data;
  if (tex.isCompressedTexture || !d || !tex.image.width) return tex;
  const key = `${tex.uuid}:${hex}`;
  if (palCache.has(key)) return palCache.get(key);
  const { width: w, height: h } = tex.image;
  const data = new Uint8Array(d);
  const ch = data.length / (w * h);                       // 3 ou 4 octets par pixel
  const row = tex.flipY ? 0 : h - 1;                      // ligne du haut de l'image
  const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  for (let i = 0; i < 16 && i < w; i++) {
    const o = (row * w + i) * ch;
    for (let k = 0; k < 3; k++) data[o + k] = Math.round(rgb[k] * HOUSE_SCALE[i] / 255);
  }
  const t = new THREE.DataTexture(data, w, h, ch === 4 ? THREE.RGBAFormat : THREE.RGBFormat);
  t.flipY = tex.flipY; t.generateMipmaps = tex.generateMipmaps; t.minFilter = tex.minFilter; t.magFilter = tex.magFilter;
  t.colorSpace = tex.colorSpace; t.wrapS = tex.wrapS; t.wrapT = tex.wrapT; t.repeat.copy(tex.repeat); t.offset.copy(tex.offset);
  t.needsUpdate = true;
  palCache.set(key, t);
  return t;
}

function applyTexture(mat, tex, b, texName) {
  if (!tex) return;
  const opt = texOptions();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Constaté à l'écran : les V des meshes W3D sont "à l'OpenGL" (V = 1 en haut de l'image).
  //  - TGA (flipY vrai, comme une image web, haut de l'image à V = 1) : aucune correction ;
  //  - DDS compressé (flipY faux, première ligne = haut à V = 0)      : on retourne V.
  const flipV = tex.isCompressedTexture !== opt.invertV;
  tex.repeat.set(opt.mirrorU ? -1 : 1, flipV ? -1 : 1);
  tex.offset.set(opt.mirrorU ? 1 : 0, flipV ? 1 : 0);
  const mode = zhcMode(texName);
  const targets = [mat, ...(mat._houseClones ?? [])]; // + copies par instance (couleur d'équipe)
  for (const m of targets) {
    m.userData.zhc = mode;
    m.map = mode === 'D' && m.userData.houseHex !== undefined ? recolorPalette(tex, m.userData.houseHex) : tex;
    if (b.mode === 'opaque' && !m.userData.keepColor) m.color.set(0xffffff);
    m.needsUpdate = true;
  }
}

// ---------- couleur d'équipe : application à une instance ----------
const rgbToHsv = hex => {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx > 0 ? d / mx : 0, mx];
};

const HOUSE_GLSL = `
vec3 hcRgb2Hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)),d/(q.x+1e-10),q.x); }
vec3 hcHsv2Rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
`;

// Donne à chaque instance ses propres matériaux, recolorés par `colorHex`. Réglage de diagnostic :
// localStorage.houseAll = '1' applique la teinte (alpha) à TOUTES les textures opaques, pas seulement ZHCA*.
export function applyHouseColor(inst, colorHex) {
  const all = flag('houseAll') ? 1 : 0;
  const [hue, sat] = rgbToHsv(colorHex);
  const color = new THREE.Color(colorHex);
  const own = [];
  const clone = src => { const m = src.clone(); (src._houseClones ??= []).push(m); m.userData.houseHex = colorHex;
    if (m.userData.zhc === 'D' && m.map) m.map = recolorPalette(m.map, colorHex); // texture déjà chargée (modèle en cache)
    own.push(m); return m; };
  const alphaTint = src => {
    if (!src.userData.house) return src;
    const m = clone(src);
    m.onBeforeCompile = sh => {
      sh.uniforms.houseOn = { value: m.userData.zhc === 'A' || all ? 1 : 0 };
      sh.uniforms.houseHS = { value: new THREE.Vector2(hue, sat) };
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', `uniform float houseOn;\nuniform vec2 houseHS;\n${HOUSE_GLSL}\nvoid main() {`)
        .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  if (houseOn > 0.5) { // le moteur : teinte = celle de l'équipe, saturation x celle de l'équipe, valeur inchangée
    float hcM = 1.0 - smoothstep(0.9, 0.998, diffuseColor.a);
    vec3 hcHsv = hcRgb2Hsv(pow(max(diffuseColor.rgb, 0.0), vec3(1.0 / 2.2)));
    hcHsv.x = houseHS.x; hcHsv.y *= houseHS.y;
    diffuseColor.rgb = mix(diffuseColor.rgb, pow(hcHsv2Rgb(hcHsv), vec3(2.2)), hcM);
  }
#endif`);
    };
    m.customProgramCacheKey = () => `house2-${all}`;
    return m;
  };
  const flatTint = src => { // mesh HOUSECOLOR : ambiant/diffuse = couleur d'équipe
    const m = clone(src);
    m.userData.keepColor = true; m.color.copy(color);
    return m;
  };
  inst.traverse(o => {
    if (!o.isMesh) return;
    const f = isHouseMesh(o.name) ? flatTint : alphaTint;
    o.material = Array.isArray(o.material) ? o.material.map(f) : f(o.material);
  });
  return own;
}

// ---------- animations ----------
function sampleScalar(keys, f) {
  if (f <= keys[0].t) return keys[0].v[0];
  for (let i = 1; i < keys.length; i++) {
    if (f <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      if (a.step) return a.v[0];
      return a.v[0] + (b.v[0] - a.v[0]) * (f - a.t) / Math.max(1e-6, b.t - a.t);
    }
  }
  return keys[keys.length - 1].v[0];
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleQuat(keys, f, out) {
  const last = keys[keys.length - 1];
  if (f <= keys[0].t) return out.fromArray(keys[0].v);
  if (f >= last.t) return out.fromArray(last.v);
  for (let i = 1; i < keys.length; i++) {
    if (f <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      if (a.step) return out.fromArray(a.v);
      _qa.fromArray(a.v); _qb.fromArray(b.v);
      return out.slerpQuaternions(_qa, _qb, (f - a.t) / Math.max(1e-6, b.t - a.t));
    }
  }
  return out.fromArray(last.v);
}

// Les canaux W3D sont des décalages appliqués PAR-DESSUS la pose de repos de l'os, pas des poses absolues
// (HTreeClass::Anim_Update du moteur) : Transform = Parent * Base * Translate(t) * Rotate(q).
// Donc position = base.t + base.q * t  et  rotation = base.q * q. Le pivot 0 (racine) n'est jamais animé.
function buildClip(anim, hierarchy, prefix = '', holders = new Set()) {
  const n = Math.max(2, anim.numFrames), rate = anim.frameRate || 30;
  const times = Float32Array.from({ length: n }, (_, f) => f / rate);
  const byPivot = new Map();
  for (const ch of anim.channels) { if (ch.pivot < 1) continue; if (!byPivot.has(ch.pivot)) byPivot.set(ch.pivot, []); byPivot.get(ch.pivot).push(ch); }

  const tracks = [], q = new THREE.Quaternion(), qb = new THREE.Quaternion(), t = new THREE.Vector3();
  for (const [pivot, chans] of byPivot) {
    const rest = hierarchy.pivots[pivot];
    if (!rest) continue;
    qb.set(...rest.rotation);
    const trans = chans.filter(c => c.type !== 'Q'), rot = chans.find(c => c.type === 'Q');
    if (trans.length) {
      const vals = new Float32Array(n * 3);
      for (let f = 0; f < n; f++) {
        t.set(0, 0, 0);
        for (const c of trans) t.setComponent('XYZ'.indexOf(c.type), sampleScalar(c.keys, f));
        t.applyQuaternion(qb).add(new THREE.Vector3(...rest.translation)).toArray(vals, f * 3);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${prefix}b${pivot}.position`, times, vals));
    }
    if (rot) {
      const vals = new Float32Array(n * 4);
      for (let f = 0; f < n; f++) { sampleQuat(rot.keys, f, q); q.premultiply(qb).normalize().toArray(vals, f * 4); }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${prefix}b${pivot}.quaternion`, times, vals));
    }
  }
  // Canaux de visibilité (hcanim.cpp : Get_Visibility) : le sous-objet porté par le pivot apparaît / disparaît selon l'image. La cible est le
  // conteneur `v<pivot>` des maillages rigides de ce pivot (et non l'os : masquer l'os masquerait aussi tous ses os enfants).
  for (const v of anim.vis ?? []) {
    if (!holders.has(v.pivot)) continue;
    const tt = [], vv = [];
    v.keys.forEach((k, i) => { const t = i === 0 ? 0 : k.t / rate; if (tt.length && t <= tt[tt.length - 1]) return; tt.push(t); vv.push(!!k.v); });
    tracks.push(new THREE.BooleanKeyframeTrack(`${prefix}v${v.pivot}.visible`, tt, vv));
  }
  return new THREE.AnimationClip(anim.name, n / rate, tracks);
}

// opts : { hide, show, muzzle, auto } (noms de sous-objets issus de l'INI)
//        { stateAnims } (animations par état : voir plus bas ; celles du fichier modèle s'y ajoutent)
export function buildModel(parsed, hierarchy, loadTexture, opts = {}) {
  const up = l => new Set((l ?? []).map(x => x.toUpperCase()));
  const hideSet = up(opts.hide), showSet = up(opts.show), muzzleSet = up(opts.muzzle), autoSet = up(opts.auto);

  // --- os : un THREE.Bone par pivot (noms b0, b1... : les pistes d'animation les retrouvent par ce nom) ---
  const group = new THREE.Group();
  const bones = [], holders = new Map(); // holders : pivot -> conteneur des maillages rigides de ce pivot
  if (hierarchy) {
    hierarchy.pivots.forEach((p, i) => {
      const b = new THREE.Bone();
      b.name = `${opts.prefix ?? ''}b${i}`; b.userData.pivot = p.name;
      b.position.set(...p.translation); b.quaternion.set(...p.rotation);
      bones.push(b);
    });
    hierarchy.pivots.forEach((p, i) => (p.parent >= 0 && bones[p.parent] ? bones[p.parent] : group).add(bones[i]));
  }
  group.updateMatrixWorld(true);
  const world = bones.map(b => b.matrixWorld.clone()); // pose de repos
  const skeleton = bones.length ? new THREE.Skeleton(bones) : null;

  const byName = new Map(parsed.meshes.map(m => [`${m.container}.${m.name}`.toLowerCase(), m]));
  const hlod = parsed.hlods[0];
  const placements = hlod
    ? chooseLod(hlod).subObjects.map(s => ({ mesh: byName.get(s.name.toLowerCase()), bone: s.bone, label: s.name }))
    : parsed.meshes.map(m => ({ mesh: m, bone: 0, label: m.name }));

  // Garde-fou : si les drapeaux W3D masquaient plus de la moitié du modèle, on les ignore (bit mal interprété).
  const flagged = placements.filter(p => p.mesh && ((p.mesh.attributes & A_HIDDEN) || [GEOM_AABOX, GEOM_OBBOX].includes(p.mesh.attributes & GEOM_MASK))).length;
  const useFlags = flagged <= placements.length / 2;

  const info = { placed: [], missing: [], hidden: [], textures: new Set(), meshes: [], bones: bones.length, clip: null, clips: {}, animNote: '', rotors: [] };
  for (const { mesh, bone, label } of placements) {
    if (!mesh || !mesh.vertices || !mesh.indices) { info.missing.push(label); continue; }

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(mesh.vertices);
    const nor = mesh.normals ? new Float32Array(mesh.normals) : null;
    const nv = pos.length / 3;
    const skinned = !!(mesh.influences && skeleton && mesh.influences.length >= nv);
    if (skinned) {
      // sommets en repère local de leur os : on les place en pose de repos, puis on skinne (poids 1 sur un os)
      const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
      const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
      for (let i = 0; i < nv; i++) {
        const bi = mesh.influences[i] < bones.length ? mesh.influences[i] : 0, M = world[bi];
        v.fromArray(pos, i * 3).applyMatrix4(M).toArray(pos, i * 3);
        if (nor) { nm.getNormalMatrix(M); n.fromArray(nor, i * 3).applyMatrix3(nm).normalize().toArray(nor, i * 3); }
        si[i * 4] = bi; sw[i * 4] = 1;
      }
      geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (mesh.uvs && mesh.uvs.length / 2 === nv) geo.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));

    const b = blendOf(mesh);
    const hasDcg = !!mesh.dcg && mesh.dcg.length / 4 === nv && b.mode !== 'opaque' && b.mode !== 'mul';
    if (hasDcg) { // dégradés de couleur et d'alpha par sommet (cônes de phares, flammes)
      const col = new Float32Array(nv * 4);
      for (let i = 0; i < nv * 4; i++) col[i] = mesh.dcg[i] / 255;
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    }

    // Textures par face : un matériau par texture utilisée (le W3D en met plusieurs sur un même mesh).
    const nTri = mesh.indices.length / 3, ids = mesh.textureIds;
    const perFace = ids && ids.length === nTri && new Set(ids).size > 1;
    let materials, texNames = [];
    if (perFace) {
      const order = [...Array(nTri).keys()].sort((a, c) => ids[a] - ids[c]);
      const index = new Uint32Array(mesh.indices.length);
      order.forEach((tri, k) => { for (let j = 0; j < 3; j++) index[k * 3 + j] = mesh.indices[tri * 3 + j]; });
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      materials = []; let start = 0;
      for (const id of [...new Set(order.map(t => ids[t]))]) {
        const count = order.filter(t => ids[t] === id).length * 3;
        geo.addGroup(start, count, materials.length); start += count;
        materials.push(makeMaterial(b, hasDcg)); texNames.push(mesh.textures[id]);
      }
    } else {
      geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      materials = [makeMaterial(b, hasDcg)];
      texNames = [mesh.textures[ids?.[0] ?? 0] ?? mesh.textures[0]];
    }
    if (!nor) geo.computeVertexNormals();

    materials.forEach((mat, i) => {
      const name = b.textured ? texNames[i] : null;
      if (!name) return;
      info.textures.add(name);
      loadTexture(name).then(tex => applyTexture(mat, tex, b, name)).catch(() => {});
    });

    const mats = perFace ? materials : materials[0];
    const m = skinned ? new THREE.SkinnedMesh(geo, mats) : new THREE.Mesh(geo, mats);
    m.name = label;
    if (skinned) { m.frustumCulled = false; group.add(m); m.updateMatrixWorld(true); m.bind(skeleton); }
    else { // mesh rigide : suit son os (donc l'animation), dans un conteneur propre au pivot (cible des canaux de visibilité)
      if (bones[bone] && !holders.has(bone)) { const h = new THREE.Group(); h.name = `${opts.prefix ?? ''}v${bone}`; bones[bone].add(h); holders.set(bone, h); }
      (holders.get(bone) ?? group).add(m);
    }

    // Passes de matériau supplémentaires (drapeau + emblème, calques de détail...) : chacune est dessinée comme un
    // calque par-dessus le mesh, avec sa texture, ses UV et son shader. Enfant du mesh : il en suit la visibilité et l'os.
    const hasTex = p => p.stages.find(s => s.uvs && s.textureIds && s.uvs.length / 2 === nv);
    let baseIdx = mesh.passes.findIndex(hasTex); if (baseIdx < 0) baseIdx = 0;
    let overlays = 0;
    mesh.passes.forEach((pass, pi) => {
      const stage = pi > baseIdx ? hasTex(pass) : null;
      const texName = stage ? mesh.textures[stage.textureIds[0]] : null;
      if (!stage || !texName) return;
      const ob = blendOf({ shaders: mesh.shaders, shaderIds: pass.shaderIds, vertexMaterials: mesh.vertexMaterials, vertexMaterialIds: pass.vertexMaterialIds });
      if (ob.mode === 'opaque') ob.mode = 'alpha'; // un calque se superpose : on le traite comme tel
      const dcg2 = !!pass.dcg && pass.dcg.length / 4 === nv && ob.mode !== 'mul';
      const g2 = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'skinIndex', 'skinWeight']) if (geo.getAttribute(k)) g2.setAttribute(k, geo.getAttribute(k));
      g2.setAttribute('uv', new THREE.BufferAttribute(stage.uvs, 2));
      g2.setIndex(new THREE.BufferAttribute(mesh.indices, 1)); // ordre d'origine des triangles
      if (dcg2) { const col = new Float32Array(nv * 4); for (let i = 0; i < nv * 4; i++) col[i] = pass.dcg[i] / 255; g2.setAttribute('color', new THREE.BufferAttribute(col, 4)); }
      const mat2 = makeMaterial(ob, dcg2);
      mat2.polygonOffset = true; mat2.polygonOffsetFactor = -2; mat2.polygonOffsetUnits = -2; mat2.depthWrite = false;
      info.textures.add(texName);
      loadTexture(texName).then(tex => applyTexture(mat2, tex, ob, texName)).catch(() => {});
      const m2 = skinned ? new THREE.SkinnedMesh(g2, mat2) : new THREE.Mesh(g2, mat2);
      m2.name = `${label}#passe${pi}`; m2.frustumCulled = false;
      m.add(m2);
      if (skinned) { m.updateMatrixWorld(true); m2.bind(skeleton); }
      texNames.push(`${texName} (passe ${pi}, ${ob.mode})`); overlays++;
    });

    // Visibilité : INI d'abord (explicite), puis noms de muzzle flash, sous-objets que seul un autre état montre, drapeaux W3D.
    const short = label.split('.').pop().toUpperCase();
    let reason = '';
    if (!showSet.has(short)) {
      if (hideSet.has(short) || hideSet.has(label.toUpperCase())) reason = 'INI HideSubObject';
      else if (muzzleSet.has(short) || /MUZZLE/.test(short)) reason = 'muzzle flash';
      else if (autoSet.has(short)) reason = 'montré seulement par un autre état';
      else if (useFlags && (mesh.attributes & A_HIDDEN)) reason = 'drapeau W3D HIDDEN';
      else if (useFlags && [GEOM_AABOX, GEOM_OBBOX].includes(mesh.attributes & GEOM_MASK)) reason = 'boîte de collision';
    }
    if (muzzleSet.has(short) || /MUZZLE/.test(short)) m.userData.muzzle = true;
    if (reason) { m.visible = false; info.hidden.push(`${label} (${reason})`); }
    info.placed.push(label);
    info.meshes.push({
      label, object: m, attributes: mesh.attributes, verts: nv, tris: nTri, textures: texNames.filter(Boolean),
      blend: b.mode + (b.alphaTest ? '+test' : '') + (hasDcg ? '+couleurs' : '') + (b.textured ? '' : ' sans texture') + (perFace ? ' multi-textures' : '') + (skinned ? ' skin' : '') + (overlays ? ` +${overlays} passe(s)` : ''),
      reason,
    });
  }

  // --- animations demandées par l'INI : un clip par état (idle / move / attack), cf. opts.stateAnims ---
  // stateAnims : { idle: { animations, name, mode, speed }, move: {...}, attack: {...} }
  info.clips = {};
  if (hierarchy) {
    const notes = [];
    for (const [key, st] of Object.entries(opts.stateAnims ?? {})) {
      const all = [...(st.animations ?? []), ...parsed.animations];
      const want = (st.name ?? '').toUpperCase();
      const anim = all.find(x => x.name.toUpperCase() === want || x.name.toUpperCase().endsWith('.' + want)) ?? (st.animations?.[0] ?? null);
      if (anim && anim.channels.length) {
        const clip = buildClip(anim, hierarchy, opts.prefix ?? '', new Set(holders.keys()));
        info.clips[key] = { clip, mode: st.mode ?? 'LOOP', speed: st.speed ?? 1, door: st.door, start: st.start ?? null };
        notes.push(`${key} : ${anim.name} (${anim.numFrames} images, ${clip.tracks.length} pistes${anim.vis?.length ? `, dont ${clip.tracks.filter(t => t.name.endsWith('.visible')).length}/${anim.vis.length} de visibilité` : ''}${anim.skipped ? `, ${anim.skipped} canal(aux) illisible(s)` : ''})`);
      } else notes.push(`${key} : ${anim ? `${anim.name} : aucun canal décodé` : `animation "${st.name}" introuvable`}`);
    }
    info.animNote = notes.join(' ; ');
    info.clip = (info.clips.idle ?? Object.values(info.clips)[0])?.clip ?? null;
  }
  // Rotors d'hélicoptère : os dont le nom contient ROTOR (tournent autour de leur axe Z local)
  bones.forEach(bn => { if (/ROTOR/i.test(bn.userData.pivot)) info.rotors.push(bn.name); });

  return { group, info };
}
