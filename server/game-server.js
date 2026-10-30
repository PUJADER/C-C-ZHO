// Serveur de jeu : WebSocket (/ws), lobby (liste des rooms), rooms indépendantes (une simulation par room)
// et boucle de simulation à 30 ticks/s.
//
// Protocole (JSON, champ `t`) :
//   hors room  : hello {name} · rooms · gchat {text} (chat général) · create {name} · join {room,name}
//   serveur    : rooms {rooms:[…]} (push pour qui est au lobby) · created {id} · welcome {…} · error {msg,fatal?}
//   dans la room : setup {faction|'random',team,color,slot} · ready · spectate {on} · map {id} (hôte) · settings {money,max} (hôte) · kick {id} (hôte) · chat · start · leave · spawn · move · stop · attack · rally · train · press · cancel · build
//   serveur    : players · countdown {n} · cancel {msg} · chat {from,text} · start · snap · ev · leave …
import { WebSocketServer } from 'ws';
import { World, TICK_HZ, DT, MAP_LIMIT } from '../shared/sim.js';
import { makeCatalog, factionsOf, dozerFor } from '../shared/objects.js';
import { PLAYER_COLORS } from '../shared/colors.js';

const MAX_UNITS_PER_PLAYER = 200;
const MAX_NEUTRAL = 30;
const SNAP_EVERY = 2;        // un instantané tous les 2 ticks (15/s)
const START_MONEY = 10000;
const MONEY_CHOICES = [2000, 5000, 10000, 20000, 50000]; // argent de départ proposé par l'hôte
const GCHAT_KEEP = 60;       // messages du chat général gardés pour les nouveaux arrivants
const INCOME_PER_SEC = 10;   // revenu fixe provisoire, en attendant les camions de ravitaillement
const START_RADIUS = 450;    // distance des bases au centre de la carte
const MAX_PLAYERS = 8;
const MAX_MAP_PROPS = 8000;    // décor de carte (arbres, rochers...)
const MAX_MAP_NEUTRAL = 800;   // bâtiments / objets neutres avec points de vie (vraies unités)
const MAX_ROOMS = 20;
const COUNTDOWN_S = 3;
const EMPTY_ROOM_GRACE_MS = 30_000; // une room vide survit 30 s (rechargement de page, passage lobby -> jeu)
const DEV_SPAWN = process.env.DEV_SPAWN !== '0'; // outil de test : création libre d'unités

export function attachGame(httpServer, db, extras = {}, opts = {}) {
  const maps = opts.maps ?? null; // catalogue de cartes (server/maps.js)
  const catalog = makeCatalog(db, extras);
  const factions = factionsOf(db);
  const rooms = new Map(); // id -> room
  const conns = new Map(); // ws -> { name, room, me }
  const gchat = []; // historique du chat général
  let roomsDirty = false;

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });

  const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const broadcastRoom = (room, o) => { const s = JSON.stringify(o); for (const ws of room.players.keys()) if (ws.readyState === 1) ws.send(s); };
  const defaultFaction = () => factions[0]?.object ?? null;

  // ---------- rooms ----------
  const active = room => [...room.players.values()].filter(p => !p.spectator);
  const hostOf = room => { const a = active(room); return a.length ? Math.min(...a.map(p => p.id)) : 0; };
  const playerList = room => [...room.players.values()].map(({ id, name, faction, team, spectator, ready, slot, color, played }) => ({ id, name, faction: (room.phase !== 'lobby' && played) || faction, random: faction === 'random', team, spectator, ready, color, slot: spectator ? null : slot ?? null }));
  const sendPlayers = room => broadcastRoom(room, { t: 'players', phase: room.phase, host: hostOf(room), map: room.map?.id ?? null, settings: { ...room.settings, max: room.max }, slots: slots(room), players: playerList(room) });
  const sysChat = (room, text) => broadcastRoom(room, { t: 'chat', sys: true, from: '', text }); // message système dans le chat de la room
  const freeColor = (room, except = null) => { const taken = new Set(active(room).filter(p => p !== except).map(p => p.color)); const i = PLAYER_COLORS.findIndex((_, k) => !taken.has(k)); return i < 0 ? 0 : i; };
  const mapInfo = room => room.map ? { id: room.map.id, name: room.map.name, w: room.map.w, h: room.map.h, players: room.map.players, preview: room.map.preview, starts: room.map.starts.map(s => [+(s.x / room.map.w).toFixed(4), +(s.y / room.map.h).toFixed(4)]) } : null;
  const scaleOf = mp => mp ? Math.min(1, (MAP_LIMIT * 0.96) / (Math.max(mp.w, mp.h) / 2)) : 1; // carte plus grande que la sim : réduite d'un bloc
  const shown = room => room.map ? { ...mapInfo(room), w: room.map.w * scaleOf(room.map), h: room.map.h * scaleOf(room.map) } : null;
  const slots = room => Math.min(room.max, room.map?.players ?? MAX_PLAYERS); // places réelles : limitées par la carte
  // Emplacements de départ : chaque joueur occupe un point de départ de la carte (choisi au salon, avant le lancement).
  const slotCount = room => room.map?.players ?? MAX_PLAYERS;
  function freeSlot(room, except = null) { const taken = new Set(active(room).filter(p => p !== except).map(p => p.slot)); for (let i = 0; i < slotCount(room); i++) if (!taken.has(i)) return i; return null; }
  function fixSlots(room) { // valides et uniques (nouvelle carte, départ d'un joueur...) : les conflits sont reclassés sur la première place libre
    const seen = new Set();
    for (const p of active(room).sort((a, b) => a.id - b.id)) {
      if (Number.isInteger(p.slot) && p.slot >= 0 && p.slot < slotCount(room) && !seen.has(p.slot)) { seen.add(p.slot); continue; }
      p.slot = null; p.slot = freeSlot(room, p); if (p.slot !== null) seen.add(p.slot);
    }
  }

  function newRoomId() {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 6).toUpperCase();
      if (id.length === 4 && !rooms.has(id)) return id;
    }
  }
  function createRoom(name, max, map) {
    if (map) maps?.loadObjects(map.id).catch(e => console.warn(`Objets de ${map.id} illisibles : ${e.message}`)); // préchargés pour un lancement immédiat
    const room = { id: newRoomId(), name, max, map, settings: { money: START_MONEY }, world: new World(catalog), phase: 'lobby', players: new Map(), nextPlayer: 1, emptySince: Date.now(), countdown: null };
    rooms.set(room.id, room);
    roomsDirty = true;
    console.log(`Room ${room.id} « ${room.name} » créée (${rooms.size} room(s))`);
    return room;
  }
  function deleteRoom(room) {
    cancelCountdown(room);
    rooms.delete(room.id);
    roomsDirty = true;
    console.log(`Room ${room.id} « ${room.name} » supprimée (${rooms.size} room(s))`);
  }
  function summary(room) {
    const act = active(room), host = act.find(p => p.id === hostOf(room));
    return { id: room.id, name: room.name, map: room.map?.name ?? null, phase: room.phase, players: act.length, spectators: room.players.size - act.length, max: slots(room), host: host?.name ?? null, names: act.map(p => p.name) };
  }
  const onlineNames = () => [...conns.values()].filter(c => !c.room && c.name).map(c => c.name);
  const roomsMsg = () => ({ t: 'rooms', rooms: [...rooms.values()].sort((a, b) => a.name.localeCompare(b.name)).map(summary), online: { total: conns.size, lobby: onlineNames() } });
  function pushRooms() { // vers tous ceux qui sont au lobby (pas encore dans une room)
    const s = JSON.stringify(roomsMsg());
    for (const [ws, c] of conns) if (!c.room && ws.readyState === 1) ws.send(s);
    roomsDirty = false;
  }

  // ---------- compte à rebours et démarrage ----------
  function cancelCountdown(room, why) {
    if (!room.countdown) return;
    clearInterval(room.countdown);
    room.countdown = null;
    if (why) broadcastRoom(room, { t: 'cancel', msg: why });
  }
  function beginCountdown(room) {
    if (active(room).length <= 1) return launch(room); // seul : pas d'attente
    let n = COUNTDOWN_S;
    broadcastRoom(room, { t: 'countdown', n });
    room.countdown = setInterval(() => {
      n--;
      if (n > 0) return broadcastRoom(room, { t: 'countdown', n });
      clearInterval(room.countdown); room.countdown = null;
      launch(room);
    }, 1000);
  }
  function launch(room) { // charge les objets de la carte (si besoin) puis démarre la partie
    if (room.launching) return;
    room.launching = true;
    Promise.resolve(room.map && maps?.loadObjects(room.map.id)).catch(e => console.warn(`Objets de la carte illisibles : ${e.message}`)).then(() => {
      room.launching = false;
      if (room.phase !== 'playing' && active(room).length) startMatch(room);
    });
  }
  function startMatch(room) {
    const world = room.world = new World(catalog);
    world.incomePerSec = INCOME_PER_SEC;
    fixSlots(room);
    const act = active(room).sort((a, b) => a.id - b.id);
    const mp = room.map && room.map.starts.length >= act.length ? room.map : null; // sans carte (ou trop petite) : bases en cercle
    // Les coordonnées de la carte partent d'un coin ; la sim est centrée.
    const k = scaleOf(mp);
    if (k < 1) console.log(`[${room.id}] carte ${mp.id} réduite à ${(k * 100).toFixed(0)} % pour tenir dans la sim`);
    act.forEach((p, i) => {
      world.addPlayer(p.id, p.team, room.settings.money ?? START_MONEY);
      p.played = p.faction === 'random' ? factions[Math.floor(Math.random() * factions.length)].object : p.faction; // « aléatoire » tiré au lancement
      const ang = (i / act.length) * Math.PI * 2 + Math.PI / 4;
      const bx = mp ? (mp.starts[p.slot ?? i].x - mp.w / 2) * k : Math.cos(ang) * START_RADIUS, by = mp ? (mp.starts[p.slot ?? i].y - mp.h / 2) * k : Math.sin(ang) * START_RADIUS;
      const face = Math.atan2(-by, -bx); // la base regarde vers le centre
      const cc = world.spawn(p.id, p.played, bx, by, face);
      const dz = dozerFor(db, p.played);
      if (dz) world.spawn(p.id, dz, bx + Math.cos(face) * (cc.radius + 30), by + Math.sin(face) * (cc.radius + 30), face);
    });
    // Objets posés sur la carte : ceux qui ont des points de vie (bâtiments civils, structures techniques...) deviennent des unités neutres
    // destructibles ; les autres (arbres, rochers...) sont du décor à collision. Tout vient des INI : aucun cas particulier par objet.
    if (mp) {
      const info = new Map(), look = name => { // classement mis en cache par nom d'objet
        if (!info.has(name)) info.set(name, name.startsWith('*') || !catalog.has(name) || catalog.rail?.(name) ? null : { hp: (catalog.body(name)?.maxHealth ?? 0) > 0, dock: !!catalog.dock?.(name), keep: !!(catalog.kinds?.(name)?.has('CAPTURABLE') || catalog.deposit?.(name) || catalog.transport?.(name)), r: catalog.radius(name) ?? 0 });
        return info.get(name);
      };
      let nProps = 0, nNeutral = 0, nDocks = 0;
      for (const o of maps.objectsOf(mp.id) ?? []) {
        const c = look(o.name);
        if (!c) continue;
        const x = (o.x - mp.w / 2) * k, y = (o.y - mp.h / 2) * k;
        if (Math.abs(x) > MAP_LIMIT || Math.abs(y) > MAP_LIMIT) continue;
        if (c.hp || c.dock || c.keep) { if (nNeutral < MAX_MAP_NEUTRAL) { // points de vie, entrepôt, ou bâtiment à capturer / à garnison / à revenu : une vraie unité neutre (sélectionnable)
          world.spawn(0, o.name, x, y, o.angle, { z: (o.z ?? 0) * k }); nNeutral++; if (c.dock) nDocks++; } } // entrepôts de ravitaillement : unités neutres avec leurs caisses
        else if (nProps < MAX_MAP_PROPS) { world.addProp(o.name, x, y, o.angle, c.r, (o.z ?? 0) * k); nProps++; }
      }
      if (nDocks) world.incomePerSec = 0; // la carte a des entrepôts : l'argent vient du ravitaillement, plus du revenu fixe de secours
      console.log(`[${room.id}] Carte ${mp.id} : ${nNeutral} objet(s) neutre(s) (dont ${nDocks} entrepôt(s) de ravitaillement), ${nProps} élément(s) de décor`);
    }
    world.drainEvents(); // les créations initiales partent dans le message 'start'
    room.phase = 'playing';
    broadcastRoom(room, { t: 'start', units: world.listUnits(), props: world.listProps(), money: world.moneyObject(), map: shown(room) });
    sendPlayers(room);
    roomsDirty = true;
    console.log(`[${room.id}] Partie lancée : ${act.map(p => `${p.name} (${p.played}, équipe ${p.team})`).join(' · ')}`);
  }

  // ---------- entrée / sortie d'une room ----------
  function joinRoom(ws, c, room, name) {
    const taken = new Set(active(room).map(p => p.team));
    let team = 1; while (taken.has(team) && team < MAX_PLAYERS) team++; // première équipe libre : chacun pour soi par défaut
    const me = { id: room.nextPlayer++, name: name || '', faction: defaultFaction(), team, spectator: room.phase === 'playing' || active(room).length >= slots(room), ready: false, color: 0 };
    if (!me.name) me.name = `Joueur ${me.id}`;
    room.players.set(ws, me);
    me.color = freeColor(room, me);
    if (!me.spectator) me.slot = freeSlot(room);
    room.emptySince = null;
    c.room = room; c.me = me;
    send(ws, { t: 'welcome', you: me.id, tickHz: TICK_HZ, phase: room.phase, dev: DEV_SPAWN, factions, moneyChoices: MONEY_CHOICES, settings: { ...room.settings, max: room.max }, slots: slots(room), room: { id: room.id, name: room.name, max: room.max }, map: shown(room),
               host: hostOf(room), players: playerList(room), units: room.world.listUnits(), props: room.world.listProps(), money: room.world.moneyObject() });
    sendPlayers(room);
    sysChat(room, `${me.name} a rejoint la room${me.spectator ? ' (observateur)' : ''}`);
    roomsDirty = true;
    console.log(`[${room.id}] + ${me.name}${me.spectator ? ' (spectateur)' : ''} (${room.players.size} connecté(s))`);
  }
  function leaveRoom(ws, c) {
    const { room, me } = c;
    if (!room) return;
    const wasHost = !me.spectator && me.id === hostOf(room);
    room.players.delete(ws);
    c.room = null; c.me = null;
    const removed = room.world.leave(me.id);
    broadcastRoom(room, { t: 'leave', id: me.id, removed });
    cancelCountdown(room, `${me.name} a quitté : lancement annulé`);
    if (!room.players.size) room.emptySince = Date.now();
    else {
      sendPlayers(room);
      sysChat(room, `${me.name} a quitté la room`);
      if (wasHost) { const nh = active(room).find(p => p.id === hostOf(room)); if (nh) sysChat(room, `${nh.name} est le nouvel hôte ★`); }
    }
    roomsDirty = true;
    console.log(`[${room.id}] - ${me.name} (${room.players.size} connecté(s))`);
  }

  // ---------- messages ----------
  function onRoomMessage(ws, c, m) {
    const { room, me } = c;
    const world = room.world;
    const err = msg => send(ws, { t: 'error', msg });

    // --- salon de la room ---
    if (m.t === 'hello' && typeof m.name === 'string') {
      me.name = m.name.trim().slice(0, 24) || me.name; sendPlayers(room); roomsDirty = true;
    } else if (m.t === 'setup') {
      if (room.phase === 'playing' || me.spectator || room.countdown) return;
      if (me.ready) return err('Décoche « prêt » pour modifier ta configuration');
      if (m.faction === 'random' || (typeof m.faction === 'string' && factions.some(f => f.object === m.faction))) me.faction = m.faction;
      const team = Number(m.team);
      if (m.team !== undefined && Number.isInteger(team) && team >= 1 && team <= 8) me.team = team;
      if (m.color !== undefined && m.color !== null) { // couleur : unique dans la room
        const c = Number(m.color);
        if (!Number.isInteger(c) || c < 0 || c >= PLAYER_COLORS.length) return err('Couleur inconnue');
        const owner = active(room).find(p => p !== me && p.color === c);
        if (owner) return err(`${PLAYER_COLORS[c].name} est déjà pris par ${owner.name}`);
        me.color = c;
      }
      if (m.slot !== undefined && m.slot !== null) { // emplacement de départ : doit exister et être libre
        const s = Number(m.slot);
        if (!Number.isInteger(s) || s < 0 || s >= slotCount(room)) return err('Emplacement inconnu');
        if (active(room).some(p => p !== me && p.slot === s)) return err(`Emplacement ${s + 1} déjà pris`);
        me.slot = s;
      }
      sendPlayers(room);
    } else if (m.t === 'ready') {
      if (room.phase === 'playing' || me.spectator) return;
      if (me.ready === !!m.ready) return;
      me.ready = !!m.ready;
      if (!me.ready) cancelCountdown(room, `${me.name} n'est plus prêt : lancement annulé`);
      sendPlayers(room); sysChat(room, me.ready ? `${me.name} est prêt ✔` : `${me.name} n'est plus prêt`);
    } else if (m.t === 'map') {
      if (room.phase === 'playing' || me.spectator || me.id !== hostOf(room)) return err('Seul l\'hôte peut changer la carte');
      if (room.countdown) return;
      const mp = m.id ? maps?.get(m.id) : null; // id vide : pas de carte (bases en cercle)
      if (m.id && !mp) return err('Carte inconnue');
      if (mp && active(room).length > Math.min(room.max, mp.players)) return err(`Cette carte n'a que ${Math.min(room.max, mp.players)} places pour ${active(room).length} joueurs : exclus ou passe des joueurs en observateur`);
      if (mp) maps?.loadObjects(mp.id).catch(e => console.warn(`Objets de ${mp.id} illisibles : ${e.message}`));
      room.map = mp;
      fixSlots(room);
      for (const p of active(room)) p.ready = false;
      sendPlayers(room); roomsDirty = true;
      broadcastRoom(room, { t: 'map', map: shown(room) });
      sysChat(room, `${me.name} a choisi la carte : ${mp ? mp.name : 'aucune (bases en cercle)'}`);
    } else if (m.t === 'settings') { // options de la partie (hôte)
      if (room.phase === 'playing' || me.spectator || me.id !== hostOf(room)) return err('Seul l\'hôte peut changer les options');
      if (room.countdown) return;
      const notes = [];
      if (m.money !== undefined) {
        const v = Number(m.money);
        if (!MONEY_CHOICES.includes(v)) return err('Montant non proposé');
        if (v !== room.settings.money) { room.settings.money = v; notes.push(`argent de départ ${v} $`); }
      }
      if (m.max !== undefined) {
        const v = Number(m.max), cap = room.map?.players ?? MAX_PLAYERS;
        if (!Number.isInteger(v) || v < 2 || v > MAX_PLAYERS) return err('Nombre de places invalide');
        if (v < active(room).length) return err(`${active(room).length} joueurs présents : exclus ou passe des joueurs en observateur d'abord`);
        if (v !== room.max) { room.max = v; fixSlots(room); notes.push(`${Math.min(v, cap)} places`); }
      }
      if (!notes.length) return;
      for (const p of active(room)) p.ready = false; // les règles ont changé : chacun doit reconfirmer
      sendPlayers(room); roomsDirty = true;
      sysChat(room, `${me.name} a modifié : ${notes.join(', ')} — confirmez « prêt » à nouveau`);
    } else if (m.t === 'spectate') { // passer observateur / redevenir joueur, avant le lancement
      if (room.phase === 'playing' || room.countdown) return;
      if (m.on) {
        if (me.spectator) return;
        me.spectator = true; me.ready = false; me.slot = null;
        fixSlots(room); sendPlayers(room); sysChat(room, `${me.name} est maintenant observateur`);
      } else {
        if (!me.spectator) return;
        if (active(room).length >= slots(room)) return err('La room est pleine');
        me.spectator = false; me.ready = false; me.color = freeColor(room, me); me.slot = freeSlot(room, me);
        const taken = new Set(active(room).filter(p => p !== me).map(p => p.team)); let t = 1; while (taken.has(t) && t < MAX_PLAYERS) t++; me.team = t;
        sendPlayers(room); sysChat(room, `${me.name} rejoint les joueurs`);
      }
      roomsDirty = true;
    } else if (m.t === 'kick') { // exclure un joueur (hôte)
      if (room.phase === 'playing' || me.spectator || me.id !== hostOf(room)) return err('Seul l\'hôte peut exclure');
      const target = [...room.players].find(([, p]) => p.id === Number(m.id));
      if (!target || target[1].id === me.id) return;
      const [tws, tp] = target, tc = conns.get(tws);
      sysChat(room, `${tp.name} a été exclu par ${me.name}`);
      send(tws, { t: 'kicked' });
      if (tc) leaveRoom(tws, tc);
    } else if (m.t === 'chat' && typeof m.text === 'string') {
      const text = m.text.trim().slice(0, 200);
      if (text) broadcastRoom(room, { t: 'chat', from: me.name, id: me.id, text });
    } else if (m.t === 'start') {
      if (room.phase === 'playing' || me.spectator || me.id !== hostOf(room)) return err('Seul l\'hôte peut lancer la partie');
      if (room.countdown) return;
      if (!factions.length) return err('Aucun centre de commandement trouvé dans les INI');
      const waiting = active(room).filter(p => p.id !== me.id && !p.ready);
      if (waiting.length) return err(`Pas prêt : ${waiting.map(p => p.name).join(', ')}`);
      beginCountdown(room);
    } else if (m.t === 'leave') {
      leaveRoom(ws, c);
    }

    // --- jeu ---
    else if (m.t === 'spawn' && typeof m.object === 'string') {
      if (!DEV_SPAWN) return err('Création libre désactivée');
      if (!world.catalog.has(m.object)) return err(`Object inconnu : ${m.object}`);
      const owner = m.neutral ? 0 : me.id;
      if (owner > 0 && me.spectator) return;
      if (world.countOf(owner) >= (owner === 0 ? MAX_NEUTRAL : MAX_UNITS_PER_PLAYER)) return err('Limite d\'unités atteinte');
      const r = world.catalog.radius(m.object);
      let x = Number(m.x), y = Number(m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        x = 0; y = 0; // on cherche une place libre autour du centre
        for (let i = 0; i < 60; i++) {
          const cx = (Math.random() - 0.5) * (120 + i * 6), cy = (Math.random() - 0.5) * (120 + i * 6);
          if (world.isFree(cx, cy, r)) { x = cx; y = cy; break; }
        }
      }
      x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, x)); y = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, y));
      world.spawn(owner, m.object, x, y, 0);
    } else if (m.t === 'move' || m.t === 'stop' || m.t === 'attack') {
      if (!me.spectator && room.phase === 'playing') world.command(me.id, m);
    } else if (m.t === 'enter') {
      if (!me.spectator && room.phase === 'playing') { const e = world.enter(me.id, m.ids, m.target); if (e) err(e); }
    } else if (m.t === 'capture') {
      if (!me.spectator && room.phase === 'playing') { const e = world.capture(me.id, m.ids, m.target); if (e) err(e); }
    } else if (m.t === 'evacuate') {
      if (!me.spectator && room.phase === 'playing') world.evacuate(me.id, m.ids);
    } else if (m.t === 'unload') {
      if (!me.spectator && room.phase === 'playing') world.unloadOne(me.id, m.id, m.index);
    } else if (m.t === 'gather') {
      if (!me.spectator && room.phase === 'playing') world.gather(me.id, m.ids);
    } else if (m.t === 'rally') {
      if (!me.spectator && room.phase === 'playing' && Array.isArray(m.ids)) for (const id of m.ids.slice(0, 50)) world.setRally(me.id, id, m.x, m.y);
    } else if (m.t === 'train') {
      if (me.spectator || room.phase !== 'playing') return;
      const e = world.train(me.id, m.building, m.object);
      if (e) err(e);
    } else if (m.t === 'press') {
      if (me.spectator || room.phase !== 'playing') return;
      const e = world.press(me.id, m.building, String(m.button ?? ''));
      if (e) err(e);
    } else if (m.t === 'cancel') {
      if (me.spectator || room.phase !== 'playing') return;
      const e = world.cancel(me.id, m.building, Number(m.index));
      if (e) err(e);
    } else if (m.t === 'build') {
      if (me.spectator || room.phase !== 'playing') return;
      const e = world.place(me.id, m.dozer, m.object, m.x, m.y, m.a);
      if (e) err(e);
    }
  }

  wss.on('connection', ws => {
    const c = { name: '', room: null, me: null };
    conns.set(ws, c); roomsDirty = true;
    send(ws, roomsMsg());
    send(ws, { t: 'gchat-history', msgs: gchat });

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      const err = (msg, fatal = false) => send(ws, { t: 'error', msg, fatal });

      if (c.room) return onRoomMessage(ws, c, m);

      // --- lobby ---
      if (m.t === 'hello' && typeof m.name === 'string') { c.name = m.name.trim().slice(0, 24); roomsDirty = true; }
      else if (m.t === 'rooms') send(ws, roomsMsg());
      else if (m.t === 'gchat' && typeof m.text === 'string') { // chat général (hors room)
        const text = m.text.trim().slice(0, 200), now = Date.now();
        if (!text) return;
        if (c.lastChat && now - c.lastChat < 600) return err('Doucement, un message à la fois');
        c.lastChat = now;
        const msg = { t: 'gchat', from: c.name || 'Anonyme', text, at: now };
        gchat.push(msg); if (gchat.length > GCHAT_KEEP) gchat.shift();
        const str = JSON.stringify(msg); for (const [w, o] of conns) if (!o.room && w.readyState === 1) w.send(str);
      }
      else if (m.t === 'create') {
        if (rooms.size >= MAX_ROOMS) return err('Trop de rooms ouvertes, réessaie plus tard');
        if (typeof m.name === 'string' && m.name.trim().length === 0) return err('Donne un nom à la room');
        const name = String(m.name ?? '').trim().slice(0, 40) || `Room ${rooms.size + 1}`;
        const map = maps?.get(m.map) ?? null; // la carte se choisit dans la room (l'hôte) ; création sans carte par défaut
        const room = createRoom(name, MAX_PLAYERS, map);
        send(ws, { t: 'created', id: room.id });
      } else if (m.t === 'join') {
        const room = rooms.get(String(m.room ?? '').trim().toUpperCase());
        if (!room) return err('Room introuvable (elle a peut-être été fermée)', true);
        const name = (typeof m.name === 'string' ? m.name.trim().slice(0, 24) : '') || c.name;
        joinRoom(ws, c, room, name);
      }
    });

    ws.on('close', () => {
      leaveRoom(ws, c);
      conns.delete(ws); roomsDirty = true;
    });
  });

  // Boucle à pas fixe avec accumulateur (rattrape les retards, plafonné), toutes rooms confondues.
  function tickRoom(room) {
    const world = room.world;
    world.step(); // même au salon : les unités de test (création libre) bougent et combattent
    const ev = world.drainEvents();
    if (ev.length) broadcastRoom(room, { t: 'ev', e: ev });
    if (room.phase === 'playing' && ev.some(e => e.k === 'end')) {
      room.phase = 'ended';
      for (const p of room.players.values()) { p.spectator = false; p.ready = false; } // tout le monde peut rejouer
      sendPlayers(room); roomsDirty = true;
      console.log(`[${room.id}] Partie terminée`);
    }
    if (world.tick % SNAP_EVERY === 0) {
      broadcastRoom(room, { t: 'snap', k: world.tick, u: world.snapshot(), m: world.moneyObject(), b: world.buildingStates(), v: world.visualStates(), pu: world.playerUpgrades(), e: Object.fromEntries([...world.matchOwners].map(o => [o, world.energyOf(o)])) });
    }
  }
  let last = performance.now(), acc = 0;
  setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + (now - last) / 1000, 0.25);
    last = now;
    while (acc >= DT) {
      acc -= DT;
      for (const room of rooms.values()) if (room.players.size) tickRoom(room);
    }
  }, 10);

  // Ménage et liste des rooms (1 fois par seconde).
  setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) if (!room.players.size && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) deleteRoom(room);
    if (roomsDirty) pushRooms();
  }, 1000);

  return { rooms, wss };
}
