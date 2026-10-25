import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const rooms = new Map();
const clients = new Map(); // ws -> { userId, username, roomId }

function createRoom(name, hostId) {
  const roomId = randomUUID();
  const room = {
    id: roomId,
    name,
    hostId,
    mapId: null,
    status: 'lobby',
    maxPlayers: 8,
    players: new Map(),
    messages: [],
  };

  rooms.set(roomId, room);
  return room;
}

function roomToJSON(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    mapId: room.mapId,
    status: room.status,
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()],
    messages: room.messages.slice(-50),
  };
}

function broadcastToRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const [ws, info] of clients.entries()) {
    if (info.roomId === roomId) {
      ws.send(JSON.stringify(payload));
    }
  }
}

function broadcastRoomList() {
  const list = [...rooms.values()].map(roomToJSON);
  for (const ws of clients.keys()) {
    ws.send(JSON.stringify({ type: 'room-list', rooms: list }));
  }
}

function safeUserInfo(ws) {
  const info = clients.get(ws);
  return info ?? null;
}

const wss = new WebSocketServer({ port: 3002 });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }

    const type = message.type;

    if (type === 'register') {
      const userId = String(message.userId || randomUUID());
      const username = String(message.username || 'Guest').slice(0, 48);
      clients.set(ws, { userId, username, roomId: null });
      ws.send(JSON.stringify({ type: 'registered', userId, username }));
      broadcastRoomList();
      return;
    }

    const userInfo = safeUserInfo(ws);
    if (!userInfo) {
      ws.send(JSON.stringify({ type: 'error', message: 'register first' }));
      return;
    }

    if (type === 'list-rooms') {
      const list = [...rooms.values()].map(roomToJSON);
      ws.send(JSON.stringify({ type: 'room-list', rooms: list }));
      return;
    }

    if (type === 'create-room') {
      const name = String(message.name || 'Salle').slice(0, 80);
      const room = createRoom(name, userInfo.userId);
      room.players.set(userInfo.userId, {
        userId: userInfo.userId,
        username: userInfo.username,
        ready: false,
      });
      userInfo.roomId = room.id;
      ws.send(JSON.stringify({ type: 'room-created', room: roomToJSON(room) }));
      broadcastRoomList();
      broadcastToRoom(room.id, { type: 'room-update', room: roomToJSON(room) });
      return;
    }

    if (type === 'join-room') {
      const roomId = message.roomId;
      const room = rooms.get(roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'room not found' }));
        return;
      }

      if (room.players.size >= room.maxPlayers) {
        ws.send(JSON.stringify({ type: 'error', message: 'room full' }));
        return;
      }

      if (room.status !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: 'match already started' }));
        return;
      }

      room.players.set(userInfo.userId, {
        userId: userInfo.userId,
        username: userInfo.username,
        ready: false,
      });
      userInfo.roomId = room.id;

      const payload = {
        type: 'joined-room',
        room: roomToJSON(room),
      };
      ws.send(JSON.stringify(payload));
      broadcastRoomList();
      broadcastToRoom(room.id, { type: 'room-update', room: roomToJSON(room) });
      return;
    }

    if (type === 'leave-room') {
      const roomId = userInfo.roomId;
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      room.players.delete(userInfo.userId);
      userInfo.roomId = null;

      if (room.players.size === 0) {
        rooms.delete(roomId);
      } else if (room.hostId === userInfo.userId) {
        const first = [...room.players.keys()][0];
        room.hostId = first;
      }

      ws.send(JSON.stringify({ type: 'left-room' }));
      broadcastRoomList();
      broadcastToRoom(roomId, { type: 'room-update', room: roomToJSON(room) });
      return;
    }

    if (type === 'chat-message') {
      const roomId = userInfo.roomId;
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      const text = String(message.text || '').slice(0, 500);
      if (!text.trim()) return;

      const chat = {
        type: 'chat-message',
        roomId,
        userId: userInfo.userId,
        username: userInfo.username,
        text,
        time: Date.now(),
      };

      room.messages.push(chat);
      if (room.messages.length > 200) room.messages.shift();

      broadcastToRoom(roomId, chat);
      return;
    }

    if (type === 'set-ready') {
      const roomId = userInfo.roomId;
      const room = rooms.get(roomId);
      if (!room) return;

      const player = room.players.get(userInfo.userId);
      if (!player) return;

      player.ready = !!message.ready;
      broadcastToRoom(roomId, { type: 'room-update', room: roomToJSON(room) });
      return;
    }

    if (type === 'set-map') {
      const roomId = userInfo.roomId;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.hostId !== userInfo.userId) return;

      room.mapId = String(message.mapId || 'map_01');
      broadcastToRoom(roomId, { type: 'room-update', room: roomToJSON(room) });
      return;
    }

    if (type === 'start-match') {
      const roomId = userInfo.roomId;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.hostId !== userInfo.userId) return;

      room.status = 'playing';
      broadcastToRoom(roomId, {
        type: 'match-started',
        room: roomToJSON(room),
        mapId: room.mapId,
      });
      return;
    }

    if (type === 'end-match') {
      const roomId = userInfo.roomId;
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.hostId !== userInfo.userId) return;

      room.status = 'finished';
      broadcastToRoom(roomId, {
        type: 'match-ended',
        room: roomToJSON(room),
        winnerId: message.winnerId || null,
      });
      return;
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (!info) return;

    const room = rooms.get(info.roomId);
    if (room) {
      room.players.delete(info.userId);
      if (room.players.size === 0) {
        rooms.delete(info.roomId);
      } else if (room.hostId === info.userId) {
        const firstPlayerId = [...room.players.keys()][0];
        room.hostId = firstPlayerId;
      }
      broadcastRoomList();
      broadcastToRoom(info.roomId, { type: 'room-update', room: roomToJSON(room) });
    }

    clients.delete(ws);
  });
});

console.log('WS room server running on ws://localhost:3002');

export { rooms, clients };
