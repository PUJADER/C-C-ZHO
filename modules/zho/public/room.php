<?php
?>
<html>
<head>
  <meta charset="utf-8" />
  <title>Room ZHO</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    #chat { width: 520px; height: 220px; overflow: auto; border: 1px solid #ccc; padding: 10px; margin-top: 12px; }
    .row { margin: 8px 0; }
    input, button { padding: 6px 8px; }
  </style>
</head>
<body>
  <h1>Room ZHO</h1>
  <p>Cette page est le point d'entrée de la room et du chat live.</p>
  <p>Le WebSocket est sur : <strong>ws://localhost:3002</strong></p>

  <div id="room-box" class="row"></div>
  <div id="chat"></div>

  <div class="row">
    <input id="username" type="text" value="Joueur" />
    <button id="connectBtn">Connecter</button>
  </div>

  <div class="row">
    <input id="roomName" type="text" value="Salle 1" />
    <button id="createRoomBtn">Créer salle</button>
  </div>

  <div class="row">
    <input id="roomIdInput" type="text" placeholder="ID salle" />
    <button id="joinRoomBtn">Rejoindre</button>
  </div>

  <div class="row">
    <input id="chatInput" type="text" placeholder="Message" />
    <button id="sendMsgBtn">Envoyer</button>
  </div>

  <p><a href="lobby.php">Retour au lobby</a></p>

  <script>
    var ws = new WebSocket('ws://localhost:3002');
    var myUserId = null;
    var currentRoom = null;

    var roomBox = document.getElementById('room-box');
    var chatBox = document.getElementById('chat');

    function escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderRoom(room) {
      if (!room) {
        roomBox.innerHTML = '<p>Aucune salle ouverte.</p>';
        return;
      }

      var playerList = '';
      if (room.players && room.players.length) {
        playerList = room.players.map(function (player) {
          return '<li>' + escapeHtml(player.username) + (player.ready ? ' (ready)' : '') + '</li>';
        }).join('');
      } else {
        playerList = '<li>Aucun joueur</li>';
      }

      roomBox.innerHTML = '<h3>' + escapeHtml(room.name) + '</h3>' +
        '<p>ID: ' + escapeHtml(room.id) + '</p>' +
        '<p>Map: ' + escapeHtml(room.mapId || 'Aucune') + '</p>' +
        '<p>Statut: ' + escapeHtml(room.status) + '</p>' +
        '<ul>' + playerList + '</ul>';
    }

    function addChatMessage(data) {
      var div = document.createElement('div');
      div.innerHTML = '<strong>' + escapeHtml(data.username) + ':</strong> ' + escapeHtml(data.text);
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    ws.onmessage = function (event) {
      var data = JSON.parse(event.data);

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
    };

    document.getElementById('connectBtn').onclick = function () {
      var username = document.getElementById('username').value.trim() || 'Joueur';
      myUserId = 'user_' + Date.now();
      ws.send(JSON.stringify({
        type: 'register',
        userId: myUserId,
        username: username
      }));
    };

    document.getElementById('createRoomBtn').onclick = function () {
      if (!myUserId) {
        alert('Connectez-vous avant de créer une salle');
        return;
      }

      var username = document.getElementById('username').value.trim() || 'Joueur';
      var name = document.getElementById('roomName').value.trim() || 'Salle 1';

      ws.send(JSON.stringify({
        type: 'create-room',
        userId: myUserId,
        username: username,
        name: name
      }));
    };

    document.getElementById('joinRoomBtn').onclick = function () {
      if (!myUserId) {
        alert('Connectez-vous avant de rejoindre');
        return;
      }

      var username = document.getElementById('username').value.trim() || 'Joueur';
      var roomId = document.getElementById('roomIdInput').value.trim();

      ws.send(JSON.stringify({
        type: 'join-room',
        userId: myUserId,
        username: username,
        roomId: roomId
      }));
    };

    document.getElementById('sendMsgBtn').onclick = function () {
      var text = document.getElementById('chatInput').value.trim();
      if (!text) {
        return;
      }

      ws.send(JSON.stringify({
        type: 'chat-message',
        text: text
      }));

      document.getElementById('chatInput').value = '';
    };
  </script>
</body>
</html>
