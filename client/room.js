// Salle d'attente d'une room : s'affiche plein écran tant que la partie n'est pas lancée.
// Chacun y choisit sa couleur, son armée, son équipe et son emplacement de départ, puis se déclare « prêt » ;
// l'hôte (★) choisit la carte, règle les options, exclut si besoin et lance quand tout le monde est prêt.
// Le composant ne parle pas au réseau : game.js lui fournit `api` (send + état courant) et l'appelle à chaque message reçu.
import { PLAYER_COLORS } from '/shared/colors.js';

const $ = id => document.getElementById(id);
const hex = c => '#' + c.toString(16).padStart(6, '0');
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `${Number(n).toLocaleString('fr-FR')} $`;
const armyLabel = o => (o === 'random' ? '🎲 Aléatoire' : String(o ?? '?').replace(/(CommandCenter|Command)$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2'));

export function createRoomUI(api) {
  let built = false, maps = [], mapsReady = false, cdTimer = null;
  const S = () => api.state();
  const colorHex = i => hex(PLAYER_COLORS[i]?.hex ?? 0x888888);

  // Listes fixes : armées, équipes, argent, places. Construites une fois (la reconstruction ferait perdre le focus pendant un choix).
  function build(st) {
    const bySide = new Map();
    for (const f of st.factions) { if (!bySide.has(f.side)) bySide.set(f.side, []); bySide.get(f.side).push(f.object); }
    $('rmFaction').innerHTML = `<option value="random">${armyLabel('random')}</option>` +
      [...bySide].map(([side, list]) => `<optgroup label="${esc(side || 'autre')}">${list.map(o => `<option value="${esc(o)}">${esc(armyLabel(o))}</option>`).join('')}</optgroup>`).join('');
    $('rmTeam').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}">Équipe ${n}</option>`).join('');
    $('rmMoney').innerHTML = (st.moneyChoices ?? [10000]).map(v => `<option value="${v}">${money(v)}</option>`).join('');
    $('rmMax').innerHTML = [2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}">${n} joueurs</option>`).join('');
    built = true;
  }

  async function loadMaps() { // cartes disponibles (analysées côté serveur)
    let r; try { r = await (await fetch('/api/maps')).json(); } catch { return setTimeout(loadMaps, 3000); }
    maps = r.maps; mapsReady = !!r.ready;
    const sel = $('rmMap'), cur = S().map?.id ?? '';
    sel.replaceChildren(new Option('— Aucune (bases en cercle) —', ''), ...maps.map(m => new Option(`${m.name} · ${m.players} joueurs`, m.id)));
    sel.value = cur;
    if (!r.ready) setTimeout(loadMaps, 2000);
    render();
  }

  function swatches(st, mine) { // 12 pastilles : prises = grisées (nom du propriétaire en infobulle)
    const owner = new Map([...st.players.values()].filter(p => !p.spectator).map(p => [p.color, p]));
    $('rmColors').innerHTML = PLAYER_COLORS.map((c, i) => {
      const o = owner.get(i), me = o && o.id === st.me;
      return `<button class="sw${me ? ' mine' : ''}${o && !me ? ' taken' : ''}" data-c="${i}" style="--c:${hex(c.hex)}" title="${esc(c.name)}${o && !me ? ' — pris par ' + esc(o.name) : ''}" ${!mine || (o && !me) || st.locked ? 'disabled' : ''}></button>`;
    }).join('');
  }

  function playersTable(st) {
    const act = [...st.players.values()].filter(p => !p.spectator).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.id - b.id);
    const iHost = st.me === st.hostId;
    let rows = act.map(p => {
      const state = p.id === st.hostId ? '<span class="tag host">★ hôte</span>' : p.ready ? '<span class="tag ok">✔ prêt</span>' : '<span class="tag wait">en attente…</span>';
      return `<tr class="${p.id === st.me ? 'me' : ''}"><td><span class="dot" style="background:${colorHex(p.color)}"></span></td>
        <td class="nm">${esc(p.name)}${p.id === st.me ? ' <small>(toi)</small>' : ''}</td><td>${esc(armyLabel(p.random ? 'random' : p.faction))}</td>
        <td>Éq. ${p.team}</td><td>${p.slot != null && st.starts.length ? p.slot + 1 : '—'}</td><td>${state}</td>
        <td>${iHost && p.id !== st.me ? `<button class="x" data-kick="${p.id}" title="Exclure ${esc(p.name)}">✕</button>` : ''}</td></tr>`;
    });
    for (let i = act.length; i < st.slots; i++) rows.push(`<tr class="free"><td><span class="dot"></span></td><td colspan="6">Emplacement libre</td></tr>`);
    $('rmRows').innerHTML = rows.join('');
    const specs = [...st.players.values()].filter(p => p.spectator);
    $('rmSpecs').innerHTML = specs.length ? `👁 Observateurs : ${specs.map(p => esc(p.name) + (p.id === st.me ? ' (toi)' : '') + (iHost && p.id !== st.me ? ` <button class="x" data-kick="${p.id}" title="Exclure">✕</button>` : '')).join(', ')}` : '';
    $('rmCount').textContent = `${act.length} / ${st.slots}`;
  }

  // Mini-carte des emplacements : un point par départ ; pris = couleur du joueur, libre = cliquable.
  function drawSlots(st) {
    const cv = $('rmSlotMap'), c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H); c.fillStyle = '#0a1018'; c.fillRect(0, 0, W, H);
    if (st.preview) { c.drawImage(st.preview, 0, 0, W, H); c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(0, 0, W, H); }
    else { c.strokeStyle = '#26384a'; for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(i * W / 4, 0); c.lineTo(i * W / 4, H); c.moveTo(0, i * H / 4); c.lineTo(W, i * H / 4); c.stroke(); } }
    const by = new Map([...st.players.values()].filter(p => !p.spectator && p.slot != null).map(p => [p.slot, p]));
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = 'bold 13px system-ui';
    st.starts.forEach(([sx, sy], i) => {
      const x = 16 + sx * (W - 32), y = 16 + sy * (H - 32), p = by.get(i), mine = p && p.id === st.me;
      c.beginPath(); c.arc(x, y, 13, 0, Math.PI * 2); c.fillStyle = p ? colorHex(p.color) : '#182533'; c.fill();
      c.lineWidth = mine ? 3 : 1.5; c.strokeStyle = mine ? '#fff' : '#4a6a88'; c.stroke();
      c.fillStyle = p ? '#000' : '#9fb4c8'; c.fillText(String(i + 1), x, y + 1);
    });
    $('rmNoMap').style.display = st.starts.length ? 'none' : 'flex';
  }

  function render() {
    const st = S();
    if (!st.factions?.length && !built) return;
    if (!built) build(st);
    const meP = st.players.get(st.me), iHost = st.me === st.hostId, spec = !meP || meP.spectator;
    const playing = st.phase === 'playing';
    st.locked = !!meP?.ready || cdTimer !== null; // prêt ou lancement en cours : la configuration est verrouillée
    $('rmName').textContent = st.roomName || 'Room';
    $('rmCode').textContent = st.roomId;

    // Ma configuration
    $('rmMine').style.display = spec ? 'none' : '';
    if (!spec) {
      swatches(st, true);
      for (const [id, val] of [['rmFaction', meP.random ? 'random' : meP.faction], ['rmTeam', String(meP.team)]]) { const el = $(id); if (el.value !== val && document.activeElement !== el) el.value = val; el.disabled = st.locked; }
    }
    // Carte et options (hôte seulement)
    const mapSel = $('rmMap');
    if (document.activeElement !== mapSel && mapSel.value !== (st.map?.id ?? '')) mapSel.value = st.map?.id ?? '';
    mapSel.disabled = !iHost || st.locked;
    $('rmMapName').textContent = st.map ? st.map.name : 'Aucune carte';
    $('rmMapInfo').textContent = st.map ? `${st.map.players} joueurs max · ${Math.round(st.map.w / 10)}×${Math.round(st.map.h / 10)} cases` : 'Les bases seront placées en cercle.';
    for (const [id, val] of [['rmMoney', String(st.settings.money)], ['rmMax', String(st.settings.max)]]) { const el = $(id); if (document.activeElement !== el && el.value !== val) el.value = val; el.disabled = !iHost || st.locked; }
    for (const o of $('rmMax').options) o.disabled = Number(o.value) > (st.map?.players ?? 8);
    $('rmOptHint').textContent = iHost ? '' : 'Réglé par l’hôte';

    playersTable(st); drawSlots(st);

    // Pied de page : prêt / lancer / observateur
    const waiting = [...st.players.values()].filter(p => !p.spectator && p.id !== st.hostId && !p.ready);
    const btnReady = $('rmReady'), btnStart = $('rmStart'), btnSpec = $('rmSpec');
    btnReady.style.display = spec || iHost ? 'none' : '';
    btnReady.textContent = meP?.ready ? '✔ Prêt — cliquer pour annuler' : 'Je suis prêt';
    btnReady.classList.toggle('on', !!meP?.ready);
    btnReady.disabled = cdTimer !== null;
    btnStart.style.display = iHost && !spec ? '' : 'none';
    btnStart.disabled = waiting.length > 0 || cdTimer !== null;
    btnSpec.textContent = spec ? 'Rejoindre en joueur' : 'Passer observateur';
    btnSpec.disabled = cdTimer !== null || (spec && [...st.players.values()].filter(p => !p.spectator).length >= st.slots);
    $('rmStatus').textContent = cdTimer !== null ? '' : spec ? 'Tu observes : les joueurs configurent leur partie.'
      : iHost ? (waiting.length ? `En attente de : ${waiting.map(p => p.name).join(', ')}` : 'Tout le monde est prêt : tu peux lancer la partie !')
      : meP?.ready ? 'Prêt ! En attente que l’hôte lance la partie.' : 'Choisis ta couleur, ton armée, ton équipe puis clique « Je suis prêt ».';
    $('rmStatus').className = !iHost || waiting.length ? '' : 'go';
  }

  // ---- événements ----
  const sendSetup = o => api.send({ t: 'setup', ...o });
  $('rmColors').onclick = e => { const b = e.target.closest('button[data-c]'); if (b && !b.disabled) sendSetup({ color: Number(b.dataset.c) }); };
  $('rmFaction').onchange = () => sendSetup({ faction: $('rmFaction').value });
  $('rmTeam').onchange = () => sendSetup({ team: Number($('rmTeam').value) });
  $('rmMap').onchange = () => api.send({ t: 'map', id: $('rmMap').value });
  $('rmMoney').onchange = () => api.send({ t: 'settings', money: Number($('rmMoney').value) });
  $('rmMax').onchange = () => api.send({ t: 'settings', max: Number($('rmMax').value) });
  $('rmReady').onclick = () => api.send({ t: 'ready', ready: !S().players.get(S().me)?.ready });
  $('rmStart').onclick = () => api.send({ t: 'start' });
  $('rmSpec').onclick = () => api.send({ t: 'spectate', on: !S().players.get(S().me)?.spectator });
  $('rmRows').onclick = $('rmSpecs').onclick = e => { const b = e.target.closest('[data-kick]'); if (b && confirm('Exclure ce joueur de la room ?')) api.send({ t: 'kick', id: Number(b.dataset.kick) }); };
  $('rmSlotMap').onclick = e => {
    const st = S(), r = $('rmSlotMap').getBoundingClientRect(), k = $('rmSlotMap').width / r.width, mx = (e.clientX - r.left) * k, my = (e.clientY - r.top) * k, W = $('rmSlotMap').width, H = $('rmSlotMap').height;
    let best = -1, bd = 1e9; st.starts.forEach(([sx, sy], i) => { const d = Math.hypot(16 + sx * (W - 32) - mx, 16 + sy * (H - 32) - my); if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && bd < 24 && !st.locked) sendSetup({ slot: best });
  };
  $('rmCopy').onclick = () => { const url = `${location.origin}/index.html?room=${S().roomId}`; (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(() => chat('', 'Lien copié : envoie-le à tes amis', true), () => prompt('Lien de la room :', url)); };
  function sendChat() { const t = $('rmChatIn').value.trim(); if (t) api.send({ t: 'chat', text: t }); $('rmChatIn').value = ''; }
  $('rmChatSend').onclick = sendChat;
  $('rmChatIn').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); }); // la saisie ne déclenche pas les raccourcis du jeu

  function chat(from, text, sys = false, color = null) {
    const d = document.createElement('div'); if (sys) d.className = 'sys';
    d.innerHTML = sys ? esc(text) : `<b style="color:${color ?? '#9fd8ff'}">${esc(from)}</b> ${esc(text)}`;
    const log = $('rmChatLog'); log.appendChild(d); while (log.children.length > 100) log.firstChild.remove(); log.scrollTop = log.scrollHeight;
  }
  function countdown(n) { // lancement imminent : grand chiffre, configuration verrouillée
    clearTimeout(cdTimer); cdTimer = setTimeout(() => { cdTimer = null; render(); }, 1500);
    $('rmCountdown').textContent = n; $('rmCountdown').style.display = 'flex'; render();
  }
  function cancelled(msg) { clearTimeout(cdTimer); cdTimer = null; $('rmCountdown').style.display = 'none'; chat('', msg, true); render(); }

  loadMaps();
  return {
    render, chat, countdown, cancelled,
    show(v) { $('room').style.display = v ? 'flex' : 'none'; if (v) render(); else { clearTimeout(cdTimer); cdTimer = null; $('rmCountdown').style.display = 'none'; } },
    colorHex,
  };
}
