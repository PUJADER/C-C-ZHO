// Résolution Object -> modèles W3D, locomoteur et stats de déplacement (à partir de l'INI).
// Partagé : utilisé par le serveur (sim) et le serveur de visionneuse.
import { fieldOf, fieldsOf } from './ini.js';

export function resolveObject(db, name) {
  return db.get('Object', name) ?? db.get('ObjectReskin', name) ?? null;
}

function collect(block, key, out = []) {
  const k = key.toLowerCase();
  for (const it of block.items) {
    if (it.kind === 'field' && it.key.toLowerCase() === k) out.push(it.value);
    else if (it.kind === 'block') collect(it, key, out);
  }
  return out;
}

// Pour un ObjectReskin, on retombe sur l'Object parent (2e argument).
function viaParent(db, name, pick, depth = 0) {
  const b = resolveObject(db, name);
  if (!b) return null;
  const own = pick(b);
  if (own || depth > 4 || b.type.toLowerCase() !== 'objectreskin') return own;
  return viaParent(db, b.args[1], pick, depth + 1) ?? own;
}

export function modelsOf(db, name) {
  return viaParent(db, name, b => {
    const m = [...new Set(collect(b, 'Model').map(v => v.split(/\s+/)[0]).filter(x => x && x.toLowerCase() !== 'none'))];
    return m.length ? m : null;
  });
}

export function locomotorNameOf(db, name, flags = NOFLAGS) {
  return viaParent(db, name, b => {
    const vals = collect(b, 'Locomotor');
    if (!vals.length) return null;
    const up = flags.has('LOCO_UPGRADED') ? vals.find(x => /^SET_NORMAL_UPGRADED\b/i.test(x)) : null; // LocomotorSetUpgrade
    const v = up ?? vals.find(x => /^SET_NORMAL\b/i.test(x)) ?? vals[0];
    return v.split(/\s+/).find(t => !/^SET_/i.test(t)) ?? null;
  });
}

const tokens = v => (v ?? '').trim().split(/\s+/).filter(Boolean);
const num = (b, key, dflt) => { const n = parseFloat(fieldOf(b, key)); return Number.isFinite(n) ? n : dflt; };

// Vitesse en unités/s, rotation en rad/s, accélération/freinage en unités/s².
export function locomotorStats(db, locoName) {
  const b = locoName && db.get('Locomotor', locoName);
  if (!b) return null;
  const speed = num(b, 'Speed', 0);
  return {
    name: locoName,
    speed,
    turnRate: num(b, 'TurnRate', 60) * Math.PI / 180,
    accel: num(b, 'Acceleration', speed * 2),
    brake: num(b, 'Braking', speed * 3),
    appearance: fieldOf(b, 'Appearance') ?? '',
    air: tokens(fieldOf(b, 'Surfaces')).some(x => x.toUpperCase() === 'AIR'),
    flyHeight: numF(b, 'PreferredHeight', 80), // altitude de vol (unités) des appareils
    minSpeed: num(b, 'MinSpeed', 0),            // > 0 + WINGS : ne peut pas stationner, il tourne en rond (CirclingRadius)
    circlingRadius: num(b, 'CirclingRadius', 0),
  };
}

// Géométrie de collision déclarée dans l'INI (CYLINDER / SPHERE / BOX).
// Pour BOX : MajorRadius = demi-longueur, MinorRadius = demi-largeur.
export function geometryOf(db, name) {
  return viaParent(db, name, b => {
    const major = parseFloat(fieldOf(b, 'GeometryMajorRadius'));
    const shape = (fieldOf(b, 'Geometry') ?? '').trim().toUpperCase();
    if (!shape && !Number.isFinite(major)) return null;
    const minor = parseFloat(fieldOf(b, 'GeometryMinorRadius'));
    return {
      shape: shape || 'CYLINDER',
      major: Number.isFinite(major) ? major : 6,
      minor: Number.isFinite(minor) ? minor : (Number.isFinite(major) ? major : 6),
      height: parseFloat(fieldOf(b, 'GeometryHeight')) || 0,
    };
  });
}

// Rayon du cercle de collision utilisé par la simulation.
export function collisionRadius(g) {
  if (!g) return 6;
  const r = g.shape === 'BOX' ? (g.major + g.minor) / 2 : g.major;
  return Math.max(1, r);
}

// ---------- Combat : points de vie, armure, arme ----------
const firstNum = (s, d) => { const m = /-?\d+(\.\d+)?/.exec(s ?? ''); return m ? parseFloat(m[0]) : d; };
const numF = (b, key, d) => firstNum(fieldOf(b, key), d);

function blocksOf(block, type, out = []) {
  const t = type.toLowerCase();
  for (const it of block.items) if (it.kind === 'block') { if (it.type.toLowerCase() === t) out.push(it); else blocksOf(it, type, out); }
  return out;
}
// Jeu "par défaut" : celui sans Conditions (ou Conditions = None), sinon le premier.
const NOFLAGS = new Set();
const condsOfSet = b => (fieldOf(b, 'Conditions') ?? '').trim().split(/\s+/).filter(x => x && !/^none$/i.test(x)).map(x => x.toUpperCase());
// Jeu d'armes / d'armure actif : celui dont TOUTES les Conditions sont dans les drapeaux de l'objet, et qui en a le plus
// (ex. WeaponSet Conditions = PLAYER_UPGRADE une fois l'amélioration obtenue) ; sinon le jeu par défaut.
const pickSet = (sets, flags) => {
  let best = null, bn = -1;
  for (const st of sets) { const c = condsOfSet(st); if (c.length && c.every(x => flags.has(x)) && c.length > bn) { best = st; bn = c.length; } }
  return best ?? defaultSet(sets);
};
const defaultSet = sets => sets.find(b => { const c = (fieldOf(b, 'Conditions') ?? 'None').trim(); return !c || /^none$/i.test(c); }) ?? sets[0] ?? null;

export function bodyStatsOf(db, name) {
  return viaParent(db, name, b => {
    const mh = collect(b, 'MaxHealth');
    const maxHealth = mh.length ? firstNum(mh[0], 0) : 0;
    if (maxHealth <= 0) return null;
    const ih = collect(b, 'InitialHealth');
    return { maxHealth, initial: ih.length ? Math.min(maxHealth, firstNum(ih[0], maxHealth)) : maxHealth };
  });
}

export function armorNameOf(db, name, flags = NOFLAGS) {
  return viaParent(db, name, b => {
    const set = pickSet(blocksOf(b, 'ArmorSet'), flags);
    return set ? (fieldOf(set, 'Armor') ?? '').split(/\s+/)[0] || null : null;
  });
}

// Table { TYPE_DE_DEGATS: multiplicateur } ; DEFAULT = valeur par défaut.
export function armorTable(db, armorName) {
  const b = armorName && db.get('Armor', armorName);
  const table = {};
  if (!b) return table;
  for (const v of collect(b, 'Armor')) {
    const [type, pct] = v.trim().split(/\s+/);
    if (type && pct) table[type.toUpperCase()] = firstNum(pct, 100) / 100;
  }
  return table;
}

export function weaponNameOf(db, name, flags = NOFLAGS) {
  return viaParent(db, name, b => {
    const set = pickSet(blocksOf(b, 'WeaponSet'), flags);
    if (!set) return null;
    for (const v of collect(set, 'Weapon')) {
      const [slot, wname] = v.trim().split(/\s+/);
      if (/^PRIMARY$/i.test(slot) && wname) return wname;
    }
    return null;
  });
}

// "WeaponBonus = PLAYER_UPGRADE RATE_OF_FIRE 200%" -> { PLAYER_UPGRADE: { RATE_OF_FIRE: 2 } }
function bonusLines(lines) {
  const out = {};
  for (const v of lines) {
    const [cond, field, pct] = tokens(v);
    if (!cond || !field || !pct) continue;
    (out[cond.toUpperCase()] ??= {})[field.toUpperCase()] = firstNum(pct, 100) / 100;
  }
  return out;
}
export function weaponBonusTable(db) { // bonus généraux de GameData.ini
  const g = db.all('GameData')[0];
  return g ? bonusLines(fieldsOf(g, 'WeaponBonus')) : {};
}

// Armes d'un jeu : [PRIMARY, SECONDARY, TERTIARY] (noms), sans trous.
export function weaponNamesOf(db, name, flags = NOFLAGS) {
  return viaParent(db, name, b => {
    const set = pickSet(blocksOf(b, 'WeaponSet'), flags);
    if (!set) return null;
    const bySlot = {};
    for (const v of collect(set, 'Weapon')) { const [slot, wname] = tokens(v); if (slot && wname && !/^none$/i.test(wname)) bySlot[slot.toUpperCase()] = wname; }
    const out = ['PRIMARY', 'SECONDARY', 'TERTIARY'].map(k => bySlot[k]).filter(Boolean);
    return out.length ? out : null;
  });
}

// Durées en ms dans l'INI -> ticks ; portées/vitesses en unités (et unités/s).
export function weaponStats(db, weaponName, tickHz = 30) { // (les durées sont converties en ticks)
  const b = weaponName && db.get('Weapon', weaponName);
  if (!b) return null;
  const damage = numF(b, 'PrimaryDamage', 0);
  if (damage <= 0) return null;
  const ticks = ms => Math.max(1, Math.round(ms / 1000 * tickHz));
  return {
    name: weaponName,
    damage,
    radius: numF(b, 'PrimaryDamageRadius', 0),
    range: numF(b, 'AttackRange', 100),
    minRange: numF(b, 'MinimumAttackRange', 0),
    damageType: (fieldOf(b, 'DamageType') ?? 'DEFAULT').trim().split(/\s+/)[0].toUpperCase(),
    deathType: (fieldOf(b, 'DeathType') ?? 'NORMAL').trim().split(/\s+/)[0].toUpperCase(), // type de mort infligé (filtré par DeathTypes des modules de mort)
    delay: ticks(numF(b, 'DelayBetweenShots', 1000)),
    clipSize: numF(b, 'ClipSize', 0),
    reload: ticks(numF(b, 'ClipReloadTime', 0)),
    speed: numF(b, 'WeaponSpeed', 999999),
    antiAir: /^yes$/i.test((fieldOf(b, 'AntiAirborneVehicle') ?? '').trim()),     // peut toucher les appareils en vol
    antiGround: !/^no$/i.test((fieldOf(b, 'AntiGround') ?? 'Yes').trim()),         // peut toucher les cibles au sol
    bonus: bonusLines(fieldsOf(b, 'WeaponBonus')),                                 // bonus propres à cette arme (PLAYER_UPGRADE, VETERAN...)
  };
}

// ---------- Données de partie : KindOf, side, coûts, boutons de commande ----------

export function kindOf(db, name) {
  return viaParent(db, name, b => {
    const v = collect(b, 'KindOf');
    return v.length ? new Set(v.flatMap(tokens).map(x => x.toUpperCase())) : null;
  }) ?? new Set();
}

export function sideOf(db, name) {
  return viaParent(db, name, b => { const v = fieldOf(b, 'Side'); return v ? tokens(v)[0] : null; }) ?? '';
}

// BuildCost (argent) et BuildTime (secondes).
export function buildInfo(db, name) {
  return viaParent(db, name, b => {
    const c = fieldOf(b, 'BuildCost'), t = fieldOf(b, 'BuildTime');
    return c === undefined && t === undefined ? null : { cost: firstNum(c, 0), time: firstNum(t, 5) };
  }) ?? { cost: 0, time: 5 };
}

// Amélioration (Upgrade.ini) : { type: OBJECT | PLAYER, cost, time }
export function upgradeInfo(db, name) {
  const b = db.get('Upgrade', name);
  if (!b) return null;
  return { type: (fieldOf(b, 'Type') ?? 'PLAYER').trim().toUpperCase(), cost: firstNum(fieldOf(b, 'BuildCost'), 0), time: firstNum(fieldOf(b, 'BuildTime'), 5) };
}

// Énergie d'un bâtiment : production (négatif = consommation), bonus d'amélioration, amélioration qui le déclenche (PowerPlantUpgrade).
export function energyOf(db, name) {
  return viaParent(db, name, b => {
    const prod = numF(b, 'EnergyProduction', 0), bonus = numF(b, 'EnergyBonus', 0);
    const up = behaviorBlock(b, 'PowerPlantUpgrade');
    return prod || bonus ? { prod, bonus, upgrade: up ? tokens(fieldOf(up, 'TriggeredBy'))[0] ?? null : null } : null;
  });
}

// Plans de bataille du Strategy Center (BattlePlanUpdate) : durées de déploiement et bonus.
export function battlePlanOf(db, name) {
  return viaParent(db, name, b => {
    const m = behaviorBlock(b, 'BattlePlanUpdate');
    if (!m) return null;
    const sec = k => numF(m, k, 7000) / 1000;
    return { time: [0, sec('BombardmentPlanAnimationTime'), sec('HoldTheLinePlanAnimationTime'), sec('SearchAndDestroyPlanAnimationTime')],
             holdArmor: numF(m, 'HoldTheLinePlanArmorDamageScalar', 0.9), sightScalar: numF(m, 'SearchAndDestroyPlanSightRangeScalar', 1.2),
             holdHealth: numF(m, 'StrategyCenterHoldTheLineMaxHealthScalar', 2), paralyze: numF(m, 'BattlePlanChangeParalyzeTime', 5000) / 1000 };
  });
}

// Boutons du CommandSet de l'Object : [{ slot, button, command, object, upgrade, power, options }]
export function commandButtonsOf(db, name, setOverride = null) {
  const setName = setOverride ?? viaParent(db, name, b => { const v = collect(b, 'CommandSet'); return v.length ? tokens(v[0])[0] : null; });
  const set = setName && db.get('CommandSet', setName);
  if (!set) return [];
  const out = [];
  for (const it of set.items) {
    if (it.kind !== 'field' || !/^\d+$/.test(it.key)) continue;
    const btn = db.get('CommandButton', tokens(it.value)[0] ?? '');
    if (!btn) continue;
    out.push({
      slot: Number(it.key), button: btn.args[0],
      command: (fieldOf(btn, 'Command') ?? '').trim().toUpperCase(),
      object: tokens(fieldOf(btn, 'Object'))[0] ?? null,
      upgrade: tokens(fieldOf(btn, 'Upgrade'))[0] ?? null,
      power: tokens(fieldOf(btn, 'SpecialPower'))[0] ?? null,
      options: tokens(fieldOf(btn, 'Options')).map(x => x.toUpperCase()),
      img: tokens(fieldOf(btn, 'ButtonImage'))[0] ?? null,
    });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// "Animation = UIRGRD_SKL.UIRGRD_RNA" : avant le point = squelette, APRÈS = nom de l'animation ET du fichier
// (le moteur charge "<après le point>.w3d", cf. WW3DAssetManager::Get_HAnim). `alt` = ancien usage (fichier = squelette).
function animRef(v) {
  const t = tokens(v)[0];
  if (!t || /^none$/i.test(t)) return null;
  const dot = t.indexOf('.');
  return dot < 0 ? { file: t, alt: t, name: t } : { file: t.slice(dot + 1), alt: t.slice(0, dot), name: t.slice(dot + 1) };
}

function animOfState(st) {
  const ref = animRef(fieldOf(st, 'Animation')) ?? animRef(fieldOf(st, 'IdleAnimation'));
  if (!ref) return null;
  const sp = tokens(fieldOf(st, 'AnimationSpeedFactorRange')).map(Number).filter(Number.isFinite);
  // Flags = START_FRAME_FIRST / START_FRAME_LAST : image sur laquelle l'animation démarre (et reste si elle est
  // figée : MANUAL, ONCE_BACKWARDS...). Par défaut le moteur part de la DERNIÈRE image.
  const flags = tokens(fieldOf(st, 'Flags')).map(f => f.toUpperCase());
  return { ...ref, mode: (tokens(fieldOf(st, 'AnimationMode'))[0] ?? 'LOOP').toUpperCase(),
           speed: sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 1,
           start: flags.includes('START_FRAME_FIRST') ? 'first' : flags.includes('START_FRAME_LAST') ? 'last' : null };
}

// Conditions d'un état : "DefaultConditionState", "ConditionState = MOVING"... (selon la façon dont l'INI est lu,
// elles sont dans le type, les arguments ou la valeur du bloc : on rassemble tout).
const conditionsOf = st => new Set([st.type, ...(st.args ?? []), st.value]
  .flatMap(x => String(x ?? '').toUpperCase().split(/[\s=]+/)).filter(Boolean));
const NOT_LIVING = ['DYING', 'DEATH', 'DAMAGED', 'REALLYDAMAGED', 'RUBBLE', 'TOPPLED', 'FREEFALL', 'PARACHUTING', 'CONSTRUCTION', 'AWAITING', 'POST', 'PREATTACK', 'SOLD', 'PACKING', 'UNPACKING', 'ENTERING', 'EXITING', 'RAPPELLING', 'CLIMBING'];

// Animations utiles pour les unités mobiles, par état : { idle, move, attack } (chacun { file, alt, name, mode, speed } ou absent).
// idle = état par défaut (ou sans condition de mouvement/tir), move = MOVING, attack = USING_WEAPON_A.
function animStatesIn(states, defaultState) {
  const out = {};
  for (const st of states) {
    const conds = conditionsOf(st);
    if ([...conds].some(c => NOT_LIVING.some(n => c.includes(n)))) continue;
    // Porte du bâtiment : ouverture, attente porte ouverte, fermeture. Chaque module Draw a la sienne (DOOR_1 pour le 1er...).
    // WAITING_TO_CLOSE (plans de bataille) : le module est invisible (Model = NONE) tant que le plan est actif.
    const dm = [...conds].map(c => /^DOOR_(\d+)_(OPENING|WAITING_OPEN|WAITING_TO_CLOSE|CLOSING)$/.exec(c)).find(Boolean);
    const a = animOfState(st);
    if (dm) {
      const n = Number(dm[1]);
      if (dm[2] === 'WAITING_TO_CLOSE' && !a && /^none$/i.test(tokens(fieldOf(st, 'Model'))[0] ?? '')) { out.door_hide = { door: n, hide: true }; continue; }
      const doorKey = { OPENING: 'door_open', WAITING_OPEN: 'door_wait', WAITING_TO_CLOSE: 'door_wait', CLOSING: 'door_close' }[dm[2]];
      if (a && !out[doorKey]) out[doorKey] = { ...a, door: n };
      continue;
    }
    if (!a) continue;
    // Amélioration en cours (pilotée par progression côté client) : conservée séparément pour le pilotage manuel.
    if ([...conds].some(c => c.includes('_UPGRADING'))) { if (!out.upgrading) out.upgrading = a; continue; }
    const moving = conds.has('MOVING'), firing = [...conds].some(c => c.startsWith('USING_WEAPON'));
    const key = firing ? 'attack' : moving ? 'move' : null;
    if (key && !out[key]) out[key] = a;
    else if (!key && (st === defaultState || /DEFAULTCONDITIONSTATE|^NONE$/.test([...conds].join(' '))) && !out.idle) out.idle = a;
  }
  if (!out.idle) { const a = animOfState(defaultState); if (a) out.idle = a; }
  return Object.keys(out).length ? out : null;
}

// ---------- Améliorations : modules *Upgrade des Objects ----------
// Chaque module a TriggeredBy (améliorations qui l'activent), ConflictsWith (qui l'empêchent) et RequiresAllTriggers.
// Les effets sont appliqués par la simulation (voir World.#applyUpgrades) ; ici on ne fait que lire l'INI.
const UPGRADE_MODULES = new Set(['armorupgrade', 'weaponsetupgrade', 'weaponbonusupgrade', 'maxhealthupgrade', 'locomotorsetupgrade',
  'modelconditionupgrade', 'subobjectsupgrade', 'commandsetupgrade', 'stealthupgrade', 'radarupgrade', 'powerplantupgrade',
  'replaceobjectupgrade', 'objectcreationupgrade', 'unpausespecialpowerupgrade', 'grantupgradecreate', 'passengersfireupgrade',
  'experiencescalarupgrade', 'costmodifierupgrade']);
export function upgradeModulesOf(db, name) {
  return viaParent(db, name, b => {
    const out = [];
    const walk = blk => {
      for (const it of blk.items) {
        if (it.kind !== 'block') continue;
        const kind = (it.args[0] ?? '').toLowerCase();
        if (it.type.toLowerCase() === 'behavior' && UPGRADE_MODULES.has(kind)) {
          const f = {};
          for (const x of it.items) if (x.kind === 'field') f[x.key.toLowerCase()] = x.value;
          const names = k => tokens(f[k]).filter(n => !/^none$/i.test(n)).map(n => n.toLowerCase());
          out.push({ type: kind, tag: it.args[1] ?? '', triggers: names('triggeredby'), conflicts: names('conflictswith'),
                     all: /^yes$/i.test((f.requiresalltriggers ?? '').trim()), f });
        } else walk(it);
      }
    };
    walk(b);
    return out.length ? out : null;
  });
}

// ObjectCreationList : [{ object, count }] (les drones de l'amélioration, etc.)
export function oclOf(db, name) {
  const b = db.get('ObjectCreationList', name);
  if (!b) return [];
  const out = [];
  const walk = blk => { for (const it of blk.items) { if (it.kind !== 'block') continue;
    if (it.type.toLowerCase() === 'createobject') { const o = tokens(fieldOf(it, 'ObjectNames'))[0]; if (o) out.push({ object: o, count: Math.max(1, Math.round(numF(it, 'Count', 1))) }); } else walk(it); } };
  walk(b);
  return out;
}

// Premier module Behavior d'un certain type (ProductionUpdate, ParkingPlaceBehavior...).
function behaviorBlock(b, type) {
  const t = type.toLowerCase();
  const find = blk => {
    for (const it of blk.items) {
      if (it.kind !== 'block') continue;
      if (it.type.toLowerCase() === 'behavior' && (it.args[0] ?? '').toLowerCase() === t) return it;
      const r = find(it); if (r) return r;
    }
    return null;
  };
  return find(b);
}

// Portes de production (ProductionUpdate) : le moteur ouvre la porte quand une unité est terminée, ne crée l'unité
// qu'une fois la porte TOTALEMENT ouverte, la laisse ouverte DoorWaitOpenTime, puis la ferme. Durées en secondes.
export function productionOf(db, name) {
  return viaParent(db, name, b => {
    const m = behaviorBlock(b, 'ProductionUpdate');
    if (!m) return null;
    const ms = (k, d) => numF(m, k, d) / 1000;
    return { doors: Math.round(numF(m, 'NumDoorAnimations', 0)), open: ms('DoorOpeningTime', 0), wait: ms('DoorWaitOpenTime', 0),
             close: ms('DoorCloseTime', 0), maxQueue: Math.round(numF(m, 'MaxQueueEntries', 9)) };
  });
}

// Parking des avions (ParkingPlaceBehavior) : NumRows x NumCols places ; les positions viennent des os du modèle.
export function parkingOf(db, name) {
  return viaParent(db, name, b => {
    const m = behaviorBlock(b, 'ParkingPlaceBehavior');
    if (!m) return null;
    const yes = k => /^yes$/i.test((fieldOf(m, k) ?? '').trim());
    return { rows: Math.max(1, Math.round(numF(m, 'NumRows', 1))), cols: Math.max(1, Math.round(numF(m, 'NumCols', 1))),
             hasRunways: yes('HasRunways'), parkInHangars: yes('ParkInHangars'), approachHeight: numF(m, 'ApproachHeight', 50) };
  });
}

// Noms des os logiques du parking (ParkingPlaceBehavior::buildInfo), colonne = piste, rangée = place.
export function parkingBoneNames(info) {
  const spaces = [];
  for (let row = 0; row < info.rows; row++) for (let col = 0; col < info.cols; col++)
    spaces.push({ han: `Runway${col + 1}Park${row + 1}Han`, park: `Runway${col + 1}Parking${row + 1}`, prep: `Runway${col + 1}Prep${row + 1}`, runway: col });
  const runways = [];
  if (info.hasRunways) for (let col = 0; col < info.cols; col++) runways.push({ start: `RunwayStart${col + 1}`, end: `RunwayEnd${col + 1}` });
  return { spaces, runways };
}

// Ce que le moteur de simulation sait d'un bâtiment à parking, à partir des positions d'os déjà lues (bones) ; sans os,
// une grille de secours devant le bâtiment. Repère du bâtiment : +X devant, +Y gauche.
export function buildParking(info, bones, radius = 60) {
  const names = parkingBoneNames(info);
  const pt = n => { const b = bones?.[n.toUpperCase()]; return b ? [b.pos[0], b.pos[1], b.yaw] : null; };
  const spaces = names.spaces.map((s, i) => {
    let park = pt(s.park), han = pt(s.han), prep = pt(s.prep);
    if (!park) { // secours : grille derrière le bâtiment
      const col = i % info.cols, row = Math.floor(i / info.cols);
      park = [-radius * 0.5 - row * 40, (col - (info.cols - 1) / 2) * 40, 0];
    }
    return { han: han ?? park, park, prep: prep ?? park, runway: s.runway, fromBones: !!pt(s.park) };
  });
  const runways = names.runways.map((r, i) => {
    const a = pt(r.start), b = pt(r.end);
    return { start: a ?? [radius, (i - (info.cols - 1) / 2) * 40, 0], end: b ?? [radius + 220, (i - (info.cols - 1) / 2) * 40, 0] };
  });
  return { spaces, runways, approachHeight: info.approachHeight, parkInHangars: info.parkInHangars };
}
// Modèle affiché par défaut + sous-objets à masquer. Sources, par ordre de fiabilité :
//   - hide  : HideSubObject de l'état par défaut (explicite dans l'INI)
//   - muzzle: noms donnés par WeaponMuzzleFlash (le moteur les cache et ne les allume que pendant un tir)
//   - auto  : sous-objets que SEUL un autre état montre (ShowSubObject) : phares de nuit, pièces
//             "endommagées"... visibles nulle part ailleurs, donc masqués dans l'état par défaut.
// Conditions "actives" d'un bâtiment terminé : le centre de commandement a sa tour radar déployée
// (RadarUpdate : RADAR_EXTENDING puis RADAR_UPGRADED). Les autres états (DAMAGED, NIGHT, DOOR_*...) ne s'appliquent pas au repos.
export const ACTIVE_CONDS = ['RADAR_UPGRADED'];

// États (ConditionState...) d'UN module Draw, dans l'ordre de l'INI (les blocs imbriqués sont aplatis).
function statesOfDraw(draw) {
  const states = [];
  const walk = blk => { for (const it of blk.items) { if (it.kind !== 'block') continue; states.push(it); walk(it); } };
  walk(draw);
  return states;
}

// Un objet a souvent PLUSIEURS modules W3DModelDraw (centre de commandement : bâtiment, porte, radar, échafaudages,
// drapeau...). Chacun a son modèle, son squelette et ses états : le moteur les dessine tous au même endroit.
// Résout, pour chaque module, l'état effectif d'un objet au repos (conditions `active`), ou null si le module est caché.
function moduleOf(draw, active) {
  const states = statesOfDraw(draw);
  if (!states.length) return null;
  const low = list => list.map(t => t.toUpperCase());
  const declaredModel = x => tokens(fieldOf(x, 'Model'))[0];
  const hasModel = x => { const m = declaredModel(x); return m && !/^none$/i.test(m); };

  // Le 1er état du module est son état par défaut. Chaque autre état part d'une COPIE de celui-ci (modèle, sous-objets,
  // animation) puis ajoute ses lignes (W3DModelDrawModuleData::parseConditionState). Le moteur retient l'état dont toutes
  // les conditions sont actives et qui en a le plus (W3DModelDraw::findBestInfo).
  const def = states[0];
  const ACT = new Set(active.map(c => c.toUpperCase()));
  const realConds = x => [...conditionsOf(x)].filter(c => !/^(CONDITIONSTATE|DEFAULTCONDITIONSTATE|NONE)$/.test(c));
  let best = null;
  for (const x of states) {
    if (x === def) continue;
    const c = realConds(x);
    if (c.length && c.every(k => ACT.has(k)) && (!best || c.length > realConds(best).length)) best = x;
  }
  const modelName = best && declaredModel(best) ? declaredModel(best) : declaredModel(def);
  if (!modelName || /^none$/i.test(modelName)) {
    // Module caché par défaut mais qui se montre quand la porte n d'un plan de bataille est en attente (pièces déployées :
    // paraboles du Search and Destroy...) : on le renvoie avec `onlyDoor` = n, le client ne l'affiche que dans cette phase.
    for (const x of states) {
      const dm = [...conditionsOf(x)].map(c => /^DOOR_(\d+)_WAITING_TO_CLOSE$/.exec(c)).find(Boolean);
      if (!dm || !hasModel(x) || active.some(c => c.toUpperCase() === dm[0])) continue;
      const m = moduleOf(draw, [...active, dm[0]]);
      if (m) return { ...m, onlyDoor: Number(dm[1]) };
    }
    return null; // module caché dans cet état (Model = None)
  }

  const hiddenSet = new Set(low(fieldsOf(def, 'HideSubObject').flatMap(tokens)));
  const shownSet = new Set(low(fieldsOf(def, 'ShowSubObject').flatMap(tokens)));
  if (best) {
    for (const n of low(fieldsOf(best, 'HideSubObject').flatMap(tokens))) { hiddenSet.add(n); shownSet.delete(n); }
    for (const n of low(fieldsOf(best, 'ShowSubObject').flatMap(tokens))) { shownSet.add(n); hiddenSet.delete(n); }
  }
  const hide = [...hiddenSet], show = [...shownSet];
  const muzzle = [...new Set(states.flatMap(x => fieldsOf(x, 'WeaponMuzzleFlash')).map(v => tokens(v).pop()).filter(Boolean).map(t => t.toUpperCase()))];

  const others = states.filter(x => x !== def && x !== best);
  // Les états de porte, d'ouverture, de déploiement... n'indiquent pas qu'une pièce est cachée au repos
  // (la porte d'un bâtiment est visible fermée) : ils ne servent pas à deviner les parties masquées par défaut.
  const TRANSITIONAL = /DOOR|OPEN|CLOS|RAIS|LOWER|DEPLOY|PACK|LANDING|TAKEOFF|CONSTRUCT|SOLD|SELL|TRANSITION/;
  const stable = others.filter(x => ![...conditionsOf(x)].some(c => TRANSITIONAL.test(c)));
  const shownElsewhere = new Set(stable.flatMap(x => low(fieldsOf(x, 'ShowSubObject').flatMap(tokens))));
  const hiddenElsewhere = new Set(others.flatMap(x => low(fieldsOf(x, 'HideSubObject').flatMap(tokens))));
  const auto = [...shownElsewhere].filter(n => !show.includes(n) && !hiddenElsewhere.has(n) && !hide.includes(n));

  const anim = (best && animOfState(best)) || animOfState(def);
  const anims = animStatesIn(states, def) ?? {};
  // l'état actif remplace l'animation de repos... sauf un état *_UPGRADING : son animation est pilotée par la progression
  // de l'amélioration (anims.upgrading), elle ne doit pas se lancer toute seule comme un repos
  if (best && animOfState(best) && ![...conditionsOf(best)].some(c => c.includes('_UPGRADING'))) anims.idle = animOfState(best);
  // DOOR_n_WAITING_TO_CLOSE avec ShowSubObject / HideSubObject : pièces qui n'apparaissent que quand le plan n est en service
  // (Strategy Center : le châssis du canon de bombardement est caché au repos).
  const doorSub = states.map(x => {
    const dm = [...conditionsOf(x)].map(c => /^DOOR_(\d+)_WAITING_TO_CLOSE$/.exec(c)).find(Boolean);
    if (!dm) return null;
    const sh = low(fieldsOf(x, 'ShowSubObject').flatMap(tokens)), hi = low(fieldsOf(x, 'HideSubObject').flatMap(tokens));
    return sh.length || hi.length ? { door: Number(dm[1]), show: sh, hide: hi } : null;
  }).filter(Boolean);
  // Os nommés par l'INI : Turret = Turret01 (cap), TurretPitch = TurretEL (élévation), WeaponLaunchBone = PRIMARY Muzzle (départ du tir),
  // WeaponRecoilBone = PRIMARY Barrel (recul). Le moteur cherche l'os "Muzzle" ou "Muzzle01" dans le modèle.
  const firstOf = key => { for (const x of states) { const v = fieldsOf(x, key)[0]; if (v) return v; } return null; };
  const lastTok = v => (v ? tokens(v).pop() : null);
  const turretBone = lastTok(firstOf('Turret')), pitchBone = lastTok(firstOf('TurretPitch')), launchBone = lastTok(firstOf('WeaponLaunchBone')), recoilBone = lastTok(firstOf('WeaponRecoilBone'));
  const summary = states.map(x => ({
    conds: realConds(x).length ? realConds(x) : [...conditionsOf(x)].filter(c => c !== 'CONDITIONSTATE'),
    model: declaredModel(x) ?? null,
    show: low(fieldsOf(x, 'ShowSubObject').flatMap(tokens)), hide: low(fieldsOf(x, 'HideSubObject').flatMap(tokens)),
    anim: (a => a ? `${a.alt}.${a.name} ${a.mode}` : null)(animOfState(x)),
  }));
  return { tag: draw.args?.[1] ?? '', model: modelName, hide, show, muzzle, auto, doorSub, turretBone, pitchBone, launchBone, recoilBone, anim, anims: Object.keys(anims).length ? anims : null,
           states: summary, activeState: best ? realConds(best).join('+') : null };
}

export function drawModulesOf(db, name, active = ACTIVE_CONDS) {
  return viaParent(db, name, b => {
    const mods = blocksOf(b, 'Draw').map(d => moduleOf(d, active)).filter(Boolean);
    return mods.length ? mods : null;
  });
}

// Compatibilité : le 1er module visible en champs de tête, tous les modules dans `modules`.
export function drawStateOf(db, name, active = ACTIVE_CONDS) {
  const modules = drawModulesOf(db, name, active);
  return modules ? { ...modules[0], modules } : null;
}

// Sortie de production (DefaultProductionExitUpdate, QueueProductionExitUpdate, SupplyCenterProductionExitUpdate...) :
//   UnitCreatePoint = X:.. Y:.. Z:..   où apparaît l'unité   } repère du bâtiment : +X = avant,
//   NaturalRallyPoint = X:.. Y:.. Z:.. où elle va ensuite    } +Y = gauche, origine = centre
// Renvoie { create: [x, y], rally: [x, y] } ou null si le bâtiment n'a pas de sortie déclarée.
export function productionExitOf(db, name) {
  const xy = v => {
    if (!v) return null;
    const x = /X:\s*(-?\d+(\.\d+)?)/i.exec(v), y = /Y:\s*(-?\d+(\.\d+)?)/i.exec(v);
    return x && y ? [parseFloat(x[1]), parseFloat(y[1])] : null;
  };
  return viaParent(db, name, b => {
    const create = xy(collect(b, 'UnitCreatePoint')[0]);
    if (!create) return null;
    return { create, rally: xy(collect(b, 'NaturalRallyPoint')[0]) ?? [create[0] * 2, create[1] * 2] };
  });
}

// Seuils d'état de dégâts (GameData.ini) : au-dessus de `damaged` de la vie max = intact, entre les deux = DAMAGED, en dessous = REALLYDAMAGED.
export function damageThresholds(db) {
  const g = db.all('GameData')[0];
  return { damaged: g ? numF(g, 'UnitDamagedThreshold', 0.7) : 0.7, really: g ? numF(g, 'UnitReallyDamagedThreshold', 0.35) : 0.35 };
}

// Modules de mort (DieModule du moteur) dans l'ordre de l'INI. Filtres communs (DieMuxData) : DeathTypes, ExemptStatus, RequiredStatus.
const DIE_MODULES = new Set(['slowdeathbehavior', 'instantdeathbehavior', 'fxlistdie', 'createobjectdie', 'destroydie', 'keepobjectdie', 'crushdie']);
function parseDeathTypes(v) { // "ALL -CRUSHED -SPLATTED" | "NORMAL LASERED" | absent = tous
  const t = tokens(v ?? '').map(x => x.toUpperCase());
  const minus = new Set(t.filter(x => x.startsWith('-')).map(x => x.slice(1)));
  const plus = t.filter(x => !x.startsWith('-'));
  return { all: plus.length === 0 || plus.includes('ALL'), set: new Set(plus.filter(x => x !== 'ALL' && x !== 'NONE')), minus };
}
export function deathApplies(m, death) { return (m.deathTypes.all || m.deathTypes.set.has(death)) && !m.deathTypes.minus.has(death); }
export function diesOf(db, name) {
  return viaParent(db, name, b => {
    const out = [];
    const walk = blk => {
      for (const it of blk.items) {
        if (it.kind !== 'block') continue;
        const kind = (it.args[0] ?? '').toLowerCase();
        if (it.type.toLowerCase() === 'behavior' && DIE_MODULES.has(kind)) {
          const f = {}, lists = {};
          for (const x of it.items) if (x.kind === 'field') { const k = x.key.toLowerCase(); f[k] = x.value; (lists[k] ??= []).push(x.value); }
          const ms = k => numF({ items: [{ kind: 'field', key: k, value: f[k] ?? '0' }] }, k, 0) / 1000;
          out.push({ type: kind, tag: it.args[1] ?? '', deathTypes: parseDeathTypes(f.deathtypes),
                     exempt: new Set(tokens(f.exemptstatus ?? '').map(x => x.toUpperCase())), required: new Set(tokens(f.requiredstatus ?? '').map(x => x.toUpperCase())),
                     fx: kind === 'fxlistdie' ? [f.deathfx].filter(Boolean) : (lists.fx ?? []), ocl: kind === 'createobjectdie' ? [f.creationlist].filter(Boolean) : (lists.ocl ?? []),
                     destructionDelay: ms('destructiondelay'), destructionVariance: ms('destructiondelayvariance'), sinkDelay: ms('sinkdelay'), sinkDelayVariance: ms('sinkdelayvariance'),
                     sinkRate: parseFloat(f.sinkrate) || 0, probability: f.probabilitymodifier != null ? (parseInt(f.probabilitymodifier, 10) || 1) : 10 });
        } else walk(it);
      }
    };
    walk(b);
    return out.length ? out : null;
  });
}

// SlavedUpdate (drones...) : distances de garde / attaque / éclaireur de l'INI. Comportement du moteur : voir sim.js #stepSlave.
export function slavedOf(db, name) {
  return viaParent(db, name, b => {
    const n = k => { const v = parseFloat(collect(b, k)[0]); return Number.isFinite(v) ? v : 0; };
    if (!['GuardMaxRange', 'AttackRange', 'ScoutRange'].some(k => collect(b, k).length)) return null;
    return { guardMax: n('GuardMaxRange'), guardWander: n('GuardWanderRange'), attackRange: n('AttackRange'), attackWander: n('AttackWanderRange'),
             scoutRange: n('ScoutRange'), scoutWander: n('ScoutWanderRange'), spot: n('DistToTargetToGrantRangeBonus') };
  });
}

// Conteneurs : TransportContain (véhicules : Slots), OverlordContain / HelixContain (Slots), GarrisonContain (bâtiments : ContainMax),
// HealContain (ContainMax + soins), TunnelContain / CaveContain (inventaire partagé du réseau, capacité = GameData MaxTunnelCapacity).
// AllowInsideKindOf / ForbidInsideKindOf = ce qui peut entrer (infanterie par défaut sauf véhicules de transport) ;
// chaque passager occupe `TransportSlotCount` places (champ de l'objet passager : 0 = ne peut pas entrer).
const CONTAIN_TYPES = [['TransportContain', 'transport', 'Slots'], ['OverlordContain', 'transport', 'Slots'], ['HelixContain', 'transport', 'Slots'],
  ['GarrisonContain', 'garrison', 'ContainMax'], ['HealContain', 'heal', 'ContainMax'], ['TunnelContain', 'tunnel', null], ['CaveContain', 'tunnel', null]];
export function containOf(db, name) {
  return viaParent(db, name, b => {
    for (const [type, kind, key] of CONTAIN_TYPES) {
      const m = behaviorBlock(b, type);
      if (!m) continue;
      const kinds = k => new Set(tokens(fieldOf(m, k) ?? '').map(x => x.toUpperCase()).filter(x => x !== 'NONE'));
      const allow = kinds('AllowInsideKindOf');
      if (!allow.size && kind !== 'transport') allow.add('INFANTRY');
      return { kind, slots: key ? Math.round(numF(m, key, 0)) : 0, allow, forbid: kinds('ForbidInsideKindOf'),
               fire: /^(yes|true|1)$/i.test((fieldOf(m, 'PassengersAllowedToFire') ?? '').trim()), exitDelay: numF(m, 'ExitDelay', 0) / 1000,
               heal: numF(m, 'TimeForFullHeal', 0) / 1000 };
    }
    return null;
  });
}
export const transportOf = containOf; // ancien nom
export function tunnelMaxOf(db) { const g = db.all('GameData')[0]; return g ? Math.round(numF(g, 'MaxTunnelCapacity', 10)) : 10; }
export function slotCountOf(db, name) {
  return viaParent(db, name, b => { const v = fieldOf(b, 'TransportSlotCount'); return v === undefined ? null : Math.round(firstNum(v, 0)); }) ?? 0;
}

// Ravitaillement : camions (SupplyTruckAIUpdate) et Chinook (ChinookAIUpdate) portent MaxBoxes caisses entre un entrepôt
// (SupplyWarehouseDockUpdate : StartingBoxes caisses) et un centre de ravitaillement (SupplyCenterDockUpdate). Durées en secondes.
export function supplyOf(db, name) {
  return viaParent(db, name, b => {
    const m = ['SupplyTruckAIUpdate', 'ChinookAIUpdate', 'WorkerAIUpdate'].map(t => behaviorBlock(b, t)).find(x => x && fieldOf(x, 'MaxBoxes') !== undefined);
    if (!m) return null;
    return { max: Math.max(1, Math.round(numF(m, 'MaxBoxes', 3))), centerDelay: numF(m, 'SupplyCenterActionDelay', 0) / 1000,
             whDelay: numF(m, 'SupplyWarehouseActionDelay', 0) / 1000, scan: numF(m, 'SupplyWarehouseScanDistance', 0) };
  });
}
export function dockOf(db, name) {
  return viaParent(db, name, b => {
    const w = behaviorBlock(b, 'SupplyWarehouseDockUpdate');
    if (w) return { type: 'warehouse', boxes: Math.round(numF(w, 'StartingBoxes', 1)), deleteWhenEmpty: /^(yes|true|1)$/i.test((fieldOf(w, 'DeleteWhenEmpty') ?? '').trim()) };
    if (behaviorBlock(b, 'SupplyCenterDockUpdate')) return { type: 'center' };
    return null;
  });
}
// Conditions de modèle (ConditionState = ...) que l'INI de l'objet déclare dans ses modules Draw : permet de n'activer que les états qui existent.
export function conditionNamesOf(db, name) {
  return viaParent(db, name, b => {
    const out = new Set();
    for (const d of blocksOf(b, 'Draw')) for (const st of statesOfDraw(d)) for (const c of conditionsOf(st)) out.add(c);
    return out.size ? out : null;
  }) ?? new Set();
}
// Rapport texte des états d'affichage d'un objet (pour diagnostiquer une animation) : conditions, modèle, animation, mode, sous-objets.
export function stateReportOf(db, name) {
  const lines = [], join = (st, k) => fieldsOf(st, k).map(v => String(v)).join(' | ') || '-';
  const mods = viaParent(db, name, b => { const d = blocksOf(b, 'Draw'); return d.length ? d : null; }) ?? [];
  mods.forEach((d, i) => {
    lines.push(`Module Draw #${i + 1} : ${[d.type, ...(d.args ?? []), d.value].filter(Boolean).join(' ')}`);
    for (const st of statesOfDraw(d)) {
      const conds = [...conditionsOf(st)].filter(c => c !== 'CONDITIONSTATE' && c !== 'DEFAULTCONDITIONSTATE').join(' ') || 'PAR DÉFAUT';
      lines.push(`  [${st.type}] ${conds}`);
      lines.push(`      Model=${join(st, 'Model')}  Animation=${join(st, 'Animation')}  Mode=${join(st, 'AnimationMode')}  Vitesse=${join(st, 'AnimationSpeedFactorRange')}`);
      const sh = join(st, 'ShowSubObject'), hi = join(st, 'HideSubObject'), fl = join(st, 'Flags'), tk = join(st, 'TransitionKey');
      if (sh !== '-' || hi !== '-') lines.push(`      Show=${sh}  Hide=${hi}`);
      if (fl !== '-' || tk !== '-') lines.push(`      Flags=${fl}  TransitionKey=${tk}`);
    }
  });
  return lines.join('\n') || '(aucun module Draw)';
}
// États d'accostage d'un objet (DOCKING_BEGINNING / _ACTIVE / _ENDING ou DOCKING, avec ou sans CARRYING) qui ont une animation.
function dockStatesOf(db, name) {
  const mods = viaParent(db, name, b => { const d = blocksOf(b, 'Draw'); return d.length ? d : null; }) ?? [], out = [];
  for (const d of mods) for (const st of statesOfDraw(d)) {
    const conds = conditionsOf(st), dk = ['DOCKING_BEGINNING', 'DOCKING_ACTIVE', 'DOCKING_ENDING', 'DOCKING'].find(c => conds.has(c)), ref = dk && animOfState(st);
    if (ref) out.push({ key: dk + (conds.has('CARRYING') ? '+CARRYING' : ''), ref });
  }
  return out;
}
export const dockAnimRefsOf = (db, name) => dockStatesOf(db, name).map(s => s.ref);
// Durée (s) de lecture de chaque état d'accostage = longueur du clip / vitesse de l'INI (animSeconds(ref) = longueur du clip). Les boucles n'ont pas de fin.
export function dockDurationsOf(db, name, animSeconds) {
  const out = {};
  for (const { key, ref } of dockStatesOf(db, name)) {
    if (ref.mode === 'LOOP' || ref.mode === 'PING_PONG') continue;
    const len = animSeconds?.(ref);
    if (len > 0 && out[key] === undefined) out[key] = len / Math.max(0.01, ref.speed || 1);
  }
  return out;
}
// Tous les modules `Behavior = <type>` d'un objet (behaviorBlock n'en renvoie que le premier).
function behaviorBlocks(b, type) {
  const t = type.toLowerCase(), out = [];
  const walk = blk => { for (const it of blk.items) { if (it.kind !== 'block') continue; if (it.type.toLowerCase() === 'behavior' && (it.args[0] ?? '').toLowerCase() === t) out.push(it); walk(it); } };
  walk(b);
  return out;
}
// Capture de bâtiments : SpecialAbilityUpdate dont SpecialPowerTemplate contient CAPTURE (ex. SpecialAbilityRangerCaptureBuilding).
// Durée = UnpackTime + PreparationTime (ms) ; portée = StartAbilityRange.
export function captureOf(db, name) {
  return viaParent(db, name, b => {
    for (const m of behaviorBlocks(b, 'SpecialAbilityUpdate')) {
      if (!/CAPTURE/i.test(fieldOf(m, 'SpecialPowerTemplate') ?? '')) continue;
      return { time: Math.max(1, (numF(m, 'UnpackTime', 0) + numF(m, 'PreparationTime', 0)) / 1000 || 3), range: numF(m, 'StartAbilityRange', 5) };
    }
    return null;
  });
}
// Revenu d'un bâtiment (puits de pétrole, raffinerie) : AutoDepositUpdate = DepositAmount toutes les DepositTiming ms, + InitialCaptureBonus à la capture.
export function depositOf(db, name) {
  return viaParent(db, name, b => {
    const m = behaviorBlock(b, 'AutoDepositUpdate');
    return m ? { timing: numF(m, 'DepositTiming', 0) / 1000, amount: numF(m, 'DepositAmount', 0), bonus: numF(m, 'InitialCaptureBonus', 0) } : null;
  });
}
export function boxValueOf(db) { const g = db.all('GameData')[0]; return g ? numF(g, 'ValuePerSupplyBox', 75) : 75; }

// Tourelle (AIUpdateInterface > Turret) : vitesses de rotation, positions naturelles, balayage au repos. Angles en radians.
export function turretOf(db, name) {
  return viaParent(db, name, b => {
    const v = k => { const x = parseFloat(collect(b, k)[0]); return Number.isFinite(x) ? x : null; };
    const rad = x => (x == null ? null : x * Math.PI / 180);
    const turn = v('TurretTurnRate');
    if (turn == null) return null;
    const yes = k => /^yes|true|1$/i.test(String(collect(b, k)[0] ?? '').trim());
    const nat = v('NaturalTurretAngle') ?? 0, natP = v('NaturalTurretPitch') ?? 0;
    return { turnRate: rad(turn), pitchRate: rad(v('TurretPitchRate') ?? 0), allowsPitch: yes('AllowsPitch'), natAngle: rad(nat), natPitch: rad(natP),
             firePitch: rad(v('FirePitch') ?? natP),
             scan: { minInterval: (v('MinIdleScanInterval') ?? 0) / 1000, maxInterval: (v('MaxIdleScanInterval') ?? 0) / 1000, minAngle: rad(v('MinIdleScanAngle') ?? 0), maxAngle: rad(v('MaxIdleScanAngle') ?? 0) } };
  });
}

// Chemins de sortie lus dans les os du modèle : paires EXITSTART / EXITEND (suffixe éventuel : EXITSTART2 / EXITEND2 = 2e porte).
// Renvoie [{ start: [x, y], end: [x, y] }] dans l'ordre des portes, ou []. Repère du bâtiment (+X avant, +Y gauche).
export function exitPathsOf(bones) {
  if (!bones) return [];
  const paths = [];
  for (const [name, b] of Object.entries(bones)) {
    const m = /^EXIT[_ ]?START(\d*)$/.exec(name);
    if (!m) continue;
    const e = bones[`EXITEND${m[1]}`] ?? bones[`EXIT_END${m[1]}`] ?? bones[`EXIT END${m[1]}`];
    if (e) paths.push({ n: m[1] === '' ? 1 : Number(m[1]), start: [b.pos[0], b.pos[1]], end: [e.pos[0], e.pos[1]] });
  }
  return paths.sort((a, b) => a.n - b.n).map(({ start, end }) => ({ start, end }));
}

// Centres de commandement = factions de départ (data-driven : un mod qui en ajoute apparaît tout seul).
export function factionsOf(db) {
  return db.all('Object')
    .map(b => b.args[0])
    .filter(n => kindOf(db, n).has('COMMANDCENTER'))
    .map(n => ({ object: n, side: sideOf(db, n) }))
    .sort((a, b) => a.side.localeCompare(b.side) || a.object.localeCompare(b.object));
}

// Bulldozer / ouvrier de départ d'une faction (même side, préfixe de nom identique si possible).
// Images d'interface d'un Object : cameo (ButtonImage) et portrait de sélection (SelectPortrait), noms de MappedImage.
export function imagesOf(db, name) {
  return viaParent(db, name, b => {
    const cameo = tokens(fieldOf(b, 'ButtonImage'))[0] ?? null, portrait = tokens(fieldOf(b, 'SelectPortrait'))[0] ?? null;
    return cameo || portrait ? { cameo, portrait } : null;
  }) ?? { cameo: null, portrait: null };
}

// Image nommée (bloc MappedImage) : fichier de texture + rectangle. Coords = "Left:2 Top:2 Right:62 Bottom:50" ; Status ROTATED_90_CLOCKWISE : image tournée dans la texture.
export function mappedImageOf(db, name) {
  const b = db.get('MappedImage', name);
  if (!b) return null;
  const c = Object.fromEntries([...(fieldOf(b, 'Coords') ?? '').matchAll(/(\w+)\s*:\s*(-?\d+)/g)].map(m => [m[1].toLowerCase(), Number(m[2])]));
  const file = tokens(fieldOf(b, 'Texture'))[0];
  if (!file || c.right === undefined) return null;
  return { name: b.args[0], file: file.replace(/\.[^.]+$/, ''), tw: numF(b, 'TextureWidth', 0), th: numF(b, 'TextureHeight', 0), l: c.left ?? 0, t: c.top ?? 0, r: c.right, b: c.bottom ?? 0,
           rot: /ROTATED_90/i.test(fieldOf(b, 'Status') ?? '') };
}

// Matériel roulant : l'Object a un module RailroadBehavior (locomotive ou wagon). Renvoie null sinon.
// prefix = début du nom des waypoints de la voie ; carriages = wagons attelés (CarriageTemplateName) ; speed = vitesse max (unités/s).
export function railOf(db, name) {
  return viaParent(db, name, b => {
    const m = b.items.find(i => i.kind === 'block' && /^behavior$/i.test(i.type) && /^railroadbehavior$/i.test(i.args?.[0] ?? ''));
    if (!m) return null;
    return { locomotive: /^(yes|true|1)$/i.test((fieldOf(m, 'IsLocomotive') ?? '').trim()), carriages: fieldsOf(m, 'CarriageTemplateName').flatMap(tokens),
             speed: numF(m, 'SpeedMax', 100), prefix: tokens(fieldOf(m, 'PathPrefixName'))[0] ?? null, wait: numF(m, 'WaitAtStationTime', 0) };
  });
}

// Définition d'une route ou d'un pont de Data\INI\Roads.ini (blocs « Road X » / « Bridge X »).
export function roadDefOf(db, name) {
  const b = db.get('Road', name) ?? db.get('Bridge', name);
  if (!b) return null;
  const isBridge = !!db.get('Bridge', name) && !db.get('Road', name);
  return { name: b.args[0], bridge: isBridge, texture: tokens(fieldOf(b, 'Texture'))[0] ?? null, width: numF(b, 'RoadWidth', 30), widthInTexture: numF(b, 'RoadWidthInTexture', 1),
           model: tokens(fieldOf(b, 'BridgeModelName'))[0] ?? null, scale: numF(b, 'BridgeScale', 1) };
}

export function dozerFor(db, ccName) {
  const side = sideOf(db, ccName);
  const prefix = ccName.replace(/CommandCenter.*$/i, '').toLowerCase();
  const dozers = db.all('Object').map(b => b.args[0]).filter(n => kindOf(db, n).has('DOZER') && sideOf(db, n) === side);
  return dozers.find(n => n.toLowerCase().startsWith(prefix)) ?? dozers[0] ?? null;
}

export function makeCatalog(db, extras = {}) { // extras.bones(name) : table d'os { NOM: { pos, yaw } } du modèle, si connue
  const cache = new Map();
  return {
    has: name => !!resolveObject(db, name),
    rail(name) { const k = 'rail:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, railOf(db, name)); return cache.get(k); },
    models: name => modelsOf(db, name) ?? [],
    radius: name => collisionRadius(geometryOf(db, name)),
    body: name => bodyStatsOf(db, name),
    kinds(name) {
      const k = 'kinds:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, kindOf(db, name));
      return cache.get(k);
    },
    build(name) {
      const k = 'build:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, buildInfo(db, name));
      return cache.get(k);
    },
    dies(name) { const k = 'dies:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, diesOf(db, name) ?? []); return cache.get(k); },
    thresholds() { return cache.get('thr') ?? (cache.set('thr', damageThresholds(db)), cache.get('thr')); },
    transport(name) { const k = 'transport:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, transportOf(db, name)); return cache.get(k); },
    tunnelMax() { return cache.get('tunmax') ?? (cache.set('tunmax', tunnelMaxOf(db)), cache.get('tunmax')); },
    slotCount(name) { const k = 'slots:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, slotCountOf(db, name)); return cache.get(k); },
    supply(name) { const k = 'supply:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, supplyOf(db, name)); return cache.get(k); },
    dock(name) { const k = 'dock:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, dockOf(db, name)); return cache.get(k); },
    condNames(name) { const k = 'cond:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, conditionNamesOf(db, name)); return cache.get(k); },
    dockDurations(name) { return dockDurationsOf(db, name, extras.animSeconds); }, // pas de cache : les longueurs d'animation sont lues au démarrage, en arrière-plan
    capture(name) { const k = 'capture:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, captureOf(db, name)); return cache.get(k); },
    deposit(name) { const k = 'deposit:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, depositOf(db, name)); return cache.get(k); },
    boxValue() { return cache.get('boxv') ?? (cache.set('boxv', boxValueOf(db)), cache.get('boxv')); },
    slaved(name) { const k = 'slaved:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, slavedOf(db, name)); return cache.get(k); },
    turret(name) { const k = 'turret:' + name.toLowerCase(); if (!cache.has(k)) cache.set(k, turretOf(db, name)); return cache.get(k); },
    exit(name) { // sortie de l'INI (point de création, ralliement) + chemin des os EXITSTART -> EXITEND : l'unité sort PAR la porte
      const k = 'exit:' + name.toLowerCase();
      if (!cache.has(k)) {
        const e = productionExitOf(db, name);
        const paths = e ? exitPathsOf(extras.bones?.(name)) : [];
        cache.set(k, e ? { ...e, ...(paths.length ? { paths } : {}) } : null);
      }
      return cache.get(k);
    },
    upgrade: name => upgradeInfo(db, name),
    energy(name) {
      const k = 'energy:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, energyOf(db, name));
      return cache.get(k);
    },
    battlePlan(name) {
      const k = 'plan:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, battlePlanOf(db, name));
      return cache.get(k);
    },
    production(name) {
      const k = 'prod:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, productionOf(db, name));
      return cache.get(k);
    },
    parking(name) {
      const k = 'park:' + name.toLowerCase();
      if (!cache.has(k)) { const i = parkingOf(db, name); cache.set(k, i ? buildParking(i, extras.bones?.(name) ?? null, collisionRadius(geometryOf(db, name))) : null); }
      return cache.get(k);
    },
    buttons(name) {
      const k = 'buttons:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, commandButtonsOf(db, name));
      return cache.get(k);
    },
    // `flags` : drapeaux d'amélioration de l'objet (PLAYER_UPGRADE, LOCO_UPGRADED...) qui changent de jeu d'armes / d'armure / de locomoteur.
    armor(name, flags = NOFLAGS) {
      const k = 'armor:' + name.toLowerCase() + [...flags].join();
      if (!cache.has(k)) cache.set(k, armorTable(db, armorNameOf(db, name, flags)));
      return cache.get(k);
    },
    weapon(name, flags = NOFLAGS) {
      const k = 'weapon:' + name.toLowerCase() + [...flags].join();
      if (!cache.has(k)) cache.set(k, weaponStats(db, weaponNameOf(db, name, flags)));
      return cache.get(k);
    },
    locomotor(name, flags = NOFLAGS) {
      const k = 'loco:' + name.toLowerCase() + [...flags].join();
      if (!cache.has(k)) cache.set(k, locomotorStats(db, locomotorNameOf(db, name, flags)));
      return cache.get(k);
    },
    weapons(name, flags = NOFLAGS) { // toutes les armes du jeu actif : [{...stats}] (celles sans dégâts sont ignorées)
      const k = 'weapons:' + name.toLowerCase() + [...flags].join();
      if (!cache.has(k)) cache.set(k, (weaponNamesOf(db, name, flags) ?? []).map(n => weaponStats(db, n)).filter(Boolean));
      return cache.get(k);
    },
    upgradeModules(name) {
      const k = 'upm:' + name.toLowerCase();
      if (!cache.has(k)) cache.set(k, upgradeModulesOf(db, name));
      return cache.get(k);
    },
    ocl: name => oclOf(db, name),
    weaponBonus() { return cache.get('wb') ?? (cache.set('wb', weaponBonusTable(db)), cache.get('wb')); },
    buttonsOfSet(name, setName) { return commandButtonsOf(db, name, setName); },
  };
}
