// Atlas de route : détection des PIÈCES de raccord (T, carrefour à 4 branches, Y) dessinées dans la texture. Logique pure (ni DOM ni Three) :
// testable sous Node. Aucune coordonnée n'est écrite en dur : les atlas de route (TRTwoLane*) et de rail (TRTrainTrack*) n'ont pas la même
// mise en page. Chaque pièce est une tache d'alpha isolée ; ses BRANCHES sont repérées par leurs bouts droits (coupes perpendiculaires à la route).
// img : { width, height, data: Uint8ClampedArray RGBA }. Les coordonnées renvoyées sont en pixels d'image (x vers la droite, y vers le bas).

const DEG = Math.PI / 180;

// Étiquette les taches d'alpha (après une dilatation de `r` pixels qui recolle les petits trous : traverses, passages piétons).
function labelBlobs(solid, W, H, r = 3) {
  const tmp = new Uint8Array(W * H), dil = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { // dilatation horizontale
    let last = -1e9;
    for (let x = 0; x < W; x++) if (solid[y * W + x]) last = x, tmp[y * W + x] = 1; else if (x - last <= r) tmp[y * W + x] = 1;
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) if (solid[y * W + x]) last = x; else if (last - x <= r) tmp[y * W + x] = 1;
  }
  for (let x = 0; x < W; x++) { // dilatation verticale
    let last = -1e9;
    for (let y = 0; y < H; y++) if (tmp[y * W + x]) last = y, dil[y * W + x] = 1; else if (y - last <= r) dil[y * W + x] = 1;
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) if (tmp[y * W + x]) last = y; else if (last - y <= r) dil[y * W + x] = 1;
  }
  const lab = new Int32Array(W * H), blobs = []; let id = 0;
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!dil[s] || lab[s]) continue;
    id++; lab[s] = id; stack.push(s); const xs = [], ys = [];
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p - x) / W;
      if (solid[p]) { xs.push(x); ys.push(y); }
      if (x > 0 && dil[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && dil[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && dil[p - W] && !lab[p - W]) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && dil[p + W] && !lab[p + W]) { lab[p + W] = id; stack.push(p + W); }
    }
    if (xs.length) blobs.push({ xs, ys });
  }
  return blobs;
}

// Branches d'une pièce : pour chaque direction (pas de 1°), les pixels les plus avancés dans cette direction forment une « coupe ». Si cette coupe
// est une droite perpendiculaire à la direction et aussi longue que la route (≥ 0.7 w), c'est le bout d'une branche. On garde le milieu du plateau
// d'angles qui donnent une coupe valide (les angles voisins en donnent une plus courte).
function findArms(xs, ys, w, lum) {
  const n = xs.length, tol = 2.5, arms = [];
  const cut = new Float64Array(360); // longueur de coupe par angle
  const cen = new Array(360);
  for (let a = 0; a < 360; a++) {
    const dx = Math.cos(a * DEG), dy = Math.sin(a * DEG);
    let mx = -1e9; for (let i = 0; i < n; i++) { const p = xs[i] * dx + ys[i] * dy; if (p > mx) mx = p; }
    let lo = 1e9, hi = -1e9, sx = 0, sy = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const p = xs[i] * dx + ys[i] * dy; if (p < mx - tol) continue;
      const q = -xs[i] * dy + ys[i] * dx; if (q < lo) lo = q; if (q > hi) hi = q; sx += xs[i]; sy += ys[i]; c++;
    }
    cut[a] = hi - lo; cen[a] = [sx / c, sy / c, mx, (hi + lo) / 2];
  }
  const ok = a => cut[((a % 360) + 360) % 360] >= 0.7 * w;
  let s0 = 0; while (s0 < 360 && ok(s0)) s0++;
  if (s0 === 360) return arms; // coupe valide dans toutes les directions : pas une pièce de route
  for (let i = 1; i <= 360; i++) {
    const a = s0 + i; if (!ok(a)) continue;
    let b = a; while (ok(b + 1)) b++; // plateau [a..b] d'angles qui donnent une coupe valide
    let best = a; for (let k = a; k <= b; k++) if (cut[((k % 360) + 360) % 360] > cut[((best % 360) + 360) % 360]) best = k;
    const bi = ((best % 360) + 360) % 360, c = cen[bi], dx = Math.cos(bi * DEG), dy = Math.sin(bi * DEG);
    // point de sortie : bord le plus avancé dans la direction de la branche, centré sur la coupe
    const arm = { ang: bi, dx, dy, x: c[2] * dx - c[3] * dy, y: c[2] * dy + c[3] * dx, len: cut[bi] };
    // bord FERMÉ : une ligne claire continue longe la coupe (bordure de route) ; une branche ouverte n'en a pas (le bitume continue)
    let hit = 0, tot = 0; const half = cut[bi] / 2 - 6;
    for (let t = -half; t <= half; t++) { // à chaque position le long de la coupe : y a-t-il un pixel clair dans les 6 pixels qui la bordent ?
      tot++;
      for (let k = 1; k <= 6; k++) {
        const px = arm.x - dx * k - dy * t, py = arm.y - dy * k + dx * t;
        if (lum(Math.round(px), Math.round(py)) > lum.base + 40) { hit++; break; }
      }
    }
    arm.edge = tot ? hit / tot : 0; arms.push(arm);
    i += b - a;
  }
  return arms;
}

// Type d'une pièce d'après ses branches : T (deux opposées + une à 90°), X (deux paires opposées), Y (deux opposées + une oblique 15°..75°).
function classify(arms) {
  const dot = (p, q) => p.dx * q.dx + p.dy * q.dy;
  if (arms.length === 4) return arms.every(p => arms.some(q => q !== p && dot(p, q) < -0.95)) ? 'X' : 'other';
  if (arms.length === 3) {
    for (let i = 0; i < 3; i++) {
      const p = arms[i], q = arms[(i + 1) % 3], r = arms[(i + 2) % 3];
      if (dot(p, q) < -0.95) return Math.max(Math.abs(dot(p, r)), Math.abs(dot(q, r))) < 0.1 ? 'T' : 'Y'; // r à 90° (±6°) : T, sinon Y
    }
  }
  return arms.length === 2 ? 'curve' : 'other';
}

// Analyse un atlas. w : largeur de la route dans l'image (hauteur de sa bande droite, en pixels).
// Renvoie { pieces:[{ kind, box:{x0,y0,x1,y1}, arms:[{x,y,dx,dy,ang}] }] } ou null si l'image n'a pas de canal alpha exploitable.
export function analyzeAtlas(img, w) {
  const { width: W, height: H, data } = img;
  const solid = new Uint8Array(W * H); let n = 0;
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] > 128) { solid[i] = 1; n++; }
  if (n / (W * H) > 0.97 || !(w > 4)) return null;
  const pieces = [];
  for (const b of labelBlobs(solid, W, H)) {
    if (b.xs.length < w * w * 0.3) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < b.xs.length; i++) { if (b.xs[i] < x0) x0 = b.xs[i]; if (b.xs[i] > x1) x1 = b.xs[i]; if (b.ys[i] < y0) y0 = b.ys[i]; if (b.ys[i] > y1) y1 = b.ys[i]; }
    if (x1 - x0 + 1 >= W * 0.9) continue; // la bande de route droite
    const lum = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : (data[(y * W + x) * 4] + data[(y * W + x) * 4 + 1] + data[(y * W + x) * 4 + 2]) / 3;
    const ls = b.xs.map((x, i) => lum(x, b.ys[i])).sort((p, q) => p - q); lum.base = ls[ls.length >> 1]; // luminance médiane du bitume
    const all = findArms(b.xs, b.ys, w, lum), arms = all.filter(a => a.edge < 0.9);
    pieces.push({ kind: classify(arms), box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, arms, closed: all.length - arms.length, debug: all.map(a => `${a.ang}°:${a.edge.toFixed(2)}`).join(' ') });
  }
  return { pieces };
}

// ---------- pose des pièces sur la carte ----------
const TAU = Math.PI * 2;
const wrap = a => { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
function permutations(n) {
  const out = [], rec = (cur, rest) => { if (!rest.length) { out.push(cur); return; } rest.forEach((v, i) => rec([...cur, v], rest.filter((_, j) => j !== i))); };
  rec([], [...Array(n).keys()]); return out;
}

// Pièces utilisables pour des raccords : 3 ou 4 branches, dont la largeur correspond à celle de la route (sinon l'atlas n'est pas ce qu'on croit).
export function usablePieces(analysis, w) {
  return (analysis?.pieces ?? []).filter(p => (p.arms.length === 3 || p.arms.length === 4) && p.arms.every(a => a.len > 0.8 * w && a.len < 1.25 * w));
}

// Point où se coupent les axes des branches (moindres carrés) : c'est le « centre » du raccord, posé sur le nœud de la carte.
export function pieceAnchor(piece) {
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0; // somme de (I - u uᵀ) et de (I - u uᵀ) p
  for (const m of piece.arms) {
    const m00 = 1 - m.dx * m.dx, m01 = -m.dx * m.dy, m11 = 1 - m.dy * m.dy;
    a += m00; b += m01; c += m11; e += m00 * m.x + m01 * m.y; f += m01 * m.x + m11 * m.y;
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) { const n = piece.arms.length; return [piece.arms.reduce((s, m) => s + m.x, 0) / n, piece.arms.reduce((s, m) => s + m.y, 0) / n]; }
  d = (c * e - b * f) / det; const y = (a * f - b * e) / det; return [d, y];
}

// Meilleur ajustement d'une pièce sur un nœud : rotation θ, symétrie éventuelle, et quelle branche de la pièce va sur quelle branche de la carte.
function fitPiece(J, piece) {
  const k = J.dirs.length; if (piece.arms.length !== k) return null;
  const B = J.dirs.map(d => Math.atan2(d[1], d[0]));
  let best = null;
  for (const f of [1, -1]) {
    const A = piece.arms.map(m => Math.atan2(-m.dy, f * m.dx)); // y retourné (l'image a y vers le bas), x miroir si f = -1
    for (const perm of permutations(k)) { // perm[i] : branche de la carte reliée à la branche i de la pièce
      let sx = 0, sy = 0; for (let i = 0; i < k; i++) { const d = B[perm[i]] - A[i]; sx += Math.sin(d); sy += Math.cos(d); }
      const theta = Math.atan2(sx, sy); let err = 0;
      for (let i = 0; i < k; i++) err = Math.max(err, Math.abs(wrap(B[perm[i]] - A[i] - theta)));
      if (!best || err < best.err) best = { piece, f, theta, perm, err };
    }
  }
  return best;
}

// Plans de pose. junctions : [{ id, x, y, nbr:[ids], dirs:[[dx,dy]..], lens:[..] }] (voir roadChains). s : unités de jeu par pixel d'atlas.
// Un raccord n'est posé que si la pièce colle à moins de maxErr degrés ET si chaque branche a la place de recevoir sa sortie.
export function planJunctions(junctions, pieces, s, hw, maxErr = 35) {
  const plans = [];
  for (const J of junctions ?? []) {
    let best = null;
    for (const p of pieces) { const fit = fitPiece(J, p); if (fit && (!best || fit.err < best.err)) best = fit; }
    if (!best || best.err > maxErr * Math.PI / 180) continue;
    const [cx, cy] = pieceAnchor(best.piece), cs = Math.cos(best.theta), sn = Math.sin(best.theta), f = best.f;
    const to = (px, py) => { const vx = f * (px - cx), vy = -(py - cy); return [J.x + s * (vx * cs - vy * sn), J.y + s * (vx * sn + vy * cs)]; };
    const dirTo = (dx, dy) => { const vx = f * dx, vy = -dy; return [vx * cs - vy * sn, vx * sn + vy * cs]; };
    const exits = new Array(J.dirs.length); let fits = true;
    best.piece.arms.forEach((m, i) => {
      const j = best.perm[i], [x, y] = to(m.x, m.y), [dx, dy] = dirTo(m.dx, m.dy);
      exits[j] = { x, y, dx, dy };
      if (J.lens[j] < Math.hypot(x - J.x, y - J.y) + hw * 0.8) fits = false; // la branche est trop courte pour la sortie de la pièce
    });
    if (fits) plans.push({ J, piece: best.piece, f, theta: best.theta, err: best.err, exits, to, s });
  }
  return plans;
}

// Réécrit les tracés autour des raccords posés : chaque tracé qui traverse ou aboutit à un nœud posé est coupé à la sortie de la pièce
// (et non plus au nœud), avec un petit point de tangence pour que le ruban parte dans l'axe de la branche.
// chains : [{ pts:[[x,y,flags,nodeId]..], closed, ends:[a,b] }]. Renvoie de nouveaux tracés avec pieceEnds:[bool,bool].
export function applyJunctions(chains, plans, hw) {
  const byNode = new Map(plans.map(p => [p.J.id, p])), out = [];
  const exitFor = (plan, nbrId) => { const j = plan.J.nbr.indexOf(nbrId); return j < 0 ? null : plan.exits[j]; };
  for (const ch of chains) {
    let pts = ch.pts;
    if (!pts.some(p => byNode.has(p[3]))) { out.push(ch); continue; }
    if (ch.closed && !byNode.has(pts[0][3])) { // boucle : on la rouvre sur un nœud posé pour que les deux bouts tombent sur une pièce
      const k = pts.findIndex(p => byNode.has(p[3])); pts = [...pts.slice(k, -1), ...pts.slice(0, k + 1)];
    }
    let cur = [], curStartsAtOrigin = true, curPieceStart = false;
    const flush = (endsAtOrigin, pieceEnd) => {
      if (cur.length >= 2) out.push({ pts: cur, closed: false, ends: [curStartsAtOrigin ? ch.ends[0] : 3, endsAtOrigin ? ch.ends[1] : 3], pieceEnds: [curPieceStart, pieceEnd] });
      cur = [];
    };
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i], plan = byNode.get(P[3]);
      if (!plan) { cur.push(P); continue; }
      const prev = i > 0 ? pts[i - 1] : null, next = i < pts.length - 1 ? pts[i + 1] : null;
      const ePrev = prev && exitFor(plan, prev[3]), eNext = next && exitFor(plan, next[3]);
      if ((prev && !ePrev) || (next && !eNext)) { cur.push(P); continue; } // voisin inattendu : on laisse le nœud tel quel
      if (prev) { // on arrive au raccord : le tracé s'arrête sur la sortie de la branche d'où l'on vient
        const m = Math.min(hw * 1.5, 0.4 * Math.hypot(prev[0] - ePrev.x, prev[1] - ePrev.y));
        cur.push([ePrev.x + ePrev.dx * m, ePrev.y + ePrev.dy * m, 0, -1], [ePrev.x, ePrev.y, 0, -1]);
        flush(false, true);
      }
      if (next) { // on repart du raccord : nouveau tracé qui commence sur la sortie de la branche d'arrivée
        const m = Math.min(hw * 1.5, 0.4 * Math.hypot(next[0] - eNext.x, next[1] - eNext.y));
        curStartsAtOrigin = false; curPieceStart = true;
        cur.push([eNext.x, eNext.y, 0, -1], [eNext.x + eNext.dx * m, eNext.y + eNext.dy * m, 0, -1]);
      }
    }
    flush(true, false);
    curStartsAtOrigin = true; curPieceStart = false;
  }
  return out;
}
