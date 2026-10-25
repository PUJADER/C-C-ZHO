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
    this.incomePerSec = 0;        // revenu fixe provisoire (en attendant les camions de ravitaillement)
    this.pupgrades = new Map();   // owner -> Set des améliorations de joueur obtenues
    this.armyPlan = new Map();    // owner -> plan de bataille actif (0 aucun, 1 bombardement, 2 tenir la ligne, 3 recherche et destruction)
    this.matchOwners = new Set(); // joueurs encore dans la partie
    this.startTeamCount = 0;
    this.ended = false;
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
    this.units.set(u.id, u);
    if (!u.cn) this.#onBuilt(u);
    this.events.push({ k: 'spawn', unit: this.describe(u) });
    return u;
  }

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
    u.armor = c.armor?.(u.object, u.flags) ?? u.armor;
    if (u.flags.has('LOCO_UPGRADED')) { const l = c.locomotor(u.object, u.flags); if (l) u.loco = l; }
  }
  #applyModule(u, m) {
    const f = m.f, tk = k => (f[k] ?? '').trim().split(/\s+/).filter(x => x && !/^none$/i.test(x));
    switch (m.type) {
      case 'armorupgrade': u.flags.add('PLAYER_UPGRADE'); return true;
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
    for (const u of all) this.#stepUnit(u);
    this.#resolveCollisions();
    this.#updateArmyPlans();
    for (const u of all) { this.#stepCombat(u); this.#stepConstruction(u); this.#stepProduction(u); this.#stepPlan(u); }
    this.#resolveHits();
    if (this.tick % TICK_HZ === 0) {
      if (this.incomePerSec) for (const [o, m] of this.money) if (this.matchOwners.has(o)) this.money.set(o, m + this.incomePerSec);
      this.#checkEnd();
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
             hp: Math.ceil(u.hp), mh: u.maxHp, cn: u.cn ? 1 : 0, st: u.structure ? 1 : 0, air: u.air ? 1 : 0, fh: u.flyHeight,
             ...(u.fly ? { fl: u.fly } : {}),
             ...(u.exit ? { rp: (p => [r2(p.x), r2(p.y)])(this.rallyOf(u)) } : {}) };
  }
  listUnits() { return [...this.units.values()].map(u => this.describe(u)); }

  // Instantané compact : [id, x, y, angle, pv]
  snapshot() {
    // 6e champ : id de la cible visée (ordre d'attaque ou cible automatique), 0 si aucune : sert à orienter les tourelles
    return [...this.units.values()].map(u => [u.id, r2(u.x), r2(u.y), Math.round(u.angle * 1000) / 1000, Math.ceil(u.hp), u.attackId ?? u.autoId ?? 0]);
  }
}
