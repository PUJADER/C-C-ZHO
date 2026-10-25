<?php
// modules/zho/public/room.php
require_once '../../../mainfile.php';
require_once XOOPS_ROOT_PATH . '/header.php';
?>
<h1>Room ZHO</h1>
<p>Cette page est le point d’entrée de la room, du chat et du lobby live.</p>
<p>Le WebSocket est sur : <strong>ws://localhost:3002</strong></p>

<div id="room-box" style="border:1px solid #ddd; padding:12px; margin-bottom:12px;"></div>
<div id="chat" style="height:220px; overflow:auto; border:1px solid #ddd; padding:10px; margin-bottom:12px;"></div>

<div style="margin-bottom:10px;">
  <input id="username" value="Joueur" placeholder="Pseudo" />
  <button id="connectBtn">Connecter</button>
</div>

<div style="margin-bottom:10px;">
  <input id="roomName" value="Salle 1" placeholder="Nom salle" />
  <button id="createRoomBtn">Créer salle</button>
  <input id="roomIdInput" placeholder="ID salle" />
  <button id="joinRoomBtn">Rejoindre</button>
</div>

<div>
  <input id="chatInput" placeholder="Message" />
  <button id="sendMsgBtn">Envoyer</button>
</div>

<script>
  const ws = new WebSocket('ws://localhost:3002');
  const roomBox = document.getElementById('room-box');
  const chatBox = document.getElementById('chat');

  let myUserId = null;
  let currentRoom = null;

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>\"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[s]));
  }

  function renderRoom(room) {
    if (!room) {
      roomBox.innerHTML = '<p>Aucune salle ouverte.</p>';
      return;
    }

    const players = (room.players || []).map((p) => `<li>${escapeHtml(p.username)} ${p.ready ? '<span>(ready)</span>' : ''}</li>`).join('');
    roomBox.innerHTML = `
      <h3>${escapeHtml(room.name)}</h3>
      <p>ID: ${escapeHtml(room.id)}</p>
      <p>Map: ${escapeHtml(room.mapId || 'Aucune')}</p>
      <p>Statut: ${escapeHtml(room.status)}</p>
      <ul>${players}</ul>
    `;
  }

  function addChatMessage(data) {
    const line = document.createElement('div');
    line.innerHTML = `<strong>${escapeHtml(data.username)}:</strong> ${escapeHtml(data.text)}`;
    chatBox.appendChild(line);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'registered') {
      myUserId = data.userId;
      return;
    }
    if (data.type === 'room-created' || data.type === 'joined-room' || data.type === 'room-update') {
      currentRoom = data.room;
      renderRoom(currentRoom);
    }
    if (data.type === 'chat-message') {
      addChatMessage(data);
    }
    if (data.type === 'error') {
      alert(data.message || 'Erreur');
    }
  });

  document.getElementById('connectBtn').onclick = () => {
    const username = document.getElementById('username').value.trim() || 'Joueur';
    myUserId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'register', userId: myUserId, username }));
  };

  document.getElementById('createRoomBtn').onclick = () => {
    const username = document.getElementById('username').value.trim() || 'Joueur';
    ws.send(JSON.stringify({
      type: 'create-room',
      userId: myUserId,
      username,
      name: document.getElementById('roomName').value || 'Salle 1'
    }));
  };

  document.getElementById('joinRoomBtn').onclick = () => {
    const username = document.getElementById('username').value.trim() || 'Joueur';
    ws.send(JSON.stringify({
      type: 'join-room',
      userId: myUserId,
      username,
      roomId: document.getElementById('roomIdInput').value
    }));
  };

  document.getElementById('sendMsgBtn').onclick = () => {
    const text = document.getElementById('chatInput').value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: 'chat-message', text }));
    document.getElementById('chatInput').value = '';
  };
</script>
<?php
require_once XOOPS_ROOT_PATH . '/footer.php';
