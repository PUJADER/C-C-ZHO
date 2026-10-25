// Serveur de jeu : WebSocket (/ws), salon (lobby), parties et boucle de simulation à 30 ticks/s.
import { WebSocketServer } from 'ws';
import { World, TICK_HZ, DT, MAP_LIMIT } from '../shared/sim.js';
import { makeCatalog, factionsOf, dozerFor } from '../shared/objects.js';

const MAX_UNITS_PER_PLAYER = 200;
const MAX_NEUTRAL = 30;
const SNAP_EVERY = 2;        // un instantané tous les 2 ticks (15/s)
const START_MONEY = 10000;
const INCOME_PER_SEC = 10;   // revenu fixe provisoire, en attendant les camions de ravitaillement
const START_RADIUS = 450;    // distance des bases au centre de la carte
const MAX_PLAYERS = 8;
const DEV_SPAWN = process.env.DEV_SPAWN !== '0'; // outil de test : création libre d'unités

export function attachGame(httpServer, db, extras = {}) {
  const catalog = makeCatalog(db, extras);
  const factions = factionsOf(db);
  let world = new World(catalog);
  let phase = 'lobby'; // 'lobby' | 'playing' | 'ended'

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });
  const players = new Map(); // ws -> { id, name, faction, team, spectator }
  let nextPlayer = 1;

  const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const broadcast = o => { const s = JSON.stringify(o); for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s); };
  const hostId = () => Math.min(...[...players.values()].filter(p => !p.spectator).map(p => p.id));
  const playerList = () => [...players.values()].map(({ id, name, faction, team, spectator }) => ({ id, name, faction, team, spectator }));
  const sendPlayers = () => broadcast({ t: 'players', phase, host: hostId(), players: playerList() });
  const defaultFaction = () => factions[0]?.object ?? null;

  // ---------- démarrage d'une partie ----------
  function startMatch() {
    world = new World(catalog);
    world.incomePerSec = INCOME_PER_SEC;
    const active = [...players.values()].filter(p => !p.spectator);
    active.forEach((p, i) => {
      world.addPlayer(p.id, p.team, START_MONEY);
      const ang = (i / active.length) * Math.PI * 2 + Math.PI / 4;
      const bx = Math.cos(ang) * START_RADIUS, by = Math.sin(ang) * START_RADIUS;
      const face = Math.atan2(-by, -bx); // la base regarde vers le centre
      const cc = world.spawn(p.id, p.faction, bx, by, face);
      const dz = dozerFor(db, p.faction);
      if (dz) world.spawn(p.id, dz, bx + Math.cos(face) * (cc.radius + 30), by + Math.sin(face) * (cc.radius + 30), face);
    });
    world.drainEvents(); // les créations initiales partent dans le message 'start'
    phase = 'playing';
    broadcast({ t: 'start', units: world.listUnits(), money: world.moneyObject() });
    sendPlayers();
    console.log(`Partie lancée : ${active.map(p => `${p.name} (${p.faction}, équipe ${p.team})`).join(' · ')}`);
  }

  wss.on('connection', ws => {
    const me = { id: nextPlayer++, name: '', faction: defaultFaction(), team: 0, spectator: false };
    me.name = `Joueur ${me.id}`;
    me.team = me.id; // par défaut chacun pour soi
    me.spectator = phase === 'playing' || players.size >= MAX_PLAYERS;
    players.set(ws, me);
    send(ws, { t: 'welcome', you: me.id, tickHz: TICK_HZ, phase, dev: DEV_SPAWN, factions,
               host: hostId(), players: playerList(), units: world.listUnits(), money: world.moneyObject() });
    sendPlayers();
    console.log(`+ ${me.name}${me.spectator ? ' (spectateur)' : ''} (${players.size} connecté(s))`);

    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      const err = msg => send(ws, { t: 'error', msg });

      // --- salon ---
      if (m.t === 'hello' && typeof m.name === 'string') {
        me.name = m.name.trim().slice(0, 24) || me.name; sendPlayers();
      } else if (m.t === 'setup') {
        if (phase === 'playing' || me.spectator) return;
        if (typeof m.faction === 'string' && factions.some(f => f.object === m.faction)) me.faction = m.faction;
        const team = Number(m.team);
        if (Number.isInteger(team) && team >= 1 && team <= 8) me.team = team;
        sendPlayers();
      } else if (m.t === 'start') {
        if (phase === 'playing' || me.spectator || me.id !== hostId()) return err('Seul l\'hôte peut lancer la partie');
        if (!factions.length) return err('Aucun centre de commandement trouvé dans les INI');
        startMatch();
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
        if (!me.spectator && phase === 'playing') world.command(me.id, m);
      } else if (m.t === 'rally') {
        if (!me.spectator && phase === 'playing' && Array.isArray(m.ids)) for (const id of m.ids.slice(0, 50)) world.setRally(me.id, id, m.x, m.y);
      } else if (m.t === 'train') {
        if (me.spectator || phase !== 'playing') return;
        const e = world.train(me.id, m.building, m.object);
        if (e) err(e);
      } else if (m.t === 'press') {
        if (me.spectator || phase !== 'playing') return;
        const e = world.press(me.id, m.building, String(m.button ?? ''));
        if (e) err(e);
      } else if (m.t === 'cancel') {
        if (me.spectator || phase !== 'playing') return;
        const e = world.cancel(me.id, m.building, Number(m.index));
        if (e) err(e);
      } else if (m.t === 'build') {
        if (me.spectator || phase !== 'playing') return;
        const e = world.place(me.id, m.dozer, m.object, m.x, m.y, m.a);
        if (e) err(e);
      }
    });

    ws.on('close', () => {
      players.delete(ws);
      const removed = world.leave(me.id);
      broadcast({ t: 'leave', id: me.id, removed });
      if (players.size === 0) { world = new World(catalog); phase = 'lobby'; } // salle vide : on repart de zéro
      else sendPlayers();
      console.log(`- ${me.name} (${players.size} connecté(s))`);
    });
  });

  // Boucle à pas fixe avec accumulateur (rattrape les retards, plafonné).
  let last = performance.now(), acc = 0;
  setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + (now - last) / 1000, 0.25);
    last = now;
    while (acc >= DT) {
      world.step(); // même au salon : les unités de test (création libre) bougent et combattent
      acc -= DT;
      const ev = world.drainEvents();
      if (ev.length && players.size) broadcast({ t: 'ev', e: ev });
      if (phase === 'playing' && ev.some(e => e.k === 'end')) {
        phase = 'ended';
        for (const p of players.values()) p.spectator = false; // tout le monde peut rejouer
        sendPlayers(); console.log('Partie terminée');
      }
      if (world.tick % SNAP_EVERY === 0 && players.size) {
        broadcast({ t: 'snap', k: world.tick, u: world.snapshot(), m: world.moneyObject(), b: world.buildingStates(), v: world.visualStates(), pu: world.playerUpgrades(), e: Object.fromEntries([...world.matchOwners].map(o => [o, world.energyOf(o)])) });
      }
    }
  }, 10);

  return { get world() { return world; }, wss };
}
