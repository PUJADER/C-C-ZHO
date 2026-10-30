// Relief d'une carte Generals : maillage à partir de HeightMapData + hauteur du sol en tout point (pour poser unités, bâtiments, curseur).
// Les coordonnées de jeu sont centrées sur la carte ; une carte trop grande est réduite d'un facteur k (distances ET hauteurs).
import * as THREE from 'three';

export const CELL = 10;            // taille d'une case de la carte (unités Generals)
export const HEIGHT_SCALE = 0.625; // unités par octet de hauteur (MAP_HEIGHT_SCALE de Generals : 10 / 16)

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// map : { w, h } = zone jouable déjà réduite ; W,H,B = largeur, hauteur et bordure de la grille (en cases) ; hs = 1 octet par case.
export function buildTerrain(map, W, H, B, hs) {
  const k = map.w / ((W - 2 * B) * CELL), cell = CELL * k, hk = HEIGHT_SCALE * k;
  const pos = new Float32Array(W * H * 3), col = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const n = j * W + i;
    pos[n * 3] = (i - B) * cell - map.w / 2; pos[n * 3 + 1] = hs[n] * hk; pos[n * 3 + 2] = -((j - B) * cell - map.h / 2);
  }
  const idx = new Uint32Array((W - 1) * (H - 1) * 6);
  let q = 0;
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c; // sens anti-horaire vu du dessus
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal.array, grass = new THREE.Color(0x3c5a36), dry = new THREE.Color(0x8c7c52), rock = new THREE.Color(0x6e6c66), c = new THREE.Color();
  let lo = 255, hi = 0; for (let n = 0; n < hs.length; n++) { if (hs[n] < lo) lo = hs[n]; if (hs[n] > hi) hi = hs[n]; }
  for (let n = 0; n < W * H; n++) { // couleur : herbe -> terre selon l'altitude, roche sur les fortes pentes
    const alt = hi > lo ? (hs[n] - lo) / (hi - lo) : 0;
    c.copy(grass).lerp(dry, smooth(0.15, 0.85, alt)).lerp(rock, smooth(0.1, 0.35, 1 - nrm[n * 3 + 1]));
    col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));

  // hauteur du sol au point de jeu (x, y) : interpolation bilinéaire
  const at = (x, y) => {
    const fx = Math.min(W - 1.001, Math.max(0, (x + map.w / 2) / cell + B)), fy = Math.min(H - 1.001, Math.max(0, (y + map.h / 2) / cell + B));
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, n = j * W + i;
    return lerp(lerp(hs[n], hs[n + 1], tx), lerp(hs[n + W], hs[n + W + 1], tx), ty) * hk;
  };

  // point où un rayon (origine o, direction d, repère Three) touche le relief : marche par pas d'une case puis dichotomie
  const hit = (o, d, out = new THREE.Vector3()) => {
    const h = t => o.y + d.y * t - at(o.x + d.x * t, -(o.z + d.z * t));
    let prev = 0, above = h(0) > 0;
    for (let t = cell; t <= 8000; t += cell) {
      const above2 = h(t) > 0;
      if (above && !above2) {
        let a = prev, b = t;
        for (let s = 0; s < 14; s++) { const m = (a + b) / 2; if (h(m) > 0) a = m; else b = m; }
        return out.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      above = above2; prev = t;
    }
    return null;
  };
  return { mesh, at, hit, cell, k };
}
