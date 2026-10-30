import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadObjectModel, cloneModel, bindTexToggles } from '/model-loader.js';
import { applyHouseColor } from '/w3d-three.js';
import { buildTerrain } from '/terrain.js';
import { texturizeTerrain } from '/terrain-tex.js';
import { setCameo } from '/cameos.js';
import { loadMapFeatures } from '/features.js';
import { PLAYER_COLORS } from '/shared/colors.js';
import { createRoomUI } from '/room.js';

const $ = id => document.getElementById(id);
const COLORS = [0x4aa3ff, 0xff5050, 0x50d070, 0xffc040, 0xc070ff, 0x40e0d0, 0xff80c0, 0xa0a0a0];
const colorOf = owner => (owner === 0 ? 0x888888 : PLAYER_COLORS[players.get(owner)?.color]?.hex ?? COLORS[(owner - 1) % COLORS.length]); // couleur choisie dans la salle d'attente
let roomUI = null, roomShown = false, backToRoom = false, roomSettings = { money: 10000, max: 8 }, slotsN = 8, moneyChoices = [], curMapInfo = null;
const hex = c => '#' + c.toString(16).padStart(6, '0');
const TAU = Math.PI * 2;
const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const MAP_LIMIT = 2000;
bindTexToggles($('texV'), $('texU'));

// ---------- scène ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10151a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 20000);
camera.position.set(0, 220, 220);
const controls = new OrbitControls(camera, canvas);
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 }; // gauche/droit = jeu
controls.enablePan = false;
controls.maxPolarAngle = Math.PI / 2.1;
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(200, 400, 150); scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x2a3a2c, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
let grid = new THREE.GridHelper(4000, 200, 0x4a5d4c, 0x364638);
scene.add(grid);
let curStarts = [], curPreview = null, previewFor = ''; // points de départ de la carte (0..1) pour le choix d'emplacement ; aperçu .tga décodé
function decodeTga(buf) { // TGA non compressé (2/3) ou RLE (10/11), 8/24/32 bits -> ImageData
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
function setMap(m) { // sol et grille à la taille de la carte choisie (sinon 4000×4000)
  curMapInfo = m ?? null; curStarts = m?.starts ?? []; curPreview = null; previewFor = m?.preview ?? '';
  if (m?.preview) { const want = m.preview; fetch(want).then(r => r.arrayBuffer()).then(b => { const img = decodeTga(b), t = document.createElement('canvas'); t.width = img.width; t.height = img.height; t.getContext('2d').putImageData(img, 0, 0); if (previewFor === want) { curPreview = t; roomUI?.render(); } }).catch(() => {}); } // image de la carte (aperçu du jeu)
  roomUI?.render();
  const w = m?.w ?? 4000, h = m?.h ?? 4000;
  ground.scale.set(w / 4000, h / 4000, 1);
  scene.remove(grid); grid.geometry.dispose();
  const size = Math.max(w, h);
  grid = new THREE.GridHelper(size, Math.max(10, Math.round(size / 20)), 0x4a5d4c, 0x364638);
  scene.add(grid);
  loadTerrain(m);
}
// ---------- décor de la carte (arbres, rochers... : statique, indestructible) ----------
// Le serveur envoie { types: [{ o: objet, r: rayon }], rows: [[type, x, y, angle]...] } ; les modèles viennent des INI comme pour les unités.
const propsGroup = new THREE.Group();
scene.add(propsGroup);
let propList = [], propGen = 0;
function setProps(d) {
  propGen++; propsGroup.clear(); propList = [];
  if (!d?.rows?.length) return;
  const gen = propGen, models = d.types.map(t => loadObjectModel(t.o, []).catch(() => null)); // un chargement par type d'objet
  let i = 0;
  const place = async () => { // par paquets : des milliers d'arbres ne doivent pas figer la page
    for (const end = Math.min(d.rows.length, i + 150); i < end; i++) {
      const [t, x, y, a, z = 0] = d.rows[i], m = await models[t];
      if (gen !== propGen) return; // une autre partie a commencé entre-temps
      if (!m) continue;
      const { inst } = cloneModel(m);
      inst.position.set(x, groundY(x, y) + z, -y); inst.rotation.y = a; // z : décalage vertical posé dans le .map (sol + z, comme le moteur)
      inst.updateMatrix(); inst.matrixAutoUpdate = false; // statique : plus aucun calcul par image
      propsGroup.add(inst); propList.push({ inst, x, y, z });
    }
    if (i < d.rows.length) setTimeout(place, 0);
  };
  place();
}
function reseatProps() { for (const p of propList) { p.inst.position.y = groundY(p.x, p.y) + p.z; p.inst.updateMatrix(); } } // le relief est arrivé après le décor

// ---------- relief de la carte (hauteurs lues par le serveur dans le .map) ----------
let terrain = null; // { id, mesh, at, hit, cell }
let features = null; // routes, rails, ponts et train de la carte (client/features.js)
const groundY = (x, y) => (terrain ? terrain.at(x, y) : 0);
async function loadTerrain(map) {
  if (terrain && terrain.id === map?.id) return;
  features?.dispose(); features = null;
  if (terrain) { scene.remove(terrain.mesh); terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose(); terrain = null; }
  ground.visible = grid.visible = true; // sans relief : sol plat
  if (!map) return;
  try {
    const r = await fetch(`/api/map/${encodeURIComponent(map.id)}/terrain`);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const [W, H, B] = r.headers.get('X-Terrain').split(',').map(Number);
    const hs = new Uint8Array(await r.arrayBuffer());
    if (curMapId !== map.id || hs.length !== W * H) return; // la carte a changé entre-temps
    terrain = { id: map.id, ...buildTerrain(map, W, H, B, hs) };
    scene.add(terrain.mesh); ground.visible = grid.visible = false;
    reseatProps();
    focusMyBase();
    const mine = terrain; // textures du terrain (BlendTileData + art/terrain) : posées dès qu'elles sont prêtes, le relief colorié par l'altitude sert en attendant
    texturizeTerrain(mine, map, W, H, B, () => terrain !== mine).then(ok => { if (ok) console.info(`[terrain] textures : ${mine.texInfo.classes.join(', ')}`); })
      .catch(e => console.warn('Textures du terrain indisponibles (couleurs par altitude) :', e.message));
    loadMapFeatures({ scene, terrain: mine, map, mapId: map.id, shouldAbort: () => terrain !== mine }) // routes, rails, ponts, train
      .then(f => { if (f) { features = f; console.info('[carte] routes/rails/ponts/train :', JSON.stringify(f.stats)); } })
      .catch(e => console.warn('Routes, ponts et train indisponibles :', e.message));
  } catch (e) { console.warn('Relief indisponible, sol plat :', e.message); }
}

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------- état ----------
let me = 0, phase = 'lobby', hostId = 0, dev = false, myMoney = 0, roomName = '', curMapId = '', curMapName = '';
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const units = new Map(); // id -> { id, owner, object, root, ring, bar, bg, fill, model, muzzles, x,y,a, tx,ty,ta, radius, hp, mh, h, cn, st }
window.zhoUnits = units; // diagnostic console
const selected = new Set();
const players = new Map();
let factions = [];

function amSpectator() { const p = players.get(me); return !p || p.spectator; }
const shortName = n => n.replace(/^(America|China|GLA)/i, '').replace(/^(Vehicle|Infantry|Structure)/i, '') || n;

function setStatus() {
  const mine = [...units.values()].filter(u => u.owner === me).length;
  const where = phase === 'lobby' ? 'Salon' : phase === 'playing' ? 'Partie en cours' : 'Partie terminée';
  $('status').textContent = `${roomName ? roomName + ' · ' : ''}${curMapName ? curMapName + ' · ' : ''}${where} — joueur #${me}${amSpectator() && phase === 'playing' ? ' (spectateur)' : ''} — ${mine} unité(s) à toi, ${selected.size} sélectionnée(s)`;
  $('money').textContent = phase === 'lobby' ? '' : `$ ${Math.floor(myMoney)}`;
  $('players').innerHTML = [...players.values()].map(p =>
    `<span style="color:${hex(colorOf(p.id))}">■</span> ${esc(p.name)}${p.id === me ? ' (toi)' : ''}${p.id === hostId ? ' ★' : ''} — ${p.spectator ? 'spectateur' : `${shortFaction(p.faction)}, équipe ${p.team}${p.slot != null && curStarts.length ? `, empl. ${p.slot + 1}` : ''}${p.ready && phase !== 'playing' ? ' ✔ prêt' : ''}`}`).join('<br>');
  const showRoom = phase === 'lobby' || (phase === 'ended' && backToRoom); // salle d'attente plein écran avant la partie, et après si on y retourne
  if (showRoom !== roomShown) { roomShown = showRoom; roomUI?.show(showRoom); }
  $('lobby').style.display = phase === 'ended' && !backToRoom ? 'block' : 'none'; // fin de partie : bouton de retour à la salle
  $('dev').style.display = dev ? 'block' : 'none';
  $('diag').style.display = dev ? 'flex' : 'none'; // diagnostic des textures : réservé au mode dev
}
const shortFaction = f => f || '?';

// ---------- barres de vie ----------
const PLANE = new THREE.PlaneGeometry(1, 1);
const BAR_BG = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.65, depthTest: false });

function makeBar() {
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(PLANE, BAR_BG); bg.renderOrder = 10;
  const fill = new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({ color: 0x40e060, depthTest: false })); fill.renderOrder = 11; fill.position.z = 0.01;
  bar.add(bg, fill);
  return { bar, bg, fill };
}

function updateBar(u) {
  const ratio = u.mh > 0 ? Math.max(0, Math.min(1, u.hp / u.mh)) : 1;
  u.bar.visible = u.mh > 0 && (ratio < 1 || selected.has(u.id));
  if (!u.bar.visible) return;
  const w = Math.max(u.radius * 1.8, 12), iw = w - 1;
  u.bg.scale.set(w, 3, 1);
  u.fill.scale.set(Math.max(0.01, ratio * iw), 1.8, 1);
  u.fill.position.x = -(iw * (1 - ratio)) / 2;
  u.fill.material.color.setHex(u.cn ? 0x4aa3ff : ratio > 0.5 ? 0x40e060 : ratio > 0.25 ? 0xf0c030 : 0xe04040);
}

// ---------- unités ----------
// (Re)charge le modèle d'une unité selon ses conditions de modèle (améliorations : POWER_PLANT_UPGRADED, USER_1...).
function attachModel(u) {
  const conds = [...(u.mc ?? [])].sort(), sig = conds.join(',');
  u.msig = sig;
  loadObjectModel(u.object, conds).then(m => {
    if (!units.has(u.id) || u.msig !== sig) return; // morte, ou des conditions plus récentes sont arrivées
    const { inst, mixer, rotors, actions, state, door, upAnim } = cloneModel(m); // instance indépendante : os, animation (drapeaux, ventilos) et rotors
    if (u.model) u.root.remove(u.model);
    u.houseMats = applyHouseColor(inst, colorOf(u.owner)); // HouseColor : le modèle porte la couleur du joueur
    u.muzzles = []; u.stealthOn = false;
    inst.traverse(o => { if (o.userData?.muzzle) u.muzzles.push(o); });
    u.turret = findTurret(inst, m); // tourelle : os et paramètres de l'INI
    u.launch = findBone(inst, m.parts.map(p => p.bones?.launch).find(Boolean)); // WeaponLaunchBone : d'où part le tir
    u.root.add(inst);
    u.model = inst; u.mixer = mixer; u.rotors = rotors; u.actions = actions; u.animState = state; u.door = door; if (door && u.doorLog) door.setPhase(u.doorLog[1], u.doorLog[0], 0); // rejouée sans durée : la porte prend directement sa pose
    u.upAnim = upAnim || null; u.upFrac = null; // progression de l'animation d'amélioration : recalculée à chaque image
    u.h = m.size.y + 5;
    applySub(u); applyStealth(u);
  }).catch(e => { showMsg(e.message); console.warn(e); });
}
// Sous-objets montrés / cachés par une amélioration (SubObjectsUpgrade).
function applySub(u) {
  if (!u.model || !u.sub) return;
  const show = new Set(u.sub.show), hide = new Set(u.sub.hide);
  u.model.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const short = (o.name ?? '').split('#')[0].split('.').pop().toUpperCase();
    if (show.has(short)) o.visible = true; else if (hide.has(short)) o.visible = false;
  });
}
// Unité furtive (StealthUpgrade) : à moitié transparente (matériaux copiés : ceux du modèle sont partagés entre instances).
function applyStealth(u) {
  if (!u.model || !u.stealth || u.stealthOn) return;
  u.stealthOn = true;
  u.model.traverse(o => {
    if (!o.material) return;
    const fix = m => { const c = m.cloneModel(); c.transparent = true; c.opacity = Math.min(c.opacity, 0.45); return c; };
    o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
  });
}
// État visuel envoyé par le serveur : { id: { mc, sub, cs, sl } }.
function applyVisuals(v) {
  for (const u of units.values()) {
    const s = v[u.id] ?? null, mc = s?.mc ?? [], sig = JSON.stringify(s);
    if (u.vsig === sig) continue;
    u.vsig = sig;
    const csChanged = (u.cs ?? null) !== (s?.cs ?? null);
    u.sub = s?.sub ?? null; u.cs = s?.cs ?? null; u.stealth = !!s?.sl;

    const mcSig = [...mc].sort().join(',');
    if (mcSig !== [...(u.mc ?? [])].sort().join(',')) { u.mc = mc; attachModel(u); } else { applySub(u); applyStealth(u); }
    if (csChanged && selected.has(u.id)) refreshCommands();
  }
}
// Ravitailleurs (Chinook, camions) : les modèles des états d'accostage sont chargés dès l'apparition de l'unité, sinon le changement d'état
// attend le téléchargement du modèle et l'animation démarre en retard sur le serveur (filet coupé, caisse qui disparaît trop tôt).
const dockPreloaded = new Set();
function preloadDocking(object) {
  if (dockPreloaded.has(object)) return;
  dockPreloaded.add(object);
  for (const cs of [['DOCKING'], ['CARRYING'], ['CARRYING', 'DOCKING'], ['DOCKING_ACTIVE'], ['CARRYING', 'DOCKING_ACTIVE']]) loadObjectModel(object, cs).catch(() => {}); // conditions triées, comme attachModel
}
function addUnit(d) {
  if (units.has(d.id)) return;
  if (d.sp) preloadDocking(d.object);
  const root = new THREE.Group();
  root.userData.unitId = d.id;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.12, 48),
    new THREE.MeshBasicMaterial({ color: colorOf(d.owner), side: THREE.DoubleSide, transparent: true, opacity: 0.4, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; ring.scale.setScalar(d.r ?? 8); // le cercle = zone de collision du serveur
  root.add(ring);
  root.position.set(d.x, 0, -d.y); root.rotation.y = d.a;
  scene.add(root);
  const { bar, bg, fill } = makeBar();
  scene.add(bar);
  const u = { id: d.id, owner: d.owner, object: d.object, root, ring, bar, bg, fill, model: null, muzzles: [], flashT: 0, mixer: null, rotors: [], actions: null, animState: null, movedAt: 0, shotAt: 0, air: !!d.air, fly: d.fl ?? null, bank: 0, fh: d.fh ?? 0, lm: d.lm ?? 0, ld: d.ld ?? 0, cg: d.cg ?? [], sc: d.sc ?? 0, dk: d.dk ?? 0, ck: d.ck ?? '', cp: d.cp ?? 0, cc: d.cc ?? 0, z: 0, mz: d.mz ?? 0,
    x: d.x, y: d.y, a: d.a, tx: d.x, ty: d.y, ta: d.a, radius: d.r ?? 8, hp: d.hp ?? 0, mh: d.mh ?? 0, h: 14, cn: !!d.cn, st: !!d.st, rp: d.rp ?? null, flag: null };
  units.set(d.id, u);
  attachModel(u);
  updateBar(u);
  refreshRings();
}

// ---------- drapeau de sortie (point de ralliement) ----------
// Visible quand un de mes bâtiments de production est sélectionné ; clic droit au sol = le déplacer.
const FLAG_POLE = new THREE.CylinderGeometry(0.5, 0.5, 26, 6);
const FLAG_CLOTH = (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 14, -4.5, 0, 0, -9, 0]), 3)); return g; })();
function makeFlag(owner) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(FLAG_POLE, new THREE.MeshBasicMaterial({ color: 0xdddddd, depthTest: false }));
  pole.position.y = 13;
  const cloth = new THREE.Mesh(FLAG_CLOTH, new THREE.MeshBasicMaterial({ color: colorOf(owner), side: THREE.DoubleSide, depthTest: false }));
  cloth.position.set(0.5, 25, 0); // triangle accroché au sommet du mât, flottant vers +X
  g.add(pole, cloth); g.traverse(o => { o.renderOrder = 15; });
  return g;
}
function updateRally(u) {
  const show = u.rp && u.owner === me && selected.has(u.id) && !u.cn;
  if (show && !u.flag) { u.flag = makeFlag(u.owner); scene.add(u.flag); }
  if (u.flag) { u.flag.visible = !!show; if (u.rp) u.flag.position.set(u.rp[0], groundY(u.rp[0], u.rp[1]), -u.rp[1]); }
}

function removeUnit(id) {
  const u = units.get(id);
  if (!u) return;
  scene.remove(u.root); scene.remove(u.bar);
  u.fill.material.dispose();
  u.houseMats?.forEach(m => m.dispose());
  if (u.flag) { scene.remove(u.flag); u.flag.traverse(o => o.material?.dispose()); }
  units.delete(id);
  selected.delete(id);
}

function clearUnits() { for (const id of [...units.keys()]) removeUnit(id); selected.clear(); }

function showMsg(t) { $('msg').textContent = t; clearTimeout(showMsg.t); showMsg.t = setTimeout(() => { $('msg').textContent = ''; }, 4000); }

function flash(u) { // muzzle flash : visible le temps d'un tir
  if (!u.muzzles.length) return;
  for (const m of u.muzzles) m.visible = true;
  clearTimeout(u.flashT);
  u.flashT = setTimeout(() => { for (const m of u.muzzles) m.visible = false; }, 90);
}

// ---------- tourelles (données de l'INI) ----------
// Draw : Turret = Turret01 (os de cap), TurretPitch = TurretEL (os d'élévation), WeaponLaunchBone = PRIMARY Muzzle (départ du tir).
// AIUpdateInterface > Turret : TurretTurnRate, TurretPitchRate, NaturalTurretAngle / Pitch, FirePitch, balayage au repos (MinIdleScan*, MaxIdleScan*).
// Le tireur braque la tourelle sur sa cible (snapshot : 6e champ) ou sur son dernier tir ; sans cible elle revient à sa position naturelle
// et balaie au hasard autour d'elle. Angle 0 = pose du modèle ; angles en radians.
const AXE_Z = new THREE.Vector3(0, 0, 1), AXE_Y = new THREE.Vector3(0, 1, 0), QTMP = new THREE.Quaternion();
function findBone(inst, name) { // le moteur accepte "Muzzle" ou "Muzzle01" pour l'os nommé "Muzzle"
  if (!name) return null;
  const want = name.toUpperCase().replace(/[ _]/g, ''); let exact = null, numbered = null;
  inst.traverse(o => {
    if (!o.isBone) return;
    const n = (o.userData?.pivot ?? o.name ?? '').toUpperCase().replace(/[ _]/g, '');
    if (n === want) exact ??= o; else if (n === want + '01') numbered ??= o;
  });
  return exact ?? numbered;
}
function findTurret(inst, m) {
  const p = m.parts.find(p => p.bones?.turret || p.bones?.pitch);
  if (!p) return null;
  const yaw = findBone(inst, p.bones.turret), pitch = findBone(inst, p.bones.pitch);
  if (!yaw && !pitch) { console.warn('[ZHO] tourelle : os introuvables', p.bones); return null; }
  const tu = m.object?.turret ?? {}, sc = tu.scan ?? {};
  console.log('[ZHO] tourelle', m.object?.name, 'cap=' + (yaw?.userData.pivot ?? '-'), 'élévation=' + (pitch?.userData.pivot ?? '-'), JSON.stringify(tu));
  return { yaw, pitch, yawRest: yaw?.quaternion.clone(), pitchRest: pitch?.quaternion.clone(),
           turn: tu.turnRate ?? 1.5, pitchRate: tu.pitchRate || tu.turnRate || 1.5, nat: tu.natAngle ?? 0, natPitch: tu.natPitch ?? 0, firePitch: tu.firePitch ?? tu.natPitch ?? 0, allowsPitch: tu.allowsPitch ?? false,
           scan: sc, ang: tu.natAngle ?? 0, pit: tu.natPitch ?? 0, scanUntil: 0, scanOff: 0 };
}
function updateTurret(u, dt) {
  const T = u.turret; if (!T) return;
  const now = performance.now();
  const tgt = u.aimId ? units.get(u.aimId) : null;
  let tx = null, ty = null;
  if (tgt) { tx = tgt.x; ty = tgt.y; }
  else if (u.lastShot && now - u.shotAt < 2500) { tx = u.lastShot.x; ty = u.lastShot.y; }
  let want, wantPitch;
  if (tx != null) { want = wrap(Math.atan2(ty - u.y, tx - u.x) - u.a); wantPitch = T.firePitch; } // angle monde -> repère du bâtiment
  else {
    wantPitch = T.natPitch;
    const sc = T.scan;
    if (sc.maxAngle > 0 && now > T.scanUntil) { // balayage au repos : nouvel écart au hasard autour de la position naturelle
      T.scanUntil = now + 1000 * (sc.minInterval + Math.random() * Math.max(0, sc.maxInterval - sc.minInterval));
      T.scanOff = (Math.random() < 0.5 ? -1 : 1) * (sc.minAngle + Math.random() * (sc.maxAngle - sc.minAngle));
    }
    want = wrap(T.nat + (sc.maxAngle > 0 ? T.scanOff : 0));
  }
  const step = T.turn * dt;
  T.ang = wrap(T.ang + Math.max(-step, Math.min(step, wrap(want - T.ang))));
  if (T.allowsPitch) { const ps = T.pitchRate * dt; T.pit += Math.max(-ps, Math.min(ps, wantPitch - T.pit)); }
  if (T.yaw) T.yaw.quaternion.copy(T.yawRest).multiply(QTMP.setFromAxisAngle(AXE_Z, T.ang));
  if (T.pitch) T.pitch.quaternion.copy(T.pitchRest).multiply(QTMP.setFromAxisAngle(AXE_Y, -T.pit)); // +Y baisse l'avant : on inverse
}

// ---------- effets : projectiles et explosions ----------
const SPHERE = new THREE.SphereGeometry(1, 12, 8);
const fx = []; // { mesh, born, dur, update(f) }
function addFx(color, dur, update) {
  const mesh = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
  scene.add(mesh);
  fx.push({ mesh, born: performance.now(), dur: dur * 1000, update });
}
function blast(x, y, r, dur, color = 0xffa030, z = 0) {
  addFx(color, dur, (m, f) => { m.position.set(x, 6 + z + groundY(x, y), -y); m.scale.setScalar(r * (0.3 + 0.7 * f)); m.material.opacity = 0.85 * (1 - f); });
}
function projectile(e) {
  const dur = Math.max(0.12, e.travel / 30);
  const z0 = e.z ?? 0, z1 = e.tz ?? 0;
  addFx(0xffe080, dur, (m, f) => { const px = e.x + (e.tx - e.x) * f, py = e.y + (e.ty - e.y) * f; m.position.set(px, 6 + z0 + (z1 - z0) * f + groundY(px, py), -py); m.scale.setScalar(1.4); m.material.opacity = 1; });
}

function banner(text, sub = '') {
  const b = $('banner');
  b.innerHTML = `${text}<small>${sub}</small>`;
  b.style.display = 'flex';
}
$('banner').onclick = () => { $('banner').style.display = 'none'; };

function handleEvent(e) {
  if (e.k === 'spawn') addUnit(e.unit);
  else if (e.k === 'shot') {
    const su = units.get(e.a);
    if (su) {
      flash(su); su.shotAt = performance.now(); su.lastShot = { x: e.tx, y: e.ty };
      const mz = su.launch ?? su.muzzles?.[0]; // le tir part de WeaponLaunchBone (à défaut du sous-objet de flamme), plus du centre du bâtiment
      if (mz) { const p = mz.getWorldPosition(new THREE.Vector3()); e = { ...e, x: p.x, y: -p.z, z: p.y - 6 }; }
    }
    projectile(e);
  }
  else if (e.k === 'hit') blast(e.x, e.y, Math.max(e.r, 4), 0.35, 0xffa030, e.z ?? 0);
  else if (e.k === 'dying') { // début d'agonie (SlowDeathBehavior) ou épave (KeepObjectDie)
    const u = units.get(e.id);
    if (u) { selected.delete(u.id); refreshRings(); u.dying = { t0: performance.now(), sd: e.sd, sr: e.sr, wreck: e.dl < 0 }; if (e.dl >= 0) blast(e.x, e.y, Math.max(e.r * 1.2, 10), 0.6, 0xff8030, u.fh ?? 0); }
  }
  else if (e.k === 'in') { removeUnit(e.id); const c = units.get(e.c); if (c) { c.ld = e.n; c.cg = e.cg ?? c.cg; if (selected.has(c.id)) refreshCommands(); } refreshRings(); } // un passager monte : il disparaît du monde
  else if (e.k === 'cargo') { const c = units.get(e.id); if (c) { c.ld = e.n; c.cg = e.cg ?? c.cg; if (selected.has(c.id)) refreshCommands(); } }
  else if (e.k === 'own') { const u = units.get(e.id); if (u) { u.owner = e.o; if (e.o !== me) selected.delete(u.id); if (!e.g) attachModel(u); refreshRings(); } } // bâtiment neutre occupé / libéré : il change de camp (g : simple garnison, on garde le modèle tel quel ; une capture le recolore)
  else if (e.k === 'gone') { removeUnit(e.id); refreshRings(); } // objet retiré sans explosion (entrepôt vidé)
  else if (e.k === 'cash') { if (units.get(e.id)?.owner === me) showMsg(e.dep ? `+${e.v} $ (revenu)` : `+${e.v} $ livrés`); }
  else if (e.k === 'dead') { removeUnit(e.id); blast(e.x, e.y, Math.max(e.r * 1.8, 12), 0.8, 0xff6020, e.z ?? 0); refreshRings(); }
  else if (e.k === 'door') {
    const u = units.get(e.id);
    if (!u) return;
    u.doorLog = [e.door, e.ph, e.dur]; // dernière phase reçue : rejouée si le modèle arrive après l'évènement
    if (u.door) u.door.setPhase(e.ph, e.door, e.dur); else console.warn('[porte] évènement reçu mais', u.object, 'n\'a pas de porte animée', e);
  }
  else if (e.k === 'alt') { const u = units.get(e.id); if (u) u.fh = e.fh; }
  else if (e.k === 'upg') { if (units.get(e.id)?.owner === me) showMsg(`Amélioration terminée : ${shortName(e.name.replace(/^Upgrade_/, ''))}`); }
  else if (e.k === 'morph') { const u = units.get(e.id); if (u) { u.object = e.object; u.radius = e.r; u.mh = e.mh; attachModel(u); if (selected.has(u.id)) refreshCommands(); } }
  else if (e.k === 'rally') { const u = units.get(e.id); if (u) { u.rp = [e.x, e.y]; updateRally(u); } }
  else if (e.k === 'built') { const u = units.get(e.id); if (u) { u.cn = false; refreshRings(); } }
  else if (e.k === 'out') {
    e.removed.forEach(removeUnit);
    const p = players.get(e.owner);
    showMsg(`${p ? p.name : 'Un joueur'} est éliminé`);
    if (e.owner === me) banner('Éliminé', 'Ta base est détruite. Tu peux regarder la fin de la partie.');
    refreshRings();
  } else if (e.k === 'end') {
    if (e.winners.includes(me)) banner('Victoire !', 'Clique pour fermer, puis « Retour à la salle d\'attente » pour rejouer.');
    else if (!$('banner').style.display || $('banner').style.display === 'none') banner('Partie terminée', 'Clique pour fermer, puis « Retour à la salle d\'attente » pour rejouer.');
  }
}

// ---------- réseau ----------
const params = new URLSearchParams(location.search);
const roomId = (params.get('room') || '').toUpperCase();
if (!roomId) location.replace('/lobby.html'); // pas de room : retour au lobby
const myName = params.get('name') || localStorage.getItem('zho-name') || '';
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
ws.onopen = () => send({ t: 'join', room: roomId, name: myName });
ws.onclose = () => { $('status').textContent = 'Déconnecté du serveur (recharge la page ou retourne au lobby)'; };

// Salle d'attente : tout l'affichage et les choix sont dans room.js ; game.js fournit l'état et l'envoi réseau.
roomUI = createRoomUI({
  send,
  state: () => ({ me, hostId, phase, roomId, roomName, players, factions, moneyChoices, settings: roomSettings, slots: slotsN, map: curMapInfo, starts: curStarts, preview: curPreview }),
});
$('backRoom').onclick = () => { backToRoom = true; $('banner').style.display = 'none'; setStatus(); };

function focusMyBase() {
  let best = null;
  for (const u of units.values()) if (u.owner === me && (!best || u.radius > best.radius)) best = u;
  if (!best) return;
  const gy = groundY(best.x, best.y);
  controls.target.set(best.x, gy, -best.y);
  camera.position.set(best.x, gy + 230, -best.y + 230);
}

function setPlayers(m) {
  phase = m.phase; hostId = m.host;
  if (m.settings) roomSettings = m.settings;
  if (m.slots != null) slotsN = m.slots;
  players.clear(); for (const p of m.players) players.set(p.id, p);
  setStatus(); roomUI?.render();
}

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.t === 'welcome') {
    me = m.you; dev = m.dev; factions = m.factions; moneyChoices = m.moneyChoices ?? []; backToRoom = false;
    roomName = m.room?.name ?? ''; curMapId = m.map?.id ?? ''; curMapName = m.map?.name ?? ''; setMap(m.map); setProps(m.props); document.title = `${roomName} — Zero Hour Online`;
    myMoney = m.money?.[me] ?? 0;
    setPlayers(m);
    m.units.forEach(addUnit);
    if (m.phase !== 'lobby') focusMyBase();
  } else if (m.t === 'players') setPlayers(m);
  else if (m.t === 'start') {
    clearUnits(); phase = 'playing'; backToRoom = false; $('banner').style.display = 'none'; curMapId = m.map?.id ?? ''; curMapName = m.map?.name ?? ''; setMap(m.map); setProps(m.props);
    myMoney = m.money?.[me] ?? 0;
    m.units.forEach(addUnit);
    focusMyBase(); setStatus(); refreshRings();
  } else if (m.t === 'leave') { m.removed.forEach(removeUnit); refreshRings(); }
  else if (m.t === 'snap') {
    for (const [id, x, y, a, hp, at] of m.u) { const u = units.get(id); if (u) { u.aimId = at || null; if (Math.hypot(x - u.tx, y - u.ty) > 0.05) u.movedAt = performance.now(); u.tx = x; u.ty = y; u.ta = a; u.hp = hp; } }
    if (m.m && m.m[me] !== undefined && Math.floor(m.m[me]) !== Math.floor(myMoney)) { myMoney = m.m[me]; $('money').textContent = `$ ${Math.floor(myMoney)}`; }
    bst = m.b ?? {}; pup = m.pu ?? {}; energy = m.e ?? {};
    for (const u of units.values()) { const h = bst[u.id]?.q?.[0]; u.upgProg = h && h[2] === 1 ? h[1] : null; } // progression de l'amélioration en tête de file (même sans sélection)
    if (m.v) applyVisuals(m.v);
    updatePanel(); updateEnergy();
  } else if (m.t === 'ev') m.e.forEach(handleEvent);
  else if (m.t === 'map') { curMapId = m.map?.id ?? ''; curMapName = m.map?.name ?? ''; setMap(m.map); showMsg(`Carte : ${m.map?.name ?? 'aucune'}`); }
  else if (m.t === 'countdown') { showMsg(`Lancement dans ${m.n}…`); roomUI.countdown(m.n); }
  else if (m.t === 'cancel') { showMsg(m.msg); roomUI.cancelled(m.msg); }
  else if (m.t === 'chat') { const p = [...players.values()].find(q => q.name === m.from); roomUI.chat(m.from, m.text, !!m.sys, p ? roomUI.colorHex(p.color) : null); }
  else if (m.t === 'kicked') location.replace('/lobby.html?kicked=1');
  else if (m.t === 'error') { showMsg(m.msg); if (roomShown) roomUI.chat('', `⚠ ${m.msg}`, true); if (m.fatal) setTimeout(() => location.replace('/lobby.html'), 2500); }
};

// ---------- barre de commandes : production et construction ----------
const infoCache = new Map();
const getInfo = (name, set = null) => {
  const key = name + '|' + (set ?? '');
  if (!infoCache.has(key)) infoCache.set(key, fetch(`/api/object/${encodeURIComponent(name)}${set ? '?set=' + encodeURIComponent(set) : ''}`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return infoCache.get(key);
};

// État reçu du serveur : file de production, améliorations de chaque bâtiment, améliorations de joueur, énergie.
let bst = {}, pup = {}, energy = {};
let panelFor = null, panelEls = [];   // bâtiment affiché + éléments de bouton (mis à jour sur place, jamais reconstruits à chaque instantané)
let cmdToken = 0;
const SLOTS = 14;

// ---------- disposition du panneau de commandes ----------
// 'h' = barre horizontale en bas, 'v' = colonne verticale à droite (voir cmd.css).
let cmdMode = localStorage.getItem('cmd-mode') || 'h';
if (cmdMode !== 'h' && cmdMode !== 'v') cmdMode = 'h';
let cmdCompact = localStorage.getItem('cmd-compact') === '1';   // masque les emplacements vides
let cmdMini = false;                                            // panneau réduit à son en-tête

function applyCmdMode(resetPos = false) {
  const p = $('cmd');
  p.classList.toggle('h', cmdMode === 'h');
  p.classList.toggle('v', cmdMode === 'v');
  p.classList.toggle('compact', cmdCompact);
  p.classList.toggle('mini', cmdMini);
  if (resetPos) { // on reprend la position prévue par le mode (le déplacement manuel est effacé)
    p.style.left = p.style.top = p.style.right = p.style.bottom = p.style.transform = '';
  }
}
function toggleCmdMode() {
  cmdMode = cmdMode === 'h' ? 'v' : 'h';
  localStorage.setItem('cmd-mode', cmdMode);
  applyCmdMode(true);
}
function toggleCmdCompact() {
  cmdCompact = !cmdCompact;
  localStorage.setItem('cmd-compact', cmdCompact ? '1' : '0');
  applyCmdMode();
}
function toggleCmdMini() {
  cmdMini = !cmdMini;
  applyCmdMode();
}

// Bouton « Évacuer » : visible dès que la sélection contient un de mes conteneurs (véhicule, garnison, tunnel) avec des occupants.
function updateEvac() {
  const ids = [...selected].filter(id => { const u = units.get(id); return u && u.owner === me && u.ld > 0; });
  return ids;
}
async function refreshCommands() {
  updateEvac();
  const token = ++cmdToken, panel = $('cmd');
  panel.innerHTML = ''; panel.style.display = 'none'; panelFor = null; panelEls = [];
  if (phase !== 'playing' || selected.size !== 1) return;
  const u = units.get([...selected][0]);
  if (!u || u.cn) return;
  const mine = u.owner === me;
  const garrisonView = !!u.lm && (mine || (u.owner === 0 && u.ck === 'garrison')); // bâtiment à garnison neutre : on voit ses emplacements, sans commandes
  if (!mine && !garrisonView) return;
  const info = mine ? await getInfo(u.object, u.cs) : { buttons: [] }; // u.cs : jeu de commandes imposé par une amélioration
  if (token !== cmdToken || !info) return; // la sélection a changé entre-temps
  if (!info.buttons.length && !u.lm) return;

  const head = document.createElement('div'); head.className = 'head';
  if (info.images?.portrait) { const pt = document.createElement('div'); pt.className = 'portrait'; head.appendChild(pt); setCameo(pt, info.images.portrait, 'on'); } // portrait de l'unité sélectionnée (SelectPortrait)
  head.insertAdjacentHTML('beforeend', `<b>${shortName(u.object)}</b>${u.lm ? `<small> — passagers ${u.ld}/${u.lm}</small>` : ''}<span class="hp"></span>`);
  // Petits boutons de l'en-tête : disposition, compactage, réduction
  const miniBtn = (title, txt, fn) => {
    const b = document.createElement('button');
    b.className = 'mini'; b.title = title; b.textContent = txt;
    b.onclick = e => { e.stopPropagation(); fn(); };
    b.onmousedown = e => e.stopPropagation(); // ne pas démarrer le déplacement du panneau
    return b;
  };
  head.append(
    miniBtn('Disposition : barre horizontale (H) ou colonne verticale (V)', '⇄', toggleCmdMode),
    miniBtn('Masquer les emplacements vides', '≡', toggleCmdCompact),
    miniBtn('Réduire / restaurer le panneau', '–', toggleCmdMini),
  );
  const queue = document.createElement('div'); queue.className = 'queue';
  const grid = document.createElement('div'); grid.className = 'grid';
  const cells = Array.from({ length: SLOTS }, () => document.createElement('i'));
  cells.forEach(c => grid.appendChild(c));
  panelEls = [];
  for (const b of info.buttons) {
    if (b.slot < 1 || b.slot > SLOTS) continue;
    const el = document.createElement('button');
    el.className = 'b ' + (b.upgrade ? 'upg' : b.command === 'SPECIAL_POWER' ? 'pwr' : /^(SELL|STOP)$/.test(b.command) ? 'sys' : '');
    const cost = b.cost !== undefined && (b.object || b.upgrade) ? `<em>$${b.cost}</em><span>${b.time ? Math.round(b.time) + ' s' : ''}</span>` : '<span></span>';
    el.innerHTML = `<span class="n">${b.label}</span><span class="c">${cost}</span><span class="bar" style="width:0"></span>`;
    setCameo(el, b.img); // cameo du bouton (MappedImage de ButtonImage)
    el.title = `${b.label}${b.object ? ' — ' + b.object : b.upgrade ? ' — ' + b.upgrade : ''}${b.ok ? '' : '\n(pas encore géré dans cette version)'}`;
    el.onclick = () => {
      if (b.command === 'DOZER_CONSTRUCT') startPlacing(u.id, b);
      else if (b.command === 'SELL') { if (confirm('Vendre ce bâtiment ?')) send({ t: 'press', building: u.id, button: b.button }); }
      else send({ t: 'press', building: u.id, button: b.button });
    };
    cells[b.slot - 1].replaceWith(el);
    panelEls.push({ b, el, bar: el.querySelector('.bar') });
  }
  const parts = [head, queue];
  if (info.buttons.length) parts.push(grid);
  if (u.lm) parts.push(buildSlots(u, mine));
  panel.append(...parts);
  panel.style.display = 'flex';
  applyCmdMode();          // applique la disposition choisie (sans bouger le panneau)
  panelFor = { id: u.id, head, queue, info, qsig: '' };
  updatePanel();
}

// Met à jour les boutons selon l'argent, la file, les améliorations et le plan de bataille du bâtiment affiché.
// Emplacements d'un conteneur (garnison, transport, tunnel) : une case par emplacement, remplie par l'occupant ; clic sur un occupant = le faire sortir.
function buildSlots(u, mine) {
  const box = document.createElement('div'); box.className = 'slots';
  const row = document.createElement('div'); row.className = 'slotrow';
  const cells = [];
  (u.cg ?? []).forEach(([obj, sc], idx) => {
    for (let k = 0; k < Math.max(1, sc); k++) {
      const c = document.createElement('div'); c.className = 'slot full' + (k ? ' cont' : '');
      if (!k) { c.textContent = shortName(obj); c.title = `${shortName(obj)}${mine ? ' — clic : faire sortir' : ''}`; if (mine) c.onclick = () => send({ t: 'unload', id: u.id, index: idx }); }
      else c.title = shortName(obj);
      cells.push(c);
    }
  });
  while (cells.length < u.lm) { const c = document.createElement('div'); c.className = 'slot'; c.title = 'Emplacement libre'; cells.push(c); }
  cells.slice(0, Math.max(u.lm, cells.length)).forEach(c => row.appendChild(c));
  const bar = document.createElement('div'); bar.className = 'slotbar';
  const lab = document.createElement('span');
  lab.textContent = `${u.ck === 'garrison' ? 'Garnison' : u.ck === 'tunnel' ? 'Tunnel' : 'Passagers'} ${u.ld}/${u.lm}` + (!mine ? ' — neutre : clic droit avec des unités pour l\'occuper' : '');
  bar.appendChild(lab);
  if (mine) {
    const ev = document.createElement('button'); ev.className = 'evac'; ev.textContent = 'Évacuer (E)'; ev.disabled = !(u.ld > 0);
    ev.onclick = () => { const ids = updateEvac(); if (ids.length) send({ t: 'evacuate', ids }); };
    bar.appendChild(ev);
  }
  box.append(bar, row);
  return box;
}

function updatePanel() {
  if (!panelFor) return;
  const u = units.get(panelFor.id);
  if (!u) { refreshCommands(); return; }
  const st = bst[panelFor.id] ?? { q: [], up: [] }, mine = pup[me] ?? [];
  panelFor.head.querySelector('.hp').textContent = `${Math.ceil(u.hp)} / ${u.mh ?? '?'} PV`;
  // file de production (clic = annuler et être remboursé)
  const sig = st.q.map(q => q[0] + q[2]).join('|');
  if (sig !== panelFor.qsig) {
    panelFor.qsig = sig; panelFor.queue.innerHTML = '';
    st.q.forEach((q, i) => {
      const d = document.createElement('div'); d.className = 'qi' + (q[2] ? ' up' : '');
      d.innerHTML = `${q[2] ? '⬆ ' : ''}${shortName(q[0].replace(/^Upgrade_/, ''))}<i></i>`;
      d.title = 'Clic : annuler (remboursé)';
      setCameo(d, panelFor.info?.buttons?.find(b => b.object === q[0] || b.upgrade === q[0])?.img);
      d.onclick = () => send({ t: 'cancel', building: panelFor.id, index: i });
      panelFor.queue.appendChild(d);
    });
  }
  [...panelFor.queue.children].forEach((d, i) => { if (st.q[i]) d.querySelector('i').style.width = `${Math.round(st.q[i][1] * 100)}%`; });
  u.queue = st.q;

  const pl = st.pl; // [plan actuel, plan voulu, phase]
  for (const { b, el, bar } of panelEls) {
    let disabled = !b.ok, done = false, on = false, busy = false, hidden = false, frac = 0;
    if (b.upgrade) {
      done = st.up.includes(b.upgrade) || mine.includes(b.upgrade);
      const qi = st.q.findIndex(q => q[0] === b.upgrade);
      busy = qi >= 0; if (busy) frac = st.q[qi][1];
      disabled = disabled || done || busy || myMoney < (b.cost ?? 0);
    } else if (b.object) {
      disabled = disabled || myMoney < (b.cost ?? 0);
    } else if (b.command === 'SPECIAL_POWER' && pl) {
      const n = b.options.includes('OPTION_ONE') ? 1 : b.options.includes('OPTION_TWO') ? 2 : b.options.includes('OPTION_THREE') ? 3 : 0;
      on = pl[1] === n; busy = on && pl[2] !== 'active'; done = on && pl[2] === 'active';
      disabled = disabled || on;
    } else if (b.command === 'STOP' && b.options.includes('OPTION_ONE')) {
      hidden = !pl || (pl[1] === 0 && pl[0] === 0);
    }
    el.disabled = disabled; el.style.visibility = hidden ? 'hidden' : '';
    el.classList.toggle('done', done); el.classList.toggle('on', on && !done); el.classList.toggle('busy', busy);
    bar.style.width = `${Math.round(frac * 100)}%`;
  }
}
const refreshAffordability = updatePanel;

function updateEnergy() {
  const e = energy[me], el = $('energy');
  if (!e || phase !== 'playing') { el.textContent = ''; return; }
  el.textContent = `⚡ ${e[0]} / ${e[1]}`;
  el.classList.toggle('low', e[1] > e[0]);
}

// ---------- pose d'un bâtiment ----------
let placing = null, ghost = null;
function startPlacing(dozerId, b) {
  cancelPlacing();
  placing = { dozer: dozerId, object: b.object, radius: Math.max(b.radius, 4), x: 0, y: 0, angle: 0, ok: false, down: false, anchor: null };
  const mat = () => new THREE.MeshBasicMaterial({ color: 0x40e060, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), mat());
  ring.rotation.x = -Math.PI / 2;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 4), mat()); // flèche : sens du bâtiment (+X avant rotation)
  arrow.rotation.z = -Math.PI / 2; arrow.position.set(1.2, 0, 0);
  ghost = new THREE.Group(); ghost.add(ring, arrow);
  ghost.position.y = 0.6; ghost.scale.setScalar(placing.radius);
  ghost.traverse(o => { o.renderOrder = 20; });
  scene.add(ghost);
  showMsg(`Pose : ${b.object} — clic gauche pour placer (maintenir et glisser = orienter), R = pivoter, Échap = annuler`);
}
function cancelPlacing() {
  if (ghost) { scene.remove(ghost); ghost.traverse(o => o.material?.dispose()); }
  ghost = null; placing = null;
}
function updateGhost(e) {
  const p = groundPoint(e);
  if (!p) return;
  if (placing.down) { // bouton enfoncé : le bâtiment reste sur place, la souris choisit son orientation
    const dx = p.x - placing.anchor.x, dy = -p.z - placing.anchor.y;
    if (Math.hypot(dx, dy) > 6) placing.angle = Math.atan2(dy, dx);
  } else {
    placing.x = p.x; placing.y = -p.z;
    placing.ok = Math.abs(placing.x) < MAP_LIMIT && Math.abs(placing.y) < MAP_LIMIT &&
      ![...units.values()].some(u => !u.air && Math.hypot(u.x - placing.x, u.y - placing.y) < u.radius + placing.radius + 2);
    ghost.position.x = p.x; ghost.position.z = p.z; ghost.position.y = p.y + 0.6;
    ghost.children.forEach(c => c.material.color.setHex(placing.ok ? 0x40e060 : 0xe04040));
  }
  ghost.rotation.y = placing.angle; // même convention que les unités : angle 0 = +X, sens trigonométrique
}

// Fiche d'un objet neutre / ennemi sélectionné : nom, camp, points de vie, garnison, capturable.
function updateInfo() {
  const el = $('info'), u = selected.size === 1 ? units.get([...selected][0]) : null;
  if (!u || u.owner === me) { el.style.display = 'none'; return; }
  const bits = [shortName(u.object), u.owner === 0 ? 'neutre' : `joueur ${u.owner}`];
  if (u.mh > 0) bits.push(`PV ${Math.ceil(u.hp)}/${Math.round(u.mh)}`);
  if (u.lm) bits.push(`garnison ${u.ld}/${u.lm}`);
  if (u.cp) bits.push('capturable');
  el.textContent = bits.join(' — '); el.style.display = 'block';
}
function refreshRings() {
  for (const u of units.values()) { const sel = selected.has(u.id); u.ring.visible = sel; u.ring.material.opacity = 1; updateRally(u); }
  setStatus();
  updateInfo();
  refreshCommands();
}

// ---------- sélection / ordres ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const setNdc = e => ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

function unitAt(e) {
  setNdc(e); ray.setFromCamera(ndc, camera);
  for (const h of ray.intersectObjects([...units.values()].filter(u => !u.dying).map(u => u.root), true)) { // on ne clique pas un mort
    let o = h.object;
    while (o && o.userData.unitId === undefined) o = o.parent;
    if (o) return units.get(o.userData.unitId);
  }
  return null;
}

function groundPoint(e) {
  setNdc(e); ray.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  if (terrain) return terrain.hit(ray.ray.origin, ray.ray.direction, p);
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
}

let drag = null;
const box = $('box');
canvas.addEventListener('pointerdown', e => {
  if (placing) { // mode pose : appui = fixer l'emplacement, glisser = orienter, relâcher = poser ; autre bouton = annuler
    if (e.button === 0) { updateGhost(e); placing.down = true; placing.anchor = { x: placing.x, y: placing.y }; }
    else cancelPlacing();
    return;
  }
  if (e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: false };
  else if (e.button === 2 && selected.size) {
    const sel = [...selected].filter(id => units.get(id)?.owner === me); // seules mes unités reçoivent des ordres
    if (!sel.length) return;
    const prod = sel.map(id => units.get(id)).filter(u => u && u.rp && !u.cn);
    if (prod.length) { const p = groundPoint(e); if (p) send({ t: 'rally', ids: prod.map(u => u.id), x: p.x, y: -p.z }); return; }
    const target = unitAt(e);
    if (target && target.lm && (target.owner === me || (target.owner === 0 && target.ck === 'garrison'))) { // transport / bâtiment à garnison (même neutre) : les unités qui peuvent y entrer le rejoignent
      const boarders = sel.filter(id => id !== target.id && units.get(id)?.sc > 0);
      if (boarders.length) { send({ t: 'enter', ids: boarders, target: target.id }); return; }
      showMsg('Aucune unité sélectionnée ne peut entrer ici'); return;
    }
    if (target && target.dk) { send({ t: 'gather', ids: sel }); return; } // clic droit sur un entrepôt / centre : ravitaillement
    if (target && target.cp && target.owner !== me && (target.owner === 0 || e.ctrlKey)) { // bâtiment capturable : neutre = capture par défaut, ennemi = Ctrl + clic droit
      const cap = sel.filter(id => units.get(id)?.cc);
      if (cap.length) { send({ t: 'capture', ids: cap, target: target.id }); return; }
      if (target.owner === 0) { showMsg('Aucune unité sélectionnée ne sait capturer'); return; }
    }
    if (target && target.owner === 0 && !e.ctrlKey) { showMsg(target.lm ? 'Ce conteneur est neutre : seules les garnisons peuvent être occupées' : "Aucune action possible sur cet objet neutre (Ctrl + clic droit pour l'attaquer)"); return; }
    if (target && target.owner !== me && target.mh > 0) send({ t: 'attack', ids: sel, target: target.id });
    else { const p = groundPoint(e); if (p) send({ t: 'move', ids: sel, x: p.x, y: -p.z }); }
  }
});
addEventListener('pointermove', e => {
  if (placing && e.target === canvas) updateGhost(e);
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
  if (drag.moved) {
    box.style.display = 'block';
    box.style.left = Math.min(drag.x, e.clientX) + 'px'; box.style.top = Math.min(drag.y, e.clientY) + 'px';
    box.style.width = Math.abs(e.clientX - drag.x) + 'px'; box.style.height = Math.abs(e.clientY - drag.y) + 'px';
  }
});
addEventListener('pointerup', e => {
  if (placing?.down && e.button === 0) {
    if (placing.ok) { send({ t: 'build', dozer: placing.dozer, object: placing.object, x: placing.x, y: placing.y, a: placing.angle }); cancelPlacing(); }
    else { placing.down = false; showMsg('Emplacement occupé ou hors carte'); }
    return;
  }
  if (e.button !== 0 || !drag) return;
  const d = drag; drag = null; box.style.display = 'none';
  if (!e.shiftKey) selected.clear();
  if (d.moved) { // rectangle : seulement les unités mobiles (les bâtiments se sélectionnent d'un clic)
    const x0 = Math.min(d.x, e.clientX), x1 = Math.max(d.x, e.clientX), y0 = Math.min(d.y, e.clientY), y1 = Math.max(d.y, e.clientY);
    const v = new THREE.Vector3();
    for (const u of units.values()) {
      if (u.owner !== me || u.st) continue;
      v.set(u.x, 0, -u.y).project(camera);
      const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight;
      if (v.z < 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) selected.add(u.id);
    }
  } else {
    const u = unitAt(e);
    if (u) { // un objet neutre ou ennemi se sélectionne seul (inspection : nom, points de vie, garnison) ; il ne reçoit jamais d'ordre
      if (u.owner === me) { for (const id of [...selected]) if (units.get(id)?.owner !== me) selected.delete(id); selected.add(u.id); }
      else { selected.clear(); selected.add(u.id); }
    }
  }
  refreshRings();
});

// ---------- clavier ----------
const keys = new Set();
addEventListener('keydown', e => {
  if (e.key === 'Escape') { cancelPlacing(); return; }
  if (placing && e.key.toLowerCase() === 'r') { // pivote le bâtiment par pas de 45° (Maj = sens inverse)
    placing.angle = ((placing.angle + (e.shiftKey ? -1 : 1) * Math.PI / 4 + Math.PI) % TAU + TAU) % TAU - Math.PI;
    ghost.rotation.y = placing.angle; return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'a') { selected.clear(); for (const u of units.values()) if (u.owner === me && !u.st) selected.add(u.id); refreshRings(); }
  if (k === 's' && selected.size) send({ t: 'stop', ids: [...selected] });
  if (k === 'e') { const ids = updateEvac(); if (ids.length) send({ t: 'evacuate', ids }); }
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

function panCamera(dt) {
  const f = new THREE.Vector3().subVectors(controls.target, camera.position); f.y = 0;
  if (f.lengthSq() < 1e-6) return;
  f.normalize();
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const d = new THREE.Vector3();
  if (keys.has('z') || keys.has('w') || keys.has('arrowup')) d.add(f);
  if (keys.has('arrowdown')) d.sub(f);
  if (keys.has('d') || keys.has('arrowright')) d.add(r);
  if (keys.has('q') || keys.has('arrowleft')) d.sub(r);
  if (d.lengthSq() === 0) return;
  d.normalize().multiplyScalar(camera.position.distanceTo(controls.target) * 0.9 * dt);
  camera.position.add(d); controls.target.add(d);
}

// ---------- outil de test : création libre d'unités ----------
$('spawn').onclick = () => send({ t: 'spawn', object: $('obj').value.trim(), neutral: $('neutral').checked });
$('obj').addEventListener('keydown', e => { if (e.key === 'Enter') $('spawn').click(); });
fetch('/api/objects').then(r => r.json()).then(list => { $('objs').innerHTML = list.map(n => `<option value="${n}">`).join(''); });

// ---------- boucle de rendu (interpolation vers le dernier instantané) ----------
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now;
  const k = 1 - Math.exp(-dt * 14);
  features?.update(dt); // train
  for (const u of units.values()) {
    u.x += (u.tx - u.x) * k; u.y += (u.ty - u.y) * k; u.a += wrap(u.ta - u.a) * k;
    const zt = u.air ? Math.max(u.fh, 0.8) : 0; // posé : léger décalage pour que les roues ne s'enfoncent pas dans le tarmac
     // les appareils montent à leur altitude de vol (et redescendent)
    u.z += Math.max(-(u.fh > 0 ? 45 : 14) * dt, Math.min((u.fh > 0 ? 45 : 14) * dt, zt - u.z));
    u.root.position.set(u.x, u.z + u.mz + groundY(u.x, u.y), -u.y); // mz : décalage vertical du .map (pont, tunnels)
    if (u.dying && !u.dying.wreck) { // SlowDeathBehavior : s'enfonce à SinkRate (unités/s) une fois SinkDelay écoulé
      const t = (performance.now() - u.dying.t0) / 1000 - u.dying.sd;
      if (t > 0) u.root.position.y -= u.dying.sr * t;
    }
    u.root.rotation.y = u.a;
    u.ring.position.y = 0.3 - u.z - u.mz; // le cercle reste au sol
    if (u.mixer) { // animations du modèle : drapeaux, ventilateurs... et, pour les unités, repos / marche / tir
      const a = u.actions;
      const want = a?.attack && now - u.shotAt < 450 ? 'attack' : a?.move && now - u.movedAt < 250 ? 'move' : a?.idle ? 'idle' : u.animState;
      if (want !== u.animState && a?.[want]) { a[want].reset().play(); a[u.animState]?.crossFadeTo(a[want], 0.15, false); u.animState = want; }
      u.door?.update(dt); // ouverture / fermeture de la porte du bâtiment
      u.mixer.update(dt);
      if (u.upAnim) { // centrale électrique : les tiges suivent la progression de l'amélioration (0 au début -> 1 à la fin), puis restent en haut
        const mcs = u.mc ?? [];
        const target = mcs.includes('POWER_PLANT_UPGRADING') ? Math.max(0, Math.min(1, u.upgProg ?? 0)) : mcs.includes('POWER_PLANT_UPGRADED') ? 1 : 0;
        u.upFrac = u.upFrac == null ? target : u.upFrac + (target - u.upFrac) * Math.min(1, dt * 5);
        u.upAnim.action.time = u.upFrac * u.upAnim.dur; u.upAnim.action.enabled = true; u.mixer.update(0);
      }
    }
    if (u.fly && u.model) { // vol : un drone n'est jamais figé
      const t = performance.now() / 1000 + u.id * 1.7;
      if (u.fly === 'hover') { // stationnaire : flotte, légères oscillations
        u.model.position.y = 1.4 + 1.6 * Math.sin(t * 2.1);
        u.model.rotation.x = 0.05 * Math.sin(t * 1.7); u.model.rotation.z = 0.05 * Math.sin(t * 1.3 + 1);
      } else { // 'orbit' : s'incline dans les virages (le retard d'angle interpolé donne la vitesse de rotation)
        u.bank += (-Math.max(-0.6, Math.min(0.6, wrap(u.ta - u.a) * 5)) - u.bank) * Math.min(1, dt * 4);
        u.model.rotation.x = u.bank; u.model.position.y = 0.8 * Math.sin(t * 3);
      }
    }
    updateTurret(u, dt); // après le mixer : la tourelle écrase la pose des os TURRET* (aussi pour un modèle sans animation)
    if (u.air) for (const r of u.rotors) r.rotation.z += dt * 28; // rotors d'hélicoptère
    if (u.model) u.model.scale.y = u.cn ? 0.15 + 0.85 * (u.mh ? u.hp / u.mh : 1) : 1; // un chantier "pousse"
    u.bar.position.set(u.x, u.z + u.mz + u.h + groundY(u.x, u.y), -u.y);
    u.bar.quaternion.copy(camera.quaternion); // la barre fait toujours face à la caméra
    updateBar(u);
    if (selected.has(u.id) && u.owner !== me) updateInfo(); // les points de vie d'un objet inspecté évoluent
  }
  for (let i = fx.length - 1; i >= 0; i--) { // effets : projectiles et explosions
    const f = fx[i], p = (now - f.born) / f.dur;
    if (p >= 1) { scene.remove(f.mesh); f.mesh.material.dispose(); fx.splice(i, 1); }
    else f.update(f.mesh, p);
  }
  panCamera(dt);
  controls.update();
  renderer.render(scene, camera);
});
