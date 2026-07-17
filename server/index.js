import cors from "cors";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomWord } from "./words.js";

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 10;

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

/** @typedef {{ id: string, name: string, isHost: boolean }} Player */
/** @typedef {{
 *  code: string,
 *  hostId: string,
 *  players: Map<string, Player>,
 *  phase: 'lobby' | 'playing',
 *  drawerId: string | null,
 *  word: string | null,
 * }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socketId -> roomCode */
const socketRoom = new Map();

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

function startRound(room) {
  const players = [...room.players.values()];
  if (players.length === 0) return;

  const drawer = players[Math.floor(Math.random() * players.length)];
  const word = randomWord();
  room.phase = "playing";
  room.drawerId = drawer.id;
  room.word = word;

  io.to(room.code).emit("clearCanvas");

  for (const player of players) {
    const payload = {
      drawerId: drawer.id,
      drawerName: drawer.name,
      players: publicPlayers(room),
    };
    if (player.id === drawer.id) {
      io.to(player.id).emit("roundStart", { ...payload, word });
    } else {
      io.to(player.id).emit("roundStart", { ...payload, word: null });
    }
  }
}

function leaveRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  if (!room) return;

  const wasDrawer = room.drawerId === socket.id;
  const wasHost = room.hostId === socket.id;
  room.players.delete(socket.id);
  socket.leave(code);

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (wasHost) {
    const nextHost = [...room.players.values()][0];
    room.hostId = nextHost.id;
    nextHost.isHost = true;
  }

  if (room.phase === "playing" && wasDrawer) {
    startRound(room);
  } else {
    emitLobby(room);
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    try {
      const trimmed = String(name || "").trim().slice(0, 12);
      if (!trimmed) return cb?.({ ok: false, error: "名前を入力してください" });

      const code = generateCode();
      /** @type {Room} */
      const room = {
        code,
        hostId: socket.id,
        players: new Map(),
        phase: "lobby",
        drawerId: null,
        word: null,
      };
      room.players.set(socket.id, {
        id: socket.id,
        name: trimmed,
        isHost: true,
      });
      rooms.set(code, room);
      socketRoom.set(socket.id, code);
      socket.join(code);

      cb?.({
        ok: true,
        code,
        playerId: socket.id,
        hostId: room.hostId,
        players: publicPlayers(room),
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
    if (room.phase !== "lobby") {
      return cb?.({ ok: false, error: "ゲーム中のため入れません" });
    }
    if (room.players.size >= MAX_PLAYERS) {
      return cb?.({ ok: false, error: "部屋が満員です（最大10人）" });
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: trimmed,
      isHost: false,
    });
    socketRoom.set(socket.id, roomCode);
    socket.join(roomCode);

    cb?.({
      ok: true,
      code: roomCode,
      playerId: socket.id,
      hostId: room.hostId,
      players: publicPlayers(room),
    });
    emitLobby(room);
  });

  socket.on("startGame", (cb) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "部屋がありません" });
    if (room.hostId !== socket.id) {
      return cb?.({ ok: false, error: "ホストだけが開始できます" });
    }
    if (room.players.size < 2) {
      return cb?.({ ok: false, error: "2人以上必要です" });
    }
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("stroke", (data) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room || room.phase !== "playing") return;
    if (room.drawerId !== socket.id) return;
    socket.to(code).emit("stroke", data);
  });

  socket.on("nextRound", (cb) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "部屋がありません" });
    if (room.phase !== "playing") {
      return cb?.({ ok: false, error: "プレイ中ではありません" });
    }
    if (room.drawerId !== socket.id) {
      return cb?.({ ok: false, error: "描き手だけが次へ進めます" });
    }
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("endGame", (cb) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "部屋がありません" });
    if (room.hostId !== socket.id) {
      return cb?.({ ok: false, error: "ホストだけが終了できます" });
    }
    room.phase = "lobby";
    room.drawerId = null;
    room.word = null;
    io.to(code).emit("clearCanvas");
    io.to(code).emit("gameEnded");
    emitLobby(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
