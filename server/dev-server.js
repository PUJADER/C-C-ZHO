// Usage : node server/dev-server.js "<dossier jeu>" ["<dossier Generals>"] ["<dossier mod>"]
// Sert la visionneuse (/), le jeu (/game.html), les fichiers du jeu (/api/vfs/...) et le WebSocket (/ws).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountGame } from './game-vfs.js';
import { IniDatabase, loadIni } from '../shared/ini.js';
import { modulesOf, objectFields, topLevel, coverage } from '../shared/ini-bridge.js';
import { turretOf, modelsOf as modelsFor, resolveObject, drawStateOf, ACTIVE_CONDS, factionsOf, commandButtonsOf, buildInfo, upgradeInfo, collisionRadius, geometryOf, kindOf } from '../shared/objects.js';
import { attachGame } from './game-server.js';
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
// Le type MIME doit être correct : sinon Chrome refuse d'appliquer la feuille de style
// (« Refused to apply style … MIME type application/octet-stream ») et cmd.css est ignoré.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
async function serveStatic(res, dir, rel) {
  const full = normalize(join(dir, rel));
  if (!full.startsWith(dir + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch { res.writeHead(404).end('introuvable'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/objects') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(withModel));
    } else if (path === '/api/factions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(factions));
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
    } else if (path.startsWith('/api/object/')) {
      const name = path.slice('/api/object/'.length);
      if (!resolveObject(db, name)) return void res.writeHead(404).end('{}');
      const models = modelsOf(name) ?? [];
      const extra = (url.searchParams.get('c') ?? '').split(',').filter(Boolean).map(x => x.toUpperCase()); // conditions de modèle de l'objet (améliorations...)
      const st = drawStateOf(db, name, [...ACTIVE_CONDS, ...extra]); // modèle par défaut + sous-objets à masquer (muzzle flashes...)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name, model: st?.model ?? models[0] ?? null, models, hide: st?.hide ?? [], show: st?.show ?? [], muzzle: st?.muzzle ?? [], auto: st?.auto ?? [], anim: st?.anim ?? null, anims: st?.anims ?? null, states: st?.states ?? [], activeState: st?.activeState ?? null, modules: st?.modules ?? [], turret: turretOf(db, name),
        radius: collisionRadius(geometryOf(db, name)), buttons: buttonsFor(name, url.searchParams.get('set') || null),
      }));
    } else if (path.startsWith('/api/vfs/')) {
      const p = path.slice('/api/vfs/'.length);
      if (!vfs.has(p)) return void res.writeHead(404).end();
      if (req.method === 'HEAD') return void res.writeHead(200).end();
      const data = await vfs.readBytes(p);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'max-age=3600' }).end(Buffer.from(data));
    } else if (path.startsWith('/shared/')) {
      await serveStatic(res, join(root, 'shared'), path.slice('/shared/'.length));
    } else {
      await serveStatic(res, join(root, 'client'), path === '/' ? 'index.html' : path.slice(1));
    }
  } catch (e) { console.error(e); res.writeHead(500).end(String(e.message)); }
});
const bones = await loadBuildingBones(db, vfs).catch(e => { console.error('os des bâtiments :', e.message); return new Map(); });
attachGame(server, db, { bones: n => bones.get(n.toLowerCase()) });
server.listen(PORT, () => {
  console.log(`Visionneuse : http://localhost:${PORT}`);
  console.log(`Jeu         : http://localhost:${PORT}/game.html`);
});
