<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Zero Hour Game</title>
    <style>
      body { margin: 0; background: #0f172a; color: white; font-family: Arial, sans-serif; }
      #game { width: 100vw; height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #0f172a, #111827); }
      #panel { background: rgba(15, 23, 42, 0.9); border: 1px solid #334155; border-radius: 12px; padding: 20px; min-width: 360px; }
      h1 { margin-top: 0; }
      .meta { margin: 8px 0; color: #cbd5e1; }
      button { margin-top: 12px; padding: 10px 14px; border: 0; border-radius: 8px; background: #2563eb; color: white; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="game">
      <div id="panel">
        <h1>Début de partie</h1>
        <div class="meta">Room: <span id="roomId">-</span></div>
        <div class="meta">Joueur: <span id="playerName">-</span></div>
        <div class="meta">Etat: <span id="state">Chargement...</span></div>
        <button id="endMatchBtn">Terminer la partie</button>
      </div>
    </div>

    <script>
      const params = new URLSearchParams(window.location.search);
      const roomId = params.get('roomId');
      const userId = params.get('userId');

      document.getElementById('roomId').textContent = roomId || 'inconnu';
      document.getElementById('playerName').textContent = userId || 'inconnu';

      const ws = new WebSocket('ws://localhost:3010');

      ws.addEventListener('open', () => {
        document.getElementById('state').textContent = 'Connecté';
        ws.send(JSON.stringify({
          type: 'register',
          userId: userId,
          username: 'Joueur'
        }));

        if (roomId) {
          ws.send(JSON.stringify({
            type: 'join-room',
            roomId: roomId,
            userId: userId,
            username: 'Joueur'
          }));
        }
      });

      ws.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'match-started') {
          document.getElementById('state').textContent = 'Partie lancée';
        }
        if (data.type === 'room-update') {
          document.getElementById('state').textContent = 'Room mise à jour';
        }
      });

      document.getElementById('endMatchBtn').onclick = () => {
        ws.send(JSON.stringify({
          type: 'end-match',
          winnerId: userId
        }));
        document.getElementById('state').textContent = 'Partie terminée';
      };
    </script>
  </body>
</html>
