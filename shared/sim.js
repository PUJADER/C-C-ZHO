// Simulation à pas fixe (module pur, sans I/O) : le serveur fait autorité.
// Repère : plan sol = (x, y), angle 0 = vers +x (comme les modèles W3D).

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
const deathApplies = (m, death) => (m.deathTypes.all || m.deathTypes.set.has(death)) && !m.deathTypes.minus.has(death); // DieMuxData::DeathTypes
export const MAP_LIMIT = 2000;
const ARRIVE = 1.5;
const STOP_MARGIN = 12;     // une unité s'arrête si elle touche une unité arrêtée près de sa cible
const PUSH_MOVING = 0.4;    // facilité à être poussée : en mouvement < arrêtée (=1) ; immobile = 0
const AUTO_EVERY = 5;       // recherche d'une cible automatique tous les 5 ticks (par unité, décalé)
const SPLASH_FALLOFF = 0.5; // dégâts de zone : 100 % au centre -> 50 % au bord
const QUEUE_MAX = 5;        // taille de la file de production d'un bâtiment
const NO_FLAGS = new Set();
const TAXI_SPEED = 18;       // vitesse d'un avion roulant au sol (unités/s)
const LAND_SPEED = 45;       // vitesse d'un avion en train de se poser
const ORBIT_R = 140;        // rayon du cercle décrit par un avion qui attend en vol
const RETURN_IDLE = 12;       // secondes d'inactivité en vol avant que l'avion rentre à l'aérodrome
const PROP_CELL = 48;         // taille des cases de la grille spatiale du décor
const DOCK_BEGIN_S = 1.5;      // durée de l'état DOCKING_BEGINNING (arrivée) quand l'INI en déclare un
const DOCK_END_S = 1.0;        // idem DOCKING_ENDING (départ)
const BUILD_REACH = 30;     // distance (bord à bord) à laquelle un bulldozer fait avancer un chantier

const TAU = Math.PI * 2;
const wrap = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = v => Math.round(v * 100) / 100;
const ticks = sec => Math.max(1, Math.round(sec * TICK_HZ));

// owner 0 = neutre (cibles d'entraînement) : jamais de tir automatique, attaquable par tous.
export class World {
  constructor(catalog) {
    this.catalog = catalog; // { locomotor, radius, body?, armor?, weapon?, kinds?, build?, buttons? }
    this.units = new Map();
    this.nextId = 1;
    this.tick = 0;
    this.rngState = 0x9e3779b9;
    this.pending = []; // tirs en vol : { at, owner, target, w }
    this.events = [];  // évènements du tick (tirs, impacts, morts, créations...) pour les clients

    // partie : équipes, argent, joueurs encore en lice
    this.teams = new Map();       // owner -> équipe
    this.money = new Map();       // owner -> argent
    this.incomePerSec = 0;        // revenu fixe de secours (cartes sans entrepôt de ravitaillement)
    this.boxValue = catalog.boxValue?.() ?? 75; // valeur d'une caisse déposée au centre (GameData : ValuePerSupplyBox)
    this.pupgrades = new Map();   // owner -> Set des améliorations de joueur obtenues
    this.armyPlan = new Map();    // owner -> plan de bataille actif (0 aucun, 1 bombardement, 2 tenir la ligne, 3 recherche et destruction)
    this.matchOwners = new Set(); // joueurs encore dans la partie
    this.startTeamCount = 0;
    this.ended = false;

    // décor de carte sans points de vie (arbres, rochers...) : cercles fixes dans une grille spatiale
    this.props = []; this.propGrid = new Map(); this.propTypes = []; this.propTypeIdx = new Map();
    this.tunnelCargo = new Map(); // propriétaire -> passagers du réseau de tunnels (partagés entre tous ses tunnels)
  }

  // ---------- joueurs / équipes ----------
  addPlayer(owner, team, money = 0) {
    this.teams.set(owner, team);
    this.money.set(owner, money);
    this.matchOwners.add(owner);
    this.startTeamCount = new Set([...this.matchOwners].map(o => this.teamOf(o))).size;
  }
  teamOf(owner) { return this.teams.get(owner) ?? -owner; }
  areAllies(a, b) { return a === b || (a > 0 && b > 0 && this.teamOf(a) === this.teamOf(b)); }
  moneyObject() { return Object.fromEntries(this.money); }

  // ---------- unités ----------
  spawn(owner, object, x, y, angle = 0, opts = {}) {
    const c = this.catalog;
    const loco = c.locomotor(object);
    const body = c.body?.(object) ?? null;
    const ws = this.#slots(object, NO_FLAGS);
    const kinds = c.kinds?.(object) ?? new Set();
    const buttons = c.buttons?.(object) ?? [];
    const low = cmd => new Set(buttons.filter(b => b.command === cmd && b.object).map(b => b.object.toLowerCase()));
    const u = {
      id: this.nextId++, owner, object, x, y, angle,
      mz: opts.z ?? 0, // décalage vertical posé dans le .map (sol + z : pont à 83, tunnels enfoncés à -6..-15) ; 0 pour toute unité normale
      radius: c.radius ? c.radius(object) : 6,
      speed: 0, target: null, loco,
      immovable: !loco || loco.speed <= 0, // bâtiments, etc.
      fly: this.#flyStyle(object, loco), // 'orbit' : tourne en rond à l'arrêt (ne peut pas stationner) ; 'hover' : flotte, jamais immobile
      dies: c.dies?.(object) ?? [], dying: null, // modules de mort de l'INI : voir #die
      slaved: c.slaved?.(object) ?? null, slaveWait: 0, // SlavedUpdate de l'INI (drones) : voir #stepSlave
      air: !!loco?.air, flyHeight: loco?.air && !opts.grounded ? loco.flyHeight : 0, // appareils : volent (flyHeight = altitude voulue, 0 = au sol), ne collisionnent pas avec le sol
      av: null,                            // avion rattaché à un aérodrome : { st, home, slot, idle, pend, ... }
      contact: null,                       // dernier contact avec un obstacle immobile
      exitFrom: null,                      // id du bâtiment dont l'unité sort : pas de collision avec lui tant qu'elle le chevauche
      maxHp: body?.maxHealth ?? 0, hp: body?.initial ?? 0,
      armor: c.armor?.(object) ?? {},
      ws, weapon: ws[0]?.w ?? null, // armes : une entrée par emplacement (PRIMARY, SECONDARY...) { w, cool, clip }
      attackId: null, autoId: null,
      structure: kinds.has('STRUCTURE'), dozer: kinds.has('DOZER'),
      buildList: low('UNIT_BUILD'), constructList: low('DOZER_CONSTRUCT'),
      queue: [], cn: null, // cn = chantier en cours { progress, total, builder }
      exit: c.exit?.(object) ?? null, // sortie de production (repère du bâtiment)
      rally: null,                     // point de ralliement choisi par le joueur (monde) ; sinon celui de l'INI
      production: c.production?.(object) ?? null, // durées des portes de production (s)
      doors: [],                       // état de chaque porte : { ph: closed|opening|wait|closing, t }
      upgrades: new Set(),             // améliorations d'objet obtenues
      plan: null,                      // Strategy Center : { cur, tgt, ph: idle|closing|opening|active, t }
      eligible: (kinds.has('INFANTRY') || kinds.has('VEHICLE') || kinds.has('CAN_ATTACK')) && !['DOZER', 'STRUCTURE', 'AIRCRAFT', 'DRONE'].some(k => kinds.has(k)), // reçoit les bonus des plans de bataille
      park: null,                      // parking des avions : { spaces, runways, slots: [{ occupant, reserved }] }
      flags: new Set(),                // drapeaux d'amélioration : PLAYER_UPGRADE (jeu d'armes / d'armure), LOCO_UPGRADED
      wb: new Set(),                   // conditions de bonus d'arme actives (PLAYER_UPGRADE...) -> GameData.ini / Weapon.ini
      mc: new Set(),                   // conditions de modèle imposées par les améliorations (POWER_PLANT_UPGRADED, USER_1...)
      applied: new Set(),              // modules *Upgrade déjà appliqués à cet objet
      sub: null,                       // sous-objets montrés / cachés par SubObjectsUpgrade
      cmdset: null,                    // CommandSet imposé par CommandSetUpgrade
      stealth: false, powers: new Set(), master: null,
      capture: c.capture?.(object) ?? null, captureId: null, cap: null,  // peut capturer des bâtiments (SpecialAbilityUpdate *Capture*)
      capturable: !!c.kinds?.(object)?.has('CAPTURABLE'),                // KindOf CAPTURABLE : peut être capturé
      deposit: (d => (d && d.timing > 0 && d.amount > 0 ? { ...d, t: d.timing, paid: false } : null))(c.deposit?.(object) ?? null), // AutoDepositUpdate : revenu régulier
      aflags: new Set(),               // drapeaux d'ARMURE (ArmorUpgrade) : séparés de `flags` (jeu d'armes), comme ARMORSET_ / WEAPONSET_PLAYER_UPGRADE du moteur
      transport: c.transport?.(object) ?? null, cargo: [], evac: null, enterId: null, // TransportContain : passagers retirés de `units` pendant le transport
      sc: c.slotCount?.(object) ?? 0,  // TransportSlotCount : places occupées dans un transport (0 = ne peut pas monter)
      supply: (s => (s ? { ...s, carried: 0, st: 'seek', t: 0, dock: null, auto: true, fl: this.#dockFlags(object), dur: c.dockDurations?.(object) ?? {} } : null))(c.supply?.(object) ?? null), // camion / Chinook de ravitaillement
      dock: (d => (d ? { type: d.type, boxes: d.boxes ?? 0, del: !!d.deleteWhenEmpty, fl: this.#dockFlags(object) } : null))(c.dock?.(object) ?? null),   // entrepôt (caisses) ou centre de ravitaillement
    };
    if (u.production?.doors > 0) u.doors = Array.from({ length: u.production.doors }, () => ({ ph: 'closed', t: 0 }));
    if (c.battlePlan?.(object)) u.plan = { cur: 0, tgt: 0, ph: 'idle', t: 0 };
    const pk = c.parking?.(object);
    if (pk) u.park = { ...pk, slots: pk.spaces.map(() => ({ occupant: null, reserved: false })) };
    if (opts.constructing) {
      const info = c.build?.(object) ?? { time: 5 };
      u.cn = { progress: 0, total: ticks(info.time), builder: opts.builder ?? null };
      u.hp = Math.max(1, u.maxHp * 0.05);
    }
    if (u.transport?.kind === 'tunnel') u.cargo = this.#tunnelCargo(owner); // tous les tunnels d'un joueur partagent le même inventaire
    this.units.set(u.id, u);
    if (!u.cn) this.#onBuilt(u);
    this.events.push({ k: 'spawn', unit: this.describe(u) });
    return u;
  }

  // ---------- décor de carte ----------
  // Objets statiques et indestructibles : des milliers ne coûtent presque rien (la grille évite les tests deux à deux).
  addProp(object, x, y, angle, radius, z = 0) {
    let t = this.propTypeIdx.get(object);
    if (t === undefined) { t = this.propTypes.length; this.propTypes.push({ o: object, r: r2(radius) }); this.propTypeIdx.set(object, t); }
    const p = { t, x, y, angle, radius, z };
    this.props.push(p);
    if (radius >= 1) {
      for (let cx = Math.floor((x - radius) / PROP_CELL); cx <= Math.floor((x + radius) / PROP_CELL); cx++)
        for (let cy = Math.floor((y - radius) / PROP_CELL); cy <= Math.floor((y + radius) / PROP_CELL); cy++) {
          const k = cx * 100003 + cy; let l = this.propGrid.get(k); if (!l) this.propGrid.set(k, l = []); l.push(p);
        }
    }
    return p;
  }
  #propsNear(x, y, r) { // décor dont la case touche le cercle (x, y, r)
    const out = [];
    for (let cx = Math.floor((x - r) / PROP_CELL); cx <= Math.floor((x + r) / PROP_CELL); cx++)
      for (let cy = Math.floor((y - r) / PROP_CELL); cy <= Math.floor((y + r) / PROP_CELL); cy++) { const l = this.propGrid.get(cx * 100003 + cy); if (l) for (const p of l) out.push(p); }
    return out;
  }
  listProps() { return { types: this.propTypes, rows: this.props.map(p => [p.t, r2(p.x), r2(p.y), r2(p.angle), r2(p.z ?? 0)]) }; }

  removeOwner(owner) {
    const ids = [];
    for (const u of this.units.values()) if (u.owner === owner) { ids.push(u.id); this.units.delete(u.id); }
    return ids;
  }

  // Un joueur quitte la partie : ses unités disparaissent et la fin de partie est réévaluée.
  leave(owner) {
    const ids = this.removeOwner(owner);
    this.matchOwners.delete(owner);
    this.#checkEnd();
    return ids;
  }

  countOf(owner) { let n = 0; for (const u of this.units.values()) if (u.owner === owner) n++; return n; }

  // Place libre (aucun chevauchement) pour un cercle de rayon r ?
  isFree(x, y, r, air = false) {
    if (air) return true; // un appareil peut se poser/apparaître n'importe où
    for (const u of this.units.values()) if (!u.air && Math.hypot(u.x - x, u.y - y) < u.radius + r) return false;
    if (this.propGrid.size && this.#propsNear(x, y, r).some(p => Math.hypot(p.x - x, p.y - y) < p.radius + r)) return false;
    return true;
  }

  // Convertit un point du repère du bâtiment (+X avant, +Y gauche) en coordonnées monde.
  #local(b, p) {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    return { x: b.x + p[0] * c - p[1] * s, y: b.y + p[0] * s + p[1] * c };
  }
  rallyOf(b) { return b.rally ?? (b.exit ? this.#local(b, b.exit.rally) : null); }

  // Point de ralliement d'un bâtiment de production (le drapeau de sortie).
  setRally(owner, id, x, y) {
    const b = this.units.get(id);
    x = Number(x); y = Number(y);
    if (!b || b.owner !== owner || !b.exit || !Number.isFinite(x) || !Number.isFinite(y)) return;
    b.rally = { x: clamp(x, -MAP_LIMIT, MAP_LIMIT), y: clamp(y, -MAP_LIMIT, MAP_LIMIT) };
    this.events.push({ k: 'rally', id, x: r2(b.rally.x), y: r2(b.rally.y) });
  }

  // ---------- économie : production et construction (renvoient un message d'erreur ou null) ----------
  train(owner, buildingId, object) {
    const b = this.units.get(buildingId);
    if (!b || b.owner !== owner) return 'Bâtiment introuvable';
    if (b.cn) return 'Bâtiment en construction';
    if (typeof object !== 'string' || !b.buildList.has(object.toLowerCase())) return 'Ce bâtiment ne produit pas ça';
    if (b.queue.length >= QUEUE_MAX) return 'File de production pleine';
    const info = this.catalog.build(object);
    // Un avion garde sa place de parking, même en vol : pas plus d'appareils vivants que de places (un avion abattu libère la sienne).
    let space = null;
    if (b.park && this.catalog.locomotor(object)?.air && !this.catalog.kinds?.(object)?.has('PRODUCED_AT_HELIPAD')) {
      space = this.#freeSlot(b);
      if (space < 0) return 'Plus de place de parking';
    }
    const money = this.money.get(owner) ?? 0;
    if (money < info.cost) return 'Pas assez d\'argent';
    this.money.set(owner, money - info.cost);
    if (space != null) b.park.slots[space].reserved = true;
    const total = ticks(info.time);
    b.queue.push({ object, remaining: total, total, cost: info.cost, space });
    return null;
  }

  // Un bouton de la barre de commandes d'un bâtiment (la liste des boutons vient du CommandSet de son Object).
  press(owner, buildingId, buttonName) {
    const b = this.units.get(buildingId);
    if (!b || b.owner !== owner) return 'Bâtiment introuvable';
    if (b.cn) return 'Bâtiment en construction';
    const btn = this.buttonsOf(b).find(x => x.button === buttonName);
    if (!btn) return 'Bouton inconnu';
    switch (btn.command) {
      case 'UNIT_BUILD': return this.train(owner, buildingId, btn.object);
      case 'OBJECT_UPGRADE': case 'PLAYER_UPGRADE': return this.#queueUpgrade(owner, b, btn);
      case 'SPECIAL_POWER': {
        if (!b.plan || !/BattlePlans/i.test(btn.power ?? '')) return 'Pas encore disponible';
        return this.#choosePlan(b, btn.options.includes('OPTION_ONE') ? 1 : btn.options.includes('OPTION_TWO') ? 2 : btn.options.includes('OPTION_THREE') ? 3 : 0);
      }
      case 'STOP': if (b.plan) return this.#choosePlan(b, 0); return null;
      case 'SELL': return this.sell(owner, b);
      case 'EVACUATE': if (!b.cargo.length) return 'Aucun passager'; b.evac = { t: 0 }; return null;
      default: return 'Pas encore disponible';
    }
  }

  buttonsOf(u) { return (u.cmdset ? this.catalog.buttonsOfSet?.(u.object, u.cmdset) : this.catalog.buttons?.(u.object)) ?? []; }

  hasUpgrade(owner, b, name) {
    const n = name.toLowerCase(), has = set => !!set && [...set].some(x => x.toLowerCase() === n);
    return has(b.upgrades) || has(this.pupgrades.get(owner));
  }

  // ---------- effets des améliorations (modules *Upgrade des Objects) ----------
  // Un module s'applique, une seule fois, quand ses TriggeredBy sont obtenus (tous, si RequiresAllTriggers) et qu'aucun
  // ConflictsWith ne l'est. Les améliorations de joueur touchent tous les objets du joueur, présents et futurs.
  #moduleActive(u, m) {
    if (!m.triggers.length || m.type === 'grantupgradecreate') return false;
    const owned = n => this.hasUpgrade(u.owner, u, n);
    return (m.all ? m.triggers.every(owned) : m.triggers.some(owned)) && !m.conflicts.some(owned);
  }
  #applyUpgrades(u) {
    const mods = this.catalog.upgradeModules?.(u.object);
    if (!mods || u.cn || !this.units.has(u.id)) return;
    let changed = false;
    mods.forEach((m, i) => {
      if (u.applied.has(i) || !this.#moduleActive(u, m)) return;
      u.applied.add(i);
      changed = this.#applyModule(u, m) || changed;
    });
    if (changed) this.#refit(u);
  }
  #refit(u) { // jeu d'armes / d'armure / locomoteur selon les drapeaux
    const c = this.catalog, ws = this.#slots(u.object, u.flags);
    if (ws.map(s => s.w.name).join() !== u.ws.map(s => s.w.name).join()) { u.ws = ws; u.weapon = ws[0]?.w ?? null; }
    u.armor = c.armor?.(u.object, u.aflags) ?? u.armor; // l'armure ne suit que ArmorUpgrade, les armes que WeaponSetUpgrade
    if (u.flags.has('LOCO_UPGRADED')) { const l = c.locomotor(u.object, u.flags); if (l) u.loco = l; }
  }
  #applyModule(u, m) {
    const f = m.f, tk = k => (f[k] ?? '').trim().split(/\s+/).filter(x => x && !/^none$/i.test(x));
    switch (m.type) {
      case 'armorupgrade': u.aflags.add('PLAYER_UPGRADE'); return true;
      case 'weaponsetupgrade': u.flags.add('PLAYER_UPGRADE'); u.mc.add('WEAPONSET_PLAYER_UPGRADE'); return true;
      case 'weaponbonusupgrade': u.wb.add('PLAYER_UPGRADE'); return false;
      case 'locomotorsetupgrade': u.flags.add('LOCO_UPGRADED'); return true;
      case 'maxhealthupgrade': {
        const add = parseFloat(f.addmaxhealth) || 0, type = (f.changetype ?? 'SAME_CURRENTHEALTH').trim().toUpperCase();
        if (type === 'PRESERVE_RATIO') u.hp = u.maxHp > 0 ? u.hp * (u.maxHp + add) / u.maxHp : u.hp;
        else if (type === 'ADD_CURRENT_HEALTH_TOO') u.hp += add;
        u.maxHp += add; u.hp = Math.min(u.hp, u.maxHp);
        return false;
      }
      case 'modelconditionupgrade': if (f.conditionflag) u.mc.add(f.conditionflag.trim().toUpperCase()); return false;
      case 'powerplantupgrade': u.mc.add('POWER_PLANT_UPGRADED'); return false;
      case 'subobjectsupgrade': {
        u.sub ??= { show: [], hide: [] };
        u.sub.show.push(...tk('showsubobjects').map(x => x.toUpperCase())); u.sub.hide.push(...tk('hidesubobjects').map(x => x.toUpperCase()));
        return false;
      }
      case 'commandsetupgrade': u.cmdset = tk('commandset')[0] ?? null; return false;
      case 'stealthupgrade': u.stealth = true; return false;
      case 'unpausespecialpowerupgrade': for (const p of tk('specialpowertemplate')) u.powers.add(p.toLowerCase()); return false;
      case 'objectcreationupgrade': this.#createFor(u, tk('upgradeobject')[0]); return false;
      case 'replaceobjectupgrade': { const o = tk('replaceobject')[0]; if (o) this.#morph(u, o); return true; }
      default: return false; // radar, expérience, passagers... : sans effet sur la simulation
    }
  }
  // Objets créés par une amélioration (drones...) : ils restent près de leur créateur et meurent avec lui.
  #createFor(u, oclName) {
    for (const { object, count } of this.catalog.ocl?.(oclName) ?? []) {
      if (!this.catalog.has(object)) continue;
      for (let i = 0; i < count; i++) {
        const ang = (u.id + i) * 2.4, d = u.radius + 14 + 8 * i;
        const o = this.spawn(u.owner, object, u.x + Math.cos(ang) * d, u.y + Math.sin(ang) * d, ang);
        if (this.catalog.kinds?.(object)?.has('DRONE') || !o.immovable) o.master = u.id;
      }
    }
  }
  // ReplaceObjectUpgrade : l'objet devient un autre (mêmes points de vie en proportion, mêmes améliorations).
  #morph(u, object) {
    if (!this.catalog.has(object)) return;
    const c = this.catalog, ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1, body = c.body?.(object);
    u.object = object; u.radius = c.radius ? c.radius(object) : u.radius;
    if (body) { u.maxHp = body.maxHealth; u.hp = Math.max(1, u.maxHp * ratio); }
    const kinds = c.kinds?.(object) ?? new Set(), buttons = c.buttons?.(object) ?? [];
    const low = cmd => new Set(buttons.filter(b => b.command === cmd && b.object).map(b => b.object.toLowerCase()));
    u.structure = kinds.has('STRUCTURE'); u.buildList = low('UNIT_BUILD'); u.constructList = low('DOZER_CONSTRUCT');
    u.exit = c.exit?.(object) ?? null; u.production = c.production?.(object) ?? null;
    u.doors = u.production?.doors > 0 ? Array.from({ length: u.production.doors }, () => ({ ph: 'closed', t: 0 })) : [];
    u.plan = c.battlePlan?.(object) ? (u.plan ?? { cur: 0, tgt: 0, ph: 'idle', t: 0 }) : null;
    u.cmdset = null; u.applied = new Set();
    this.#refit(u);
    this.events.push({ k: 'morph', id: u.id, object, r: r2(u.radius), mh: u.maxHp });
    this.#applyUpgrades(u);
  }
  // Un objet terminé reçoit les améliorations de son joueur et celles qu'il se donne lui-même (GrantUpgradeCreate).
  #onBuilt(u) {
    for (const m of this.catalog.upgradeModules?.(u.object) ?? []) {
      if (m.type === 'grantupgradecreate' && m.f.upgradetogrant) u.upgrades.add(m.f.upgradetogrant.trim().split(/\s+/)[0]);
    }
    this.#applyUpgrades(u);
  }
  #upgradeDone(owner, scope, player) { // une amélioration vient d'être obtenue
    if (player) { for (const u of this.units.values()) if (u.owner === owner) this.#applyUpgrades(u); }
    else this.#applyUpgrades(scope);
  }
  // Bonus d'arme dus aux améliorations (PLAYER_UPGRADE...) : { dmg, rof, range }. Les lignes WeaponBonus de l'arme priment sur GameData.ini.
  #wb(u, w) {
    const t = { dmg: 1, rof: 1, range: 1 };
    if (!u.wb.size || !w) return t;
    const g = this.catalog.weaponBonus?.() ?? {};
    for (const c of u.wb) { const m = { ...(g[c] ?? {}), ...(w.bonus?.[c] ?? {}) }; t.dmg *= m.DAMAGE ?? 1; t.rof *= m.RATE_OF_FIRE ?? 1; t.range *= m.RANGE ?? 1; }
    return t;
  }
  // État visuel des objets améliorés pour les clients : conditions de modèle, sous-objets, jeu de commandes, furtivité.
  visualStates() {
    const out = {};
    for (const u of this.units.values()) {
      const mc = [...u.mc];
      // Amélioration en cours (tête de file) : certaines ont un état visuel "..._UPGRADING"
      // (centrale électrique : les tiges montent pendant toute la durée de l'amélioration).
      const head = u.queue?.[0];
      if (head?.upgrade) {
        const up = head.upgrade.toLowerCase();
        for (const m of this.catalog.upgradeModules?.(u.object) ?? []) {
          if (m.type === 'powerplantupgrade' && m.triggers.includes(up) && !mc.includes('POWER_PLANT_UPGRADING')) mc.push('POWER_PLANT_UPGRADING');
        }
      }
      // État de dégâts du corps (ActiveBody::calcDamageState) : DAMAGED / REALLYDAMAGED, puis RUBBLE pour une épave. Le client recharge le modèle correspondant.
      if (u.maxHp > 0 && !u.cn) {
        const th = this.catalog.thresholds?.() ?? { damaged: 0.7, really: 0.35 }, ratio = u.hp / u.maxHp;
        if (u.dying?.wreck) mc.push('REALLYDAMAGED', 'RUBBLE');
        else if (ratio <= th.really) mc.push('REALLYDAMAGED');
        else if (ratio <= th.damaged) mc.push('DAMAGED');
      }
      if (u.transport?.kind === 'garrison' && u.cargo.length && !u.dying) mc.push('GARRISONED'); // GarrisonContain : occupé => état de modèle GARRISONED (planches, barbelés... de l'INI)
      if (u.supply) { // ravitailleur : CARRYING tant qu'il porte des caisses ; DOCKING_* selon la phase d'accostage
        const S = u.supply, f = S.fl, atWh = S.st === 'begWh' || S.st === 'load' || S.st === 'endWh';
        if (S.carried > 0 && f.carry) mc.push(f.carry);
        // À l'entrepôt, dès qu'une caisse est prise le filet doit rester affiché avec elle : CARRYING seul, sans DOCKING_ACTIVE / DOCKING_ENDING
        // (sinon le moteur choisit l'état d'accostage, dont l'animation finit sans filet, et le filet ne revient qu'au départ).
        if (!(atWh && S.carried > 0 && f.carry)) {
          if ((S.st === 'begWh' || S.st === 'begCt') && f.beg) mc.push(f.beg);
          else if ((S.st === 'load' || S.st === 'unload') && f.act) mc.push(f.act);
          else if ((S.st === 'endWh' || S.st === 'endCt') && f.end) mc.push(f.end);
        }
      }
      if (u.dock?.fl.act && this.tick - (u.dock.t ?? -1e9) < TICK_HZ / 2) mc.push(u.dock.fl.act); // entrepôt / centre en service
      if (!mc.length && !u.sub && !u.cmdset && !u.stealth) continue;
      out[u.id] = { ...(mc.length ? { mc } : {}), ...(u.sub ? { sub: u.sub } : {}), ...(u.cmdset ? { cs: u.cmdset } : {}), ...(u.stealth ? { sl: 1 } : {}) };
    }
    return out;
  }

  #queueUpgrade(owner, b, btn) {
    const info = this.catalog.upgrade?.(btn.upgrade);
    if (!info) return 'Amélioration inconnue';
    if (this.hasUpgrade(owner, b, btn.upgrade)) return 'Déjà obtenue';
    const player = btn.command === 'PLAYER_UPGRADE';
    for (const u of this.units.values()) { // déjà en cours quelque part (un joueur ne paie pas deux fois la même amélioration)
      if (u.owner !== owner || (!player && u !== b)) continue;
      if (u.queue.some(q => q.upgrade === btn.upgrade)) return 'Déjà en cours';
    }
    // ConflictsWith : une amélioration exclue par une autre déjà obtenue (ex. tourelles de l'Helix) n'est pas disponible
    const refs = (this.catalog.upgradeModules?.(b.object) ?? []).filter(m => m.triggers.includes(btn.upgrade.toLowerCase()));
    if (refs.length && refs.every(m => m.conflicts.some(n => this.hasUpgrade(owner, b, n)))) return 'Incompatible avec une amélioration déjà obtenue';
    if (b.queue.length >= QUEUE_MAX) return 'File de production pleine';
    const money = this.money.get(owner) ?? 0;
    if (money < info.cost) return 'Pas assez d\'argent';
    this.money.set(owner, money - info.cost);
    const total = ticks(info.time);
    b.queue.push({ upgrade: btn.upgrade, player, remaining: total, total, cost: info.cost });
    return null;
  }

  // Annule un élément de la file : remboursement intégral, place de parking libérée.
  cancel(owner, buildingId, index) {
    const b = this.units.get(buildingId);
    if (!b || b.owner !== owner) return 'Bâtiment introuvable';
    const q = b.queue[index];
    if (!q) return null;
    b.queue.splice(index, 1);
    if (q.space != null && b.park) b.park.slots[q.space].reserved = false;
    this.money.set(owner, (this.money.get(owner) ?? 0) + (q.cost ?? 0));
    return null;
  }

  sell(owner, b) {
    if (!b.structure) return 'Pas un bâtiment';
    const info = this.catalog.build?.(b.object) ?? { cost: 0 };
    this.money.set(owner, (this.money.get(owner) ?? 0) + Math.floor(info.cost * 0.5)); // SellPercentage = 50 %
    for (const q of b.queue) this.money.set(owner, (this.money.get(owner) ?? 0) + (q.cost ?? 0));
    this.#destroy(b);
    return null;
  }

  // ---------- plans de bataille (Strategy Center) ----------
  #choosePlan(b, n) {
    const P = b.plan, spec = this.catalog.battlePlan(b.object);
    if (n === P.tgt) return null;
    P.tgt = n;
    if (P.ph === 'idle' || P.ph === 'active') this.#planNext(b, spec);
    return null;
  }
  // Passe à l'étape suivante : replier le plan en cours, ou déployer le plan voulu.
  #planNext(b, spec) {
    const P = b.plan;
    if (P.cur && P.cur !== P.tgt) {
      if (P.cur === 2) this.#holdHealth(b, spec, false);
      P.ph = 'closing'; P.t = 0; this.events.push({ k: 'door', id: b.id, door: P.cur, ph: 'closing', dur: spec.time[P.cur] });
    } else if (P.tgt && P.cur !== P.tgt) {
      P.ph = 'opening'; P.t = 0; this.events.push({ k: 'door', id: b.id, door: P.tgt, ph: 'opening', dur: spec.time[P.tgt] });
    } else P.ph = P.cur ? 'active' : 'idle';
  }
  #holdHealth(b, spec, on) { // Tenir la ligne : points de vie du bâtiment doublés (le ratio est conservé)
    const k = spec.holdHealth || 2;
    if (on) { b.maxHp *= k; b.hp *= k; } else { b.maxHp /= k; b.hp = Math.min(b.hp / k, b.maxHp); }
  }
  #stepPlan(b) {
    const P = b.plan;
    if (!P || P.ph === 'idle' || P.ph === 'active' || b.cn) return;
    const spec = this.catalog.battlePlan(b.object);
    P.t++;
    if (P.ph === 'closing' && P.t >= ticks(spec.time[P.cur])) {
      this.events.push({ k: 'door', id: b.id, door: P.cur, ph: 'closed' });
      P.cur = 0; this.#planNext(b, spec);
    } else if (P.ph === 'opening' && P.t >= ticks(spec.time[P.tgt])) {
      P.cur = P.tgt; P.ph = 'active';
      this.events.push({ k: 'door', id: b.id, door: P.cur, ph: 'wait' }); // "attente" : plan en service
      if (P.cur === 2) this.#holdHealth(b, spec, true);
    }
  }
  #updateArmyPlans() {
    this.armyPlan.clear();
    for (const u of this.units.values()) if (u.plan?.ph === 'active') this.armyPlan.set(u.owner, u.plan.cur);
  }
  // Bonus d'armée d'un plan de bataille : { dmg, armor, range }
  #bonus(u) {
    const n = u.eligible ? this.armyPlan.get(u.owner) : 0;
    return { dmg: n === 1 ? 1.2 : 1, armor: n === 2 ? 0.9 : 1, range: n === 3 ? 1.2 : 1 };
  }

  // ---------- énergie ----------
  energyOf(owner) {
    let prod = 0, use = 0;
    for (const u of this.units.values()) {
      if (u.owner !== owner || u.cn) continue;
      const e = this.catalog.energy?.(u.object);
      if (!e) continue;
      if (e.prod >= 0) prod += e.prod + (e.upgrade && this.hasUpgrade(owner, u, e.upgrade) ? e.bonus : 0);
      else use -= e.prod;
    }
    return [prod, use];
  }
  // État des bâtiments pour les clients : file de production, améliorations, plan de bataille.
  buildingStates() {
    const out = {};
    for (const u of this.units.values()) {
      if (!u.structure || (!u.queue.length && !u.upgrades.size && !u.plan)) continue;
      out[u.id] = { q: u.queue.map(q => [q.object ?? q.upgrade, r2(1 - Math.max(0, q.remaining) / (q.total || 1)), q.upgrade ? 1 : 0]), up: [...u.upgrades], ...(u.plan ? { pl: [u.plan.cur, u.plan.tgt, u.plan.ph] } : {}) };
    }
    return out;
  }
  playerUpgrades() { return Object.fromEntries([...this.pupgrades].map(([o, s]) => [o, [...s]])); }

  place(owner, dozerId, object, x, y, angle = 0) {
    const d = this.units.get(dozerId);
    if (!d || d.owner !== owner || !d.dozer) return 'Pas un bulldozer';
    if (typeof object !== 'string' || !d.constructList.has(object.toLowerCase())) return 'Ce bulldozer ne construit pas ça';
    x = Number(x); y = Number(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAP_LIMIT || Math.abs(y) > MAP_LIMIT) return 'Emplacement invalide';
    const info = this.catalog.build(object), r = this.catalog.radius(object);
    if (!this.isFree(x, y, r + 2)) return 'Emplacement occupé';
    const money = this.money.get(owner) ?? 0;
    if (money < info.cost) return 'Pas assez d\'argent';
    this.money.set(owner, money - info.cost);

    angle = Number.isFinite(Number(angle)) ? wrap(Number(angle)) : 0;
    const b = this.spawn(owner, object, x, y, angle, { constructing: true, builder: d.id });
    // Le bulldozer se rend au bord du chantier.
    let dx = d.x - x, dy = d.y - y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const reach = r + d.radius + 8;
    d.target = { x: x + dx * reach, y: y + dy * reach }; d.attackId = null; d.autoId = null;
    return null;
  }

  // Applique une commande d'un joueur (validée : on ne touche qu'à ses unités).
  command(owner, cmd) {
    if (!cmd || !Array.isArray(cmd.ids)) return;
    const mine = [];
    for (const id of cmd.ids.slice(0, 200)) {
      const u = this.units.get(id);
      if (u && u.owner === owner && !u.immovable) mine.push(u);
    }
    if (!mine.length) return;
    if (cmd.t === 'move' || cmd.t === 'stop' || cmd.t === 'attack') for (const u of mine) { u.enterId = null; if (u.supply) u.supply.auto = false; } // un ordre manuel interrompt le ravitaillement automatique

    if (cmd.t === 'stop') { for (const u of mine) { u.target = null; u.attackId = null; u.autoId = null; if (u.av) u.av.pend = null; } return; }

    if (cmd.t === 'attack') {
      const t = this.units.get(cmd.target);
      if (!t || this.areAllies(owner, t.owner) || t.maxHp <= 0 || t.dying) return;
      for (const u of mine) if (this.#canHitAny(u, t)) this.#giveOrder(u, { attackId: t.id });
      return;
    }

    if (cmd.t !== 'move') return;
    const x = Number(cmd.x), y = Number(cmd.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    // Groupe : on répartit les destinations en grille autour du point cliqué.
    const n = mine.length;
    const spacing = 2 * Math.max(...mine.map(u => u.radius)) + 4;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    mine.forEach((u, i) => {
      const ox = n > 1 ? ((i % cols) - (cols - 1) / 2) * spacing : 0;
      const oy = n > 1 ? (Math.floor(i / cols) - (rows - 1) / 2) * spacing : 0;
      this.#giveOrder(u, { target: { x: clamp(x + ox, -MAP_LIMIT, MAP_LIMIT), y: clamp(y + oy, -MAP_LIMIT, MAP_LIMIT) } });
    });
  }

  step() {
    this.tick++;
    this.#stepDying();
    const all = [...this.units.values()].filter(u => !u.dying);
    for (const u of all) this.#stepFlight(u);
    for (const u of all) this.#stepSlave(u);
    for (const u of all) this.#stepAviation(u);
    for (const u of all) { this.#stepEnter(u); this.#stepSupply(u); this.#stepCapture(u); this.#stepDeposit(u); }
    for (const u of all) this.#stepUnit(u);
    this.#resolveCollisions();
    this.#resolveProps();
    this.#updateArmyPlans();
    for (const u of all) this.#stepEvac(u);
    for (const u of all) { this.#stepCombat(u); this.#stepConstruction(u); this.#stepProduction(u); this.#stepPlan(u); }
    this.#resolveHits();
    if (this.tick % TICK_HZ === 0) {
      if (this.incomePerSec) for (const [o, m] of this.money) if (this.matchOwners.has(o)) this.money.set(o, m + this.incomePerSec);
      this.#checkEnd();
    }
  }

  // ---------- transport de passagers (TransportContain) ----------
  #used(t) { return t.cargo.reduce((n, p) => n + p.sc, 0); }
  #whyNot(u, t) { // pourquoi `u` ne peut pas entrer dans `t` (null : il peut)
    const T = t.transport;
    if (!T || t === u || t.cn || t.dying) return "Ce n'est pas un conteneur";
    const neutralGarrison = t.owner === 0 && T.kind === 'garrison'; // un bâtiment civil neutre peut être occupé par n'importe quel joueur
    if (u.owner !== t.owner && !neutralGarrison) return t.owner === 0 ? 'Conteneur neutre : seules les garnisons peuvent être occupées' : 'Ce conteneur appartient à un autre joueur';
    if (u.sc <= 0 || u.cargo.length || u.dying || u.owner <= 0) return 'Cette unité ne peut pas entrer dans un conteneur';
    const kinds = this.catalog.kinds?.(u.object) ?? new Set();
    if ([...T.forbid].some(k => kinds.has(k)) || (T.allow.size && ![...T.allow].some(k => kinds.has(k)))) return "Ce conteneur n'accepte pas ce type d'unité";
    if (this.#used(t) + u.sc > this.#slotsOf(t)) return 'Plus de place';
    return null;
  }
  #canEnter(u, t) { return !this.#whyNot(u, t); }
  enter(owner, ids, targetId) { // les unités choisies rejoignent le conteneur (si elles peuvent y entrer et qu'il reste de la place) ; renvoie la raison du refus si aucune ne peut
    const t = this.units.get(targetId);
    if (!t || !Array.isArray(ids)) return 'Cible introuvable';
    if (!t.transport) return "Ce bâtiment n'a pas de garnison (aucun conteneur dans son INI)";
    let why = null, n = 0;
    for (const id of ids.slice(0, 200)) {
      const u = this.units.get(id);
      if (!u || u.owner !== owner || u.immovable) continue;
      const w = this.#whyNot(u, t);
      if (w) { why = why ?? w; continue; }
      u.enterId = t.id; u.attackId = null; u.autoId = null; u.captureId = null; n++;
      if (u.supply) u.supply.auto = false;
    }
    return n ? null : (why ?? 'Aucune unité ne peut entrer');
  }
  #stepEnter(u) {
    if (u.enterId == null) return;
    const t = this.units.get(u.enterId);
    if (!t || t.dying || !this.#canEnter(u, t)) { u.enterId = null; return; }
    if (Math.hypot(t.x - u.x, t.y - u.y) <= u.radius + t.radius + 8) return this.#load(u, t);
    u.target = { x: t.x, y: t.y };
  }
  #load(u, t) { // le passager disparaît du monde (il n'est plus simulé) et attend dans le transport
    this.units.delete(u.id);
    u.target = null; u.enterId = null; u.attackId = null; u.autoId = null; u.speed = 0; u.contact = null; u.inside = t.id;
    t.cargo.push(u);
    if (t.transport.kind === 'garrison' && t.owner === 0) { t.owner = u.owner; t.garrisoned = true; this.events.push({ k: 'own', id: t.id, o: t.owner, g: 1 }); } // le 1er occupant en prend le contrôle
    this.events.push({ k: 'in', id: u.id, c: t.id, n: t.cargo.length, cg: this.#cargoView(t) });
  }
  #stepEvac(t) { // évacuation : un passager à la fois (ExitDelay) ; soins des occupants (TimeForFullHeal)
    if (t.transport?.heal > 0 && t.cargo.length && t.cargo.ht !== this.tick) { // (un réseau de tunnels n'est soigné qu'une fois par tick)
      t.cargo.ht = this.tick;
      for (const p of t.cargo) if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * DT / t.transport.heal);
    }
    const e = t.evac; if (!e) return;
    if (!t.cargo.length) { t.evac = null; return; }
    if ((e.t -= DT) > 0) return;
    e.t = Math.max(t.transport?.exitDelay ?? 0, 0.15);
    this.#unload(t, t.cargo[0]);
  }
  #unload(t, p) {
    t.cargo.splice(t.cargo.indexOf(p), 1);
    let x, y, viaExit = false;
    if (t.exit && !t.air) { // bâtiment avec une sortie déclarée dans l'INI : l'unité sort par la porte puis rejoint le ralliement
      const q = this.#local(t, t.exit.create), rp = this.rallyOf(t);
      x = q.x; y = q.y; viaExit = true;
      if (rp && !p.immovable) p.target = { x: rp.x, y: rp.y };
    } else {
      const R = t.radius + p.radius + 4; x = t.x + Math.cos(t.angle + Math.PI) * R; y = t.y + Math.sin(t.angle + Math.PI) * R;
      for (let i = 0; i < 16; i++) { // première place libre autour du conteneur, en partant de l'arrière
        const a = t.angle + Math.PI + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.5, cx = t.x + Math.cos(a) * R, cy = t.y + Math.sin(a) * R;
        if (this.isFree(cx, cy, p.radius)) { x = cx; y = cy; break; }
      }
    }
    p.x = x; p.y = y; p.inside = null; p.exitFrom = viaExit ? t.id : null;
    this.units.set(p.id, p);
    if (t.garrisoned && !t.cargo.length) { t.owner = 0; t.garrisoned = false; this.events.push({ k: 'own', id: t.id, o: 0, g: 1 }); } // plus personne : le bâtiment redevient neutre
    this.events.push({ k: 'spawn', unit: this.describe(p) }, { k: 'cargo', id: t.id, n: t.cargo.length, cg: this.#cargoView(t) });
  }
  #tunnelCargo(owner) { let a = this.tunnelCargo.get(owner); if (!a) this.tunnelCargo.set(owner, a = []); return a; }
  #cargoView(t) { return t.cargo.map(p => [p.object, p.sc]); } // contenu d'un conteneur pour l'interface : [objet, emplacements occupés]
  #slotsOf(t) { return t.transport.kind === 'tunnel' ? (this.catalog.tunnelMax?.() ?? 10) : t.transport.slots; }
  unloadOne(owner, id, index) { // sort un seul occupant (clic sur son emplacement dans le panneau)
    const t = this.units.get(id);
    if (!t || t.owner !== owner || !Number.isInteger(index) || index < 0 || index >= t.cargo.length) return;
    this.#unload(t, t.cargo[index]);
  }
  evacuate(owner, ids) { // vide les conteneurs choisis (bouton / touche E, quel que soit le type de conteneur)
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 200)) { const t = this.units.get(id); if (t && t.owner === owner && t.cargo.length) t.evac = { t: 0 }; }
  }

  // ---------- capture de bâtiments et revenus ----------
  // Une unité qui sait capturer (SpecialAbilityUpdate *Capture*) rejoint un bâtiment CAPTURABLE neutre ou ennemi, reste à son contact le temps de
  // la capture (UnpackTime + PreparationTime) puis le bâtiment change de camp ; AutoDepositUpdate verse ensuite son revenu au nouveau propriétaire.
  capture(owner, ids, targetId) {
    const t = this.units.get(targetId);
    if (!t || t.dying || !Array.isArray(ids)) return 'Cible introuvable';
    if (!t.capturable) return 'Ce bâtiment ne peut pas être capturé';
    if (t.owner === owner || (t.owner > 0 && this.areAllies(owner, t.owner))) return 'Ce bâtiment est déjà à toi ou à un allié';
    let n = 0;
    for (const id of ids.slice(0, 200)) {
      const u = this.units.get(id);
      if (!u || u.owner !== owner || !u.capture) continue;
      u.captureId = t.id; u.cap = null; u.attackId = null; u.autoId = null; u.enterId = null; n++;
      if (u.supply) u.supply.auto = false;
    }
    return n ? null : 'Aucune unité sélectionnée ne sait capturer';
  }
  #stepCapture(u) {
    if (u.captureId == null) return;
    const t = this.units.get(u.captureId);
    if (!t || t.dying || t.owner === u.owner || (t.owner > 0 && this.areAllies(u.owner, t.owner))) { u.captureId = null; u.cap = null; return; }
    if (Math.hypot(t.x - u.x, t.y - u.y) > u.radius + t.radius + u.capture.range + 6) { u.cap = null; u.target = { x: t.x, y: t.y }; return; }
    u.target = null;
    if (!u.cap) u.cap = { t: u.capture.time };
    if ((u.cap.t -= DT) > 0) return;
    this.#changeOwner(t, u.owner);
    u.captureId = null; u.cap = null;
  }
  #changeOwner(t, owner) {
    t.owner = owner; t.garrisoned = false; t.evac = null; t.rally = null;
    for (const p of t.cargo) if (t.transport?.kind !== 'tunnel') p.owner = owner; // (les occupants d'une garnison prise changent de camp avec elle)
    if (t.deposit) { t.deposit.t = t.deposit.timing; if (!t.deposit.paid) { t.deposit.paid = true; if (t.deposit.bonus > 0) { this.money.set(owner, (this.money.get(owner) ?? 0) + t.deposit.bonus); this.events.push({ k: 'cash', id: t.id, v: t.deposit.bonus, dep: true }); } } }
    this.events.push({ k: 'own', id: t.id, o: owner });
  }
  #stepDeposit(u) {
    const D = u.deposit;
    if (!D || u.owner <= 0 || u.dying || u.cn) return;
    if ((D.t -= DT) > 0) return;
    D.t += D.timing;
    this.money.set(u.owner, (this.money.get(u.owner) ?? 0) + D.amount);
    this.events.push({ k: 'cash', id: u.id, v: D.amount, dep: true });
  }

  // ---------- ravitaillement ----------
  // Un camion / Chinook (supply) enchaîne seul : entrepôt le plus proche -> charge une caisse par WarehouseActionDelay jusqu'à MaxBoxes
  // -> centre de ravitaillement allié le plus proche -> dépose (ValuePerSupplyBox par caisse). Un ordre manuel l'arrête (auto = false) ;
  // `gather` (clic droit sur un entrepôt / un centre) le relance.
  gather(owner, ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 200)) {
      const u = this.units.get(id);
      if (u?.owner === owner && u.supply) { u.supply.auto = true; u.supply.st = 'seek'; u.enterId = null; u.attackId = null; }
    }
  }
  #nearestDock(u, type) {
    let best = null, bd = Infinity;
    for (const d of this.units.values()) {
      if (!d.dock || d.dock.type !== type || d.dying || d.cn) continue;
      if (type === 'warehouse' ? d.dock.boxes <= 0 || (d.owner !== 0 && !this.areAllies(u.owner, d.owner)) : !this.areAllies(u.owner, d.owner)) continue;
      const dist = Math.hypot(d.x - u.x, d.y - u.y);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }
  // Conditions de modèle de l'INI utilisées pendant un accostage : DOCKING_BEGINNING / DOCKING_ACTIVE (ou DOCKING) / DOCKING_ENDING, CARRYING.
  // On n'active que celles que l'INI de l'objet déclare, pour ne pas ajouter d'attente inutile. Le client recharge alors le modèle / l'animation de cet état.
  #dockFlags(object) {
    const cn = this.catalog.condNames?.(object);
    if (!cn) return { beg: null, act: null, end: null, carry: null };
    return { beg: cn.has('DOCKING_BEGINNING') ? 'DOCKING_BEGINNING' : null, act: cn.has('DOCKING_ACTIVE') ? 'DOCKING_ACTIVE' : cn.has('DOCKING') ? 'DOCKING' : null,
             end: cn.has('DOCKING_ENDING') ? 'DOCKING_ENDING' : null, carry: cn.has('CARRYING') ? 'CARRYING' : null };
  }
  #stepSupply(u) {
    const S = u.supply;
    if (!S || !S.auto || u.dying || u.cn || u.owner <= 0 || u.exitFrom != null || u.attackId != null || u.enterId != null || u.cargo.length || u.evac) return; // pas de ravitaillement avec des passagers à bord
    const close = d => Math.hypot(d.x - u.x, d.y - u.y) <= u.radius + d.radius + 12;
    const dock = () => (S.dock != null ? this.units.get(S.dock) : null);
    const BEG = S.fl.beg ? (S.dur[S.fl.beg] ?? DOCK_BEGIN_S) : 0, END = S.fl.end ? (S.dur[S.fl.end] ?? DOCK_END_S) : 0;
    // Prise de la 1re caisse / dépôt : la phase dure au moins le temps d'animation de l'état (lu dans le .w3d), sinon l'animation serait coupée par le changement d'état.
    const pickT = () => Math.max(S.whDelay, (S.carried === 0 && S.fl.act ? S.dur[S.fl.act] : 0) ?? 0);
    const dropT = () => Math.max(S.centerDelay, (S.fl.act ? S.dur[S.fl.act + '+CARRYING'] : 0) ?? 0);
    const busy = d => { if (d) d.dock.t = this.tick; }; // le dock est « actif » (pour son propre modèle) tant qu'on s'en sert
    if (S.st === 'seek') {
      const w = S.carried < S.max ? this.#nearestDock(u, 'warehouse') : null;
      if (w) { S.dock = w.id; S.st = 'toWh'; }
      else if (S.carried > 0) { S.dock = null; S.st = 'toCenter'; }
      else { S.st = 'wait'; S.t = 1; }
    } else if (S.st === 'wait') {
      if ((S.t -= DT) <= 0) S.st = 'seek';
    } else if (S.st === 'toWh') {
      const w = dock();
      if (!w || w.dock.boxes <= 0) S.st = 'seek';
      else if (close(w)) { u.target = null; S.st = BEG ? 'begWh' : 'load'; S.t = BEG || pickT(); }
      else u.target = { x: w.x, y: w.y };
    } else if (S.st === 'begWh') { // arrivée à l'entrepôt (DOCKING_BEGINNING)
      u.target = null; busy(dock());
      if ((S.t -= DT) <= 0) { S.st = 'load'; S.t = pickT(); }
    } else if (S.st === 'load') { // une caisse par WarehouseActionDelay (DOCKING_ACTIVE)
      const w = dock();
      if (!w) { S.st = 'seek'; return; }
      busy(w);
      if ((S.t -= DT) > 0) return;
      if (w.dock.boxes > 0) { w.dock.boxes--; S.carried++; this.events.push({ k: 'box', id: u.id, n: S.carried }); }
      if (w.dock.boxes <= 0 && w.dock.del) { this.units.delete(w.id); this.events.push({ k: 'gone', id: w.id }); }
      if (S.carried >= S.max || w.dock.boxes <= 0) { S.dock = null; S.next = S.carried > 0 ? 'toCenter' : 'seek'; S.st = END && !(S.carried > 0 && S.fl.carry) ? 'endWh' : S.next; S.t = END; } // caisse en main + état CARRYING : on repart tout de suite
      else S.t = S.whDelay;
    } else if (S.st === 'endWh') { // départ de l'entrepôt (DOCKING_ENDING)
      if ((S.t -= DT) <= 0) S.st = S.next;
    } else if (S.st === 'toCenter') {
      let c = dock();
      if (!c || c.dock?.type !== 'center') c = this.#nearestDock(u, 'center');
      if (!c) { u.target = null; return; } // pas de centre : on attend d'en avoir un
      S.dock = c.id;
      if (close(c)) { u.target = null; S.st = BEG ? 'begCt' : 'unload'; S.t = BEG || dropT(); }
      else u.target = { x: c.x, y: c.y };
    } else if (S.st === 'begCt') {
      u.target = null; busy(dock());
      if ((S.t -= DT) <= 0) { S.st = 'unload'; S.t = dropT(); }
    } else if (S.st === 'unload') {
      busy(dock());
      if ((S.t -= DT) > 0) return;
      const gain = S.carried * this.boxValue;
      this.money.set(u.owner, (this.money.get(u.owner) ?? 0) + gain);
      this.events.push({ k: 'cash', id: u.id, v: gain });
      S.carried = 0; S.dock = null; S.st = END ? 'endCt' : 'seek'; S.t = END;
    } else if (S.st === 'endCt') {
      if ((S.t -= DT) <= 0) S.st = 'seek';
    }
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  // ---------- mouvement ----------
  #stepUnit(u) {
    if (u.immovable) return;
    if (u.exitFrom != null) { // l'unité a fini de sortir quand elle ne chevauche plus son bâtiment
      const b = this.units.get(u.exitFrom);
      if (!b || Math.hypot(b.x - u.x, b.y - u.y) >= u.radius + b.radius) u.exitFrom = null;
    }
    const L = u.loco;
    let vTarget = 0;

    if (u.target) {
      const dx = u.target.x - u.x, dy = u.target.y - u.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= ARRIVE) {
        const R = u.route, was = u.target; u.target = null;
        if (R && R.cur === was && R.list.length) u.target = R.cur = R.list.shift(); // étape suivante de la route de sortie
        else u.route = null;
      } else {
        let hx = dx / dist, hy = dy / dist;

        // Obstacle immobile touché au tick précédent : on glisse le long de sa surface.
        if (u.contact && u.contact.tick === this.tick - 1) {
          const { nx, ny } = u.contact; // normale : de l'obstacle vers l'unité
          const dot = hx * nx + hy * ny;
          if (dot < 0) {
            let tx = hx - dot * nx, ty = hy - dot * ny;
            if (Math.hypot(tx, ty) < 0.15) { tx = -ny; ty = nx; } // de face : on contourne par la gauche
            const tl = Math.hypot(tx, ty);
            hx = tx / tl; hy = ty / tl;
          }
        }

        const diff = wrap(Math.atan2(hy, hx) - u.angle);
        const maxTurn = L.turnRate * DT;
        u.angle = wrap(u.angle + clamp(diff, -maxTurn, maxTurn));
        const align = Math.abs(diff) > Math.PI / 2 ? 0 : Math.cos(diff); // mal orienté : on tourne d'abord
        const vmax = u.av && (u.av.st === 'taxiPark' || u.av.st === 'toRunway') ? Math.min(L.speed, TAXI_SPEED) : u.av?.st === 'land' ? Math.min(L.speed, LAND_SPEED) : L.speed; // un avion roule lentement au sol
        vTarget = Math.min(vmax * align, Math.sqrt(2 * L.brake * Math.max(0, dist - ARRIVE)));
      }
    }

    if (u.speed < vTarget) u.speed = Math.min(vTarget, u.speed + L.accel * DT);
    else u.speed = Math.max(vTarget, u.speed - L.brake * DT);

    if (u.speed > 0) {
      u.x += Math.cos(u.angle) * u.speed * DT;
      u.y += Math.sin(u.angle) * u.speed * DT;
    }
  }

  // ---------- collisions ----------
  // Séparation des cercles qui se chevauchent. O(n²) : suffisant jusqu'à quelques centaines
  // d'unités ; on passera à une grille spatiale au-delà.
  #resolveCollisions() {
    const arr = [...this.units.values()].filter(u => !u.dying); // un mort ne bloque plus personne
    const invMass = u => (u.immovable ? 0 : (u.target ? PUSH_MOVING : 1));

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        for (let j = i + 1; j < arr.length; j++) {
          const b = arr[j];
          if (a.air || b.air) continue;
          if (a.exitFrom === b.id || b.exitFrom === a.id) continue; // unité en train de sortir de son bâtiment
          const min = a.radius + b.radius;
          let dx = b.x - a.x, dy = b.y - a.y;
          if (Math.abs(dx) >= min || Math.abs(dy) >= min) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;

          let d = Math.sqrt(d2), nx, ny;
          if (d < 1e-6) { const ang = (a.id * 31 + b.id * 17) % 360 * Math.PI / 180; nx = Math.cos(ang); ny = Math.sin(ang); d = 0; }
          else { nx = dx / d; ny = dy / d; }

          const wa = invMass(a), wb = invMass(b), ws = wa + wb;
          if (ws === 0) continue; // deux obstacles immobiles
          const move = (min - d) * 0.8;
          a.x -= nx * move * wa / ws; a.y -= ny * move * wa / ws;
          b.x += nx * move * wb / ws; b.y += ny * move * wb / ws;

          if (pass === 0) {
            if (a.immovable) b.contact = { nx, ny, tick: this.tick };
            if (b.immovable) a.contact = { nx: -nx, ny: -ny, tick: this.tick };
            // Une unité qui en touche une autre, arrêtée près de sa propre cible, considère être arrivée.
            this.#settle(a, b); this.#settle(b, a);
          }
        }
      }
    }
  }

  // Les unités au sol sont repoussées hors du décor (obstacle immobile : même `contact` que pour un bâtiment, pour qu'elles le contournent).
  #resolveProps() {
    if (!this.propGrid.size) return;
    for (const u of this.units.values()) {
      if (u.air || u.dying || u.immovable) continue;
      for (const p of this.#propsNear(u.x, u.y, u.radius)) {
        const dx = u.x - p.x, dy = u.y - p.y, min = u.radius + p.radius, d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2), nx = d < 1e-6 ? 1 : dx / d, ny = d < 1e-6 ? 0 : dy / d;
        u.x += nx * (min - d); u.y += ny * (min - d);
        u.contact = { nx, ny, tick: this.tick };
        this.#settle(u, p);
      }
    }
  }

  #settle(mover, other) {
    if (!mover.target || other.target) return; // `other` doit être arrêtée (ou immobile)
    if (mover.attackId != null) return;        // en poursuite d'une cible : on ne s'arrête pas pour ça
    const d = Math.hypot(mover.target.x - mover.x, mover.target.y - mover.y);
    if (d < mover.radius + other.radius + STOP_MARGIN) mover.target = null;
  }

  // ---------- chantiers et production ----------
  #stepConstruction(u) {
    if (!u.cn || !this.units.has(u.id)) return;
    const b = this.units.get(u.cn.builder);
    if (!b || Math.hypot(b.x - u.x, b.y - u.y) - u.radius - b.radius > BUILD_REACH) return; // le chantier attend son bulldozer
    u.cn.progress++;
    u.hp = Math.max(u.hp, u.maxHp * u.cn.progress / u.cn.total);
    if (u.cn.progress >= u.cn.total) {
      u.cn = null; u.hp = Math.max(u.hp, 1);
      this.events.push({ k: 'built', id: u.id });
      this.#onBuilt(u);
    }
  }

  // ---------- portes de production ----------
  #doorPhase(u, i, ph) {
    const d = u.doors[i]; d.ph = ph; d.t = 0;
    const P = u.production; // dur : le client cale l'animation sur la durée réelle (DoorOpeningTime / DoorCloseTime)
    this.events.push({ k: 'door', id: u.id, door: i + 1, ph, dur: ph === 'opening' ? P.open : ph === 'closing' ? P.close : 0 });
  }
  #stepDoors(u) {
    const P = u.production, sec = v => Math.max(0, Math.round(v * TICK_HZ));
    u.doors.forEach((d, i) => {
      if (d.ph === 'closed') return;
      d.t++;
      if (d.ph === 'opening' && d.t >= sec(P.open)) this.#doorPhase(u, i, 'wait');
      else if (d.ph === 'wait' && d.t >= sec(P.wait)) this.#doorPhase(u, i, 'closing');
      else if (d.ph === 'closing' && d.t >= sec(P.close)) this.#doorPhase(u, i, 'closed');
    });
  }

  // ---------- parking des avions ----------
  #freeSlot(b) { // 1re place libre : ni occupée par un avion vivant, ni réservée par la file de production
    b.park.slots.forEach(s => { if (s.occupant != null && !this.units.has(s.occupant)) s.occupant = null; });
    return b.park.slots.findIndex(s => s.occupant == null && !s.reserved);
  }

  #stepProduction(u) {
    if (u.doors.length) this.#stepDoors(u);
    if (u.park && this.tick % TICK_HZ === 0) this.#freeSlot(u); // libère les places des avions abattus
    if (u.cn || !u.queue.length || !this.units.has(u.id)) return;
    const head = u.queue[0];
    if (head.upgrade) { // amélioration : pas de porte, elle s'applique dès que le temps est écoulé
      if (--head.remaining > 0) return;
      u.queue.shift();
      if (head.player) { if (!this.pupgrades.has(u.owner)) this.pupgrades.set(u.owner, new Set()); this.pupgrades.get(u.owner).add(head.upgrade); }
      else u.upgrades.add(head.upgrade);
      this.events.push({ k: 'upg', id: u.id, name: head.upgrade, player: head.player ? 1 : 0 });
      this.#upgradeDone(u.owner, u, head.player);
      return;
    }
    if (head.remaining > 0 && --head.remaining > 0) return;
    // Unité terminée : le moteur ne la crée qu'une fois la porte TOTALEMENT ouverte (ProductionUpdate::update).
    if (u.doors.length) {
      const di = Math.min(head.space ?? 0, u.doors.length - 1), d = u.doors[di];
      if (d.ph === 'closed') { this.#doorPhase(u, di, 'opening'); return; }
      if (d.ph === 'opening') return;
      if (d.ph === 'closing') this.#doorPhase(u, di, 'wait'); // la porte se refermait : on la remet en attente d'ouverture
      d.t = 0; // porte ouverte : le délai avant fermeture repart
    }
    u.queue.shift();
    this.#exitUnit(u, head);
  }

  #exitUnit(u, head) {
    const r = this.catalog.radius(head.object), air = !!this.catalog.locomotor(head.object)?.air;
    if (u.park && head.space != null) { this.#exitAircraft(u, head); return; }
    if (u.exit && !air) { // sortie déclarée dans l'INI : l'unité apparaît au point de création, dans l'axe du bâtiment, puis rejoint le ralliement
      const p = this.#local(u, u.exit.create), rp = this.rallyOf(u);
      const nu = this.spawn(u.owner, head.object, p.x, p.y, u.angle);
      nu.exitFrom = u.id; // le point de création est dans l'emprise du bâtiment : sans ça la collision éjecte l'unité sur le côté
      if (!nu.immovable) {
        // Chemin de sortie des os (EXITSTART -> EXITEND) : l'unité traverse la porte AVANT de filer vers le ralliement,
        // même si le drapeau est de l'autre côté du bâtiment. Un ordre donné ensuite remplace la cible : la route est alors abandonnée.
        const paths = u.exit.paths, door = Math.min(head.space ?? 0, (paths?.length ?? 1) - 1);
        const list = [];
        if (paths?.length) { const e = this.#local(u, paths[door].end); list.push({ x: e.x, y: e.y }); }
        if (rp) list.push({ x: rp.x, y: rp.y });
        if (list.length) { nu.target = list.shift(); nu.route = { list, cur: nu.target }; }
      }
      return;
    }
    for (let k = 0; k < 48; k++) { // on cherche une place libre autour du bâtiment (spirale d'or)
      const ang = k * 2.399963 + u.id, dist = u.radius + r + 8 + Math.floor(k / 8) * (2 * r + 4);
      const x = u.x + Math.cos(ang) * dist, y = u.y + Math.sin(ang) * dist;
      if (this.isFree(x, y, r, air)) { this.spawn(u.owner, head.object, x, y, ang); return; }
    }
    this.spawn(u.owner, head.object, u.x + u.radius + r + 8, u.y, 0); // plus de place : tant pis, la collision séparera
  }

  // L'avion naît dans le hangar (os RunwayNParkNHan), roule jusqu'à sa place (os RunwayNParkingN) et y reste au sol.
  #exitAircraft(u, head) {
    const sp = u.park.spaces[head.space], slot = u.park.slots[head.space];
    const han = this.#local(u, sp.han), spot = this.#local(u, u.park.parkInHangars ? sp.han : sp.park);
    const nu = this.spawn(u.owner, head.object, han.x, han.y, wrap(u.angle + sp.han[2]), { grounded: true });
    slot.reserved = false; slot.occupant = nu.id;
    nu.exitFrom = u.id;
    nu.av = { st: 'taxiPark', home: u.id, slot: head.space, idle: 0, pend: null, leg: 0, endPt: null, apprPt: null };
    nu.target = { x: spot.x, y: spot.y };
  }

  // Style de vol, lu dans le locomoteur de l'INI : Appearance = HOVER -> stationnaire (drones, hélicoptères) ; WINGS avec MinSpeed > 0
  // -> voilure qui ne peut pas stationner et tourne en rond (CirclingRadius), quand aucun hangar ne la gère.
  #flyStyle(object, loco) {
    const ap = String(loco?.appearance ?? '').toUpperCase();
    if (ap === 'HOVER') return 'hover';
    if (loco?.air && ap === 'WINGS' && loco.minSpeed > 0) return 'orbit';
    return null;
  }
  #rand() { // mulberry32 : déterministe, comme le GameLogicRandomValue du moteur
    let t = (this.rngState = (this.rngState + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // 'orbit' : sans ordre, tourne autour de l'endroit où il s'est arrêté, rayon CirclingRadius de l'INI (les avions de hangar ont leur propre logique).
  #stepFlight(u) {
    if (u.fly !== 'orbit' || u.av || u.immovable || u.cn || !this.units.has(u.id)) return;
    if (u.attackId != null) { u.orbitTg = null; return; }
    if (u.target && u.target !== u.orbitTg) { u.orbitTg = null; u.orbitC = null; return; } // ordre du joueur
    const L = u.loco, R = L.circlingRadius || 140;
    const c = u.orbitC ??= { x: u.x - Math.cos(u.angle - Math.PI / 2) * R, y: u.y - Math.sin(u.angle - Math.PI / 2) * R }; // centre à sa gauche : cercle antihoraire
    const lead = Math.max(35, L.speed * L.speed / (2 * L.brake) + ARRIVE + 12); // cible assez loin devant pour qu'il ne freine pas
    const ph = Math.atan2(u.y - c.y, u.x - c.x) + Math.min(1.3, lead / R);
    u.target = u.orbitTg = { x: c.x + Math.cos(ph) * R, y: c.y + Math.sin(ph) * R };
  }

  // SlavedUpdate du moteur (drones...) : tous les 1/4 s, par ordre de priorité
  //  1. le maître attaque : va au plus près de sa victime (sans s'éloigner du maître de plus de AttackRange), à +/- AttackWanderRange au hasard ;
  //  2. le maître se déplace : survole sa destination (ScoutRange, ScoutWanderRange) ;
  //  3. sinon il garde : au repos et loin de son point, ou à plus de 2 x GuardMaxRange du maître, il choisit un nouveau point au hasard
  //     à GuardMaxRange autour de lui. Comme le point mémorisé suit le maître, le drone ne se pose jamais vraiment : il rôde.
  // Le maître mort, le drone est détruit (le moteur le laisse s'écraser).
  #stepSlave(u) {
    if (u.master == null || !this.units.has(u.id)) return;
    const m = this.units.get(u.master);
    if (!m) { this.#destroy(u); return; }
    const S = u.slaved;
    if (!S) { // pas de SlavedUpdate dans l'INI : il reste simplement près de son maître
      if (u.target || u.attackId != null) return;
      if (Math.hypot(m.x - u.x, m.y - u.y) > m.radius + 45) { const a = Math.atan2(u.y - m.y, u.x - m.x); u.target = { x: m.x + Math.cos(a) * (m.radius + 25), y: m.y + Math.sin(a) * (m.radius + 25) }; }
      return;
    }
    if (--u.slaveWait > 0) return;
    u.slaveWait = Math.max(1, Math.round(TICK_HZ / 4));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const around = (p, r) => { if (!r) return p; const a = this.#rand() * 2 * Math.PI; return { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) }; };
    const toward = (from, to, len) => { const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy) || 1; return { x: from.x + dx / l * len, y: from.y + dy / l * len }; };
    const victim = (m.attackId ?? m.autoId) != null ? this.units.get(m.attackId ?? m.autoId) : null;
    if (S.attackRange && victim) {
      const d = dist(u, victim);
      u.target = around(d > S.attackRange ? toward(m, victim, S.attackRange) : { x: victim.x, y: victim.y }, S.attackWander);
      return;
    }
    if (S.scoutRange && m.target && dist(m, m.target) > S.guardMax * 0.5) {
      const d = dist(u, m.target);
      u.target = around(d > S.scoutRange ? toward(m, m.target, S.scoutRange) : { x: m.target.x, y: m.target.y }, S.scoutWander);
      return;
    }
    if (S.guardMax) {
      // Distances en 3D comme le moteur (FROM_CENTER_3D) : le point mémorisé est au niveau du sol, le drone vole à PreferredHeight (50) du sol, donc
      // il est toujours "trop loin" de son point : au repos il en choisit un nouveau à chaque mise à jour. C'est ce qui le fait rôder sans cesse.
      const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.flyHeight || 0) - (b.flyHeight || 0));
      const off = u.guardOff ?? { x: 0, y: 0 }, pinned = { x: m.x + off.x, y: m.y + off.y, flyHeight: m.flyHeight || 0 };
      if ((!u.target && d3(u, pinned) > 15) || d3(u, m) > 2 * S.guardMax) {
        const a = S.guardWander ? this.#rand() * 2 * Math.PI : 0;
        u.guardOff = S.guardWander ? { x: S.guardMax * Math.cos(a), y: S.guardMax * Math.sin(a) } : { x: 0, y: 0 };
        u.target = { x: pinned.x + u.guardOff.x, y: pinned.y + u.guardOff.y };
      }
    }
  }

  #setAlt(u, h) {
    if (u.flyHeight === h) return;
    u.flyHeight = h;
    this.events.push({ k: 'alt', id: u.id, fh: h });
  }
  #applyOrder(u, o) {
    if (u.av) { u.av.orbiting = false; u.av.orbitC = null; }
    if (!o) return;
    if (o.attackId != null) { u.attackId = o.attackId; u.target = null; }
    else if (o.target) { u.target = { x: o.target.x, y: o.target.y }; u.attackId = null; u.autoId = null; }
  }
  #giveOrder(u, o) {
    const a = u.av;
    if (!a || a.st === 'fly') { this.#applyOrder(u, o); return; }
    if (a.st === 'appr' || a.st === 'land') { a.st = 'fly'; a.idle = 0; this.#setAlt(u, u.loco.flyHeight); this.#applyOrder(u, o); return; }
    a.pend = o; // au sol : l'ordre attend le décollage
    if (a.st === 'parked' || a.st === 'taxiPark') this.#startTakeoff(u);
  }
  #runway(u) {
    const a = u.av, home = a.home != null ? this.units.get(a.home) : null;
    const sp = home?.park?.spaces[a.slot], rw = sp ? home.park.runways[sp.runway] : null;
    return { home, sp, rw, S: rw ? this.#local(home, rw.start) : null, E: rw ? this.#local(home, rw.end) : null };
  }
  #startTakeoff(u) {
    const a = u.av, { home, sp, rw, S, E } = this.#runway(u);
    if (!rw) { a.st = 'fly'; a.idle = 0; this.#setAlt(u, u.loco.flyHeight); this.#applyOrder(u, a.pend); a.pend = null; return; } // pas de piste : décolle sur place
    a.st = 'toRunway'; a.endPt = E; a.leg = 0;
    const pr = sp?.prep ? this.#local(home, sp.prep) : S;
    u.target = { x: pr.x, y: pr.y }; u.attackId = null; u.autoId = null;
  }

  // Cycle de vie d'un avion : taxiPark -> parked -> toRunway -> run -> fly -> appr -> land -> taxiPark
  #stepAviation(u) {
    const a = u.av;
    if (!a) return;
    const { home, sp, rw, S, E } = this.#runway(u);
    if (!home && a.home != null) { // aérodrome détruit : l'avion en vol reste en l'air
      a.home = null;
      if (a.st !== 'fly') { a.st = 'fly'; this.#setAlt(u, u.loco.flyHeight); }
    }
    const dist = p => Math.hypot(p.x - u.x, p.y - u.y);
    switch (a.st) {
      case 'taxiPark':
        if (!u.target) { a.st = 'parked'; if (sp) u.angle = wrap(home.angle + (home.park.parkInHangars ? sp.han[2] : sp.park[2])); }
        break;
      case 'toRunway': // place -> point d'attente (os Prep) -> début de piste
        if (!u.target) {
          if (a.leg === 0) { a.leg = 1; u.target = { x: S.x, y: S.y }; }
          else { a.st = 'run'; a.leg = 0; u.target = { x: E.x + (E.x - S.x) * 0.5, y: E.y + (E.y - S.y) * 0.5 }; } // plein gaz sur la piste, roues au sol
        }
        break;
      case 'run': { // on roule sur la piste ; l'avion ne quitte le sol qu'aux 3/4 de la piste
        const L = Math.hypot(E.x - S.x, E.y - S.y) || 1, done = Math.hypot(u.x - S.x, u.y - S.y);
        if (u.flyHeight === 0 && done > L * 0.75) this.#setAlt(u, u.loco.flyHeight);
        if (dist(a.endPt) < 12 || done > L) { a.st = 'fly'; this.#setAlt(u, u.loco.flyHeight); a.idle = 0; this.#applyOrder(u, a.pend); a.pend = null; }
        break;
      }
      case 'fly': {
        const busy = (u.target && !a.orbiting) || u.attackId != null || a.pend;
        if (busy) { a.idle = 0; a.orbiting = false; a.orbitC = null; break; }
        // rien à faire : un avion ne peut pas faire du sur-place, il tourne en rond
        a.orbiting = true; a.orbitC ??= { x: u.x + Math.cos(u.angle - Math.PI / 2) * -ORBIT_R, y: u.y + Math.sin(u.angle - Math.PI / 2) * -ORBIT_R };
        const ph = Math.atan2(u.y - a.orbitC.y, u.x - a.orbitC.x) + 0.7;
        u.target = { x: a.orbitC.x + Math.cos(ph) * ORBIT_R, y: a.orbitC.y + Math.sin(ph) * ORBIT_R };
        if (home && ++a.idle >= RETURN_IDLE * TICK_HZ) { // longtemps inactif : retour à l'aérodrome
          a.st = 'appr'; a.orbiting = false; a.orbitC = null;
          a.apprPt = { x: E.x + (E.x - S.x) * 0.75, y: E.y + (E.y - S.y) * 0.75 };
          u.target = { ...a.apprPt }; u.autoId = null; this.#setAlt(u, Math.min(u.loco.flyHeight, home.park.approachHeight || 40));
        }
        break;
      }
      case 'appr': // (on enchaîne sans s'arrêter au point d'approche)
        if (dist(a.apprPt) < 70) { a.st = 'land'; a.leg = 0; this.#setAlt(u, 0); u.target = { x: E.x, y: E.y }; }
        break;
      case 'land':
        if (a.leg === 0 && dist(E) < 12) { a.leg = 1; u.target = { x: S.x, y: S.y }; }
        else if (a.leg === 1 && !u.target) {
          const spot = this.#local(home, home.park.parkInHangars ? sp.han : sp.park);
          a.st = 'taxiPark'; u.target = { x: spot.x, y: spot.y };
        }
        break;
    }
  }

  // ---------- fin de partie ----------
  #checkEnd() {
    if (this.ended || this.matchOwners.size === 0 && this.startTeamCount === 0) return;
    const alive = new Set();
    for (const u of this.units.values()) if (this.matchOwners.has(u.owner) && (u.structure || u.dozer)) alive.add(u.owner);
    for (const o of [...this.matchOwners]) {
      if (alive.has(o)) continue;
      this.matchOwners.delete(o); // plus de bâtiment ni de bulldozer : éliminé
      this.events.push({ k: 'out', owner: o, removed: this.removeOwner(o) });
    }
    const teams = new Set([...this.matchOwners].map(o => this.teamOf(o)));
    if (teams.size === 0 || (teams.size === 1 && this.startTeamCount >= 2)) {
      this.ended = true;
      this.events.push({ k: 'end', winners: [...this.matchOwners] });
    }
  }

  // ---------- combat ----------
  #edgeDist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y) - b.radius; }
  #canHit(w, t) { return t.air && t.flyHeight > 0 ? w.antiAir : w.antiGround; } // un canon ne touche pas un hélicoptère, un missile sol-air ne touche pas un char

  #canHitAny(u, t) { return u.ws.some(s => this.#canHit(s.w, t)); }
  #reach(u, w) { return w.range * this.#bonus(u).range * this.#wb(u, w).range; } // Recherche et destruction : portée +20 %
  #slots(object, flags) { // armes d'un objet pour un jeu de drapeaux : une entrée par emplacement
    const c = this.catalog;
    const list = c.weapons ? c.weapons(object, flags) : [c.weapon?.(object, flags) ?? null];
    return list.filter(Boolean).map(w => ({ w, cool: 0, clip: w.clipSize ?? 0 }));
  }

  #acquire(u) {
    let best = null, bd = Math.max(...u.ws.map(s => this.#reach(u, s.w)));
    for (const t of this.units.values()) {
      if (t.owner === 0 || this.areAllies(u.owner, t.owner) || t.maxHp <= 0 || t.dying || !this.#canHitAny(u, t)) continue;
      const d = this.#edgeDist(u, t);
      if (d <= bd) { bd = d; best = t; }
    }
    return best;
  }

  #stepCombat(u) {
    if (!u.ws.length || u.cn || !this.units.has(u.id)) return;
    if (u.av && u.av.st !== 'fly') return; // un avion au sol (parking, piste, atterrissage) ne tire pas
    for (const s of u.ws) if (s.cool > 0) s.cool--;
    const maxReach = Math.max(...u.ws.map(s => this.#reach(u, s.w)));

    let t = null, explicit = false;
    if (u.attackId != null) {
      t = this.units.get(u.attackId);
      if (t && this.#canHitAny(u, t)) explicit = true; else { t = null; u.attackId = null; }
    }
    if (!t) { // cible automatique : seulement si l'unité est au repos
      t = u.autoId != null ? this.units.get(u.autoId) : null;
      if (t && (u.target || this.#edgeDist(u, t) > maxReach)) t = null;
      if (!t && !u.target && u.owner > 0 && (this.tick + u.id) % AUTO_EVERY === 0) t = this.#acquire(u);
      u.autoId = t ? t.id : null;
    }
    if (!t) return;

    const d = this.#edgeDist(u, t);
    const mine = u.ws.filter(s => this.#canHit(s.w, t)); // les armes qui peuvent toucher cette cible
    const rng = Math.max(...mine.map(s => this.#reach(u, s.w)));
    if (explicit) { // poursuite : on se rapproche jusqu'à portée, puis on s'arrête
      if (d > rng * 0.95) { if (!u.immovable) u.target = { x: t.x, y: t.y }; }
      else u.target = null;
    }
    for (const s of mine) if (d <= this.#reach(u, s.w) && d >= s.w.minRange && s.cool === 0) this.#fire(u, t, s); // chaque arme tire de son côté
  }

  #fire(u, t, s) {
    const w = s.w, dist = Math.hypot(t.x - u.x, t.y - u.y);
    const travel = w.speed < 5000 ? Math.ceil(dist / w.speed * TICK_HZ) : 0; // sinon : tir instantané
    const wb = this.#wb(u, w);
    this.pending.push({ at: this.tick + travel, owner: u.owner, target: t.id, w, mult: this.#bonus(u).dmg * wb.dmg });
    this.events.push({ k: 'shot', a: u.id, x: r2(u.x), y: r2(u.y), z: u.flyHeight, tx: r2(t.x), ty: r2(t.y), tz: t.flyHeight, travel });
    s.cool = Math.max(1, Math.round(w.delay / wb.rof));
    if (w.clipSize > 0 && --s.clip <= 0) { s.cool = Math.max(s.cool, w.reload); s.clip = w.clipSize; }
  }

  #resolveHits() {
    const due = [], keep = [];
    for (const h of this.pending) (h.at <= this.tick ? due : keep).push(h);
    this.pending = keep;

    for (const h of due) {
      const t = this.units.get(h.target);
      if (!t) continue; // cible déjà détruite : le tir est perdu
      const { x, y } = t, w = h.w;
      this.events.push({ k: 'hit', x: r2(x), y: r2(y), z: t.flyHeight, r: w.radius });
      const mult = h.mult ?? 1;
      this.#damage(t, w.damage * mult, w.damageType, w.deathType);
      if (w.radius > 0) { // zone : on évite de toucher les alliés du tireur
        for (const u of [...this.units.values()]) {
          if (u.id === h.target || this.areAllies(h.owner, u.owner) || u.maxHp <= 0 || u.dying || !this.#canHit(w, u)) continue;
          const d = Math.max(0, Math.hypot(u.x - x, u.y - y) - u.radius);
          if (d < w.radius) this.#damage(u, w.damage * mult * (1 - SPLASH_FALLOFF * d / w.radius), w.damageType, w.deathType);
        }
      }
    }
  }

  _testDamage(u, base, type, death) { this.#damage(u, base, type, death); } // pour les tests uniquement

  #damage(u, base, type, death = 'NORMAL') {
    if (u.maxHp <= 0 || u.dying || !this.units.has(u.id)) return;
    u.hp -= base * (u.armor[type] ?? u.armor.DEFAULT ?? 1) * this.#bonus(u).armor;
    if (u.hp <= 0) this.#die(u, death);
  }

  // Mort : les modules de mort de l'INI s'appliquent dans leur ordre, filtrés par DeathTypes / ExemptStatus / RequiredStatus (moteur : DieModule).
  //  FXListDie / InstantDeathBehavior : effets ; CreateObjectDie : crée les objets de l'OCL ; DestroyDie : disparaît tout de suite ;
  //  SlowDeathBehavior : agonise DestructionDelay secondes (s'enfonce à SinkRate après SinkDelay) puis disparaît ; KeepObjectDie : reste en épave.
  // Sans aucun module de mort, ou si aucun ne s'applique, on le détruit (le moteur le laisserait en place : sans effet utile ici).
  #die(u, death = 'NORMAL') {
    if (u.dying) return;
    u.hp = 0;
    const active = s => (s === 'UNDER_CONSTRUCTION' ? !!u.cn : false);
    const ok = m => deathApplies(m, death) && ![...m.exempt].some(active) && [...m.required].every(active);
    const app = (u.dies ?? []).filter(ok);
    if (!app.length) { this.#destroy(u); return; }
    const fx = [];
    for (const m of app) {
      if (m.type === 'fxlistdie' || m.type === 'instantdeathbehavior') fx.push(...m.fx);
      if (m.type === 'createobjectdie' || m.type === 'instantdeathbehavior') {
        for (const name of m.ocl) for (const { object, count } of this.catalog.ocl?.(name) ?? []) for (let i = 0; i < count; i++) this.spawn(u.owner, object, u.x, u.y, u.angle);
      }
    }
    if (app.some(m => m.type === 'destroydie')) { this.#destroy(u, fx); return; }
    const slows = app.filter(m => m.type === 'slowdeathbehavior');
    if (slows.length) { // un seul module d'agonie, tiré au sort selon ProbabilityModifier
      let r = this.#rand() * slows.reduce((s, m) => s + m.probability, 0), m = slows[0];
      for (const c of slows) { r -= c.probability; if (r <= 0) { m = c; break; } }
      const dl = m.destructionDelay + (m.destructionVariance ? (this.#rand() * 2 - 1) * m.destructionVariance : 0);
      const sd = m.sinkDelay + this.#rand() * m.sinkDelayVariance;
      u.dying = { t: 0, delay: Math.max(0.1, dl), sinkDelay: sd, sinkRate: m.sinkRate, fx: [...fx, ...m.fx], slow: true };
      u.target = null; u.attackId = null; u.autoId = null; u.speed = 0; u.route = null;
      this.events.push({ k: 'dying', id: u.id, dl: r2(u.dying.delay), sd: r2(sd), sr: m.sinkRate, x: r2(u.x), y: r2(u.y), r: r2(u.radius) });
      return;
    }
    if (app.some(m => m.type === 'keepobjectdie')) { // reste sur place, en épave (modèle RUBBLE)
      u.dying = { t: 0, delay: Infinity, sinkDelay: 0, sinkRate: 0, wreck: true };
      u.target = null; u.attackId = null; u.autoId = null; u.speed = 0;
      this.events.push({ k: 'dying', id: u.id, dl: -1, sd: 0, sr: 0, x: r2(u.x), y: r2(u.y), r: r2(u.radius) });
      return;
    }
    this.#destroy(u, fx); // aucun module ne retire l'objet (FXListDie seul...) : on évite un fantôme à 0 de vie
  }
  #stepDying() {
    for (const u of [...this.units.values()]) {
      const d = u.dying; if (!d) continue;
      d.t += DT;
      if (d.t >= d.delay) this.#destroy(u, d.fx);
    }
  }

  #destroy(u, fx = []) {
    this.units.delete(u.id);
    const lastTunnel = u.transport?.kind !== 'tunnel' || ![...this.units.values()].some(o => o.owner === u.owner && o.transport?.kind === 'tunnel');
    if (lastTunnel) for (const p of [...u.cargo]) { if (u.air && u.flyHeight > 1) u.cargo.splice(u.cargo.indexOf(p), 1); else this.#unload(u, p); } // au sol les passagers sortent ; en vol ils périssent ; tunnel : seulement si c'était le dernier
    this.events.push({ k: 'dead', id: u.id, x: r2(u.x), y: r2(u.y), z: u.flyHeight, r: r2(u.radius), ...(fx.length ? { fx } : {}) });
    if (u.park) for (const s of u.park.slots) { // les avions encore au sol meurent avec leur aérodrome
      const o = s.occupant != null ? this.units.get(s.occupant) : null;
      if (o?.av && o.av.st !== 'fly') { this.units.delete(o.id); this.events.push({ k: 'dead', id: o.id, x: r2(o.x), y: r2(o.y), z: 0, r: r2(o.radius) }); }
    }
    if (u.structure || u.dozer) this.#checkEnd(); // la fin de partie se joue dès la destruction
  }

  // ---------- vues pour le réseau ----------
  describe(u) {
    return { id: u.id, owner: u.owner, object: u.object, x: r2(u.x), y: r2(u.y), a: r2(u.angle), r: r2(u.radius),
             ...(u.mz ? { mz: r2(u.mz) } : {}), hp: Math.ceil(u.hp), mh: u.maxHp, cn: u.cn ? 1 : 0, st: u.structure ? 1 : 0, air: u.air ? 1 : 0, fh: u.flyHeight,
             ...(u.fly ? { fl: u.fly } : {}),
             ...(u.transport ? { lm: this.#slotsOf(u), ld: u.cargo.length, cg: this.#cargoView(u), ck: u.transport.kind ?? 'transport' } : {}), ...(u.sc ? { sc: u.sc } : {}), ...(u.supply ? { sp: 1 } : {}), ...(u.capture ? { cc: 1 } : {}), ...(u.capturable ? { cp: 1 } : {}), ...(u.dock ? { dk: u.dock.type === 'center' ? 2 : 1 } : {}),
             ...(u.exit ? { rp: (p => [r2(p.x), r2(p.y)])(this.rallyOf(u)) } : {}) };
  }
  listUnits() { return [...this.units.values()].map(u => this.describe(u)); }

  // Instantané compact : [id, x, y, angle, pv]
  snapshot() {
    // 6e champ : id de la cible visée (ordre d'attaque ou cible automatique), 0 si aucune : sert à orienter les tourelles
    return [...this.units.values()].map(u => [u.id, r2(u.x), r2(u.y), Math.round(u.angle * 1000) / 1000, Math.ceil(u.hp), u.attackId ?? u.autoId ?? 0]);
  }
}
