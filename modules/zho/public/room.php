<?php
// modules/zho/public/room.php
require_once '../../../mainfile.php';
require_once XOOPS_ROOT_PATH . '/header.php';
?>
<h1>Salle ZHO</h1>
<p>Cette page est le point d’entrée de la room / chat / lobby.</p>
<p>Le serveur WebSocket est sur <strong>ws://localhost:3002</strong>.</p>

<div id="room-box"></div>
<div id="chat" style="max-height: 220px; overflow: auto; border: 1px solid #ddd; padding: 12px; margin-top: 12px;"></div>

<div style="margin-top: 12px;">
  <input id="username" value="Joueur" placeholder="Pseudo" />
  <button id="connectBtn">Connecter</button>
</div>

<div style="margin-top: 12px;">
  <input id="roomName" placeholder="Nom salle" value="Salle 1" />
  <button id="createRoomBtn">Créer salle</button>
  <input id="roomIdInput" placeholder="ID salle" />
  <button id="joinRoomBtn">Rejoindre</button>
</div>

<div style="margin-top: 12px;">
  <input id="chatInput" placeholder="Message" />
  <button id="sendMsgBtn">Envoyer</button>
</div>

<script>
  const roomBox = document.getElementById('room-box');
  const chatBox = document.getElementById('chat');
  const ws = new WebSocket('ws://localhost:3002');
  let myUserId = null;
  let currentRoom = null;

  function renderRoom(room) {
    if (!room) {
      roomBox.innerHTML = '<p>Aucune salle ouverte.</p>';
      return;
    }
    const players = (room.players || []).map((p) => `<li>${p.username} ${p.ready ? '(ready)' : ''}</li>`).join('');
    roomBox.innerHTML = `
      <h3>${room.name}</h3>
      <p>ID: ${room.id}</p>
      <p>Map: ${room.mapId || 'Aucune'}</p>
      <p>Statut: ${room.status}</p>
      <ul>${players}</ul>
    `;
  }

  function pushMessage(username, text) {
    const div = document.createElement('div');
    div.textContent = `${username}: ${text}`;
    chatBox.appendChild(div);
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
      pushMessage(data.username, data.text);
    }

    if (data.type === 'room-list') {
      if (data.rooms?.length) {
        renderRoom(data.rooms[0]);
      }
    }
  });

  document.getElementById('connectBtn').onclick = () => {
    const username = document.getElementById('username').value || 'Joueur';
    myUserId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'register', userId: myUserId, username }));
  };

  document.getElementById('createRoomBtn').onclick = () => {
    const username = document.getElementById('username').value || 'Joueur';
    ws.send(JSON.stringify({ type: 'create-room', userId: myUserId, username, name: document.getElementById('roomName').value || 'Salle 1' }));
  };

  document.getElementById('joinRoomBtn').onclick = () => {
    const username = document.getElementById('username').value || 'Joueur';
    ws.send(JSON.stringify({ type: 'join-room', userId: myUserId, username, roomId: document.getElementById('roomIdInput').value }));
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
