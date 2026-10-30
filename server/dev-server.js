// Usage : node server/dev-server.js "<dossier jeu>" ["<dossier Generals>"] ["<dossier mod>"]
// Sert la visionneuse (/), le jeu (/index.html), les fichiers du jeu (/api/vfs/...) et le WebSocket (/ws).
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountGame } from './game-vfs.js';
import { IniDatabase, loadIni, fieldOf } from '../shared/ini.js';
import { modulesOf, objectFields, topLevel, coverage } from '../shared/ini-bridge.js';
import { turretOf, stateReportOf, imagesOf, mappedImageOf, railOf, roadDefOf, dockAnimRefsOf, modelsOf as modelsFor, resolveObject, drawStateOf, ACTIVE_CONDS, factionsOf, commandButtonsOf, buildInfo, upgradeInfo, collisionRadius, geometryOf, kindOf } from '../shared/objects.js';
import { attachGame } from './game-server.js';
import { createMapCatalog } from './maps.js';
import { createAnimLengths } from './anim-lengths.js';
import { loadBuildingBones } from './bones.js';

const [game, base, mod] = process.argv.slice(2);
if (!game) { console.error('Usage: node server/dev-server.js <dossier jeu> [Generals] [mod]'); process.exit(1); }
const PORT = process.env.PORT || 8080;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Montage des fichiers…');
const vfs = await mountGame({ game, base, mod });
console.log('Lecture des INI…');
const db = new IniDatabase();
for (const f of vfs.list('data/ini/', '.ini')) await loadIni(vfs, f, db);
console.log(`${db.all('Object').length} Objects, ${db.errors.length} erreur(s) INI`);

const maps = createMapCatalog(vfs); // analyse des .map en arrière-plan (MapsZH.big...)
const modelsOf = name => modelsFor(db, name);
const factions = factionsOf(db);

// Boutons de production / construction d'un Object, avec coût, durée et rayon de chaque cible.
// Tous les boutons du CommandSet : production, construction, améliorations, pouvoirs, vente... (ceux que le jeu ne gère pas
// encore sont envoyés quand même, marqués `ok: false`, pour que l'interface montre le vrai menu du bâtiment).
const SUPPORTED = new Set(['UNIT_BUILD', 'DOZER_CONSTRUCT', 'OBJECT_UPGRADE', 'PLAYER_UPGRADE', 'SELL', 'STOP']);
function buttonsFor(name, set = null) {
  return commandButtonsOf(db, name, set).map(b => {
    const out = { ...b, label: labelOf(b), ok: SUPPORTED.has(b.command) };
    if (b.object) Object.assign(out, buildInfo(db, b.object), { radius: collisionRadius(geometryOf(db, b.object)), structure: kindOf(db, b.object).has('STRUCTURE') });
    else if (b.upgrade) Object.assign(out, upgradeInfo(db, b.upgrade) ?? { cost: 0, time: 0 });
    if (b.command === 'SPECIAL_POWER' && /BattlePlans/i.test(b.power ?? '')) out.ok = true;
    return out;
  });
}
// Boutons d'un Object avec un jeu de commandes imposé (CommandSetUpgrade).
const buttonsForSet = (name, set) => buttonsFor(name, set);
// Les textes (TextLabel = CONTROLBAR:...) sont dans generals.csf : à défaut on lit le nom du bouton.
const SPLIT = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
function labelOf(b) {
  if (b.object) return SPLIT(b.object.replace(/^(America|China|GLA|AirF|Lazr|SupW|Infa|Nuke|Tank|Demo|Slth|Chem|Boss)/, ''));
  if (b.upgrade) return SPLIT(b.upgrade.replace(/^(\w+_)?Upgrade_?/, '').replace(/^(America|China|GLA)/, ''));
  if (b.command === 'SPECIAL_POWER') return SPLIT(b.button.replace(/^Command_(InitiateBattlePlan)?/, ''));
  return SPLIT(b.button.replace(/^Command_/, ''));
}
const withModel = [...db.all('Object'), ...db.all('ObjectReskin')]
  .map(b => b.args[0]).filter(n => modelsOf(n)?.length).sort((a, b) => a.localeCompare(b));

// --- HTTP ---
// Fichier de texture d'une classe de terrain : Data\INI\Terrain.ini (« Terrain <Classe> / Texture = <fichier>.tga ») donne le vrai nom du fichier,
// qui n'est pas toujours celui de la classe ; on essaie ensuite le nom de la classe seul.
const iniTexName = cls => { const b = db.get('Terrain', cls); const t = b ? (fieldOf(b, 'Texture') ?? '').trim().split(/\s+/)[0] : ''; return t ? t.replace(/\.[^.]+$/, '').toLowerCase() : null; };
function findTerrainTex(name) {
  for (const n of [...new Set([iniTexName(name), name].filter(Boolean))]) {
    const f = ['art/terrain', 'art/textures'].flatMap(d => ['tga', 'dds'].map(e => `${d}/${n}.${e}`)).find(q => vfs.has(q))
      ?? [...vfs.list('', '.tga'), ...vfs.list('', '.dds')].find(q => q.endsWith(`/${n}.tga`) || q.endsWith(`/${n}.dds`));
    if (f) return f;
  }
  return null;
}
// Le type MIME doit être correct : sinon Chrome refuse d'appliquer la feuille de style
// (« Refused to apply style … MIME type application/octet-stream ») et cmd.css est ignoré.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
// Envoi avec support des requêtes Range (indispensable à Chrome pour lire/boucler vidéos et musiques).
function sendBytes(req, res, buf, type, cache) {
  const size = buf.length, h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = Math.min(m[1] && m[2] ? Number(m[2]) : size - 1, size - 1);
    if (start > end) return void res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return void res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 }).end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { ...h, 'Content-Length': size }).end(buf);
}
const mediaCache = new Map(); // quelques médias récents en mémoire (une requête Range ne relit pas toute l'archive)
const isMedia = p => /\.(mp4|webm|mp3|ogg|wav)$/i.test(p);
async function serveStatic(req, res, dir, rel) {
  const full = normalize(join(dir, rel));
  if (!full.startsWith(dir + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(full);
    sendBytes(req, res, data, MIME[extname(full)] ?? 'application/octet-stream', 'no-store');
  } catch { res.writeHead(404).end('introuvable'); }
}

const terrainTexCache = new Map(); // nom de classe -> chemin dans le VFS (ou null)
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/objects') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(withModel));
    } else if (path === '/api/factions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(factions));
    } else if (path === '/api/media') { // vidéos de fond et musiques du lobby : lus dans les fichiers du jeu (+ dossier client/media pour les .bik convertis)
      const urlOf = p => '/api/vfs/' + p.split('/').map(encodeURIComponent).join('/');
      const extra = await readdir(join(root, 'client', 'media')).catch(() => []);
      const local = ext => extra.filter(f => ext.test(f)).sort().map(f => '/media/' + encodeURIComponent(f));
      const videos = [...local(/\.(mp4|webm)$/i), ...['.mp4', '.webm'].flatMap(e => vfs.list('', e)).map(urlOf)];
      const music = [...local(/\.(mp3|ogg)$/i), ...['.mp3', '.wav', '.ogg'].flatMap(e => vfs.list('data/audio/tracks/', e)).map(urlOf)];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ videos, music, bik: vfs.list('', '.bik').length }));
    } else if (path === '/api/maps') { // cartes jouables (≥ 2 points de départ) ; ready=false tant que l'analyse n'est pas finie
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ready: maps.done, total: maps.total, maps: maps.list(), failed: maps.failed }));
    } else if (path.startsWith('/api/image/')) { // image d'interface (MappedImage) : cameos des boutons, portraits... -> { file, tw, th, l, t, r, b, rot }
      const img = mappedImageOf(db, decodeURIComponent(path.slice('/api/image/'.length)));
      res.writeHead(img ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' }).end(JSON.stringify(img ?? { error: 'image inconnue' }));
    } else if (path.startsWith('/api/map/') && path.endsWith('/features')) { // routes, ponts, rails, waypoints et matériel roulant d'une carte (coordonnées brutes du .map)
      const f = await maps.features(decodeURIComponent(path.slice('/api/map/'.length, -'/features'.length)));
      if (!f) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'carte introuvable' }));
      const defs = {}, def = n => (n in defs ? defs[n] : (defs[n] = roadDefOf(db, n) ? { ...roadDefOf(db, n), rail: /rail/i.test(n + ' ' + (roadDefOf(db, n).texture ?? '')) } : null));
      const seg = r => ({ n: r.name, a: [r.a.x, r.a.y, r.a.z], b: [r.b.x, r.b.y, r.b.z], fa: r.a.flags | 0, fb: r.b.flags | 0 }); // fa / fb : flags World Builder de chaque point (ROAD_ANGLED 0x8, ROAD_TIGHT 0x40, ROAD_JOIN 0x80)
      const roads = f.roads.filter(r => def(r.name)).map(seg), bridges = f.bridges.filter(r => def(r.name)).map(seg);
      const trains = f.objects.filter(o => railOf(db, o.name)).map(o => ({ name: o.name, x: o.x, y: o.y, z: o.z, angle: o.angle, rail: railOf(db, o.name) }));
            const waypoints = f.waypoints.filter(w => w.id != null).map(w => ({ id: w.id, name: w.name, x: w.x, y: w.y, labels: w.labels })); // tous : la voie suit les LIENS, pas les noms (« Waypoint 417 » fait partie de la boucle)
      const loco = db.all('Object').map(b => b.args[0]).find(n => railOf(db, n)?.locomotive) ?? null; // locomotive par défaut si la carte a des rails mais aucun train posé
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ defs, roads, bridges, trains, waypoints, links: f.links, loco, locoRail: loco ? railOf(db, loco) : null }));
    } else if (path.startsWith('/api/map/') && path.endsWith('/textures')) { // diagnostic : chaque classe de texture de la carte est-elle trouvée dans les fichiers du jeu ?
      const t = await maps.tiles(decodeURIComponent(path.slice('/api/map/'.length, -'/textures'.length)));
      if (!t) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'carte introuvable' }));
      const find = name => findTerrainTex(name.toLowerCase());
      const classes = (t.classes ?? []).map(c => ({ ...c, file: find(c.name) }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: t.error ?? null, layout: t.layout, grid: t.width ? `${t.width}x${t.height}` : null, missing: classes.filter(c => !c.file).length, classes, detail: t.error ? t : undefined }, null, 1));
    } else if (path.startsWith('/api/map/') && path.endsWith('/tiles')) { // textures du terrain : classes + une tuile (Int16) par case, en base64
      const t = await maps.tiles(decodeURIComponent(path.slice('/api/map/'.length, -'/tiles'.length)));
      if (!t || t.error) res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify(t ?? { error: 'carte introuvable' }));
      else res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' }).end(JSON.stringify({ width: t.width, height: t.height, border: t.border, shift: t.shift, classes: t.classes, tiles: Buffer.from(t.tiles.buffer, t.tiles.byteOffset, t.tiles.byteLength).toString('base64') }));
    } else if (path.startsWith('/api/terrain-tex/')) { // texture d'une classe de terrain : cherchée dans art/terrain puis art/textures (.tga / .dds)
      const name = path.slice('/api/terrain-tex/'.length).replace(/[^\w .-]/g, '').toLowerCase();
      let found = terrainTexCache.get(name);
      if (found === undefined) { found = findTerrainTex(name); terrainTexCache.set(name, found); }
      if (!found) res.writeHead(404).end('texture introuvable');
      else { const d = await vfs.readBytes(found); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Tex-Ext': found.slice(-3), 'X-Tex-Path': found, 'Cache-Control': 'max-age=3600' }).end(Buffer.from(d.buffer, d.byteOffset, d.byteLength)); }
    } else if (path.startsWith('/api/map/') && path.endsWith('/terrain')) { // hauteurs brutes + dimensions de la grille dans l'en-tête X-Terrain
      const t = await maps.terrain(decodeURIComponent(path.slice('/api/map/'.length, -'/terrain'.length)));
      if (!t || t.error) res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify(t ?? { error: 'carte introuvable' }));
      else res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Terrain': `${t.width},${t.height},${t.border}`, 'Cache-Control': 'max-age=600' }).end(Buffer.from(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength));
    } else if (path.startsWith('/api/map/')) { // diagnostic d'une carte : morceaux, dimensions, points de départ, erreurs de lecture
      const info = await maps.inspect(decodeURIComponent(path.slice('/api/map/'.length)));
      res.writeHead(info ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(info ?? { error: 'carte introuvable' }, null, 1));
    } else if (path === '/api/ini/coverage') { // part des clés d'INI reconnues par le pont (schéma du moteur)
      const c = coverage(db);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...c, top: c.top.map(([k, n]) => ({ key: k, count: n })) }));
    } else if (path.startsWith('/api/ini/')) { // /api/ini/object/<nom> : champs + modules typés ; /api/ini/<type>/<nom> : Weapon, Locomotor, Upgrade, ...
      const [type, ...rest] = path.slice('/api/ini/'.length).split('/'), name = decodeURIComponent(rest.join('/'));
      let body = null;
      if (type.toLowerCase() === 'object') {
        const f = objectFields(db, name);
        if (f) body = { name, fields: f.data, unknownFields: f.unknown, modules: modulesOf(db, name).map(({ kind, type: t, tag, data, unknown }) => ({ kind, type: t, tag, data, unknown })) };
      } else { const t = topLevel(db, type, name); if (t) body = { name, type, fields: t.data, unknownFields: t.unknown }; }
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body ?? { error: 'introuvable' }));
    } else if (path.startsWith('/api/object/') && path.endsWith('/states')) { // rapport texte des états d'affichage (à coller dans la conversation)
      const name = decodeURIComponent(path.slice('/api/object/'.length, -'/states'.length));
      if (!resolveObject(db, name)) return void res.writeHead(404).end('objet introuvable');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(`${name}\n${stateReportOf(db, name)}\n`);
    } else if (path.startsWith('/api/object/')) {
      const name = path.slice('/api/object/'.length);
      if (!resolveObject(db, name)) return void res.writeHead(404).end('{}');
      const models = modelsOf(name) ?? [];
      const extra = (url.searchParams.get('c') ?? '').split(',').filter(Boolean).map(x => x.toUpperCase()); // conditions de modèle de l'objet (améliorations...)
      const st = drawStateOf(db, name, [...ACTIVE_CONDS, ...extra]); // modèle par défaut + sous-objets à masquer (muzzle flashes...)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name, model: st?.model ?? models[0] ?? null, models, hide: st?.hide ?? [], show: st?.show ?? [], muzzle: st?.muzzle ?? [], auto: st?.auto ?? [], anim: st?.anim ?? null, anims: st?.anims ?? null, states: st?.states ?? [], activeState: st?.activeState ?? null, modules: st?.modules ?? [], turret: turretOf(db, name),
        radius: collisionRadius(geometryOf(db, name)), images: imagesOf(db, name), buttons: buttonsFor(name, url.searchParams.get('set') || null),
      }));
    } else if (path.startsWith('/api/vfs/')) {
      const p = path.slice('/api/vfs/'.length);
      if (!vfs.has(p)) return void res.writeHead(404).end();
      if (req.method === 'HEAD') return void res.writeHead(200).end();
      let buf = mediaCache.get(p);
      if (!buf) {
        const data = await vfs.readBytes(p);
        buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (isMedia(p)) { mediaCache.set(p, buf); if (mediaCache.size > 4) mediaCache.delete(mediaCache.keys().next().value); }
      }
      sendBytes(req, res, buf, MIME[extname(p)] ?? 'application/octet-stream', 'max-age=3600');
    } else if (path.startsWith('/shared/')) {
      await serveStatic(req, res, join(root, 'shared'), path.slice('/shared/'.length));
    } else {
      await serveStatic(req, res, join(root, 'client'), path === '/' ? 'index.html' : path.slice(1));
    }
  } catch (e) { console.error(e); res.writeHead(500).end(String(e.message)); }
});
const bones = await loadBuildingBones(db, vfs).catch(e => { console.error('os des bâtiments :', e.message); return new Map(); });
// Durées des animations d'accostage (Chinook, camions) : lues en arrière-plan ; le ravitaillement s'y cale à la création de chaque unité.
const anims = createAnimLengths();
anims.load(vfs, db.all('Object').map(b => b.args[0]), n => dockAnimRefsOf(db, n)).then(k => console.log(`Animations d'accostage : ${k} durée(s) lue(s)`)).catch(e => console.warn(`Animations d'accostage illisibles : ${e.message}`));
attachGame(server, db, { bones: n => bones.get(n.toLowerCase()), animSeconds: anims.secondsOf }, { maps });
server.listen(PORT, () => {
  console.log(`Visionneuse : http://localhost:${PORT}`);
  console.log(`Lobby       : http://localhost:${PORT}/lobby.html   <- point d'entrée (rooms)`);
  console.log(`Jeu         : http://localhost:${PORT}/index.html?room=CODE (ouvert depuis le lobby)`);
});
