import { randomUUID } from "crypto";
import cors from "cors";
import express from "express";
import { existsSync } from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { randomWord } from "./words.js";

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 10;
const DISCONNECT_GRACE_MS = 45_000;
const MAX_CONSECUTIVE_DRAWS = 2;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "../client/dist");

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

/**
 * @typedef {{
 *  id: string,
 *  name: string,
 *  isHost: boolean,
 *  socketId: string | null,
 *  disconnectTimer?: ReturnType<typeof setTimeout>,
 * }} Player
 */
/**
 * @typedef {{
 *  code: string,
 *  hostId: string,
 *  players: Map<string, Player>,
 *  phase: 'lobby' | 'playing',
 *  drawerId: string | null,
 *  word: string | null,
 *  drawerStreak: { id: string, count: number } | null,
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socketId -> roomCode */
const socketRoom = new Map();
/** socketId -> playerId */
const socketPlayer = new Map();

function generateCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error("部屋コードを発行できませんでした");
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
  }));
}

function emitLobby(room) {
  io.to(room.code).emit("lobbyUpdate", {
    code: room.code,
    phase: room.phase,
    players: publicPlayers(room),
    hostId: room.hostId,
  });
}

function bindSocket(socket, room, player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = undefined;
  }
  if (player.socketId && player.socketId !== socket.id) {
    socketRoom.delete(player.socketId);
    socketPlayer.delete(player.socketId);
  }
  player.socketId = socket.id;
  socketRoom.set(socket.id, room.code);
  socketPlayer.set(socket.id, player.id);
  socket.join(room.code);
}

function getContext(socket) {
  const code = socketRoom.get(socket.id);
  const playerId = socketPlayer.get(socket.id);
  const room = code ? rooms.get(code) : null;
  if (!room || !playerId) return null;
  const player = room.players.get(playerId);
  if (!player) return null;
  return { code, room, playerId, player };
}

function pickDrawer(room) {
  const players = [...room.players.values()];
  if (players.length === 0) return null;

  let candidates = players;
  const streak = room.drawerStreak;
  if (streak && streak.count >= MAX_CONSECUTIVE_DRAWS && players.length > 1) {
    const filtered = players.filter((p) => p.id !== streak.id);
    if (filtered.length > 0) candidates = filtered;
  }

  const drawer = candidates[Math.floor(Math.random() * candidates.length)];
  if (streak && streak.id === drawer.id) {
    room.drawerStreak = { id: drawer.id, count: streak.count + 1 };
  } else {
    room.drawerStreak = { id: drawer.id, count: 1 };
  }
  return drawer;
}

function emitRoundStart(room) {
  const players = [...room.players.values()];
  const drawer = room.drawerId ? room.players.get(room.drawerId) : null;
  if (!drawer) return;

  for (const player of players) {
    if (!player.socketId) continue;
    const payload = {
      drawerId: drawer.id,
      drawerName: drawer.name,
      players: publicPlayers(room),
      word: player.id === drawer.id ? room.word : null,
    };
    io.to(player.socketId).emit("roundStart", payload);
  }
}

function startRound(room) {
  const drawer = pickDrawer(room);
  if (!drawer) return;

  const word = randomWord();
  room.phase = "playing";
  room.drawerId = drawer.id;
  room.word = word;

  io.to(room.code).emit("clearCanvas");
  emitRoundStart(room);
}

function syncPlayerState(socket, room, playerId) {
  const players = publicPlayers(room);
  if (room.phase === "playing" && room.drawerId) {
    const drawer = room.players.get(room.drawerId);
    io.to(socket.id).emit("roundStart", {
      drawerId: room.drawerId,
      drawerName: drawer?.name || "",
      players,
      word: room.drawerId === playerId ? room.word : null,
    });
  } else {
    emitLobby(room);
  }
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;

  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = undefined;
  }
  if (player.socketId) {
    socketRoom.delete(player.socketId);
    socketPlayer.delete(player.socketId);
    const sock = io.sockets.sockets.get(player.socketId);
    sock?.leave(room.code);
  }

  const wasDrawer = room.drawerId === playerId;
  const wasHost = room.hostId === playerId;
  room.players.delete(playerId);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (wasHost) {
    const nextHost = [...room.players.values()][0];
    room.hostId = nextHost.id;
    nextHost.isHost = true;
  }

  if (room.phase === "playing" && wasDrawer) {
    if (room.drawerStreak?.id === playerId) {
      room.drawerStreak = null;
    }
    startRound(room);
  } else {
    emitLobby(room);
  }
}

function scheduleDisconnect(room, player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
  }
  player.socketId = null;
  player.disconnectTimer = setTimeout(() => {
    const current = rooms.get(room.code);
    if (!current) return;
    const still = current.players.get(player.id);
    if (!still || still.socketId) return;
    removePlayer(current, player.id);
  }, DISCONNECT_GRACE_MS);
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    try {
      const trimmed = String(name || "").trim().slice(0, 12);
      if (!trimmed) return cb?.({ ok: false, error: "名前を入力してください" });

      const code = generateCode();
      const playerId = randomUUID();
      /** @type {Room} */
      const room = {
        code,
        hostId: playerId,
        players: new Map(),
        phase: "lobby",
        drawerId: null,
        word: null,
        drawerStreak: null,
      };
      const player = {
        id: playerId,
        name: trimmed,
        isHost: true,
        socketId: null,
      };
      room.players.set(playerId, player);
      rooms.set(code, room);
      bindSocket(socket, room, player);

      cb?.({
        ok: true,
        code,
        playerId,
        hostId: room.hostId,
        players: publicPlayers(room),
        phase: room.phase,
      });
      emitLobby(room);
    } catch (e) {
      cb?.({ ok: false, error: e.message || "部屋を作成できませんでした" });
    }
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const trimmed = String(name || "").trim().slice(0, 12);
    const roomCode = String(code || "").trim();
    if (!trimmed) return cb?.({ ok: false, error: "名前を入力してください" });
    if (!/^\d{4}$/.test(roomCode)) {
      return cb?.({ ok: false, error: "部屋コードは4桁です" });
    }

    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok: false, error: "部屋が見つかりません" });
    if (room.players.size >= MAX_PLAYERS) {
      return cb?.({ ok: false, error: "部屋が満員です（最大10人）" });
    }

    const playerId = randomUUID();
    const player = {
      id: playerId,
      name: trimmed,
      isHost: false,
      socketId: null,
    };
    room.players.set(playerId, player);
    bindSocket(socket, room, player);

    cb?.({
      ok: true,
      code: roomCode,
      playerId,
      hostId: room.hostId,
      players: publicPlayers(room),
      phase: room.phase,
    });

    socket.to(roomCode).emit("playerJoined", { name: trimmed });

    if (room.phase === "playing") {
      syncPlayerState(socket, room, playerId);
      emitLobby(room);
    } else {
      emitLobby(room);
    }
  });

  socket.on("rejoinRoom", ({ code, playerId, name }, cb) => {
    const roomCode = String(code || "").trim();
    const id = String(playerId || "").trim();
    const trimmed = String(name || "").trim().slice(0, 12);

    if (!/^\d{4}$/.test(roomCode) || !id) {
      return cb?.({ ok: false, error: "再入室できません", expired: true });
    }

    const room = rooms.get(roomCode);
    if (!room) {
      return cb?.({ ok: false, error: "部屋が見つかりません", expired: true });
    }

    const player = room.players.get(id);
    if (!player) {
      return cb?.({
        ok: false,
        error: "セッションが切れました。もう一度入室してください",
        expired: true,
      });
    }

    if (trimmed) player.name = trimmed;
    bindSocket(socket, room, player);

    cb?.({
      ok: true,
      code: roomCode,
      playerId: player.id,
      hostId: room.hostId,
      players: publicPlayers(room),
      phase: room.phase,
    });

    syncPlayerState(socket, room, player.id);
  });

  socket.on("leaveRoom", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: true });
    removePlayer(ctx.room, ctx.playerId);
    cb?.({ ok: true });
  });

  socket.on("startGame", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return cb?.({ ok: false, error: "ホストだけが開始できます" });
    }
    if (room.players.size < 2) {
      return cb?.({ ok: false, error: "2人以上必要です" });
    }
    room.drawerStreak = null;
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("stroke", (data) => {
    const ctx = getContext(socket);
    if (!ctx) return;
    const { code, room, playerId } = ctx;
    if (room.phase !== "playing") return;
    if (room.drawerId !== playerId) return;
    socket.to(code).emit("stroke", data);
  });

  socket.on("nextRound", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.phase !== "playing") {
      return cb?.({ ok: false, error: "プレイ中ではありません" });
    }
    if (room.drawerId !== playerId) {
      return cb?.({ ok: false, error: "描き手だけが次へ進めます" });
    }
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("endGame", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return cb?.({ ok: false, error: "ホストだけが終了できます" });
    }
    room.phase = "lobby";
    room.drawerId = null;
    room.word = null;
    room.drawerStreak = null;
    io.to(code).emit("clearCanvas");
    io.to(code).emit("gameEnded");
    emitLobby(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const code = socketRoom.get(socket.id);
    const playerId = socketPlayer.get(socket.id);
    socketRoom.delete(socket.id);
    socketPlayer.delete(socket.id);
    if (!code || !playerId) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;
    if (player.socketId && player.socketId !== socket.id) return;
    scheduleDisconnect(room, player);
  });
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/socket.io")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
