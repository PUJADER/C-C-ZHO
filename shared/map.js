// Lecteur de cartes Generals / Zero Hour (.map, format "CkMp" par morceaux, éventuellement compressé RefPack).
// Lit : dimensions du terrain (HeightMapData) et points de départ (waypoints Player_N_Start de ObjectsList).
// Module partagé Node + navigateur. Ne lance jamais d'exception : les problèmes vont dans `errors`.
import { isEar, decompressEar } from './refpack.js';

export const CELL = 10; // taille d'une case de terrain, en unités de jeu

// Drapeaux d'un objet de carte (MapObject.h du moteur). Les routes et ponts sont des PAIRES d'objets : un point « 1 » puis un point « 2 »,
// dont le nom est celui d'un bloc Road / Bridge de Data\INI\Roads.ini.
export const FLAG = { MIRROR: 0x1, ROAD1: 0x2, ROAD2: 0x4, ROAD_ANGLED: 0x8, BRIDGE1: 0x10, BRIDGE2: 0x20, ROAD_TIGHT: 0x40, ROAD_JOIN: 0x80, NO_RENDER: 0x100 };

const latin1 = new TextDecoder('latin1');

class Reader {
  constructor(u8, p = 0, end = u8.length) { this.b = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = p; this.end = end; }
  get left() { return this.end - this.p; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  str(n) { const s = latin1.decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
}

// Dictionnaire de propriétés : u16 nb | { u32 (idClé << 8 | type), valeur }...
function readDict(r, names) {
  const out = {};
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const kt = r.u32(), type = kt & 0xFF, key = names.get(kt >>> 8) ?? `#${kt >>> 8}`;
    let v;
    if (type === 0) v = r.u8() !== 0;
    else if (type === 1) v = r.i32();
    else if (type === 2) v = r.f32();
    else if (type === 3) v = r.str(r.u16());
    else if (type === 4) { const len = r.u16(); r.p += len * 2; v = ''; }
    else throw new Error(`type de propriété inconnu (${type})`);
    out[key] = v;
  }
  return out;
}

// BlendTileData : une tuile (Int16) par case du terrain, puis la liste des « classes » de texture (nom, première tuile, nombre de tuiles, côté en tuiles).
// Les champs entre les tableaux et la liste des classes varient selon la version : on essaie les dispositions plausibles et on garde la première
// dont la liste de classes est cohérente (noms lisibles, tuiles consécutives, numTiles = côté²).
function readBlendTiles(b, start, end, ver, W, H) {
  const n = W * H;
  if (!(n > 0) || end - start < 4 + n * 4) return { error: 'BlendTileData trop court', version: ver, size: end - start, W, H };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getInt32(start, true) !== n) return { error: `BlendTileData : ${dv.getInt32(start, true)} cases au lieu de ${n}` };
  let p = start + 4;
  const tiles = new Int16Array(n); for (let i = 0; i < n; i++) tiles[i] = dv.getInt16(p + i * 2, true);
  p += n * 2;                                  // tuiles de base
  p += n * 2;                                  // tuiles de fondu
  if (ver >= 6) p += n * 2;                    // fondu supplémentaire
  if (ver >= 5) p += n * 2;                    // infos de falaise
  const fb = ((W + 7) >> 3) * H;               // états de falaise (1 bit par case)
  const tryAt = (o, withCliff) => {
    try {
      const r = new Reader(b, o, end);
      const nBitmap = r.i32(), nBlend = r.i32(); if (withCliff) r.i32();
      const nc = r.i32();
      if (nBitmap < 0 || nBitmap > 20000 || nBlend < 0 || nBlend > 200000 || nc < 1 || nc > 255) return null;
      const classes = []; let expect = 0;
      for (let i = 0; i < nc; i++) {
        const first = r.i32(), num = r.i32(), width = r.i32(); r.i32();
        const name = r.str(r.u16());
        if (first !== expect || width < 1 || width > 32 || num !== width * width || !/^[\w .-]{1,64}$/.test(name)) return null;
        expect += num; classes.push({ first, num, width, name });
      }
      return { classes, total: expect };
    } catch { return null; }
  };
  for (const skip of [0, fb, 2 * fb, 1]) for (const withCliff of [ver >= 5, ver < 5]) {
    const got = tryAt(p + skip, withCliff);
    if (got) {
      let mx = 0; for (let i = 0; i < n; i++) if (tiles[i] > mx) mx = tiles[i];
      const shift = (mx >> 2) < got.total ? 2 : 0; // tuile = (n° de tuile << 2) | quart de tuile 32×32
      return { version: ver, tiles, classes: got.classes, shift, layout: { skip, withCliff } };
    }
  }
  const hex = (a, n) => [...b.subarray(a, Math.min(end, a + n))].map(x => x.toString(16).padStart(2, '0')).join(' ');
  return { error: 'liste des classes de texture introuvable (format inattendu)', version: ver, size: end - start, W, H, arraysEnd: p - start, afterArrays: hex(p, 160), head: hex(start, 16) };
}

export function parseMap(input, { heights = false, objects = false, tiles = false } = {}) {
  const res = { ok: false, width: 0, height: 0, border: 0, w: 0, h: 0, starts: [], waypoints: 0, chunks: [], errors: [] };
  if (objects) { res.objects = []; res.roads = []; res.bridges = []; res.waypointList = []; res.waypointLinks = []; } // objets posés (hors waypoints) : { name, x, y, z, angle, flags } ; routes / ponts : paires de points
  const pend = { road: null, bridge: null }; // premier point d'une paire route / pont en attente de son partenaire
  try {
    let b = input;
    if (isEar(b)) b = decompressEar(b);
    const r = new Reader(b);
    if (r.str(4) !== 'CkMp') { res.errors.push('signature CkMp absente (format inconnu)'); return res; }
    const names = new Map();
    for (let n = r.u32(); n > 0; n--) { const len = r.u8(); const s = r.str(len); names.set(r.u32(), s); }

    while (r.left >= 10) {
      const id = r.u32(), ver = r.u16(), size = r.i32();
      const name = names.get(id) ?? `#${id}`, start = r.p, end = start + size;
      if (size < 0 || end > b.length) { res.errors.push(`morceau ${name} : taille invalide`); break; }
      res.chunks.push(`${name} v${ver} (${size} o)`);
      try {
        const c = new Reader(b, start, end);
        if (name === 'HeightMapData') {
          res.width = c.i32(); res.height = c.i32();
          res.border = ver >= 3 ? c.i32() : 0;
          if (ver >= 4) { for (let k = c.i32(); k > 0; k--) { c.i32(); c.i32(); } }
          const dataSize = c.i32();
          res.heightMap = { version: ver, dataSize, available: c.end - c.p, expected: res.width * res.height }; // pour diagnostiquer un fichier inattendu
          if (heights) res.heights = b.subarray(c.p, c.p + Math.max(0, Math.min(dataSize, c.end - c.p)));
          res.w = (res.width - 2 * res.border) * CELL; res.h = (res.height - 2 * res.border) * CELL;
        } else if (name === 'BlendTileData' && tiles) {
          res.blend = readBlendTiles(b, start, end, ver, res.width, res.height);
        } else if (name === 'WaypointsList' && objects) {
          for (let k = c.i32(); k > 0 && c.left >= 8; k--) res.waypointLinks.push([c.i32(), c.i32()]);
        } else if (name === 'ObjectsList') {
          while (c.left >= 10) {
            const oid = c.u32(), over = c.u16(), osz = c.i32(), oend = c.p + osz;
            if (osz < 0 || oend > c.end) break;
            if (names.get(oid) === 'Object') {
              const o = new Reader(b, c.p, oend);
              const x = o.f32(), y = o.f32(), z = o.f32(), angle = o.f32(), flags = o.i32();
              const tname = o.str(o.u16());
              let d = null;
              if (over >= 2) { try { d = readDict(o, names); } catch { /* dictionnaire illisible : l'objet reste utilisable sans */ } }
              if (!/waypoint/i.test(tname)) {
                if (!objects) { c.p = oend; continue; }
                const obj = { name: tname, x, y, z, angle, flags };
                const road = flags & (FLAG.ROAD1 | FLAG.ROAD2), bridge = flags & (FLAG.BRIDGE1 | FLAG.BRIDGE2);
                if (road || bridge) { // point de route / de pont : relié à son partenaire (point 1 + point 2 consécutifs)
                  const kind = road ? 'road' : 'bridge', p0 = pend[kind], mask = road ? FLAG.ROAD1 | FLAG.ROAD2 : FLAG.BRIDGE1 | FLAG.BRIDGE2;
                  if (p0 && (p0.flags & mask) !== (flags & mask)) { res[kind + 's'].push({ name: p0.name, a: p0, b: obj }); pend[kind] = null; }
                  else pend[kind] = obj;
                } else res.objects.push(obj);
              } else if (over >= 2 && d) {
                res.waypoints++;
                const wn = d.waypointName ?? d.WaypointName;
                if (objects) res.waypointList.push({ name: typeof wn === 'string' ? wn : '', id: d.waypointID ?? d.WaypointID ?? null, x, y, z, labels: [d.waypointPathLabel1, d.waypointPathLabel2, d.waypointPathLabel3].filter(l => typeof l === 'string' && l) }); // labels : « chemins » du World Builder (c'est par eux que le moteur retrouve la voie d'un train)
                const m = typeof wn === 'string' && /^player_(\d+)_start$/i.exec(wn);
                if (m) res.starts.push({ n: Number(m[1]), x, y, z, angle });
              }
            }
            c.p = oend;
          }
        }
      } catch (e) { res.errors.push(`morceau ${name} : ${e.message}`); }
      r.p = end;
    }
    res.starts.sort((a, b2) => a.n - b2.n);
    res.ok = res.w > 0 && res.h > 0;
    if (!res.ok) res.errors.push('dimensions du terrain introuvables (HeightMapData)');
  } catch (e) { res.errors.push(e.message); }
  return res;
}
