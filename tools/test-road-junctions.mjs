// Test hors ligne des raccords de routes : node tools/test-road-junctions.mjs <TRTwoLane*.tga>
// Vérifie, sur des nœuds synthétiques (T, Y, 4 branches, V) tournés dans tous les sens, que la pièce choisie colle et que les tracés réécrits finissent sur ses sorties.
import fs from 'node:fs';
import { roadChains } from '../client/features-core.js';
import { analyzeAtlas, usablePieces, planJunctions, applyJunctions } from '../client/road-atlas.js';
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
const src = fs.readFileSync(new URL('../client/terrain-tex.js', import.meta.url), 'utf8');
const m = /export function decodeTga[\s\S]*?\n}\n/.exec(src)[0].replace('export ', '');
const decodeTga = new Function('ImageData', m + '; return decodeTga;')(ImageData);
const buf = fs.readFileSync(process.argv[2]); const img = decodeTga(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const BH = 114, hw = 17.5, s = (2 * hw) / BH;
const pieces = usablePieces(analyzeAtlas(img, BH), BH);
console.log('pièces utilisables :', pieces.map(p => p.kind + p.arms.length).join(' '));
let bad = 0;
function rot(v, a) { return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)]; }
function test(name, dirsDeg, len = 200) {
  for (const base of [0, 0.7, 2.1, 4.0]) {
    const N = [1000 + base * 13, -500];
    const segs = dirsDeg.map(d => { const v = rot([1, 0], d * Math.PI / 180 + base); return { a: N, b: [N[0] + v[0] * len, N[1] + v[1] * len], fa: 0, fb: 0 }; });
    const chains = roadChains(segs, 2);
    const plans = planJunctions(chains.junctions, pieces, s, hw);
    if (!plans.length) { console.log(name, 'rot', base, '=> pas de pièce'); continue; }
    const p = plans[0], out = applyJunctions(chains, plans, hw);
    let ok = true;
    // chaque sortie : à ~1 demi-route du nœud, orientée selon sa branche à moins de 36°, et chaque tracé réécrit touche une sortie
    p.exits.forEach((e, j) => { const bd = p.J.dirs[j], cos = e.dx * bd[0] + e.dy * bd[1], dist = Math.hypot(e.x - N[0], e.y - N[1]); if (cos < Math.cos(36 * Math.PI / 180) || dist > 3 * hw) ok = false; });
    const ends = out.flatMap(c => [c.pts[0], c.pts[c.pts.length - 1]]).filter(q => q[3] === -1);
    if (ends.length !== dirsDeg.length) ok = false;
    for (const q of ends) if (!p.exits.some(e => Math.hypot(e.x - q[0], e.y - q[1]) < 1e-6)) ok = false;
    console.log(name, 'rot', base, p.piece.kind + p.piece.arms.length, 'f', p.f, 'erreur', (p.err * 180 / Math.PI).toFixed(1) + '°', 'chaînes', chains.length, '->', out.length, ok ? 'OK' : 'ÉCHEC');
    if (!ok) bad++;
  }
}
test('T 90°', [0, 180, 90]);
test('T 90° (autre côté)', [0, 180, -90]);
test('Y 45°', [0, 180, 45]);
test('Y 135°', [0, 180, 135]);
test('4 branches', [0, 90, 180, 270]);
test('V 90/136/136', [0, 88, 224]);
test('T bancal 70°', [0, 180, 70]);
test('angle trop faible 10°', [0, 180, 10]);
console.log(bad ? 'ÉCHECS : ' + bad : 'tout est bon');
