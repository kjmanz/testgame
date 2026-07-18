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
const RELAY_MIN_PLAYERS = 3;
const COOP_MIN_PLAYERS = 3;
const RELAY_MAX_DRAWERS = 5;
const COOP_MAX_DRAWERS = 3;
const COOP_DURATION_MS = 40_000;
const GALLERY_MAX = 30;
const EVENT_MIN_GAP = 5;
const EVENT_FORCE_GAP = 8;
const EVENT_CHANCE = 0.22;
const MAX_GALLERY_DATA_URL_LEN = 400_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "../client/dist");

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e6,
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
 *  id: string,
 *  imageDataUrl: string,
 *  word: string,
 *  drawerNames: string[],
 *  roundType: 'normal' | 'relay' | 'coop',
 *  createdAt: number,
 * }} GalleryItem
 */
/**
 * @typedef {{
 *  code: string,
 *  hostId: string,
 *  players: Map<string, Player>,
 *  phase: 'lobby' | 'playing',
 *  roundType: 'normal' | 'relay' | 'coop',
 *  drawPhase: 'drawing' | 'guessing',
 *  drawerId: string | null,
 *  drawerIds: string[],
 *  word: string | null,
 *  drawerStreak: { id: string, count: number } | null,
 *  relayIndex: number,
 *  turnDurations: number[],
 *  turnEndsAt: number | null,
 *  turnTimer: ReturnType<typeof setTimeout> | null,
 *  seenWordIds: Set<string>,
 *  roundsSinceSpecial: number,
 *  lastWasSpecial: boolean,
 *  gallery: GalleryItem[],
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

/** 全角数字なども半角4桁に正規化 */
function normalizeRoomCode(code) {
  return String(code || "")
    .normalize("NFKC")
    .replace(/\D/g, "")
    .slice(0, 4);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
  }));
}

function playerNames(room, ids) {
  return ids
    .map((id) => room.players.get(id)?.name)
    .filter(Boolean);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnEndsAt = null;
}

function emitLobby(room) {
  io.to(room.code).emit("lobbyUpdate", {
    code: room.code,
    phase: room.phase,
    players: publicPlayers(room),
    hostId: room.hostId,
  });
}

function emitGallery(room, targetSocketId = null) {
  const payload = { gallery: room.gallery };
  if (targetSocketId) {
    io.to(targetSocketId).emit("galleryUpdate", payload);
  } else {
    io.to(room.code).emit("galleryUpdate", payload);
  }
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
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

function chooseRoundType(room) {
  const forced = process.env.FORCE_ROUND_TYPE;
  if (forced === "relay" || forced === "coop" || forced === "normal") {
    const n = room.players.size;
    if (forced === "relay" && n < RELAY_MIN_PLAYERS) return "normal";
    if (forced === "coop" && n < COOP_MIN_PLAYERS) return "normal";
    return forced;
  }

  const n = room.players.size;
  const eligible = [];
  if (n >= RELAY_MIN_PLAYERS) eligible.push("relay");
  if (n >= COOP_MIN_PLAYERS) eligible.push("coop");

  if (eligible.length === 0 || room.lastWasSpecial) {
    return "normal";
  }

  const gap = room.roundsSinceSpecial;
  if (gap < EVENT_MIN_GAP) return "normal";

  const roll =
    gap >= EVENT_FORCE_GAP ? true : Math.random() < EVENT_CHANCE;
  if (!roll) return "normal";

  return eligible[Math.floor(Math.random() * eligible.length)];
}

function canPlayerDraw(room, playerId) {
  if (room.phase !== "playing" || room.drawPhase !== "drawing") return false;
  if (room.roundType === "coop") {
    return room.drawerIds.includes(playerId);
  }
  return room.drawerId === playerId;
}

function canPlayerSeeWord(room, playerId) {
  if (room.phase !== "playing" || !room.word) return false;
  if (room.roundType === "normal") {
    return room.drawerId === playerId;
  }
  if (room.roundType === "coop") {
    return room.drawerIds.includes(playerId);
  }
  // relay: already drawn or currently drawing
  return room.seenWordIds.has(playerId);
}

function canPlayerNextRound(room, playerId) {
  if (room.phase !== "playing") return false;
  if (room.roundType === "normal") {
    return room.drawerId === playerId;
  }
  if (room.roundType === "relay") {
    if (room.drawPhase !== "guessing") return false;
    return room.seenWordIds.has(playerId);
  }
  if (room.roundType === "coop") {
    if (room.drawPhase !== "guessing") return false;
    return room.drawerIds.includes(playerId);
  }
  return false;
}

function canEndDrawing(room, playerId) {
  if (room.phase !== "playing" || room.drawPhase !== "drawing") return false;
  if (room.roundType === "coop") {
    return room.drawerIds.includes(playerId);
  }
  return false;
}

function buildRoundPayload(room, playerId) {
  const players = publicPlayers(room);
  const currentDrawer = room.drawerId
    ? room.players.get(room.drawerId)
    : null;
  const drawerNames = playerNames(room, room.drawerIds);
  const seesWord = canPlayerSeeWord(room, playerId);

  /** @type {Record<string, unknown>} */
  const payload = {
    roundType: room.roundType,
    drawPhase: room.drawPhase,
    drawerId: room.drawerId,
    drawerName: currentDrawer?.name || "",
    drawerIds: room.drawerIds,
    drawerNames,
    players,
    word: seesWord ? room.word : null,
    canDraw: canPlayerDraw(room, playerId),
    canSeeWord: seesWord,
    canNextRound: canPlayerNextRound(room, playerId),
    canEndDrawing: canEndDrawing(room, playerId),
    turnEndsAt: room.turnEndsAt,
    turnDurationSec:
      room.roundType === "relay" && room.drawPhase === "drawing"
        ? room.turnDurations[room.relayIndex] ?? null
        : room.roundType === "coop" && room.drawPhase === "drawing"
          ? Math.round(COOP_DURATION_MS / 1000)
          : null,
    relayIndex:
      room.roundType === "relay" ? room.relayIndex : null,
    relayTotal:
      room.roundType === "relay" ? room.drawerIds.length : null,
  };

  if (room.roundType === "coop") {
    payload.coopNames = drawerNames;
  }

  return payload;
}

function emitRoundStart(room, { clear = false, fanfare = false } = {}) {
  if (clear) {
    io.to(room.code).emit("clearCanvas");
  }

  if (fanfare) {
    const message =
      room.roundType === "relay"
        ? "⚡ リレー！"
        : room.roundType === "coop"
          ? "🤝 協力！"
          : null;
    if (message) {
      const names =
        room.roundType === "coop"
          ? playerNames(room, room.drawerIds)
          : [];
      io.to(room.code).emit("roundFanfare", {
        roundType: room.roundType,
        message,
        names,
      });
    }
  }

  for (const player of room.players.values()) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit(
      "roundStart",
      buildRoundPayload(room, player.id)
    );
  }
}

function emitRoundSync(room) {
  for (const player of room.players.values()) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit(
      "roundUpdate",
      buildRoundPayload(room, player.id)
    );
  }
}

function enterGuessing(room) {
  clearTurnTimer(room);
  room.drawPhase = "guessing";
  room.drawerId =
    room.roundType === "relay"
      ? room.drawerIds[room.drawerIds.length - 1] || null
      : room.drawerId;
  emitRoundSync(room);
}

function scheduleRelayTurn(room) {
  clearTurnTimer(room);
  const durationSec =
    room.turnDurations[room.relayIndex] ?? randomInt(5, 10);
  const ms = durationSec * 1000;
  room.turnEndsAt = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    advanceRelay(room);
  }, ms);
}

function beginRelayTurn(room) {
  const drawerId = room.drawerIds[room.relayIndex];
  if (!drawerId || !room.players.has(drawerId)) {
    advanceRelay(room);
    return;
  }
  room.drawerId = drawerId;
  room.drawPhase = "drawing";
  room.seenWordIds.add(drawerId);
  scheduleRelayTurn(room);
  emitRoundSync(room);
}

function advanceRelay(room) {
  if (!rooms.has(room.code) || room.roundType !== "relay") return;
  if (room.drawPhase === "guessing") return;

  let next = room.relayIndex + 1;
  while (next < room.drawerIds.length) {
    if (room.players.has(room.drawerIds[next])) break;
    next += 1;
  }

  if (next >= room.drawerIds.length) {
    enterGuessing(room);
    return;
  }

  room.relayIndex = next;
  beginRelayTurn(room);
}

function scheduleCoopTimer(room) {
  clearTurnTimer(room);
  room.turnEndsAt = Date.now() + COOP_DURATION_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.roundType === "coop" && room.drawPhase === "drawing") {
      enterGuessing(room);
    }
  }, COOP_DURATION_MS);
}

function resetRoundFields(room) {
  clearTurnTimer(room);
  room.roundType = "normal";
  room.drawPhase = "drawing";
  room.drawerId = null;
  room.drawerIds = [];
  room.word = null;
  room.relayIndex = 0;
  room.turnDurations = [];
  room.seenWordIds = new Set();
}

function startRound(room) {
  const players = [...room.players.values()];
  if (players.length === 0) return;

  const roundType = chooseRoundType(room);
  resetRoundFields(room);
  room.phase = "playing";
  room.roundType = roundType;
  room.word = randomWord();

  if (roundType === "relay") {
    room.lastWasSpecial = true;
    room.roundsSinceSpecial = 0;
    const count = Math.min(RELAY_MAX_DRAWERS, players.length);
    const order = shuffle(players.map((p) => p.id)).slice(0, count);
    room.drawerIds = order;
    room.turnDurations = order.map(() => randomInt(5, 10));
    room.relayIndex = 0;
    room.drawerStreak = null;
    room.drawPhase = "drawing";

    // skip missing (shouldn't happen at start)
    while (
      room.relayIndex < room.drawerIds.length &&
      !room.players.has(room.drawerIds[room.relayIndex])
    ) {
      room.relayIndex += 1;
    }
    if (room.relayIndex >= room.drawerIds.length) {
      // fallback
      room.roundType = "normal";
      room.lastWasSpecial = false;
      const drawer = pickDrawer(room);
      if (!drawer) return;
      room.drawerId = drawer.id;
      room.drawerIds = [drawer.id];
      room.seenWordIds = new Set([drawer.id]);
      emitRoundStart(room, { clear: true, fanfare: false });
      return;
    }

    room.drawerId = room.drawerIds[room.relayIndex];
    room.seenWordIds.add(room.drawerId);
    scheduleRelayTurn(room);
    emitRoundStart(room, { clear: true, fanfare: true });
    return;
  }

  if (roundType === "coop") {
    room.lastWasSpecial = true;
    room.roundsSinceSpecial = 0;
    const count = Math.min(COOP_MAX_DRAWERS, players.length);
    const members = shuffle(players.map((p) => p.id)).slice(0, count);
    room.drawerIds = members;
    room.drawerId = members[0] || null;
    room.seenWordIds = new Set(members);
    room.drawerStreak = null;
    room.drawPhase = "drawing";
    scheduleCoopTimer(room);
    emitRoundStart(room, { clear: true, fanfare: true });
    return;
  }

  // normal
  room.lastWasSpecial = false;
  room.roundsSinceSpecial += 1;
  const drawer = pickDrawer(room);
  if (!drawer) return;
  room.drawerId = drawer.id;
  room.drawerIds = [drawer.id];
  room.seenWordIds = new Set([drawer.id]);
  room.drawPhase = "drawing";
  emitRoundStart(room, { clear: true, fanfare: false });
}

function syncPlayerState(socket, room, playerId) {
  const players = publicPlayers(room);
  emitGallery(room, socket.id);
  if (room.phase === "playing" && room.word) {
    io.to(socket.id).emit("roundStart", buildRoundPayload(room, playerId));
  } else {
    emitLobby(room);
  }
  void players;
}

function skipRelayPlayer(room, playerId) {
  if (room.roundType !== "relay" || room.drawPhase !== "drawing") return false;
  if (room.drawerId !== playerId) {
    // remove from future order conceptually by skipping when index hits them
    return false;
  }
  advanceRelay(room);
  return true;
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

  const wasHost = room.hostId === playerId;
  const wasInRound =
    room.phase === "playing" &&
    (room.drawerId === playerId || room.drawerIds.includes(playerId));

  room.players.delete(playerId);
  room.seenWordIds.delete(playerId);

  if (room.players.size === 0) {
    clearTurnTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (wasHost) {
    const nextHost = [...room.players.values()][0];
    room.hostId = nextHost.id;
    nextHost.isHost = true;
  }

  if (room.phase === "playing" && wasInRound) {
    if (room.roundType === "relay" && room.drawPhase === "drawing") {
      if (room.drawerId === playerId) {
        skipRelayPlayer(room, playerId);
      } else {
        emitLobby(room);
        emitRoundSync(room);
      }
      return;
    }

    if (room.roundType === "coop") {
      room.drawerIds = room.drawerIds.filter((id) => id !== playerId);
      if (room.drawerIds.length === 0) {
        if (room.drawerStreak?.id === playerId) room.drawerStreak = null;
        startRound(room);
      } else {
        if (room.drawerId === playerId) {
          room.drawerId = room.drawerIds[0];
        }
        emitLobby(room);
        emitRoundSync(room);
      }
      return;
    }

    // normal drawer left
    if (room.drawerId === playerId) {
      if (room.drawerStreak?.id === playerId) {
        room.drawerStreak = null;
      }
      startRound(room);
      return;
    }
  }

  emitLobby(room);
  if (room.phase === "playing") emitRoundSync(room);
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

function addGalleryItem(room, { imageDataUrl, word, drawerNames, roundType }) {
  if (!imageDataUrl || typeof imageDataUrl !== "string") return;
  if (!imageDataUrl.startsWith("data:image/")) return;
  if (imageDataUrl.length > MAX_GALLERY_DATA_URL_LEN) return;

  room.gallery.push({
    id: randomUUID(),
    imageDataUrl,
    word: String(word || "").slice(0, 40),
    drawerNames: Array.isArray(drawerNames)
      ? drawerNames.map((n) => String(n).slice(0, 12)).slice(0, 8)
      : [],
    roundType: roundType || "normal",
    createdAt: Date.now(),
  });
  if (room.gallery.length > GALLERY_MAX) {
    room.gallery = room.gallery.slice(-GALLERY_MAX);
  }
  emitGallery(room);
}

function createEmptyRoom(code, hostId) {
  /** @type {Room} */
  return {
    code,
    hostId,
    players: new Map(),
    phase: "lobby",
    roundType: "normal",
    drawPhase: "drawing",
    drawerId: null,
    drawerIds: [],
    word: null,
    drawerStreak: null,
    relayIndex: 0,
    turnDurations: [],
    turnEndsAt: null,
    turnTimer: null,
    seenWordIds: new Set(),
    roundsSinceSpecial: 0,
    lastWasSpecial: false,
    gallery: [],
  };
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    try {
      const trimmed = String(name || "").trim().slice(0, 12);
      if (!trimmed) return cb?.({ ok: false, error: "名前を入力してください" });

      const code = generateCode();
      const playerId = randomUUID();
      const room = createEmptyRoom(code, playerId);
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
      emitGallery(room, socket.id);
    } catch (e) {
      cb?.({ ok: false, error: e.message || "部屋を作成できませんでした" });
    }
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const trimmed = String(name || "").trim().slice(0, 12);
    const roomCode = normalizeRoomCode(code);
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
    emitGallery(room, socket.id);

    if (room.phase === "playing") {
      syncPlayerState(socket, room, playerId);
      emitLobby(room);
    } else {
      emitLobby(room);
    }
  });

  socket.on("rejoinRoom", ({ code, playerId, name }, cb) => {
    const roomCode = normalizeRoomCode(code);
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
    room.roundsSinceSpecial = 0;
    room.lastWasSpecial = false;
    startRound(room);
    cb?.({ ok: true });
  });

  socket.on("stroke", (data) => {
    const ctx = getContext(socket);
    if (!ctx) return;
    const { code, room, playerId } = ctx;
    if (!canPlayerDraw(room, playerId)) return;
    socket.to(code).emit("stroke", {
      ...data,
      playerId,
    });
  });

  socket.on("endDrawing", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (!canEndDrawing(room, playerId)) {
      return cb?.({ ok: false, error: "描き終わりにできません" });
    }
    enterGuessing(room);
    cb?.({ ok: true });
  });

  socket.on("nextRound", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const imageDataUrl = data?.imageDataUrl;
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.phase !== "playing") {
      return cb?.({ ok: false, error: "プレイ中ではありません" });
    }
    if (!canPlayerNextRound(room, playerId)) {
      return cb?.({ ok: false, error: "つぎへ進めません" });
    }

    const drawerNames = playerNames(room, room.drawerIds);
    const word = room.word;
    const roundType = room.roundType;

    if (imageDataUrl) {
      addGalleryItem(room, {
        imageDataUrl,
        word,
        drawerNames,
        roundType,
      });
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
    clearTurnTimer(room);
    room.phase = "lobby";
    resetRoundFields(room);
    room.drawerStreak = null;
    io.to(code).emit("clearCanvas");
    io.to(code).emit("gameEnded");
    emitLobby(room);
    // gallery is kept for room lifetime
    cb?.({ ok: true });
  });

  socket.on("deleteGalleryItems", ({ ids }, cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room } = ctx;
    const idSet = new Set(
      Array.isArray(ids) ? ids.map((id) => String(id)) : []
    );
    if (idSet.size === 0) {
      return cb?.({ ok: false, error: "削除する絵がありません" });
    }
    room.gallery = room.gallery.filter((g) => !idSet.has(g.id));
    emitGallery(room);
    cb?.({ ok: true });
  });

  socket.on("clearGallery", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return cb?.({ ok: false, error: "部屋がありません" });
    const { room } = ctx;
    room.gallery = [];
    emitGallery(room);
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

    // リレー中の今の描き手が切れたらすぐ次へ
    if (
      room.phase === "playing" &&
      room.roundType === "relay" &&
      room.drawPhase === "drawing" &&
      room.drawerId === playerId
    ) {
      advanceRelay(room);
    }
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
