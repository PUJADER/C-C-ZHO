// Textures du terrain d'une carte Generals : chaque case porte une tuile (BlendTileData) qui appartient à une « classe » de texture
// (TEDesert1, TEGrass2...). Les classes sont empilées dans une texture 2D en tableau, et un petit shader choisit, pour chaque pixel du relief,
// la tuile de sa case (et de ses 3 voisines, fondues entre elles pour adoucir les bords).
// Une tuile = 64×64 pixels de la texture de classe = 2×2 cases ; le quart (2 bits de poids faible de l'indice) dit lequel des 4 quarts va à la case.
import * as THREE from 'three';

// ---------- décodage des images ----------
export function decodeTga(buf) { // TGA non compressé (2/3) ou RLE (10/11), 8/24/32 bits -> ImageData
  const d = new Uint8Array(buf), type = d[2], w = d[12] | d[13] << 8, h = d[14] | d[15] << 8, bpp = d[16], desc = d[17];
  const bytes = bpp >> 3, rle = type >= 9, gray = type === 3 || type === 11;
  if (![2, 3, 10, 11].includes(type) || ![1, 3, 4].includes(bytes) || !w || !h) throw new Error('TGA non géré');
  const raw = new Uint8Array(w * h * bytes); let p = 18 + d[0] + (d[1] ? (d[5] | d[6] << 8) * (d[7] >> 3) : 0), o = 0;
  if (!rle) raw.set(d.subarray(p, p + raw.length));
  else while (o < raw.length && p < d.length) {
    const c = d[p++], n = (c & 127) + 1;
    if (c & 128) { for (let i = 0; i < n && o < raw.length; i++) for (let k = 0; k < bytes; k++) raw[o++] = d[p + k]; p += bytes; }
    else for (let i = 0; i < n * bytes && o < raw.length; i++) raw[o++] = d[p++];
  }
  const img = new ImageData(w, h), top = (desc & 0x20) !== 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((top ? y : h - 1 - y) * w + x) * bytes, t = (y * w + x) * 4;
    if (gray || bytes === 1) img.data[t] = img.data[t + 1] = img.data[t + 2] = raw[s];
    else { img.data[t] = raw[s + 2]; img.data[t + 1] = raw[s + 1]; img.data[t + 2] = raw[s]; }
    img.data[t + 3] = bytes === 4 ? raw[s + 3] : 255;
  }
  return img;
}

const c565 = v => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
export function decodeDds(buf) { // DDS : DXT1 / DXT3 / DXT5 et 24/32 bits non compressé (premier niveau seulement) -> ImageData
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('pas un DDS');
  const h = dv.getUint32(12, true), w = dv.getUint32(16, true), pfFlags = dv.getUint32(80, true), four = String.fromCharCode(...u8.subarray(84, 88)), bits = dv.getUint32(88, true);
  const img = new ImageData(w, h), out = img.data;
  if (pfFlags & 4) { // FOURCC : blocs 4×4
    const dxt = four === 'DXT1' ? 1 : four === 'DXT3' ? 3 : four === 'DXT5' ? 5 : 0;
    if (!dxt) throw new Error(`DDS ${four} non géré`);
    const bs = dxt === 1 ? 8 : 16; let p = 128;
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4, p += bs) {
      const q = dxt === 1 ? p : p + 8, c0 = dv.getUint16(q, true), c1 = dv.getUint16(q + 2, true), bitsC = dv.getUint32(q + 4, true);
      const a = c565(c0), b = c565(c1), pal = [a, b];
      if (c0 > c1 || dxt !== 1) { pal.push(a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)); }
      else { pal.push(a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]); }
      const alpha = new Uint8Array(16).fill(255);
      if (dxt === 3) for (let i = 0; i < 16; i++) alpha[i] = ((dv.getUint8(p + (i >> 1)) >> ((i & 1) * 4)) & 15) * 17;
      else if (dxt === 5) {
        const a0 = u8[p], a1 = u8[p + 1], tab = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) tab.push(((7 - i) * a0 + i * a1) / 7); else { for (let i = 1; i < 5; i++) tab.push(((5 - i) * a0 + i * a1) / 5); tab.push(0, 255); }
        let lo = 0n; for (let i = 0; i < 6; i++) lo |= BigInt(u8[p + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = tab[Number((lo >> BigInt(3 * i)) & 7n)];
      }
      for (let i = 0; i < 16; i++) {
        const x = bx + (i & 3), y = by + (i >> 2); if (x >= w || y >= h) continue;
        const c = pal[(bitsC >> (2 * i)) & 3], t = (y * w + x) * 4;
        out[t] = c[0]; out[t + 1] = c[1]; out[t + 2] = c[2]; out[t + 3] = alpha[i];
      }
    }
  } else if (bits === 32 || bits === 24) {
    const bpp = bits >> 3;
    for (let i = 0; i < w * h; i++) { const s = 128 + i * bpp; out[i * 4] = u8[s + 2]; out[i * 4 + 1] = u8[s + 1]; out[i * 4 + 2] = u8[s]; out[i * 4 + 3] = bpp === 4 ? u8[s + 3] : 255; }
  } else throw new Error('DDS non géré');
  return img;
}

async function loadClassImage(name) { // -> ImageData | null
  const r = await fetch(`/api/terrain-tex/${encodeURIComponent(name)}`);
  if (!r.ok) return null;
  const ext = r.headers.get('X-Tex-Ext'), buf = await r.arrayBuffer();
  try { return ext === 'dds' ? decodeDds(buf) : decodeTga(buf); } catch (e) { console.warn(`[terrain] ${name} illisible :`, e.message); return null; }
}

// ---------- shader ----------
const VERT_DECL = 'uniform vec4 uGrid;\nuniform vec2 uHalf;\nvarying vec2 vGP;\n';
const FRAG_DECL = `uniform vec4 uGrid;
uniform sampler2D uCells;
uniform highp sampler2DArray uTex;
uniform float uCW[64];
varying vec2 vGP;
`;
const FRAG_MAP = `
  { // texture du terrain : tuile de la case + fondu avec les 3 cases voisines
    vec2 p = vGP, dpx = dFdx(p), dpy = dFdy(p), q = p - 0.5, f = fract(q), loc = fract(p);
    ivec2 i0 = ivec2(floor(q)), lim = ivec2(int(uGrid.x) - 1, int(uGrid.y) - 1);
    vec3 acc = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2(k & 1, k >> 1);
      float wgt = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
      vec4 d = texelFetch(uCells, clamp(i0 + o, ivec2(0), lim), 0) * 255.0;
      float cls = floor(d.r + 0.5), tile = floor(d.g + 0.5), quad = floor(d.b + 0.5), w = uCW[int(cls)];
      vec2 uv = (vec2(mod(tile, w), floor(tile / w)) + vec2(mod(quad, 2.0), floor(quad / 2.0)) * 0.5 + loc * 0.5) / w;
      acc += wgt * textureGrad(uTex, vec3(uv, cls), dpx * 0.5 / w, dpy * 0.5 / w).rgb;
    }
    diffuseColor.rgb *= acc;
  }
`;

// Habille le maillage `terrain.mesh` avec les textures de la carte. Renvoie true si les textures sont en place.
export async function texturizeTerrain(terrain, map, W, H, B, shouldAbort = () => false) {
  const r = await fetch(`/api/map/${encodeURIComponent(map.id)}/tiles`);
  if (!r.ok) throw new Error(`tuiles indisponibles (${r.status})`);
  const info = await r.json();
  if (info.width !== W || info.height !== H) throw new Error('tuiles et relief de tailles différentes');
  const bin = atob(info.tiles), tiles = new Int16Array(W * H);
  for (let i = 0; i < tiles.length; i++) tiles[i] = (bin.charCodeAt(i * 2) | bin.charCodeAt(i * 2 + 1) << 8) << 16 >> 16;
  const classes = info.classes.slice(0, 64);

  const images = await Promise.all(classes.map(c => loadClassImage(c.name).catch(() => null)));
  if (shouldAbort()) return false;
  const found = images.filter(Boolean);
  if (!found.length) throw new Error(`aucune texture trouvée (${classes.slice(0, 4).map(c => c.name).join(', ')}...)`);
  const L = found.some(i => i.width > 256 || i.height > 256) ? 512 : 256;
  const layers = new Uint8Array(L * L * 4 * classes.length), cv = document.createElement('canvas'), tmp = document.createElement('canvas');
  cv.width = cv.height = L; const cx = cv.getContext('2d', { willReadFrequently: true }), tx = tmp.getContext('2d');
  classes.forEach((c, n) => {
    const img = images[n];
    if (img) { tmp.width = img.width; tmp.height = img.height; tx.putImageData(img, 0, 0); cx.clearRect(0, 0, L, L); cx.drawImage(tmp, 0, 0, L, L); layers.set(cx.getImageData(0, 0, L, L).data, n * L * L * 4); }
    else for (let i = 0; i < L * L; i++) layers.set([96, 112, 80, 255], n * L * L * 4 + i * 4); // texture manquante : vert terne
  });
  const tex = new THREE.DataArrayTexture(layers, L, L, classes.length);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType; tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;

  // case -> (classe, tuile dans la classe, quart)
  const cells = new Uint8Array(W * H * 4);
  for (let n = 0; n < W * H; n++) {
    const t = Math.max(0, tiles[n]), ndx = t >> info.shift, quad = info.shift ? t & 3 : 0;
    let ci = classes.findIndex(c => ndx >= c.first && ndx < c.first + c.num); if (ci < 0) ci = 0;
    cells[n * 4] = ci; cells[n * 4 + 1] = ndx - classes[ci].first; cells[n * 4 + 2] = quad; cells[n * 4 + 3] = 255;
  }
  const cellTex = new THREE.DataTexture(cells, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  cellTex.minFilter = cellTex.magFilter = THREE.NearestFilter; cellTex.needsUpdate = true;

  const widths = new Array(64).fill(1); classes.forEach((c, i) => { widths[i] = c.width; });
  const u = { uGrid: { value: new THREE.Vector4(W, H, B, terrain.cell) }, uHalf: { value: new THREE.Vector2(map.w / 2, map.h / 2) }, uCells: { value: cellTex }, uTex: { value: tex }, uCW: { value: widths } };
  const mat = terrain.mesh.material;
  mat.vertexColors = false;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vGP = vec2((position.x + uHalf.x) / uGrid.w + uGrid.z, (-position.z + uHalf.y) / uGrid.w + uGrid.z);`);
    sh.fragmentShader = FRAG_DECL + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_MAP);
  };
  mat.customProgramCacheKey = () => 'zho-terrain-tex';
  mat.needsUpdate = true;
  terrain.texInfo = { classes: classes.map((c, i) => `${c.name}${images[i] ? '' : ' (manquante)'}`), layer: L };
  return true;
}
