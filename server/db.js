import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_PATH = './data/zho.db';

let db = null;

export async function initDatabase() {
  if (db) return db;

  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS zho_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zho_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_id TEXT NOT NULL,
      map_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'lobby',
      max_players INTEGER NOT NULL DEFAULT 8,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zho_room_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      ready INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS zho_room_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zho_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      winner_user_id TEXT DEFAULT NULL,
      map_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS zho_leaderboard (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      last_update TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS zho_settings (
      key_name TEXT PRIMARY KEY,
      key_value TEXT NOT NULL
    );
  `);

  return db;
}

export async function upsertUser(userId, username) {
  const database = await initDatabase();
  await database.run(
    `INSERT INTO zho_users (id, username) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username`,
    [userId, username]
  );
}

export async function saveRoom(room) {
  const database = await initDatabase();
  await database.run(
    `INSERT INTO zho_rooms (id, name, host_id, map_id, status, max_players)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       host_id = excluded.host_id,
       map_id = excluded.map_id,
       status = excluded.status,
       max_players = excluded.max_players`,
    [room.id, room.name, room.hostId, room.mapId, room.status, room.maxPlayers]
  );

  for (const player of room.players.values()) {
    await database.run(
      `INSERT INTO zho_room_members (room_id, user_id, username, ready)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET
         username = excluded.username,
         ready = excluded.ready`,
      [room.id, player.userId, player.username, player.ready ? 1 : 0]
    );
  }
}

export async function saveChatMessage(roomId, userId, username, message) {
  const database = await initDatabase();
  await database.run(
    `INSERT INTO zho_room_messages (room_id, user_id, username, message)
     VALUES (?, ?, ?, ?)`,
    [roomId, userId, username, message]
  );
}

export async function saveMatchResult(roomId, winnerUserId, mapId) {
  const database = await initDatabase();
  await database.run(
    `INSERT INTO zho_matches (room_id, winner_user_id, map_id, ended_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [roomId, winnerUserId, mapId]
  );

  const room = await database.all(
    `SELECT user_id, username FROM zho_room_members WHERE room_id = ?`,
    [roomId]
  );

  for (const member of room) {
    const isWinner = member.user_id === winnerUserId;

    const row = await database.get(
      `SELECT * FROM zho_leaderboard WHERE user_id = ?`,
      [member.user_id]
    );

    if (!row) {
      await database.run(
        `INSERT INTO zho_leaderboard (user_id, username, wins, losses, points, last_update)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [member.user_id, member.username, isWinner ? 1 : 0, isWinner ? 0 : 1, isWinner ? 25 : -5]
      );
      continue;
    }

    const newWins = isWinner ? row.wins + 1 : row.wins;
    const newLosses = isWinner ? row.losses : row.losses + 1;
    const newPoints = isWinner ? row.points + 25 : Math.max(0, row.points - 5);

    await database.run(
      `UPDATE zho_leaderboard
       SET wins = ?, losses = ?, points = ?, last_update = datetime('now')
       WHERE user_id = ?`,
      [newWins, newLosses, newPoints, member.user_id]
    );
  }
}

export async function getLeaderboard() {
  const database = await initDatabase();
  return database.all(`
    SELECT user_id, username, wins, losses, points, last_update
    FROM zho_leaderboard
    ORDER BY points DESC, wins DESC, username ASC
    LIMIT 20
  `);
}

export async function getRoomUsers(roomId) {
  const database = await initDatabase();
  return database.all(
    `SELECT user_id, username, ready FROM zho_room_members WHERE room_id = ?`,
    [roomId]
  );
}
