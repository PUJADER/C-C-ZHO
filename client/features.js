// Éléments de carte au-delà du relief : routes et rails (rubans posés sur le terrain), ponts (modèle W3D tendu entre ses deux
// extrémités) et train (locomotive + wagons qui roulent sur la voie). Données : /api/map/<id>/features (coordonnées brutes du .map).
//
// Repères : le .map place l'origine au coin jouable ; le jeu est centré et réduit d'un facteur k (terrain.k). Un point brut (rx, ry)
// devient (rx*k - map.w/2, ry*k - map.h/2) en coordonnées de jeu, puis (x, hauteur, -y) dans Three.
import * as THREE from 'three';
import { decodeTga, decodeDds } from '/terrain-tex.js';
import { loadObjectModel, cloneModel, loadRawModel } from '/model-loader.js';
import { findStraightBand, chooseTrack, roadChains, smoothPolyline, roadOrder, distToSeg } from '/features-core.js';
import { analyzeAtlas, usablePieces, planJunctions, applyJunctions } from '/road-atlas.js';

// Pièces de raccord (T, Y, carrefour) posées aux jonctions de routes. Désactivables pour comparer : ?junctions=0 dans l'adresse de la page.
const JUNCTIONS = (() => { try { return new URLSearchParams(location.search).get('junctions') !== '0'; } catch { return true; } })();

const texCache = new Map();
// Texture de route : même recherche que le terrain (art/terrain, art/textures ; .tga / .dds). Le fichier est un ATLAS (route droite, virages, T,
// carrefours...) : on n'en garde que la bande de route droite, recopiée dans sa propre texture (répétée dans le sens de la route, jamais
// dans l'autre : aucune bavure sur les pièces voisines). Renvoie { tex, ratio } ; ratio = largeur de la bande / sa hauteur (en pixels).
function loadTex(name, frac = 0) {
  const key = name.replace(/\.[^.]+$/, '').toLowerCase();
  if (!texCache.has(key)) texCache.set(key, (async () => {
    const r = await fetch(`/api/terrain-tex/${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const ext = r.headers.get('X-Tex-Ext'), buf = await r.arrayBuffer();
    const img = ext === 'dds' ? decodeDds(buf) : decodeTga(buf);
    const band = findStraightBand(img, frac) ?? { y0: 0, y1: img.height };
    const full = document.createElement('canvas'); full.width = img.width; full.height = img.height; full.getContext('2d').putImageData(img, 0, 0);
    const bh = band.y1 - band.y0, cv = document.createElement('canvas'); cv.width = img.width; cv.height = bh;
    cv.getContext('2d').drawImage(full, 0, band.y0, img.width, bh, 0, 0, img.width, bh);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4;
    const atlasTex = new THREE.CanvasTexture(full); // l'atlas entier : sert aux pièces de raccord (la bande droite ci-dessus ne sert qu'aux rubans)
    atlasTex.colorSpace = THREE.SRGBColorSpace; atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping; atlasTex.anisotropy = 4;
    let pieces = null; // analyse faite à la demande (une fois par texture) : pièces à 3 ou 4 branches de l'atlas
    const getPieces = () => {
      if (!pieces) {
        try { pieces = usablePieces(analyzeAtlas(img, bh), bh); } catch (e) { console.warn(`[routes] ${key} : analyse de l'atlas impossible :`, e.message); pieces = []; }
        console.info(`[routes] ${key} : ${pieces.length} pièce(s) de raccord`, pieces.map(p => `${p.kind}${p.arms.length}`).join(' '));
      }
      return pieces;
    };
    console.info(`[routes] ${key} : atlas ${img.width}×${img.height}, bande droite lignes ${band.y0}-${band.y1}`);
    return { tex: t, ratio: img.width / bh, bandH: bh, W: img.width, H: img.height, atlasTex, pieces: getPieces };
  })().catch(e => { console.warn(`[routes] texture ${key} illisible :`, e.message); return null; }));
  return texCache.get(key);
}

export async function loadMapFeatures({ scene, terrain, map, mapId, shouldAbort = () => false }) {
  const k = terrain.k, cell = terrain.cell;
  const toGame = ([rx, ry]) => [rx * k - map.w / 2, ry * k - map.h / 2];
  const r = await fetch(`/api/map/${encodeURIComponent(mapId)}/features`);
  if (!r.ok) throw new Error(`éléments de carte indisponibles (${r.status})`);
  const f = await r.json();
  const group = new THREE.Group(); group.name = 'map-features';
  const live = { group, trainUpdate: null, stats: { roads: 0, rails: 0, bridges: 0, train: 0 } };

  // ---------- routes et rails : rubans qui épousent le relief ----------
  // Un ruban par définition (Road X), de la largeur de la route (RoadWidth), texturé avec la bande de route droite de l'atlas.
  // Dans la bande, la route va dans le sens horizontal de l'image : u = distance le long de la route, v = travers.
  async function buildRoads() {
    const byDef = new Map();
    for (const s of f.roads) (byDef.get(s.n) ?? byDef.set(s.n, []).get(s.n)).push(s);
    // toutes les routes en coordonnées de jeu : sert à savoir si le bout d'un tracé touche une AUTRE route (sinon c'est un bout libre : fondu)
    const all = f.roads.filter(s => f.defs[s.n]).map(s => ({ n: s.n, a: toGame(s.a), b: toGame(s.b), hw: (f.defs[s.n].width * k) / 2 }));
    const touchesOther = (p, name, hwSelf) => all.some(o => o.n !== name && distToSeg(p, o.a, o.b) < o.hw + hwSelf * 0.5);
    for (const [name, segs] of [...byDef].sort((x, y) => roadOrder(x[0], f.defs[x[0]]) - roadOrder(y[0], f.defs[y[0]])) ) {
      const def = f.defs[name]; if (!def) continue;
      const order = roadOrder(name, def), rank = Math.floor(order);
      const canFade = !def.rail && rank <= 1; // fondu aux bouts libres : terre et bitume seulement (pas les rails, trottoirs ni marquages)
      const frac = def.widthInTexture > 0 && def.widthInTexture < 1 ? def.widthInTexture : 0;
      const T = def.texture ? await loadTex(def.texture, frac) : null;
      const hw = (def.width * k) / 2;                           // demi-largeur du ruban = demi-largeur de la route
      const periodU = T ? (2 * hw) * T.ratio : 1;               // longueur de route couverte par une largeur d'image (pixels carrés)
      const pos = [], uv = [], col = [], idx = [];
      // Segments -> tracés : les segments qui se touchent sont chaînés, les coins arrondis (virage large / serré / vif selon les flags du .map),
      // puis un seul ruban continu suit chaque tracé (coins en onglet, u continu : la texture ne se coupe pas dans les virages).
      const gsegs = segs.map(s => ({ a: toGame(s.a), b: toGame(s.b), fa: s.fa | 0, fb: s.fb | 0 }));
      const step = cell * 0.5, ext = hw * 0.6;
      let chains = roadChains(gsegs, Math.max(2, hw * 0.4)), jplans = [];
      if (JUNCTIONS && T && !def.rail && chains.junctions?.length) { // raccords : on remplace le chevauchement des rubans par la pièce de l'atlas qui colle (T, Y, carrefour)
        try {
          const pcs = T.pieces();
          if (pcs.length) { jplans = planJunctions(chains.junctions, pcs, (2 * hw) / T.bandH, hw); if (jplans.length) chains = applyJunctions(chains, jplans, hw); }
        } catch (e) { console.warn(`[routes] ${name} : raccords ignorés :`, e.message); jplans = []; chains = roadChains(gsegs, Math.max(2, hw * 0.4)); }
      }
      for (const ch of chains) {
        let line = smoothPolyline(ch.pts, hw);
        if (line.length < 2) continue;
        // bout libre (un seul segment, ne touche aucune autre route) : la route s'efface en douceur au lieu de s'arrêter net (pièce ALPHA_JOIN du moteur).
        // Pas pour les rails (ils finissent contre un tunnel / un pont), ni trottoirs et marquages.
        const free0 = canFade && !ch.closed && ch.ends[0] === 1 && !touchesOther(line[0], name, hw);
        const free1 = canFade && !ch.closed && ch.ends[1] === 1 && !touchesOther(line[line.length - 1], name, hw);
        if (!ch.closed) { // rallonge chaque bout raccordé pour recouvrir les raccords avec les tracés voisins (T, carrefours)
          const ext1 = (p, q) => { const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; return [p[0] + (p[0] - q[0]) / l * ext, p[1] + (p[1] - q[1]) / l * ext]; };
          const ovl = (free, piece, p, q) => { if (free) return []; const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1, e = piece ? hw * 0.06 : ext; return [[p[0] + (p[0] - q[0]) / l * e, p[1] + (p[1] - q[1]) / l * e]]; }; // bout sur une pièce de raccord : léger recouvrement seulement (pas de rallonge)
          const first = ovl(free0, ch.pieceEnds?.[0], line[0], line[1]), last = ovl(free1, ch.pieceEnds?.[1], line[line.length - 1], line[line.length - 2]);
          line = [...first, ...line, ...last];
        }
        const dense = [line[0]]; // redécoupe en pas réguliers pour que le ruban épouse le relief
        for (let i = 1; i < line.length; i++) {
          const [x0, y0] = line[i - 1], [x1, y1] = line[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
          for (let j = 1; j <= n; j++) dense.push([x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n]);
        }
        const base = pos.length / 3; let dist = 0;
        let total = 0; for (let i = 1; i < dense.length; i++) total += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
        const fade = Math.min(hw * 2.5, total * 0.45), ramp = d => { const t = Math.min(1, Math.max(0, d / fade)); return t * t * (3 - 2 * t); };
        for (let i = 0; i < dense.length; i++) {
          const [x, y] = dense[i], pv = dense[Math.max(0, i - 1)], nx_ = dense[Math.min(dense.length - 1, i + 1)];
          if (i > 0) dist += Math.hypot(x - dense[i - 1][0], y - dense[i - 1][1]);
          const l1 = Math.hypot(x - pv[0], y - pv[1]), l2 = Math.hypot(nx_[0] - x, nx_[1] - y);
          const t1 = l1 > 1e-6 ? [(x - pv[0]) / l1, (y - pv[1]) / l1] : null, t2 = l2 > 1e-6 ? [(nx_[0] - x) / l2, (nx_[1] - y) / l2] : null;
          const ta = t1 ?? t2, tb = t2 ?? t1; let mx = ta[0] + tb[0], my = ta[1] + tb[1]; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
          const nx = -my, ny = mx, miter = Math.min(2.5, 1 / Math.max(0.4, nx * -tb[1] + ny * tb[0])); // onglet : l'intérieur du virage ne se replie pas
          for (const side of [1, -1]) {
            const px = x + nx * hw * miter * side, py = y + ny * hw * miter * side;
            pos.push(px, terrain.at(px, py) + 0.35 * k, -py); uv.push(dist / periodU, side === 1 ? 1 : 0);
            col.push(1, 1, 1, Math.min(free0 ? ramp(dist) : 1, free1 ? ramp(total - dist) : 1)); // alpha : fondu aux bouts libres
          }
          if (i > 0) { const a = base + (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        }
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); // RGBA : seul l'alpha varie
      geo.setIndex(idx); geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ map: T?.tex ?? null, color: T ? 0xffffff : (def.rail ? 0x4a4038 : 0x55524c), roughness: 1, metalness: 0,
        transparent: true, vertexColors: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 - rank, polygonOffsetUnits: -2 - rank }); // plus le rang est haut, plus le ruban est tiré vers la caméra
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 2 + order * 0.1; mesh.name = `road:${name}`; // ordre explicite : terre < bitume < trottoir < rail < marquage
      group.add(mesh); live.stats[def.rail ? 'rails' : 'roads'] += segs.length;
      if (jplans.length) { // pièces de raccord : un quad quadrillé par pièce, tendu sur le relief, texturé avec l'atlas entier
        const pp = [], puv = [], pcol = [], pidx = [];
        for (const pl of jplans) {
          const b = pl.piece.box, x0 = Math.max(0, b.x0 - 1), y0 = Math.max(0, b.y0 - 1), x1 = Math.min(T.W, b.x1 + 1), y1 = Math.min(T.H, b.y1 + 1);
          const nn = Math.max(2, Math.min(40, Math.ceil(Math.max(x1 - x0, y1 - y0) * pl.s / (cell * 0.5)))), base = pp.length / 3;
          for (let j = 0; j <= nn; j++) for (let i = 0; i <= nn; i++) {
            const px = x0 + (x1 - x0) * i / nn, py = y0 + (y1 - y0) * j / nn, [wx, wy] = pl.to(px, py);
            pp.push(wx, terrain.at(wx, wy) + 0.35 * k, -wy); puv.push(px / T.W, 1 - py / T.H); pcol.push(1, 1, 1, 1);
          }
          for (let j = 0; j < nn; j++) for (let i = 0; i < nn; i++) { const a = base + j * (nn + 1) + i; pidx.push(a, a + 1, a + nn + 1, a + 1, a + nn + 2, a + nn + 1); }
        }
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); pg.setAttribute('uv', new THREE.Float32BufferAttribute(puv, 2)); pg.setAttribute('color', new THREE.Float32BufferAttribute(pcol, 4));
        pg.setIndex(pidx); pg.computeVertexNormals();
        const pm = new THREE.MeshStandardMaterial({ map: T.atlasTex, color: 0xffffff, roughness: 1, metalness: 0, transparent: true, vertexColors: true, alphaTest: 0.02, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 - rank, polygonOffsetUnits: -2 - rank });
        const pmesh = new THREE.Mesh(pg, pm); pmesh.renderOrder = 2 + order * 0.1 + 0.05; pmesh.name = `junction:${name}`;
        group.add(pmesh); live.stats.junctions = (live.stats.junctions ?? 0) + jplans.length;
      }
    }
  }

  // ---------- ponts ----------
  const _q = new THREE.Quaternion(), _d = new THREE.Vector3(), _ax = new THREE.Vector3();
  async function buildBridges() {
    for (const s of f.bridges) {
      const def = f.defs[s.n]; if (!def) continue;
      const [ax, ay] = toGame(s.a), [bx, by] = toGame(s.b), len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      // hauteur des deux culées : sol + décalage de l'objet (z), comme le moteur
      const ya = terrain.at(ax, ay) + s.a[2] * k, yb = terrain.at(bx, by) + s.b[2] * k;
      let tpl = null;
      if (def.model) { try { tpl = await loadRawModel(def.model); } catch (e) { console.warn(`[pont] ${def.model} : ${e.message}`); } }
      if (!tpl) { // pas de modèle : simple tablier plat entre les deux culées
        const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 1.5 * k, Math.max(8, def.width) * k), new THREE.MeshStandardMaterial({ color: 0x777066, roughness: 1 }));
        const holder = new THREE.Group(); holder.add(deck);
        place(holder, 'x', ax, ay, ya, bx, by, yb);
        group.add(holder); live.stats.bridges++; continue;
      }
      const model = tpl.clone(true), holder = new THREE.Group(); holder.add(model);
      const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const axis = size.x >= size.z ? 'x' : 'z', along = axis === 'x' ? size.x : size.z;
      if (along < 1e-3) continue;
      model.position.set(-c.x, 0, -c.z); // centré sur son milieu (le plan de roulement reste à y = 0 du modèle)
      const sl = len / along, cross = k * (def.scale || 1);
      const wrap = new THREE.Group(); wrap.add(holder); wrap.scale.set(axis === 'x' ? sl : cross, cross, axis === 'x' ? cross : sl);
      const out = new THREE.Group(); out.add(wrap);
      place(out, axis, ax, ay, ya, bx, by, yb);
      group.add(out); live.stats.bridges++;
    }
  }
  function place(obj, axis, ax, ay, ya, bx, by, yb) { // oriente l'axe long de l'objet de A vers B, en suivant la pente
    _d.set(bx - ax, yb - ya, -(by - ay)).normalize();
    _ax.set(axis === 'x' ? 1 : 0, 0, axis === 'z' ? 1 : 0);
    obj.quaternion.copy(_q.setFromUnitVectors(_ax, _d));
    obj.position.set((ax + bx) / 2, (ya + yb) / 2, -(ay + by) / 2);
  }

  // ---------- train ----------
  // Voie : liens de waypoints du préfixe du RailroadBehavior (comme le moteur), recoupés avec les rails dessinés (client/features-core.js).
  async function buildTrain() {
    const placed = f.trains.find(t => t.rail.locomotive) ?? null;
    const locoName = placed?.name ?? f.loco, rail = placed?.rail ?? f.locoRail;
    if (!locoName || !rail) return;
    const track = chooseTrack(f, rail.prefix, placed);
    if (!track || track.pts.length < 2) { console.warn('[train] aucune voie trouvée (ni waypoints, ni rails)'); return; }
    let raw = track.pts;
    if (track.source === 'rails' && placed && Number.isFinite(placed.angle)) { // sens de marche (voie dessinée : pas de sens imposé) : celui dans lequel la locomotive posée regarde
      const np = nearestS(raw, raw.reduce((a, q, i) => (a.push(i ? a[i - 1] + Math.hypot(q[0] - raw[i - 1][0], q[1] - raw[i - 1][1]) : 0), a), []), [placed.x, placed.y]);
      let acc = 0, i = 1; for (; i < raw.length - 1; i++) { const l = Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]); if (acc + l >= np) break; acc += l; }
      const dx = raw[i][0] - raw[i - 1][0], dy = raw[i][1] - raw[i - 1][1];
      if (dx * Math.cos(placed.angle) + dy * Math.sin(placed.angle) < 0) raw = [...raw].reverse();
    }
    console.info(`[train] voie : ${track.source} (${raw.length} points)${track.why ? ' — ' + track.why : ''}`);
    const pts = raw.map(toGame), seg = [0];
    for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = seg[seg.length - 1];
    if (L < 100) return;
    const closed = track.closed || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 40;
    // Tunnels : un waypoint dont le nom contient « Tunnel » marque un passage souterrain ; le tronçon qui part de lui est caché (le train
    // « entre dans la montagne » entre deux TrainTunnel, comme dans le jeu). Hors tunnel, le train roule sur le sol.
    const tun = track.tunnel ? track.tunnel : null;
    live.stats.tunnels = tun ? tun.filter(Boolean).length : 0;
    const at = s => { // point, cap et hauteur de la voie à l'abscisse s
      let i = 1; while (i < seg.length - 1 && seg[i] < s) i++;
      const t = (s - seg[i - 1]) / Math.max(1e-6, seg[i] - seg[i - 1]), [x0, y0] = pts[i - 1], [x1, y1] = pts[i], x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      return { x, y, a: Math.atan2(y1 - y0, x1 - x0), h: terrain.at(x, y), hid: !!(tun && tun[i - 1]) };
    };
    const names = [locoName, ...(rail.carriages ?? [])];
    const cars = [];
    for (const n of names) {
      try { const m = await loadObjectModel(n, []); const { inst } = cloneModel(m); group.add(inst); cars.push({ inst, len: Math.max(20, m.size.x) }); }
      catch (e) { console.warn(`[train] ${n} : ${e.message}`); }
    }
    if (!cars.length) return;
    const gap = 4; let offs = 0; for (const c of cars) { c.off = offs; offs += c.len + gap; }
    const total = offs, speed = Math.min(Math.max(rail.speed || 100, 30), 400);
    let s = placed ? nearestS(pts, seg, [placed.x * k - map.w / 2, placed.y * k - map.h / 2]) : total; // part du point de la voie le plus proche de la locomotive posée
    live.stats.train = cars.length;
    const wrap = x => closed ? ((x % L) + L) % L : Math.min(L, Math.max(0, x));
    // Zone jouable : la voie du .map fait une grande boucle d'attente HORS carte (≈ 60 % du parcours). Le jeu d'origine la cache sous le voile noir de
    // bordure ; ici le terrain de bordure est dessiné, donc le train y grimperait sur le relief. Hors de la zone jouable, il est masqué.
    const hx = map.w / 2, hy = map.h / 2, inPlay = (x, y) => Math.abs(x) <= hx && Math.abs(y) <= hy;
    live.trainUpdate = dt => {
      s += speed * dt;
      if (s - total > L) s = closed ? s - L : 0; // le train est sorti : il revient au début de la voie
      for (const c of cars) {
        const si = s - c.off - c.len / 2;
        const vis = closed || (si >= 0 && si <= L);
        if (!vis) { c.inst.visible = false; continue; }
        const half = c.len * 0.4, f0 = at(wrap(si + half)), b0 = at(wrap(si - half)); // essieux avant / arrière : cap lissé dans les virages
        const x = (f0.x + b0.x) / 2, y = (f0.y + b0.y) / 2, hf = f0.h, hb = b0.h;
        c.inst.visible = !at(wrap(si)).hid && inPlay(x, y); // caché dans un tunnel, et hors de la zone jouable
        if (!c.inst.visible) continue;
        c.inst.rotation.set(0, Math.atan2(f0.y - b0.y, f0.x - b0.x), Math.atan2(hf - hb, Math.hypot(f0.x - b0.x, f0.y - b0.y) || 1), 'YZX'); // lacet puis tangage (pente)
        c.inst.position.set(x, (hf + hb) / 2 + 0.5, -y); c.inst.updateMatrixWorld();
      }
    };
  }
  function nearestS(pts, seg, [x, y]) {
    let best = 0, bd = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)), d = Math.hypot(x0 + dx * t - x, y0 + dy * t - y);
      if (d < bd) { bd = d; best = seg[i - 1] + (seg[i] - seg[i - 1]) * t; }
    }
    return best;
  }

  const results = await Promise.allSettled([buildRoads(), buildBridges(), buildTrain()]);
  results.forEach((x, i) => { if (x.status === 'rejected') console.warn(`[carte] ${['routes', 'ponts', 'train'][i]} :`, x.reason?.message ?? x.reason); });
  if (shouldAbort()) return null;
  scene.add(group);
  return { group, stats: live.stats, update: dt => live.trainUpdate?.(dt), dispose() { scene.remove(group); group.traverse(o => { o.geometry?.dispose?.(); }); } };
}
