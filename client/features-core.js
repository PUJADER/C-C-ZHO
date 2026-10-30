// Logique pure (sans DOM ni Three) de client/features.js : bande droite d'un atlas de route et voie du train. Testable sous Node.

// ---------- atlas de route ----------
// Une texture de route de Generals n'est PAS une bande de route : c'est un atlas (route droite, virages, T, carrefours, passages piétons...).
// La route droite en occupe une bande pleine largeur (sens de la route = sens horizontal de l'image). On la retrouve par l'alpha :
// ce sont les lignes presque entièrement opaques, la plus longue suite de ces lignes gagne.
// img : { width, height, data: Uint8ClampedArray RGBA }. Renvoie { y0, y1 } (lignes y0 incluse .. y1 exclue, y du haut de l'image) ou null.
export function findStraightBand(img, frac = 0) {
  const { width: W, height: H, data } = img;
  // Pixels « vides » : transparents (atlas avec canal alpha) ; si l'image est entièrement opaque (TGA 24 bits, DXT1...), le vide est la couleur de fond
  // des coins de l'atlas. Dans les deux cas on travaille sur un masque « pixel de route ».
  let opaque = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++;
  const noAlpha = opaque / (W * H) > 0.97;
  let bg = null;
  if (noAlpha) {
    const at = (x, y) => [data[(y * W + x) * 4], data[(y * W + x) * 4 + 1], data[(y * W + x) * 4 + 2]];
    const cs = [at(0, 0), at(W - 1, 0), at(0, H - 1), at(W - 1, H - 1)], close = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 30;
    bg = cs.find((c, i) => cs.some((d, j) => j !== i && close(c, d))) ?? cs[0];
  }
  const rowFill = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (bg ? Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]) >= 30 : data[o + 3] > 128) n++;
    }
    rowFill[y] = n / W;
  }
  const minRows = Math.max(4, Math.round(H * 0.04));
  for (const thr of [0.97, 0.9, 0.75]) {
    const runs = []; let y = 0;
    while (y < H) {
      if (rowFill[y] < thr) { y++; continue; }
      let e = y; while (e < H && rowFill[e] >= thr) e++;
      if (e - y >= minRows) runs.push({ y0: y, y1: e });
      y = e;
    }
    if (!runs.length) continue;
    const longest = runs.reduce((m, r) => (r.y1 - r.y0 > m.y1 - m.y0 ? r : m));
    if (frac > 0.04 && frac < 0.95) { // RoadWidthInTexture (Roads.ini) : épaisseur attendue de la bande ; on la préfère si une bande y ressemble
      const want = frac * H, close = runs.filter(r => (r.y1 - r.y0) >= want * 0.6 && (r.y1 - r.y0) <= want * 1.6);
      if (close.length) return close.reduce((m, r) => (Math.abs(r.y1 - r.y0 - want) < Math.abs(m.y1 - m.y0 - want) ? r : m));
    }
    return longest;
  }
  if (frac > 0 && frac < 1) { const h = Math.round(H * frac); return { y0: 0, y1: Math.max(1, h) }; } // à défaut : le quart haut (RoadWidthInTexture)
  return null;
}

// ---------- raccords de routes ----------
// Le .map ne contient que des paires de points (a -> b). Le moteur d'origine en déduit les raccords (virages, T, carrefours) ; ici on
// reconstitue des POLYLIGNES : les segments qui se touchent (même extrémité, à `tol` près) sont chaînés en un seul tracé, puis chaque coin
// est arrondi selon les flags du World Builder (ANGLED = coin vif, TIGHT = virage serré, sinon virage large). Le ruban est ensuite
// tendu sur ce tracé lisse avec des coins en onglet : plus de trous ni de chevauchements aux jonctions.
export const ROAD_FLAG = { ANGLED: 0x8, TIGHT: 0x40, JOIN: 0x80 };

// segs : [{ a:[x,y], b:[x,y], fa, fb }] en coordonnées de jeu. Renvoie [{ pts:[[x,y,flags],...], closed, ends:[degré début, degré fin] }].
export function roadChains(segs, tol = 3) {
  const nodes = [], grid = new Map(), key = (i, j) => i + ',' + j;
  const nodeOf = (x, y, fl) => {
    const gi = Math.floor(x / tol), gj = Math.floor(y / tol);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
      for (const n of grid.get(key(gi + di, gj + dj)) ?? []) if (Math.hypot(n.x - x, n.y - y) < tol) { n.fl |= fl; return n; }
    const n = { x, y, fl, edges: [] }; nodes.push(n);
    const k = key(gi, gj); (grid.get(k) ?? grid.set(k, []).get(k)).push(n); return n;
  };
  const edges = [];
  for (const s of segs) {
    const a = nodeOf(s.a[0], s.a[1], s.fa | 0), b = nodeOf(s.b[0], s.b[1], s.fb | 0);
    if (a === b) continue;
    const e = { a, b }; edges.push(e); a.edges.push(e); b.edges.push(e);
  }
  const other = (e, n) => (e.a === n ? e.b : e.a);
  const dirOut = (n, e) => { const m = other(e, n), dx = m.x - n.x, dy = m.y - n.y, l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const bestPartner = (n, e) => { // arête la plus « dans le prolongement » de e au nœud n (virage ≤ ~45°), sinon null
    const d0 = dirOut(n, e); let best = null, bs = 0.7;
    for (const o of n.edges) { if (o === e) continue; const d = dirOut(n, o), sc = -(d0[0] * d[0] + d0[1] * d[1]); if (sc > bs) { bs = sc; best = o; } }
    return best;
  };
  const partner = (n, e) => {
    if (n.edges.length === 2) return n.edges[0] === e ? n.edges[1] : n.edges[0]; // simple virage : on enchaîne toujours
    if (n.edges.length < 2) return null;
    const p = bestPartner(n, e); return p && bestPartner(n, p) === e ? p : null; // T / carrefour : seulement les deux branches les plus alignées (et réciproques)
  };
  const used = new Set(), chains = [];
  const walk = (e, n) => { // quitte le nœud n par l'arête e et suit le tracé
    const out = []; for (let g = 0; g < 100000; g++) {
      used.add(e); const m = other(e, n); out.push(m);
      const nx = partner(m, e); if (!nx || used.has(nx)) break; n = m; e = nx;
    } return out;
  };
  for (const e0 of edges) {
    if (used.has(e0)) continue;
    const fwd = walk(e0, e0.a), back = walk(e0, e0.b).reverse(); // fwd : b, b2... ; back : ...a2, a
    const ns = [...back, ...fwd];
    if (ns.length >= 2) chains.push({ pts: ns.map(n => [n.x, n.y, n.fl]), closed: ns[0] === ns[ns.length - 1], ends: [ns[0].edges.length, ns[ns.length - 1].edges.length] }); // ends : nombre de segments à chaque bout (1 = bout libre, ≥ 3 = T / carrefour)
  }
  return chains;
}

// Arrondit les coins d'un tracé. hw = demi-largeur de la route (unités de jeu). Rayon : large 3·hw, serré (TIGHT) 1.2·hw, coin vif (ANGLED) : aucun.
// Chaque coin est remplacé par une courbe de Bézier quadratique (tangentes = les deux segments). Renvoie [[x,y],...].
export function smoothPolyline(pts, hw) {
  if (pts.length < 3) return pts.map(p => [p[0], p[1]]);
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const P = pts[i], A = pts[i - 1], B = pts[i + 1];
    const l1 = Math.hypot(P[0] - A[0], P[1] - A[1]), l2 = Math.hypot(B[0] - P[0], B[1] - P[1]);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const e1 = [(P[0] - A[0]) / l1, (P[1] - A[1]) / l1], e2 = [(B[0] - P[0]) / l2, (B[1] - P[1]) / l2];
    const theta = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])));
    if (theta < 0.06 || (P[2] & ROAD_FLAG.ANGLED) || theta > 3.0) { out.push([P[0], P[1]]); continue; } // quasi droit, coin vif, ou demi-tour
    const R = hw * ((P[2] & ROAD_FLAG.TIGHT) ? 1.2 : 3);
    const d = Math.min(R * Math.tan(theta / 2), 0.5 * Math.min(l1, l2));
    const S = [P[0] - e1[0] * d, P[1] - e1[1] * d], E = [P[0] + e2[0] * d, P[1] + e2[1] * d], n = Math.max(3, Math.ceil(theta / 0.2));
    for (let j = 0; j <= n; j++) {
      const t = j / n, u = 1 - t;
      out.push([u * u * S[0] + 2 * u * t * P[0] + t * t * E[0], u * u * S[1] + 2 * u * t * P[1] + t * t * E[1]]);
    }
  }
  const L = pts[pts.length - 1]; out.push([L[0], L[1]]);
  return out;
}

// Ordre de superposition des routes qui se croisent : terre / gravier < bitume < trottoirs < rails < marquages. À rang égal, la plus large dessous.
// Sans cela, les rubans (tous transparents) sont triés par distance à la caméra : l'ordre change selon l'angle de vue (terre par-dessus le bitume...).
export function roadRank(name, def) {
  const t = `${name} ${def?.texture ?? ''}`;
  if (def?.rail || /rail|track/i.test(t)) return 3;
  if (/line|marking|cross|stripe/i.test(t)) return 4;
  if (/sidewalk|curb|pavement/i.test(t)) return 2;
  if (/dirt|gravel|mud|path|trail|sand|snow/i.test(t)) return 0;
  return 1;
}
export const roadOrder = (name, def) => roadRank(name, def) + (1 - Math.min(1, (def?.width ?? 30) / 100)) * 0.5;

// Distance d'un point au segment [a, b] ({x,y} ou [x,y]).
export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

// ---------- voie du train ----------
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const naturalNum = s => { const m = /(\d+)\s*$/.exec(s); return m ? Number(m[1]) : Infinity; };

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / l2));
    best = Math.min(best, Math.hypot(x0 + dx * t - p[0], y0 + dy * t - p[1]));
  }
  return best;
}

// Chaîne de segments de rail (paires de points) : composante connexe la plus proche de `near`, parcourue d'un bout à l'autre
// (ou en boucle). Les segments sont { a:[x,y,z], b:[x,y,z] } en coordonnées brutes. Renvoie [[x,y],...] ou null.
export function railChain(rails, near = null, tol = 8) {
  if (!rails.length) return null;
  // nœuds fusionnés par proximité
  const nodes = [], nodeOf = p => { let i = nodes.findIndex(n => dist(n, p) < tol); if (i < 0) { nodes.push([p[0], p[1]]); i = nodes.length - 1; } return i; };
  const edges = rails.map(s => [nodeOf(s.a), nodeOf(s.b)]).filter(([a, b]) => a !== b);
  if (!edges.length) return null;
  const adj = nodes.map(() => []);
  edges.forEach(([a, b], e) => { adj[a].push([b, e]); adj[b].push([a, e]); });
  // composante la plus proche de `near` (sinon la plus grande)
  const comp = new Array(nodes.length).fill(-1); let nc = 0; const size = [];
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] >= 0) continue; size[nc] = 0; const st = [s]; comp[s] = nc;
    while (st.length) { const u = st.pop(); size[nc]++; for (const [v] of adj[u]) if (comp[v] < 0) { comp[v] = nc; st.push(v); } }
    nc++;
  }
  let pick = 0;
  if (near) { let bd = Infinity; edges.forEach(([a, b], e) => { const d = distToPolyline(near, [nodes[a], nodes[b]]); if (d < bd) { bd = d; pick = comp[a]; } }); }
  else for (let c = 1; c < nc; c++) if (size[c] > size[pick]) pick = c;
  const inComp = nodes.map((_, i) => comp[i] === pick);
  // départ : un bout de ligne (degré 1) ; en boucle, le nœud le plus proche de `near`
  let start = -1;
  for (let i = 0; i < nodes.length; i++) if (inComp[i] && adj[i].length === 1) { start = i; break; }
  if (start < 0) { let bd = Infinity; for (let i = 0; i < nodes.length; i++) if (inComp[i]) { const d = near ? dist(nodes[i], near) : i; if (d < bd) { bd = d; start = i; } } }
  if (start < 0) return null;
  // parcours : à chaque nœud, on prend l'arête non encore utilisée la plus « dans l'axe » (les aiguillages ne cassent pas la voie principale)
  const used = new Set(), out = [nodes[start]]; let cur = start, dir = null;
  for (let guard = 0; guard < 20000; guard++) {
    let bestE = null, bs = -Infinity;
    for (const [v, e] of adj[cur]) {
      if (used.has(e)) continue;
      const dx = nodes[v][0] - nodes[cur][0], dy = nodes[v][1] - nodes[cur][1], l = Math.hypot(dx, dy) || 1;
      const sc = dir ? (dx * dir[0] + dy * dir[1]) / l : 0;
      if (sc > bs) { bs = sc; bestE = [v, e]; }
    }
    if (!bestE) break;
    const [v, e] = bestE; used.add(e);
    const dx = nodes[v][0] - nodes[cur][0], dy = nodes[v][1] - nodes[cur][1], l = Math.hypot(dx, dy) || 1; dir = [dx / l, dy / l];
    out.push(nodes[v]); cur = v;
  }
  return out.length >= 2 ? out : null;
}

// Voie du train, comme le moteur : on suit les LIENS entre waypoints (WaypointsList, sens a -> b), pas les noms. La carte contient
// plusieurs chemins ; on prend celui qui contient les waypoints de la voie (`isSeed`), puis on part du waypoint le plus proche de la
// locomotive. Un waypoint dont le nom contient « Tunnel » marque un passage souterrain : le train y disparaît dans la montagne.
// wps : [{ id, name, x, y }] ; links : [[idA, idB]] ; near : [x, y] brut de la locomotive. Renvoie { pts, tunnel, closed } ou null.
export function trainPath(wps, links, isSeed, near = null) {
  const byId = new Map(); for (const w of wps) if (w.id != null) byId.set(w.id, w);
  const out = new Map(), adj = new Map();
  for (const [a, b] of links ?? []) {
    if (!byId.has(a) || !byId.has(b)) continue;
    (out.get(a) ?? out.set(a, []).get(a)).push(b);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a);
  }
  const comp = new Map(); let nc = 0;
  for (const id of adj.keys()) { if (comp.has(id)) continue; const st = [id]; comp.set(id, nc); while (st.length) { const u = st.pop(); for (const v of adj.get(u)) if (!comp.has(v)) { comp.set(v, nc); st.push(v); } } nc++; }
  const seeds = wps.filter(w => w.id != null && comp.has(w.id) && isSeed(w));
  if (!seeds.length) return null;
  let pick; // composante : celle des waypoints de la voie la plus proche de la locomotive, sinon la plus fournie
  if (near) pick = comp.get(seeds.reduce((m, w) => (dist([w.x, w.y], near) < dist([m.x, m.y], near) ? w : m)).id);
  else { const cnt = new Map(); for (const w of seeds) cnt.set(comp.get(w.id), (cnt.get(comp.get(w.id)) ?? 0) + 1); pick = [...cnt].sort((a, b) => b[1] - a[1])[0][0]; }
  const members = [...comp].filter(([, c]) => c === pick).map(([id]) => byId.get(id));
  const hasIn = new Set(); for (const [a, l] of out) if (comp.get(a) === pick) for (const b of l) hasIn.add(b);
  let start = near ? members.reduce((m, w) => (dist([w.x, w.y], near) < dist([m.x, m.y], near) ? w : m)) : (members.find(w => !hasIn.has(w.id)) ?? members[0]);
  const seen = new Set(), path = []; let cur = start, closed = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); path.push(cur);
    const nx = out.get(cur.id) ?? [];
    if (nx.includes(start.id) && path.length > 2) { closed = true; break; }
    const n = nx.find(id => !seen.has(id)); cur = n != null ? byId.get(n) : null;
  }
  if (closed) path.push(start);
  if (path.length < 2) return null;
  return { pts: path.map(w => [w.x, w.y]), tunnel: path.map(w => /tunnel/i.test(w.name ?? '')), closed };
}

// Choix de la voie : waypoints liés (comme le moteur) ; à défaut seulement, rails dessinés.
export function chooseTrack(f, prefix, placed) {
  const near = placed ? [placed.x, placed.y] : null, p = prefix?.toLowerCase();
  const isSeed = w => (p && ((w.name ?? '').toLowerCase().startsWith(p) || (w.labels ?? []).some(l => l.toLowerCase().startsWith(p)))) || /rail|train/i.test(w.name ?? '');
  const wp = trainPath(f.waypoints ?? [], f.links, isSeed, near);
  if (wp) return { ...wp, source: 'waypoints' };
  const rails = (f.roads ?? []).filter(s => f.defs?.[s.n]?.rail);
  const chain = railChain(rails, near);
  return chain ? { pts: chain, tunnel: null, closed: false, source: 'rails' } : null;
}
