// Pont INI -> jeu. Lit TOUS les blocs des INI de Generals avec les tables de champs du moteur (shared/schema.json, généré par
// tools/gen-schema.py à partir des FieldParse du code source) : chaque valeur est convertie comme le fait le moteur (durées en images,
// vitesses par image, angles en radians, pourcentages en réels...). Aucun lecteur écrit à la main par module : un module nouveau
// ou un champ nouveau dans l'INI apparaît tout seul. Le jeu n'a plus qu'à EXÉCUTER ce que le pont lui donne.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FPS = 30; // LOGICFRAMES_PER_SECOND
const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.json'), 'utf8'));
const lc = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), [k, ...v]]));
const MODULES = Object.fromEntries(Object.entries(schema.modules).map(([k, v]) => [k.toLowerCase(), lc(v)]));
const CLASSES = Object.fromEntries(Object.entries(schema.classes).map(([k, v]) => [k.toLowerCase(), lc(v)]));

const tok = v => String(v ?? '').trim().split(/[\s,=]+/).filter(Boolean);
const num = v => { const x = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(x) ? x : 0; };
const bool = v => /^(yes|true|1)$/i.test(String(v ?? '').trim());
const labeled = v => { const o = {}; for (const m of String(v ?? '').matchAll(/([A-Za-z]+)\s*:\s*(-?[\d.]+)/g)) o[m[1].toLowerCase()] = parseFloat(m[2]); return o; };
const flags = v => { // "ALL -CRUSHED" | "NORMAL LASERED" | absent = tous
  const t = tok(v).map(x => x.toUpperCase()), plus = t.filter(x => !x.startsWith('-'));
  return { all: plus.length === 0 || plus.includes('ALL'), set: plus.filter(x => x !== 'ALL' && x !== 'NONE'), minus: t.filter(x => x.startsWith('-')).map(x => x.slice(1)) };
};

// Une fonction par parseur du moteur (INI::parseXxx). Renvoie la valeur convertie, ou { raw, parser } si le parseur n'est pas (encore) connu.
const PARSERS = {
  parseReal: v => num(v), parsePositiveNonZeroReal: v => num(v),
  parseInt: v => Math.trunc(num(v)), parseUnsignedInt: v => Math.trunc(num(v)), parseShort: v => Math.trunc(num(v)), parseUnsignedShort: v => Math.trunc(num(v)), parseUnsignedByte: v => Math.trunc(num(v)),
  parseBool: bool,
  parseAsciiString: v => String(v ?? '').trim(), parseAsciiStringLC: v => String(v ?? '').trim().toLowerCase(), parseQuotedAsciiString: v => String(v ?? '').trim().replace(/^"|"$/g, ''),
  parseAndTranslateLabel: v => String(v ?? '').trim(),
  parseAsciiStringVector: v => tok(v), parseAsciiStringVectorAppend: v => tok(v),
  parsePercentToReal: v => num(v) / 100,
  parseAngleReal: v => num(v) * Math.PI / 180,
  parseAngularVelocityReal: v => num(v) * Math.PI / 180 / FPS,        // deg/s -> rad/image
  parseDurationReal: v => num(v) * FPS / 1000,                        // ms -> images
  parseDurationUnsignedInt: v => Math.ceil(num(v) * FPS / 1000), parseDurationUnsignedShort: v => Math.ceil(num(v) * FPS / 1000),
  parseVelocityReal: v => num(v) / FPS,                               // dist/s -> dist/image
  parseAccelerationReal: v => num(v) / (FPS * FPS),                   // dist/s² -> dist/image²
  parseCoord3D: v => { const o = labeled(v); return { x: o.x ?? 0, y: o.y ?? 0, z: o.z ?? 0 }; },
  parseCoord2D: v => { const o = labeled(v); return { x: o.x ?? 0, y: o.y ?? 0 }; }, parseICoord2D: v => { const o = labeled(v); return { x: o.x ?? 0, y: o.y ?? 0 }; },
  parseRGBColor: v => { const o = labeled(v); return { r: o.r ?? 0, g: o.g ?? 0, b: o.b ?? 0 }; }, parseColorInt: v => { const o = labeled(v); return { r: o.r ?? 0, g: o.g ?? 0, b: o.b ?? 0, a: o.a ?? 255 }; },
  parseDeathTypeFlags: flags, parseDamageTypeFlags: flags, parseVeterancyLevelFlags: flags,
  parseBitString32: v => tok(v).map(x => x.toUpperCase()), parseBitString8: v => tok(v).map(x => x.toUpperCase()),
  parseIndexList: v => tok(v)[0] ?? '', parseByteSizedIndexList: v => tok(v)[0] ?? '', parseLookupList: v => tok(v)[0] ?? '',
  // références à d'autres blocs d'INI (par nom)
  parseThingTemplate: v => tok(v)[0] ?? '', parseArmorTemplate: v => tok(v)[0] ?? '', parseWeaponTemplate: v => tok(v)[0] ?? '', parseFXList: v => tok(v)[0] ?? '', parseFX: v => tok(v),
  parseObjectCreationList: v => tok(v)[0] ?? '', parseOCL: v => tok(v), parseParticleSystemTemplate: v => tok(v)[0] ?? '', parseDamageFX: v => tok(v)[0] ?? '',
  parseUpgradeTemplate: v => tok(v)[0] ?? '', parseSpecialPowerTemplate: v => tok(v)[0] ?? '', parseAudioEventRTS: v => String(v ?? '').trim(), parseDynamicAudioEventRTS: v => String(v ?? '').trim(),
  parseMappedImage: v => String(v ?? '').trim(), parseBoneNameKey: v => String(v ?? '').trim(), parseAnimation: v => String(v ?? '').trim(),
};
export const knownParsers = () => Object.keys(PARSERS);
export const classTable = name => CLASSES[name.toLowerCase()]; // table de champs d'une classe du moteur (ex. 'W3DModelDrawModuleData.parseConditionState')

export function convert(parser, value) {
  const f = PARSERS[parser];
  return f ? f(value) : { raw: String(value ?? '').trim(), parser }; // parseurs spéciaux (parseTurret, parseFromINI...) : valeur brute, exécutée par le module concerné
}

// Convertit les champs d'un bloc selon une table (schema). Une clé répétée (FX, OCL...) donne une liste. Clés absentes du schéma -> `unknown`.
export function parseFields(table, block) {
  const data = {}, unknown = [];
  for (const it of block.items ?? []) {
    if (it.kind !== 'field') continue;
    const e = table?.[it.key.toLowerCase()];
    if (!e) { unknown.push(it.key); continue; }
    const [name, parser] = e, v = convert(parser, it.value);
    if (name in data) data[name] = Array.isArray(data[name]) && data[name].__multi ? (data[name].push(v), data[name]) : Object.assign([data[name], v], { __multi: true });
    else data[name] = v;
  }
  return { data, unknown };
}

const MODULE_BLOCKS = /^(behavior|draw|body|clientupdate|clientbehavior)$/i;

// Modules d'un Object (héritage ObjectReskin compris) : [{ kind, type, tag, data, unknown, block }]. `block` = bloc INI brut (états, sous-blocs).
export function modulesOf(db, name, seen = new Set()) {
  const key = name.toLowerCase();
  if (seen.has(key)) return [];
  seen.add(key);
  const obj = db.get('Object', name) ?? db.get('ObjectReskin', name);
  if (!obj) return [];
  const own = [];
  for (const it of obj.items ?? []) {
    if (it.kind !== 'block' || !MODULE_BLOCKS.test(it.type) || !it.args?.[0]) continue;
    const type = it.args[0], { data, unknown } = parseFields(MODULES[type.toLowerCase()], it);
    own.push({ kind: it.type, type, tag: it.args[1] ?? '', data, unknown, block: it });
  }
  const parent = obj.type?.toLowerCase() === 'objectreskin' ? obj.args?.[1] : null; // ObjectReskin Nom Parent
  const inherited = parent ? modulesOf(db, parent, seen).filter(m => !own.some(o => o.tag && o.tag === m.tag)) : [];
  return [...inherited, ...own];
}

// Champs de l'Object lui-même (KindOf, Side, BuildCost...), selon la table de ThingTemplate.
export function objectFields(db, name) {
  const obj = db.get('Object', name) ?? db.get('ObjectReskin', name);
  return obj ? parseFields(CLASSES.thingtemplate, obj) : null;
}

// Bloc de premier niveau d'un autre type d'INI (Weapon, Locomotor, Armor, FXList, ...) via la table de la classe moteur correspondante.
const TOP = { weapon: 'weapontemplate', locomotor: 'locomotortemplate', upgrade: 'upgradetemplate', specialpower: 'specialpowertemplate', particlesystem: 'particlesystemtemplate',
              commandbutton: 'commandbutton', commandset: 'commandset', damagefx: 'damagefx', crate: 'cratetemplate' };
export function topLevel(db, type, name) {
  const b = db.get(type, name), t = CLASSES[TOP[type.toLowerCase()]];
  return b && t ? parseFields(t, b) : null;
}

// Couverture : combien de clés des INI le schéma reconnaît-il ? (par module et au total)
export function coverage(db) {
  let known = 0, unknownN = 0; const bad = new Map();
  for (const b of [...db.all('Object'), ...db.all('ObjectReskin')]) {
    for (const m of modulesOf(db, b.args[0])) {
      if (m.block !== b && !(b.items ?? []).includes(m.block)) continue; // chaque module compté une fois (celui de l'objet lui-même)
      const n = (m.block.items ?? []).filter(i => i.kind === 'field').length; known += n - m.unknown.length; unknownN += m.unknown.length;
      for (const u of m.unknown) { const k = `${m.type}.${u}`; bad.set(k, (bad.get(k) ?? 0) + 1); }
    }
  }
  return { known, unknown: unknownN, ratio: known / Math.max(1, known + unknownN), top: [...bad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25) };
}
