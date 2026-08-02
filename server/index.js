import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import cors from "cors";
import express from "express";
import { existsSync } from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import {
  aiErrorLogDetails,
  createAwards,
  createCrazyPromptPack,
  createSecretGuess,
  isAiConfigured,
  parseImageDataUrl,
  publicAiCapabilities,
} from "./ai.js";
import {
  selectCommunityAwardCategories,
  tallyCommunityAwards,
} from "./community-awards.js";
import { findConstraint, randomConstraint } from "./constraints.js";
import { hasVisibleDrawing } from "./drawing.js";
import {
  createGradualRevealPlan,
  gradualRevealDuration,
  isGradualRevealComplete,
} from "./gradual-reveal.js";
import {
  createCeremonyPlayback,
  isCeremonyPlaybackAvailable,
  isCeremonyPlaybackInProgress,
  normalizeCeremonyPlayback,
} from "../shared/ceremony-playback.js";
import {
  buildSecretGuessCandidates,
  buildSecretGuessReveal,
  secretGuessFallbackKind,
} from "./secret-guess.js";
import {
  selectCrazyPromptMainAnswers,
  shouldEnableAiCrazyPrompt,
  takeNextCrazyPrompt,
} from "./ai-crazy-prompt.js";
import { WORDS, randomWord } from "./words.js";

const PORT = process.env.PORT || 3001;
const MAX_ROOMS = 100;
const MAX_PLAYERS = 20;
const DISCONNECT_GRACE_MS = 45_000;
/** 通常ラウンドの描き手が切断したときは短めに見切る（全員が待たされるため） */
const DRAWER_DISCONNECT_GRACE_MS = 12_000;
const MAX_CONSECUTIVE_DRAWS = 2;
const RELAY_MIN_PLAYERS = 3;
const COOP_MIN_PLAYERS = 3;
const RELAY_MIN_DRAWERS = 2;
const COOP_MIN_DRAWERS = 2;
const RELAY_MAX_DRAWERS = 5;
const COOP_MAX_DRAWERS = 5;
const COOP_DURATION_MS = 40_000;
const LIAR_MIN_PLAYERS = 4;
const LIAR_MAX_DRAWERS = 3;
const LIAR_DURATION_MS = 40_000;
const GRADUAL_MIN_PLAYERS = 2;
/**
 * 見ている側は幕がかかったまま待つだけなので、協力・うそつきの40秒より短くする。
 * 描き手を急かす声も飛ばないぶん、上限がないと丁寧に描きこんでしまう。
 */
const GRADUAL_DURATION_MS = 20_000;
const GALLERY_MAX = 60;
const EVENT_MIN_GAP = 3;
const EVENT_FORCE_GAP = 6;
const EVENT_CHANCE = 0.3;
/** しばりはふつうのラウンドだけ。たまに出るくらいの間隔にする */
const CONSTRAINT_MIN_GAP = 4;
const CONSTRAINT_FORCE_GAP = 9;
const CONSTRAINT_CHANCE = 0.25;
const RECENT_CONSTRAINTS_MAX = 4;
/**
 * 「わからない」ときのお題パス。ふつうのラウンド（しばりなし）だけ。
 * 描き手は変えずにお題だけ引き直すので、連打されると進まなくなる。
 * 1ターンにこの回数まで＝お題は最大3つ見られて、3つ目は必ず描く。
 */
const PASS_MAX_PER_TURN = 2;
/** リプレイの連打よけ */
const REPLAY_COOLDOWN_MS = 2_000;
/** 今日のハイライトの連打よけ（最初の1枚が出るまで少し余裕を取る） */
const HIGHLIGHT_COOLDOWN_MS = 3_000;
const EXTENSION_ROUNDS = 3;
const COMMUNITY_AWARDS_VOTING_MS = 45_000;
const AI_SECRET_GUESS_CAPTURE_DELAY_MS = 7_000;
const AI_SECRET_GUESS_MIN_GAP = 4;
const AI_SECRET_GUESS_FORCE_GAP = 8;
const AI_SECRET_GUESS_CHANCE = 0.25;
const MAX_AI_SECRET_GUESS_DATA_URL_LEN = 400_000;
const AI_SECRET_GUESS_ENABLED =
  String(process.env.AI_SECRET_GUESS_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";
const FORCE_AI_SECRET_GUESS = process.env.FORCE_AI_SECRET_GUESS === "1";
const aiSecretGuessMaxText = String(
  process.env.AI_SECRET_GUESS_MAX_PER_GAME ?? "",
).trim();
const parsedAiSecretGuessMax = aiSecretGuessMaxText
  ? Number(aiSecretGuessMaxText)
  : 2;
const AI_SECRET_GUESS_MAX_PER_GAME = Math.min(
  5,
  Math.max(
    0,
    Number.isFinite(parsedAiSecretGuessMax)
      ? Math.trunc(parsedAiSecretGuessMax)
      : 2,
  ),
);
const AI_CRAZY_PROMPT_MIN_GAP = 4;
const AI_CRAZY_PROMPT_FORCE_GAP = 8;
const AI_CRAZY_PROMPT_CHANCE = 0.25;
const AI_CRAZY_PROMPT_MAX_PER_GAME = 2;
const AI_CRAZY_PROMPT_PACK_SIZE = 8;
const FORCE_AI_CRAZY_PROMPT = process.env.FORCE_AI_CRAZY_PROMPT === "1";
const MAX_GALLERY_DATA_URL_LEN = 400_000;
const MAX_TOTAL_GALLERY_DATA_URL_LEN = 80_000_000;
const MAX_STROKES = 20_000;
const RECENT_WORDS_MAX = 20;
const AI_RATE_WINDOW_MS = 60 * 60 * 1000;
const AI_RATE_LIMITS = {
  room: Math.max(1, Number(process.env.ROOM_CREATE_RATE_LIMIT) || 10),
  awards: Math.max(1, Number(process.env.AI_AWARDS_RATE_LIMIT) || 12),
  secretGuess: Math.max(
    1,
    Number(process.env.AI_SECRET_GUESS_RATE_LIMIT) || 30,
  ),
  crazyPromptPack: Math.max(
    1,
    Number(process.env.AI_CRAZY_PROMPT_RATE_LIMIT) || 12,
  ),
};
const AI_GLOBAL_RATE_LIMITS = {
  room: Math.max(
    1,
    Number(process.env.GLOBAL_ROOM_CREATE_RATE_LIMIT) || 200,
  ),
  awards: Math.max(
    1,
    Number(process.env.AI_GLOBAL_AWARDS_RATE_LIMIT) || 40,
  ),
  secretGuess: Math.max(
    1,
    Number(process.env.AI_GLOBAL_SECRET_GUESS_RATE_LIMIT) || 120,
  ),
  crazyPromptPack: Math.max(
    1,
    Number(process.env.AI_GLOBAL_CRAZY_PROMPT_RATE_LIMIT) || 50,
  ),
};
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "../client/dist");

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "").trim()).origin;
  } catch {
    return "";
  }
}

const allowedOrigins = new Set(
  [
    process.env.APP_ORIGIN,
    process.env.RENDER_EXTERNAL_URL,
    ...String(process.env.ALLOWED_ORIGINS || "").split(","),
  ]
    .map(normalizeOrigin)
    .filter(Boolean),
);

function isOriginAllowed(origin) {
  if (!origin || process.env.NODE_ENV !== "production") {
    return true;
  }
  return allowedOrigins.has(normalizeOrigin(origin));
}

function allowCorsOrigin(origin, callback) {
  callback(null, isOriginAllowed(origin));
}

const app = express();
app.use(cors({ origin: allowCorsOrigin }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: allowCorsOrigin, methods: ["GET", "POST"] },
  allowRequest: (req, callback) => {
    callback(null, isOriginAllowed(req.headers.origin));
  },
  maxHttpBufferSize: 1e6,
});

/**
 * @typedef {{
 *  id: string,
 *  name: string,
 *  isHost: boolean,
 *  resumeToken: string,
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
 *  roundType: 'normal' | 'relay' | 'coop' | 'liar' | 'gradual',
 *  constraintLabel: string,
 *  createdAt: number,
 *  gameSeq: number,
 *  hasDrawing: boolean,
 *  aiCrazyPromptMainAnswer: string,
 *  aiCrazyPromptFullPrompt: string,
 * }} GalleryItem
 */
/**
 * @typedef {{
 *  code: string,
 *  hostId: string,
 *  players: Map<string, Player>,
 *  phase: 'lobby' | 'playing' | 'finished',
 *  roundType: 'normal' | 'relay' | 'coop' | 'liar' | 'gradual',
 *  drawPhase: 'drawing' | 'guessing' | 'reveal',
 *  drawerId: string | null,
 *  drawerIds: string[],
 *  word: string | null,
 *  liarId: string | null,
 *  liarName: string,
 *  drawerStreak: { id: string, count: number } | null,
 *  relayIndex: number,
 *  turnDurations: number[],
 *  turnEndsAt: number | null,
 *  turnTimer: ReturnType<typeof setTimeout> | null,
 *  gradualReveal: null | {
 *    pattern: string,
 *    stepMs: number,
 *    steps: number,
 *    startedAt: number | null,
 *  },
 *  seenWordIds: Set<string>,
 *  roundsSinceSpecial: number,
 *  lastWasSpecial: boolean,
 *  constraint: import('./constraints.js').Constraint | null,
 *  passesUsed: number,
 *  strokeCounts: Map<string, number>,
 *  blockedDrawers: Set<string>,
 *  roundsSinceConstraint: number,
 *  recentConstraints: string[],
 *  lastReplayAt: number,
 *  lastHighlightAt: number,
 *  gallery: GalleryItem[],
 *  strokes: object[],
 *  recentWords: string[],
 *  roundSeq: number,
 *  totalRounds: number,
 *  completedRounds: number,
 *  drawCounts: Map<string, number>,
 *  lastCompletedRoundSeq: number | null,
 *  gameSeq: number,
 *  aiAwardsStatus: 'idle' | 'generating' | 'ready' | 'error',
 *  aiAwards: null | {
 *    intro: string,
 *    awards: { galleryItemId: string, title: string, reason: string }[],
 *  },
 *  aiAwardsError: string,
 *  aiAwardsAttempts: number,
 *  aiAwardsToken: number,
 *  communityAwardsStatus: 'idle' | 'voting' | 'ready',
 *  communityAwardCategories: {
 *    id: string,
 *    title: string,
 *    prompt: string,
 *    emoji: string,
 *    candidateIds: string[],
 *  }[],
 *  communityAwardVotes: Map<string, Map<string, string>>,
 *  communityAwardEligibleIds: Set<string>,
 *  communityAwardsClosesAt: number | null,
 *  communityAwardsTimer: ReturnType<typeof setTimeout> | null,
 *  communityAwardsResults: null | { awards: object[] },
 *  communityAwardsToken: number,
 *  ceremonyPlaybackSeq: number,
 *  ceremonyPlayback: null | {
 *    kind: 'ai' | 'community',
 *    gameSeq: number,
 *    awardCount: number,
 *    runId: number,
 *    startedAt: number,
 *    expiresAt: number,
 *  },
 *  aiSecretGuessStatus: 'idle' | 'armed' | 'countdown' | 'requested' | 'generating' | 'ready' | 'revealed' | 'skipped' | 'error',
 *  aiSecretGuessGameSeq: number | null,
 *  aiSecretGuessRoundSeq: number | null,
 *  aiSecretGuessDrawerId: string | null,
 *  aiSecretGuessToken: string,
 *  aiSecretGuessTimer: ReturnType<typeof setTimeout> | null,
 *  aiSecretGuessCaptureAt: number | null,
 *  aiSecretGuessResult: object | null,
 *  aiSecretGuessReveal: object | null,
 *  aiSecretGuessImageAccepted: boolean,
 *  aiSecretGuessApiAttempted: boolean,
 *  aiSecretGuessAnswerRevealed: boolean,
 *  aiSecretGuessCount: number,
 *  aiSecretGuessLastRoundNumber: number | null,
 *  aiCrazyPromptPackStatus: 'idle' | 'generating' | 'ready' | 'failed',
 *  aiCrazyPromptPack: { id: string, mainAnswer: string, fullPrompt: string, used: boolean }[],
 *  aiCrazyPromptEnabled: boolean,
 *  currentAiCrazyPrompt: { id: string, mainAnswer: string, fullPrompt: string } | null,
 *  aiCrazyPromptSelectedThisRound: boolean,
 *  roundsSinceAiCrazyPrompt: number,
 *  aiCrazyPromptUsedCount: number,
 *  aiCrazyPromptLastRoundNumber: number | null,
 *  aiCrazyPromptToken: number,
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** socketId -> roomCode */
const socketRoom = new Map();
/** socketId -> playerId */
const socketPlayer = new Map();
/** client address + AI action -> { startedAt, count } */
const aiRateWindows = new Map();

function generateCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error("部屋コードを発行できませんでした");
}

/** 全角数字なども半角4桁に正規化 */
function normalizeRoomCode(code) {
  return safeString(code)
    .normalize("NFKC")
    .replace(/\D/g, "")
    .slice(0, 4);
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function safeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function createResumeToken() {
  return randomBytes(32).toString("base64url");
}

function resumeTokenMatches(player, candidate) {
  const token = safeString(candidate);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const expectedHash = createHash("sha256")
    .update(player.resumeToken)
    .digest();
  const candidateHash = createHash("sha256").update(token).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
  }));
}

function totalGalleryDataUrlLength() {
  let total = 0;
  for (const room of rooms.values()) {
    for (const item of room.gallery) {
      total += item.imageDataUrl?.length || 0;
    }
  }
  return total;
}

function hasGalleryStorageFor(room, imageDataUrl) {
  const evictedLength =
    room.gallery.length >= GALLERY_MAX
      ? room.gallery[0]?.imageDataUrl?.length || 0
      : 0;
  return (
    totalGalleryDataUrlLength() +
      imageDataUrl.length -
      evictedLength <=
    MAX_TOTAL_GALLERY_DATA_URL_LEN
  );
}

function aiClientAddress(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const forwardedText = Array.isArray(forwarded)
    ? forwarded.join(",")
    : String(forwarded || "");
  const lastForwarded = forwardedText.split(",").at(-1);
  return String(lastForwarded || socket.handshake.address || "unknown")
    .trim()
    .slice(0, 96);
}

function aiSafetyIdentifier(playerId) {
  return createHash("sha256")
    .update(String(playerId || "unknown-player"))
    .digest("hex");
}

function consumeAiQuota(socket, kind) {
  const now = Date.now();
  const clientKey = `${kind}:${aiClientAddress(socket)}`;
  const globalKey = `global:${kind}`;
  const clientEntry = aiRateWindows.get(clientKey);
  const globalEntry = aiRateWindows.get(globalKey);
  const limit = AI_RATE_LIMITS[kind];
  const globalLimit = AI_GLOBAL_RATE_LIMITS[kind];
  if (!limit || !globalLimit) return false;

  if (!clientEntry && aiRateWindows.size >= 5_000) {
    for (const [entryKey, entry] of aiRateWindows) {
      if (now - entry.startedAt >= AI_RATE_WINDOW_MS) {
        aiRateWindows.delete(entryKey);
      }
    }
    if (aiRateWindows.size >= 5_000) return false;
  }

  const clientCount =
    clientEntry && now - clientEntry.startedAt < AI_RATE_WINDOW_MS
      ? clientEntry.count
      : 0;
  const globalCount =
    globalEntry && now - globalEntry.startedAt < AI_RATE_WINDOW_MS
      ? globalEntry.count
      : 0;
  if (clientCount >= limit || globalCount >= globalLimit) return false;

  aiRateWindows.set(clientKey, {
    startedAt: clientCount === 0 ? now : clientEntry.startedAt,
    count: clientCount + 1,
  });
  aiRateWindows.set(globalKey, {
    startedAt: globalCount === 0 ? now : globalEntry.startedAt,
    count: globalCount + 1,
  });
  return true;
}

function activePlayers(room) {
  return [...room.players.values()].filter((player) => player.socketId);
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
    completedRounds: room.completedRounds,
    totalRounds: room.totalRounds,
    extensionRounds: EXTENSION_ROUNDS,
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

function currentGameGallery(room) {
  return room.gallery.filter((item) => item.gameSeq === room.gameSeq);
}

/**
 * 今のゲームで、実際に線が引かれた絵。
 * 授賞式の候補にも、今日のハイライトにも、この同じ集合を使う（白紙は出さない）。
 */
function drawnThisGame(room) {
  return currentGameGallery(room).filter((item) => item.hasDrawing);
}

function buildAiState(room) {
  return {
    ...publicAiCapabilities(),
    gameSeq: room.gameSeq,
    currentGalleryCount: currentGameGallery(room).length,
    awardCandidateCount: drawnThisGame(room).length,
    awardsStatus: room.aiAwardsStatus,
    awards: room.aiAwards,
    awardsError: room.aiAwardsError,
    canRetryAwards: room.aiAwardsAttempts < 2,
  };
}

function emitAiState(room, targetSocketId = null) {
  const payload = buildAiState(room);
  if (targetSocketId) {
    io.to(targetSocketId).emit("aiStateUpdate", payload);
    return;
  }
  io.to(room.code).emit("aiStateUpdate", payload);
}

function buildCommunityAwardsState(room, playerId = null) {
  const hasVoted = Boolean(
    playerId && room.communityAwardVotes.has(playerId),
  );
  const canVote = Boolean(
    playerId &&
      room.communityAwardsStatus === "voting" &&
      room.communityAwardEligibleIds.has(playerId),
  );
  return {
    gameSeq: room.gameSeq,
    candidateCount: drawnThisGame(room).length,
    status: room.communityAwardsStatus,
    categories: room.communityAwardCategories,
    votedCount: room.communityAwardVotes.size,
    eligibleCount: room.communityAwardEligibleIds.size,
    closesAt: room.communityAwardsClosesAt,
    hasVoted,
    canVote,
    results: room.communityAwardsResults,
  };
}

/** hasVoted/canVote は個人情報なので、同じpayloadを部屋全体へ流さない。 */
function emitCommunityAwardsState(
  room,
  targetSocketId = null,
  targetPlayerId = null,
) {
  if (targetSocketId) {
    io.to(targetSocketId).emit(
      "communityAwardsStateUpdate",
      buildCommunityAwardsState(room, targetPlayerId),
    );
    return;
  }
  for (const player of room.players.values()) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit(
      "communityAwardsStateUpdate",
      buildCommunityAwardsState(room, player.id),
    );
  }
}

function ceremonyAwardCount(room, kind) {
  if (kind === "ai") {
    return room.aiAwardsStatus === "ready" &&
      Array.isArray(room.aiAwards?.awards)
      ? room.aiAwards.awards.length
      : 0;
  }
  if (kind === "community") {
    return room.communityAwardsStatus === "ready" &&
      Array.isArray(room.communityAwardsResults?.awards)
      ? room.communityAwardsResults.awards.length
      : 0;
  }
  return 0;
}

function buildCeremonyPlaybackState(room, now = Date.now()) {
  const playback = normalizeCeremonyPlayback(room.ceremonyPlayback);
  if (
    !playback ||
    room.phase !== "finished" ||
    room.communityAwardsStatus === "voting" ||
    playback.gameSeq !== room.gameSeq ||
    playback.awardCount !== ceremonyAwardCount(room, playback.kind) ||
    !isCeremonyPlaybackAvailable(playback, now)
  ) {
    return null;
  }
  return playback;
}

function emitCeremonyPlaybackState(room, targetSocketId = null) {
  const payload = {
    playback: buildCeremonyPlaybackState(room),
    serverNow: Date.now(),
  };
  if (targetSocketId) {
    io.to(targetSocketId).emit("ceremonyPlaybackUpdate", payload);
    return;
  }
  io.to(room.code).emit("ceremonyPlaybackUpdate", payload);
}

function clearCeremonyPlayback(room, { emit = true } = {}) {
  if (!room.ceremonyPlayback) return false;
  room.ceremonyPlayback = null;
  if (emit) emitCeremonyPlaybackState(room);
  return true;
}

function startCeremonyPlayback(room, kind) {
  const awardCount = ceremonyAwardCount(room, kind);
  if (room.phase !== "finished" || awardCount < 1) return null;
  room.ceremonyPlaybackSeq += 1;
  const playback = createCeremonyPlayback({
    kind,
    gameSeq: room.gameSeq,
    awardCount,
    runId: room.ceremonyPlaybackSeq,
  });
  if (!playback) return null;
  room.ceremonyPlayback = playback;
  emitCeremonyPlaybackState(room);
  return playback;
}

function clearCommunityAwardsTimer(room) {
  if (room.communityAwardsTimer) {
    clearTimeout(room.communityAwardsTimer);
    room.communityAwardsTimer = null;
  }
}

function resetCommunityAwards(room) {
  clearCommunityAwardsTimer(room);
  room.communityAwardsToken += 1;
  room.communityAwardsStatus = "idle";
  room.communityAwardCategories = [];
  room.communityAwardVotes = new Map();
  room.communityAwardEligibleIds = new Set();
  room.communityAwardsClosesAt = null;
  room.communityAwardsResults = null;
}

function finalizeCommunityAwards(room, reason) {
  if (room.communityAwardsStatus !== "voting") return false;
  clearCommunityAwardsTimer(room);
  room.communityAwardsStatus = "ready";
  room.communityAwardsClosesAt = null;
  room.communityAwardsResults = {
    ...tallyCommunityAwards(
      room.communityAwardCategories,
      room.communityAwardVotes,
      { eligibleCount: room.communityAwardEligibleIds.size },
    ),
    finalizedAt: Date.now(),
    reason,
  };
  emitCommunityAwardsState(room);
  io.to(room.code).emit("communityAwardsReady", { gameSeq: room.gameSeq });
  startCeremonyPlayback(room, "community");
  return true;
}

function scheduleCommunityAwardsDeadline(room) {
  clearCommunityAwardsTimer(room);
  const token = room.communityAwardsToken;
  const gameSeq = room.gameSeq;
  room.communityAwardsClosesAt = Date.now() + COMMUNITY_AWARDS_VOTING_MS;
  room.communityAwardsTimer = setTimeout(() => {
    room.communityAwardsTimer = null;
    const current = rooms.get(room.code);
    if (
      current !== room ||
      current.gameSeq !== gameSeq ||
      current.communityAwardsToken !== token ||
      current.communityAwardsStatus !== "voting"
    ) {
      return;
    }
    if (current.communityAwardVotes.size === 0) {
      resetCommunityAwards(current);
      emitCommunityAwardsState(current);
      io.to(current.code).emit("communityAwardsNoVotes", {
        gameSeq: current.gameSeq,
      });
      return;
    }
    finalizeCommunityAwards(current, "timeout");
  }, COMMUNITY_AWARDS_VOTING_MS);
}

function allCommunityAwardVotesSubmitted(room) {
  return (
    room.communityAwardEligibleIds.size > 0 &&
    room.communityAwardVotes.size >= room.communityAwardEligibleIds.size
  );
}

function parseCommunityAwardBallot(room, data) {
  const submitted = Array.isArray(data?.votes) ? data.votes : null;
  if (!submitted || submitted.length !== room.communityAwardCategories.length) {
    return { error: "3つの賞すべてに投票してください" };
  }

  const categoryById = new Map(
    room.communityAwardCategories.map((category) => [category.id, category]),
  );
  const ballot = new Map();
  for (const vote of submitted) {
    const categoryId = safeString(vote?.categoryId).trim();
    const galleryItemId = safeString(vote?.galleryItemId).trim();
    const category = categoryById.get(categoryId);
    if (
      !category ||
      ballot.has(categoryId) ||
      !category.candidateIds.includes(galleryItemId)
    ) {
      return { error: "投票内容を確認してください" };
    }
    ballot.set(categoryId, galleryItemId);
  }

  if (ballot.size !== categoryById.size) {
    return { error: "3つの賞すべてに投票してください" };
  }
  return { ballot };
}

function resetAiForNewGame(room) {
  clearCeremonyPlayback(room, { emit: false });
  room.aiAwardsToken += 1;
  room.aiAwardsStatus = "idle";
  room.aiAwards = null;
  room.aiAwardsError = "";
  room.aiAwardsAttempts = 0;
}

function resetAwardsForExtension(room) {
  clearCeremonyPlayback(room, { emit: false });
  room.aiAwardsToken += 1;
  room.aiAwardsStatus = "idle";
  room.aiAwards = null;
  room.aiAwardsError = "";
  room.aiAwardsAttempts = 0;
}

function resetAiWhenReturningToLobby(room) {
  clearCeremonyPlayback(room, { emit: false });
  room.aiAwardsToken += 1;
  room.aiAwardsStatus = "idle";
  room.aiAwards = null;
  room.aiAwardsError = "";
}

function friendlyAiError(error, fallback) {
  const code = String(error?.code || "");
  if (code === "moderation_blocked") {
    return "この絵はAIで処理できませんでした";
  }
  if (error?.status === 401 || error?.status === 403) {
    return "AIの設定を確認してください";
  }
  if (error?.status === 429) {
    if (
      code === "insufficient_quota" ||
      code === "billing_hard_limit_reached"
    ) {
      return "AIの利用上限に達しました";
    }
    return "AI画伯が混み合っています。少し待って試してください";
  }
  if (
    error?.name === "TimeoutError" ||
    String(error?.message || "").includes("timed out")
  ) {
    return "AI画伯の返事に時間がかかりました";
  }
  if (
    String(error?.message || "").includes("moderation") ||
    String(error?.message || "").includes("refused")
  ) {
    return "この絵はAIで処理できませんでした";
  }
  return fallback;
}

function logAiFailure(kind, error) {
  console.error(`[ai] ${kind} failed`, aiErrorLogDetails(error));
}

function resetAiCrazyPromptForNewGame(room) {
  room.aiCrazyPromptToken += 1;
  room.aiCrazyPromptPackStatus = "idle";
  room.aiCrazyPromptPack = [];
  room.currentAiCrazyPrompt = null;
  room.aiCrazyPromptSelectedThisRound = false;
  room.roundsSinceAiCrazyPrompt = 0;
  room.aiCrazyPromptUsedCount = 0;
  room.aiCrazyPromptLastRoundNumber = null;
  room.aiCrazyPromptEnabled = isAiConfigured();
}

function startAiCrazyPromptPackGeneration(room, playerId) {
  if (
    !room.aiCrazyPromptEnabled ||
    !isAiConfigured() ||
    room.aiCrazyPromptPackStatus !== "idle"
  ) {
    return;
  }
  const socket = room.players.get(playerId)?.socketId
    ? io.sockets.sockets.get(room.players.get(playerId).socketId)
    : null;
  if (!socket || !consumeAiQuota(socket, "crazyPromptPack")) {
    room.aiCrazyPromptPackStatus = "failed";
    return;
  }

  const gameSeq = room.gameSeq;
  const token = room.aiCrazyPromptToken + 1;
  room.aiCrazyPromptToken = token;
  room.aiCrazyPromptPackStatus = "generating";
  const candidates = selectCrazyPromptMainAnswers(
    WORDS,
    AI_CRAZY_PROMPT_PACK_SIZE,
  );
  if (candidates.length < AI_CRAZY_PROMPT_PACK_SIZE) {
    room.aiCrazyPromptPackStatus = "failed";
    return;
  }
  const isCurrent = () => {
    const current = rooms.get(room.code);
    return (
      current === room &&
      current.gameSeq === gameSeq &&
      current.aiCrazyPromptToken === token &&
      current.aiCrazyPromptPackStatus === "generating"
    );
  };
  void createCrazyPromptPack(candidates, {
    safetyIdentifier: aiSafetyIdentifier(playerId),
    isCurrent,
  })
    .then((result) => {
      if (!isCurrent()) return;
      room.aiCrazyPromptPack = result.prompts.map((prompt, index) => ({
        id: `crazy-${gameSeq}-${index}-${randomUUID().slice(0, 8)}`,
        mainAnswer: prompt.mainAnswer,
        fullPrompt: prompt.fullPrompt,
        used: false,
      }));
      room.aiCrazyPromptPackStatus = "ready";
    })
    .catch((error) => {
      if (!isCurrent()) return;
      room.aiCrazyPromptPackStatus = "failed";
      room.aiCrazyPromptPack = [];
      logAiFailure("crazy prompt pack", error);
    });
}

function maybeApplyAiCrazyPrompt(room) {
  const enabled = shouldEnableAiCrazyPrompt({
    enabled: room.aiCrazyPromptEnabled,
    configured: isAiConfigured(),
    packStatus: room.aiCrazyPromptPackStatus,
    roundType: room.roundType,
    constraint: room.constraint,
    completedRounds: room.completedRounds,
    roundsSinceAiCrazyPrompt: room.roundsSinceAiCrazyPrompt,
    hasPreviousPrompt: room.aiCrazyPromptLastRoundNumber !== null,
    usedCount: room.aiCrazyPromptUsedCount,
    maxPerGame: AI_CRAZY_PROMPT_MAX_PER_GAME,
    minGap: AI_CRAZY_PROMPT_MIN_GAP,
    forceGap: AI_CRAZY_PROMPT_FORCE_GAP,
    chance: AI_CRAZY_PROMPT_CHANCE,
    force: FORCE_AI_CRAZY_PROMPT,
  });
  if (!enabled) return false;
  const next = takeNextCrazyPrompt(room);
  if (!next) return false;
  room.currentAiCrazyPrompt = next;
  room.aiCrazyPromptSelectedThisRound = true;
  room.word = next.mainAnswer;
  room.aiCrazyPromptUsedCount += 1;
  room.roundsSinceAiCrazyPrompt = 0;
  room.aiCrazyPromptLastRoundNumber = room.roundSeq;
  return true;
}

function clearAiSecretGuessTimer(room) {
  if (room.aiSecretGuessTimer) {
    clearTimeout(room.aiSecretGuessTimer);
    room.aiSecretGuessTimer = null;
  }
  room.aiSecretGuessCaptureAt = null;
}

/** ラウンド固有のタイマー・結果・非同期処理をすべて無効化する。 */
function resetAiSecretGuessRound(room) {
  clearAiSecretGuessTimer(room);
  room.aiSecretGuessToken = randomUUID();
  room.aiSecretGuessStatus = "idle";
  room.aiSecretGuessGameSeq = null;
  room.aiSecretGuessRoundSeq = null;
  room.aiSecretGuessDrawerId = null;
  room.aiSecretGuessResult = null;
  room.aiSecretGuessReveal = null;
  room.aiSecretGuessImageAccepted = false;
  room.aiSecretGuessApiAttempted = false;
  room.aiSecretGuessAnswerRevealed = false;
}

/** 発生回数と間隔は、新しいゲームを始めるときだけリセットする。 */
function resetAiSecretGuessForNewGame(room) {
  resetAiSecretGuessRound(room);
  room.aiSecretGuessCount = 0;
  room.aiSecretGuessLastRoundNumber = null;
}

function isCurrentAiSecretGuessRound(room) {
  return (
    room.aiSecretGuessStatus !== "idle" &&
    room.aiSecretGuessGameSeq === room.gameSeq &&
    room.aiSecretGuessRoundSeq === room.roundSeq
  );
}

function buildAiSecretGuessPublicState(room) {
  const active = isCurrentAiSecretGuessRound(room);
  return {
    aiSecretGuessActive: active,
    aiSecretGuessPending:
      active &&
      room.aiSecretGuessAnswerRevealed &&
      room.aiSecretGuessStatus === "generating",
    aiSecretGuessReveal:
      active && room.aiSecretGuessStatus === "revealed"
        ? room.aiSecretGuessReveal
        : null,
  };
}

function shouldArmAiSecretGuess(room) {
  if (
    !isAiConfigured() ||
    !AI_SECRET_GUESS_ENABLED ||
    room.roundType !== "normal" ||
    room.constraint ||
    room.currentAiCrazyPrompt
  ) {
    return false;
  }
  if (FORCE_AI_SECRET_GUESS) return true;
  if (room.aiSecretGuessCount >= AI_SECRET_GUESS_MAX_PER_GAME) return false;
  if (room.completedRounds < 2) return false;

  // 初回は2問完了後から抽選し、8問完了時には未登場でも必ず出す。
  if (room.aiSecretGuessLastRoundNumber === null) {
    return (
      room.completedRounds >= AI_SECRET_GUESS_FORCE_GAP ||
      Math.random() < AI_SECRET_GUESS_CHANCE
    );
  }

  // 対象ラウンド自体は「空いた問題」に含めない。
  const gap =
    room.completedRounds - room.aiSecretGuessLastRoundNumber;
  if (gap < AI_SECRET_GUESS_MIN_GAP) return false;
  return (
    gap >= AI_SECRET_GUESS_FORCE_GAP ||
    Math.random() < AI_SECRET_GUESS_CHANCE
  );
}

function armAiSecretGuessForRound(room) {
  if (!shouldArmAiSecretGuess(room)) return false;
  clearAiSecretGuessTimer(room);
  room.aiSecretGuessStatus = "armed";
  room.aiSecretGuessGameSeq = room.gameSeq;
  room.aiSecretGuessRoundSeq = room.roundSeq;
  room.aiSecretGuessDrawerId = room.drawerId;
  room.aiSecretGuessToken = randomUUID();
  room.aiSecretGuessResult = null;
  room.aiSecretGuessReveal = null;
  room.aiSecretGuessImageAccepted = false;
  room.aiSecretGuessApiAttempted = false;
  room.aiSecretGuessAnswerRevealed = false;
  room.aiSecretGuessCount += 1;
  room.aiSecretGuessLastRoundNumber = room.completedRounds + 1;
  return true;
}

function requestAiSecretGuessCapture(room) {
  const player = room.players.get(room.aiSecretGuessDrawerId);
  if (!player?.socketId) return;
  io.to(player.socketId).emit("aiSecretGuessCaptureRequest", {
    roundId: room.roundSeq,
    token: room.aiSecretGuessToken,
  });
}

function scheduleAiSecretGuessCapture(room) {
  if (
    room.aiSecretGuessStatus !== "armed" ||
    !isCurrentAiSecretGuessRound(room) ||
    !hasVisibleDrawing(room.strokes)
  ) {
    return;
  }

  const expectedGameSeq = room.gameSeq;
  const expectedRoundSeq = room.roundSeq;
  const expectedToken = room.aiSecretGuessToken;
  const expectedDrawerId = room.drawerId;
  room.aiSecretGuessStatus = "countdown";
  room.aiSecretGuessCaptureAt =
    Date.now() + AI_SECRET_GUESS_CAPTURE_DELAY_MS;
  room.aiSecretGuessTimer = setTimeout(() => {
    room.aiSecretGuessTimer = null;
    room.aiSecretGuessCaptureAt = null;
    const current = rooms.get(room.code);
    if (
      current !== room ||
      current.phase !== "playing" ||
      current.drawPhase !== "drawing" ||
      current.roundType !== "normal" ||
      current.constraint ||
      current.gameSeq !== expectedGameSeq ||
      current.roundSeq !== expectedRoundSeq ||
      current.aiSecretGuessToken !== expectedToken ||
      current.aiSecretGuessStatus !== "countdown" ||
      current.drawerId !== expectedDrawerId ||
      !hasVisibleDrawing(current.strokes)
    ) {
      return;
    }
    current.aiSecretGuessStatus = "requested";
    requestAiSecretGuessCapture(current);
  }, AI_SECRET_GUESS_CAPTURE_DELAY_MS);
}

function rearmAiSecretGuessAfterPass(room, previousStatus) {
  if (!isCurrentAiSecretGuessRound(room)) return;
  clearAiSecretGuessTimer(room);
  room.aiSecretGuessToken = randomUUID();
  room.aiSecretGuessResult = null;
  room.aiSecretGuessReveal = null;
  room.aiSecretGuessImageAccepted = false;
  room.aiSecretGuessAnswerRevealed = false;
  room.aiSecretGuessDrawerId = room.drawerId;

  if (
    !room.aiSecretGuessApiAttempted &&
    (previousStatus === "armed" ||
      previousStatus === "countdown" ||
      previousStatus === "requested")
  ) {
    room.aiSecretGuessStatus = "armed";
    return;
  }

  // すでにAPIを消費していたら、パス後のお題では2回目を呼ばない。
  room.aiSecretGuessStatus = "skipped";
}

function publishAiSecretGuessResult(room) {
  if (
    !isCurrentAiSecretGuessRound(room) ||
    room.aiSecretGuessStatus !== "ready" ||
    !room.aiSecretGuessResult ||
    room.drawPhase !== "reveal"
  ) {
    return false;
  }
  const payload = buildSecretGuessReveal({
    roundId: room.roundSeq,
    correctWord: room.word,
    result: room.aiSecretGuessResult,
  });
  room.aiSecretGuessStatus = "revealed";
  room.aiSecretGuessReveal = payload;
  io.to(room.code).emit("aiSecretGuessReveal", payload);
  return true;
}

function publishAiSecretGuessFallback(room, kind) {
  if (
    !isCurrentAiSecretGuessRound(room) ||
    room.aiSecretGuessStatus === "revealed"
  ) {
    return false;
  }
  const payload = {
    roundId: room.roundSeq,
    kind,
    correctWord: room.word,
    message:
      kind === "too_fast"
        ? "みんなが速すぎて、AIは予想する前に正解発表！"
        : "AI、考え込みすぎて今回は答えが出ませんでした！",
  };
  clearAiSecretGuessTimer(room);
  room.aiSecretGuessToken = randomUUID();
  room.aiSecretGuessStatus = "revealed";
  room.aiSecretGuessResult = null;
  room.aiSecretGuessReveal = payload;
  io.to(room.code).emit("aiSecretGuessReveal", payload);
  return true;
}

/** answerReveal と roundUpdate を配った後にだけ呼ぶ。 */
function revealAiSecretGuessAfterAnswer(room) {
  if (!isCurrentAiSecretGuessRound(room)) return;
  if (room.aiSecretGuessStatus === "revealed") return;
  room.aiSecretGuessAnswerRevealed = true;

  if (room.aiSecretGuessStatus === "ready") {
    publishAiSecretGuessResult(room);
    return;
  }
  if (room.aiSecretGuessStatus === "generating") {
    io.to(room.code).emit("aiSecretGuessPending", {
      roundId: room.roundSeq,
    });
    return;
  }
  publishAiSecretGuessFallback(
    room,
    secretGuessFallbackKind(room.aiSecretGuessStatus),
  );
}

function bindSocket(socket, room, player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = undefined;
  }
  if (player.socketId && player.socketId !== socket.id) {
    socketRoom.delete(player.socketId);
    socketPlayer.delete(player.socketId);
    io.sockets.sockets.get(player.socketId)?.leave(room.code);
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

function reply(callback, payload) {
  if (typeof callback === "function") {
    callback(payload);
  }
}

function onSocket(socket, event, handler) {
  socket.on(event, (...args) => {
    const handleError = (error) => {
      const message =
        error instanceof Error ? error.message.slice(0, 160) : "Unknown error";
      console.error("[socket] event failed", { event, message });
      const callback = args.at(-1);
      if (typeof callback === "function") {
        try {
          callback({ ok: false, error: "入力を処理できませんでした" });
        } catch {
          // A broken acknowledgement must not terminate the process.
        }
      }
    };

    try {
      const result = handler(...args);
      if (result && typeof result.then === "function") {
        result.catch(handleError);
      }
    } catch (error) {
      handleError(error);
    }
  });
}

function chooseTotalRounds(playerCount) {
  if (playerCount <= 4) return randomInt(12, 16);
  if (playerCount <= 7) return randomInt(16, 20);
  if (playerCount <= 10) return randomInt(20, 24);
  return randomInt(24, 30);
}

function getDrawCount(room, playerId) {
  return room.drawCounts.get(playerId) || 0;
}

function recordDrawers(room, ids) {
  for (const id of new Set(ids)) {
    room.drawCounts.set(id, getDrawCount(room, id) + 1);
  }
}

function pickFairPlayers(room, players, count) {
  const ranked = shuffle(players).sort(
    (a, b) => getDrawCount(room, a.id) - getDrawCount(room, b.id),
  );
  const selected = ranked.slice(0, Math.min(count, ranked.length));
  return shuffle(selected);
}

function pickDrawer(room) {
  const players = activePlayers(room);
  if (players.length === 0) return null;

  const fewestDraws = Math.min(
    ...players.map((player) => getDrawCount(room, player.id)),
  );
  let candidates = players.filter(
    (player) => getDrawCount(room, player.id) === fewestDraws,
  );

  // 同じ担当回数の人が複数いるときだけ、同じ人の連続担当を避ける。
  // 担当回数が少ない人（途中参加者を含む）の優先は崩さない。
  const streak = room.drawerStreak;
  if (
    streak &&
    streak.count >= MAX_CONSECUTIVE_DRAWS &&
    candidates.length > 1
  ) {
    candidates = candidates.filter((player) => player.id !== streak.id);
  }

  const drawer = candidates[Math.floor(Math.random() * candidates.length)];
  if (streak && streak.id === drawer.id) {
    room.drawerStreak = { id: drawer.id, count: streak.count + 1 };
  } else {
    room.drawerStreak = { id: drawer.id, count: 1 };
  }
  return drawer;
}

function chooseRoundType(room, playerCount = activePlayers(room).length) {
  const forced = process.env.FORCE_ROUND_TYPE;
  if (
    forced === "relay" ||
    forced === "coop" ||
    forced === "liar" ||
    forced === "gradual" ||
    forced === "normal"
  ) {
    const n = playerCount;
    if (forced === "relay" && n < RELAY_MIN_PLAYERS) return "normal";
    if (forced === "coop" && n < COOP_MIN_PLAYERS) return "normal";
    if (forced === "liar" && n < LIAR_MIN_PLAYERS) return "normal";
    if (forced === "gradual" && n < GRADUAL_MIN_PLAYERS) return "normal";
    return forced;
  }

  const n = playerCount;
  const eligible = [];
  if (n >= RELAY_MIN_PLAYERS) eligible.push("relay");
  if (n >= COOP_MIN_PLAYERS) eligible.push("coop");
  if (n >= LIAR_MIN_PLAYERS) eligible.push("liar");
  if (n >= GRADUAL_MIN_PLAYERS) eligible.push("gradual");

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

/**
 * しばりを引くかどうか決める。
 * ふつうのラウンド専用（リレー・協力・うそつきには重ねない）。
 */
function chooseConstraint(room) {
  const forced = process.env.FORCE_CONSTRAINT;
  if (forced) {
    if (forced === "none") return null;
    if (forced === "random") return randomConstraint();
    return findConstraint(forced);
  }

  if (room.roundsSinceConstraint < CONSTRAINT_MIN_GAP) return null;
  const roll =
    room.roundsSinceConstraint >= CONSTRAINT_FORCE_GAP
      ? true
      : Math.random() < CONSTRAINT_CHANCE;
  if (!roll) return null;
  return randomConstraint(new Set(room.recentConstraints));
}

function applyConstraint(room, roundType) {
  const constraint = roundType === "normal" ? chooseConstraint(room) : null;
  room.constraint = constraint;
  if (!constraint) {
    room.roundsSinceConstraint += 1;
    return;
  }
  room.roundsSinceConstraint = 0;
  room.recentConstraints.push(constraint.id);
  if (room.recentConstraints.length > RECENT_CONSTRAINTS_MAX) {
    room.recentConstraints = room.recentConstraints.slice(
      -RECENT_CONSTRAINTS_MAX,
    );
  }
}

/**
 * 本数しばりの残量チェック。使い切ったら、その線はまるごと捨てる
 * （start だけ捨てると move がつながって変な線になるため）。
 */
function allowConstrainedStroke(room, playerId, type) {
  const limit = room.constraint?.kind === "strokes" ? room.constraint.value : 0;
  if (!limit) return true;

  if (type === "start") {
    const used = room.strokeCounts.get(playerId) || 0;
    if (used >= limit) {
      room.blockedDrawers.add(playerId);
      return false;
    }
    room.strokeCounts.set(playerId, used + 1);
    room.blockedDrawers.delete(playerId);
    return true;
  }

  if (room.blockedDrawers.has(playerId)) {
    if (type === "end") room.blockedDrawers.delete(playerId);
    return false;
  }
  return true;
}

function canPlayerDraw(room, playerId) {
  if (room.phase !== "playing" || room.drawPhase !== "drawing") return false;
  if (room.roundType === "coop" || room.roundType === "liar") {
    return room.drawerIds.includes(playerId);
  }
  return room.drawerId === playerId;
}

function canPlayerSeeWord(room, playerId) {
  if (room.phase !== "playing" || !room.word) return false;
  if (room.roundType === "normal") {
    // 「せいかい！」のあとは全員に公開（聞き取れなかった子にも答えが伝わる）
    if (room.drawPhase === "reveal") return true;
    return room.drawerId === playerId;
  }
  if (room.roundType === "gradual") {
    return room.drawerId === playerId;
  }
  if (room.roundType === "coop") {
    return room.drawerIds.includes(playerId);
  }
  if (room.roundType === "liar") {
    // こたえ発表後は全員に公開。それまでは正直な描き手だけ
    if (room.drawPhase === "reveal") return true;
    return room.seenWordIds.has(playerId);
  }
  // relay: already drawn or currently drawing
  return room.seenWordIds.has(playerId);
}

function canPlayerNextRound(room, playerId) {
  if (room.phase !== "playing") return false;
  if (room.roundType === "normal") {
    // 「せいかい！」で答えを出してから進む
    if (room.drawPhase !== "reveal") return false;
    return room.drawerId === playerId;
  }
  if (room.roundType === "gradual") {
    // 公開が始まるまでは「できた！」で公開する（つぎへは公開後）
    if (room.drawPhase !== "guessing") return false;
    return (
      room.drawerId === playerId &&
      isGradualRevealComplete(room.gradualReveal)
    );
  }
  if (room.roundType === "relay") {
    if (room.drawPhase !== "guessing") return false;
    return room.seenWordIds.has(playerId);
  }
  if (room.roundType === "coop") {
    if (room.drawPhase !== "guessing") return false;
    return room.drawerIds.includes(playerId);
  }
  if (room.roundType === "liar") {
    if (room.drawPhase !== "reveal") return false;
    return room.drawerIds.includes(playerId) || room.hostId === playerId;
  }
  return false;
}

/** ふつうのラウンドの「せいかい！」。時間しばりであてっこタイムに入っていても押せる */
function canRevealAnswer(room, playerId) {
  if (room.phase !== "playing" || room.roundType !== "normal") return false;
  if (room.drawPhase === "reveal") return false;
  return room.drawerId === playerId;
}

/**
 * 「わからない」でお題を引き直せるか。
 * ふつうのラウンド専用（リレー・協力・うそつき・だんだん、しばり付きは不可）。
 */
function canPassWord(room, playerId) {
  if (room.phase !== "playing" || room.roundType !== "normal") return false;
  // しばり中はパスできない（お題を選び直せると、しばりの縛りが薄くなる）
  if (room.constraint) return false;
  if (room.drawPhase !== "drawing") return false;
  if (room.passesUsed >= PASS_MAX_PER_TURN) return false;
  return room.drawerId === playerId;
}

function canRevealLiar(room, playerId) {
  if (room.phase !== "playing" || room.roundType !== "liar") return false;
  if (room.drawPhase !== "guessing") return false;
  return room.drawerIds.includes(playerId) || room.hostId === playerId;
}

function buildAiCrazyPromptPublicState(room, playerId) {
  const active = Boolean(
    room.aiCrazyPromptEnabled &&
      room.currentAiCrazyPrompt &&
      room.roundType === "normal" &&
      room.phase === "playing",
  );
  const reveal = room.drawPhase === "reveal";
  const canSee = active && (reveal || room.drawerId === playerId);
  return {
    enabled: Boolean(room.aiCrazyPromptEnabled),
    active,
    mainAnswer: canSee ? room.currentAiCrazyPrompt.mainAnswer : null,
    fullPrompt: canSee ? room.currentAiCrazyPrompt.fullPrompt : null,
    promptLabel: active ? "AIむちゃぶりお題" : null,
  };
}

function buildGradualRevealPublicState(room) {
  if (room.roundType !== "gradual" || !room.gradualReveal) return null;
  return { ...room.gradualReveal };
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
    roundId: room.roundSeq,
    roundNumber: room.completedRounds + 1,
    totalRounds: room.totalRounds,
    remainingRounds: Math.max(
      0,
      room.totalRounds - room.completedRounds - 1,
    ),
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
    aiCrazyPrompt: buildAiCrazyPromptPublicState(room, playerId),
    canNextRound: canPlayerNextRound(room, playerId),
    turnEndsAt: room.turnEndsAt,
    turnDurationSec:
      room.roundType === "relay" && room.drawPhase === "drawing"
        ? room.turnDurations[room.relayIndex] ?? null
        : room.roundType === "coop" && room.drawPhase === "drawing"
          ? Math.round(COOP_DURATION_MS / 1000)
          : room.roundType === "liar" && room.drawPhase === "drawing"
            ? Math.round(LIAR_DURATION_MS / 1000)
            : room.roundType === "gradual" && room.drawPhase === "drawing"
              ? Math.round(GRADUAL_DURATION_MS / 1000)
              : room.constraint?.kind === "time" &&
                  room.drawPhase === "drawing"
                ? room.constraint.value
                : null,
    // しばりは全員に見せる（見ている側が知らないと、ただ下手な人になってしまう）
    constraint: room.constraint,
    constraintStrokesUsed: room.strokeCounts.get(playerId) || 0,
    relayIndex:
      room.roundType === "relay" ? room.relayIndex : null,
    relayTotal:
      room.roundType === "relay" ? room.drawerIds.length : null,
    ...buildAiSecretGuessPublicState(room),
  };

  if (room.roundType === "coop") {
    payload.coopNames = drawerNames;
  }

  if (room.roundType === "liar") {
    payload.isLiar = room.liarId === playerId;
    payload.canReveal = canRevealLiar(room, playerId);
    payload.liarName = room.drawPhase === "reveal" ? room.liarName : null;
  }

  if (room.roundType === "gradual") {
    payload.canFinishGradual =
      room.drawPhase === "drawing" && room.drawerId === playerId;
    payload.gradualReveal = buildGradualRevealPublicState(room);
  }

  if (room.roundType === "normal") {
    payload.canRevealAnswer = canRevealAnswer(room, playerId);
    payload.canPassWord = canPassWord(room, playerId);
    payload.passesLeft = Math.max(0, PASS_MAX_PER_TURN - room.passesUsed);
  }

  return payload;
}

function emitRoundStart(room, { clear = false, fanfare = false } = {}) {
  if (clear) {
    io.to(room.code).emit("clearCanvas");
  }

  const aiSecretGuessActive =
    isCurrentAiSecretGuessRound(room) &&
    room.aiSecretGuessStatus === "armed";
  const aiCrazyPromptActive = Boolean(room.currentAiCrazyPrompt);
  if (fanfare || aiSecretGuessActive || aiCrazyPromptActive) {
    const constraint = room.constraint;
    const message = constraint
      ? "🎲 しばりルーレット！"
      : aiCrazyPromptActive
        ? "🤖 AIからのむちゃぶり！"
      : aiSecretGuessActive
        ? "🤖 AIがこっそり予想します！"
      : room.roundType === "relay"
        ? "⚡ リレー！"
        : room.roundType === "coop"
          ? "🤝 協力！"
          : room.roundType === "liar"
            ? "🕵️ うそつきお絵かき！"
            : room.roundType === "gradual"
              ? "👀 だんだん見える！"
              : null;
    if (message) {
      const names =
        room.roundType === "coop" || room.roundType === "liar"
          ? playerNames(room, room.drawerIds)
          : [];
      io.to(room.code).emit("roundFanfare", {
        roundType: constraint
          ? "constraint"
          : aiCrazyPromptActive
            ? "normal"
          : aiSecretGuessActive
            ? "ai-secret"
            : room.roundType,
        message,
        names,
        constraint: constraint || null,
        aiCrazyPrompt: aiCrazyPromptActive,
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

function scheduleGradualRevealCompletion(room) {
  const plan = room.gradualReveal;
  const startedAt = Number(plan?.startedAt);
  const duration = gradualRevealDuration(plan);
  if (!Number.isFinite(startedAt) || startedAt <= 0 || duration <= 0) return;

  const expectedRoundSeq = room.roundSeq;
  const timer = setTimeout(() => {
    // 古いコールバックが遅れて走っても、新ラウンドのtimer参照を消さない。
    if (room.turnTimer === timer) room.turnTimer = null;
    const current = rooms.get(room.code);
    if (
      current !== room ||
      current.phase !== "playing" ||
      current.roundType !== "gradual" ||
      current.drawPhase !== "guessing" ||
      current.roundSeq !== expectedRoundSeq ||
      current.gradualReveal?.startedAt !== startedAt
    ) {
      return;
    }
    // 公開が終わった瞬間に、描き手の「つぎへ」を有効にする。
    emitRoundSync(current);
  }, Math.max(0, startedAt + duration - Date.now()) + 20);
  room.turnTimer = timer;
}

function enterGuessing(room) {
  clearTurnTimer(room);
  room.drawPhase = "guessing";
  room.drawerId =
    room.roundType === "relay"
      ? room.drawerIds[room.drawerIds.length - 1] || null
      : room.drawerId;
  // だんだん見える: ここで初めて完成した線と、全員共通の公開方法を配る。
  if (room.roundType === "gradual") {
    room.gradualReveal ||= createGradualRevealPlan();
    room.gradualReveal.startedAt = Date.now();
    io.to(room.code).emit("gradualReveal", {
      roundId: room.roundSeq,
      strokes: room.strokes,
      gradualReveal: { ...room.gradualReveal },
    });
    scheduleGradualRevealCompletion(room);
  }
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

/** 協力・うそつき・だんだん・時間しばり用: 一定時間で自動的にあてっこタイムへ */
function scheduleTimedDrawing(room, ms) {
  clearTurnTimer(room);
  room.turnEndsAt = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (
      (room.roundType === "coop" ||
        room.roundType === "liar" ||
        room.roundType === "gradual" ||
        room.constraint?.kind === "time") &&
      room.drawPhase === "drawing"
    ) {
      enterGuessing(room);
    }
  }, ms);
}

function resetRoundFields(room) {
  clearTurnTimer(room);
  resetAiSecretGuessRound(room);
  room.currentAiCrazyPrompt = null;
  room.aiCrazyPromptSelectedThisRound = false;
  room.roundType = "normal";
  room.drawPhase = "drawing";
  room.drawerId = null;
  room.drawerIds = [];
  room.word = null;
  room.relayIndex = 0;
  room.turnDurations = [];
  room.gradualReveal = null;
  room.seenWordIds = new Set();
  room.strokes = [];
  room.constraint = null;
  room.passesUsed = 0;
  room.strokeCounts = new Map();
  room.blockedDrawers = new Set();
  room.liarId = null;
  room.liarName = "";
}

function resetGameProgress(room) {
  room.totalRounds = 0;
  room.completedRounds = 0;
  room.drawCounts = new Map();
  room.lastCompletedRoundSeq = null;
}

function buildFinishedPayload(room) {
  return {
    completedRounds: room.completedRounds,
    totalRounds: room.totalRounds,
    extensionRounds: EXTENSION_ROUNDS,
  };
}

function finishGame(room) {
  room.phase = "finished";
  resetRoundFields(room);
  io.to(room.code).emit("clearCanvas");
  emitLobby(room);
  io.to(room.code).emit("gameFinished", buildFinishedPayload(room));
  emitAiState(room);
  emitCommunityAwardsState(room);
}

function pickWord(room) {
  const word = randomWord(new Set(room.recentWords));
  room.recentWords.push(word);
  if (room.recentWords.length > RECENT_WORDS_MAX) {
    room.recentWords = room.recentWords.slice(-RECENT_WORDS_MAX);
  }
  return word;
}

/**
 * わからないお題を引き直す。ラウンド自体は進めず、描き手も変えない。
 *
 * 担当回数（drawCounts）を増やさないので、pickDrawer の公平ローテーションも
 * しばり・イベントの間隔カウンタも乱さない。別の人に回すと「描きたくない」
 * ボタンになってしまうため、あくまで同じ人がお題だけ引き直す。
 */
function passWord(room) {
  const drawerId = room.drawerId;
  const drawerName = room.players.get(drawerId)?.name || "";
  const previousAiSecretGuessStatus = room.aiSecretGuessStatus;
  room.passesUsed += 1;
  const wasCrazy = Boolean(room.currentAiCrazyPrompt);
  if (wasCrazy) {
    const nextCrazy = takeNextCrazyPrompt(room);
    if (nextCrazy) {
      room.currentAiCrazyPrompt = nextCrazy;
      room.word = nextCrazy.mainAnswer;
    } else {
      room.currentAiCrazyPrompt = null;
      room.word = pickWord(room);
    }
  } else {
    room.word = pickWord(room);
  }
  room.strokes = [];
  room.strokeCounts = new Map();
  room.seenWordIds = new Set([drawerId]);
  rearmAiSecretGuessAfterPass(room, previousAiSecretGuessStatus);

  // 黙って絵が消えると当てる側が混乱するので、全員に知らせる
  io.to(room.code).emit("wordPassed", {
    drawerName,
    passesLeft: Math.max(0, PASS_MAX_PER_TURN - room.passesUsed),
  });
  io.to(room.code).emit("clearCanvas");
  // ラウンドは変わらないので roundStart ではなく同期にする
  // （ギャラリーを見ている人を無理に引きもどさない）
  emitRoundSync(room);
}

function startRound(room) {
  const players = activePlayers(room);
  if (players.length === 0) return;

  const roundType = chooseRoundType(room, players.length);
  resetRoundFields(room);
  room.roundSeq += 1;
  room.phase = "playing";
  room.roundType = roundType;
  room.word = pickWord(room);
  applyConstraint(room, roundType);

  if (roundType === "relay") {
    room.lastWasSpecial = true;
    room.roundsSinceSpecial = 0;
    // 回答者を原則2人残し、参加人数に応じた範囲で描き手数も変化させる。
    const maxCount = Math.min(
      RELAY_MAX_DRAWERS,
      Math.max(RELAY_MIN_DRAWERS, players.length - 2),
    );
    const count = randomInt(RELAY_MIN_DRAWERS, maxCount);
    const order = pickFairPlayers(room, players, count).map(
      (player) => player.id,
    );
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
      // fallback（しばりなしのふつうのラウンドとして始め直す）
      room.roundType = "normal";
      room.lastWasSpecial = false;
      const drawer = pickDrawer(room);
      if (!drawer) return;
      room.drawerId = drawer.id;
      room.drawerIds = [drawer.id];
      room.seenWordIds = new Set([drawer.id]);
      maybeApplyAiCrazyPrompt(room);
      armAiSecretGuessForRound(room);
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
    // 回答者を原則2人残し、参加人数に応じた範囲で描き手数も変化させる。
    const maxCount = Math.min(
      COOP_MAX_DRAWERS,
      Math.max(COOP_MIN_DRAWERS, players.length - 2),
    );
    const count = randomInt(COOP_MIN_DRAWERS, maxCount);
    const members = pickFairPlayers(room, players, count).map(
      (player) => player.id,
    );
    room.drawerIds = members;
    room.drawerId = members[0] || null;
    room.seenWordIds = new Set(members);
    room.drawerStreak = null;
    room.drawPhase = "drawing";
    scheduleTimedDrawing(room, COOP_DURATION_MS);
    emitRoundStart(room, { clear: true, fanfare: true });
    return;
  }

  if (roundType === "liar") {
    room.lastWasSpecial = true;
    room.roundsSinceSpecial = 0;
    const count = Math.min(LIAR_MAX_DRAWERS, players.length);
    const members = pickFairPlayers(room, players, count).map(
      (player) => player.id,
    );
    const liarId = members[Math.floor(Math.random() * members.length)];
    room.drawerIds = members;
    room.drawerId = members[0] || null;
    room.liarId = liarId;
    room.liarName = room.players.get(liarId)?.name || "";
    // うそつきにはお題を見せない
    room.seenWordIds = new Set(members.filter((id) => id !== liarId));
    room.drawerStreak = null;
    room.drawPhase = "drawing";
    scheduleTimedDrawing(room, LIAR_DURATION_MS);
    emitRoundStart(room, { clear: true, fanfare: true });
    return;
  }

  if (roundType === "gradual") {
    room.lastWasSpecial = true;
    room.roundsSinceSpecial = 0;
    const drawer = pickDrawer(room);
    if (!drawer) return;
    room.drawerId = drawer.id;
    room.drawerIds = [drawer.id];
    room.seenWordIds = new Set([drawer.id]);
    room.drawPhase = "drawing";
    room.gradualReveal = createGradualRevealPlan();
    scheduleTimedDrawing(room, GRADUAL_DURATION_MS);
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
  maybeApplyAiCrazyPrompt(room);
  if (room.constraint?.kind === "time") {
    scheduleTimedDrawing(room, room.constraint.value * 1000);
  }
  armAiSecretGuessForRound(room);
  emitRoundStart(room, { clear: true, fanfare: Boolean(room.constraint) });
}

/** だんだん見えるの公開前は、描き手本人以外に線を見せない */
function strokesVisibleTo(room, playerId) {
  if (
    room.roundType === "gradual" &&
    room.drawPhase === "drawing" &&
    room.drawerId !== playerId
  ) {
    return [];
  }
  return room.strokes;
}

function syncPlayerState(socket, room, playerId) {
  const players = publicPlayers(room);
  emitGallery(room, socket.id);
  emitAiState(room, socket.id);
  emitCommunityAwardsState(room, socket.id, playerId);
  emitCeremonyPlaybackState(room, socket.id);
  if (room.phase === "playing" && room.word) {
    io.to(socket.id).emit("roundStart", buildRoundPayload(room, playerId));
    io.to(socket.id).emit("strokeHistory", {
      roundId: room.roundSeq,
      strokes: strokesVisibleTo(room, playerId),
      gradualReveal: buildGradualRevealPublicState(room),
    });
    if (
      playerId === room.aiSecretGuessDrawerId &&
      room.aiSecretGuessStatus === "requested" &&
      room.drawPhase === "drawing"
    ) {
      requestAiSecretGuessCapture(room);
    }
  } else if (room.phase === "finished") {
    io.to(socket.id).emit("gameFinished", buildFinishedPayload(room));
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
  room.drawCounts.delete(playerId);

  if (room.players.size === 0) {
    clearTurnTimer(room);
    clearAiSecretGuessTimer(room);
    room.aiCrazyPromptToken += 1;
    clearCommunityAwardsTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (wasHost) {
    const nextHost = [...room.players.values()][0];
    room.hostId = nextHost.id;
    nextHost.isHost = true;
    io.to(room.code).emit("hostChanged", { name: nextHost.name });
  }

  // 支払い済みのAI処理は、1人になっても破棄せず完成を待つ。
  if (
    room.phase === "finished" &&
    room.players.size === 1 &&
    room.aiAwardsStatus === "generating"
  ) {
    emitLobby(room);
    emitAiState(room);
    return;
  }

  // ひとりだけ残ったらゲームを畳んでロビーへ（部屋コードで再招集できる）
  if (
    (room.phase === "playing" || room.phase === "finished") &&
    room.players.size === 1
  ) {
    clearTurnTimer(room);
    room.phase = "lobby";
    resetRoundFields(room);
    resetGameProgress(room);
    room.drawerStreak = null;
    resetAiWhenReturningToLobby(room);
    resetAiCrazyPromptForNewGame(room);
    resetCommunityAwards(room);
    io.to(room.code).emit("clearCanvas");
    io.to(room.code).emit("gameEnded", { reason: "alone" });
    emitLobby(room);
    emitAiState(room);
    emitCommunityAwardsState(room);
    return;
  }

  if (
    room.communityAwardsStatus === "voting" &&
    room.communityAwardEligibleIds.delete(playerId)
  ) {
    room.communityAwardVotes.delete(playerId);
    if (room.communityAwardEligibleIds.size === 0) {
      resetCommunityAwards(room);
      emitCommunityAwardsState(room);
      io.to(room.code).emit("communityAwardsNoVotes", {
        gameSeq: room.gameSeq,
      });
    } else if (allCommunityAwardVotesSubmitted(room)) {
      finalizeCommunityAwards(room, "all-voted");
    } else {
      emitCommunityAwardsState(room);
    }
  }

  // ホスト交代や人数変化を全経路で確実に配る
  // （描き手退出→ラウンドやり直しの経路は下でemitLobbyを通らないため）
  emitLobby(room);

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
        io.to(room.code).emit("roundAborted", {
          reason: "drawerLeft",
          name: player.name,
        });
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

    if (room.roundType === "liar") {
      room.drawerIds = room.drawerIds.filter((id) => id !== playerId);
      // 描いている途中でうそつき本人が抜けたらラウンドが成立しないのでやり直し
      const liarLeftWhileDrawing =
        room.drawPhase === "drawing" && room.liarId === playerId;
      if (liarLeftWhileDrawing || room.drawerIds.length === 0) {
        if (room.drawerStreak?.id === playerId) room.drawerStreak = null;
        io.to(room.code).emit("roundAborted", {
          reason: liarLeftWhileDrawing ? "liarLeft" : "drawerLeft",
          name: player.name,
        });
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
      io.to(room.code).emit("roundAborted", {
        reason: "drawerLeft",
        name: player.name,
      });
      startRound(room);
      return;
    }
  }

  emitLobby(room);
  if (room.phase === "playing") emitRoundSync(room);
}

function scheduleDisconnect(room, player, graceMs = DISCONNECT_GRACE_MS) {
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
  }, graceMs);
}

function reconcileRemovedGalleryItems(
  room,
  removedIds,
  { automatic = false } = {},
) {
  const idSet =
    removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  if (idSet.size === 0) return;
  clearCeremonyPlayback(room);

  if (room.aiAwardsStatus === "ready" && room.aiAwards?.awards) {
    const remainingAwards = room.aiAwards.awards.filter(
      (award) => !idSet.has(award.galleryItemId),
    );
    if (remainingAwards.length !== room.aiAwards.awards.length) {
      if (remainingAwards.length > 0) {
        room.aiAwards = {
          ...room.aiAwards,
          awards: remainingAwards,
        };
      } else {
        room.aiAwardsStatus = "error";
        room.aiAwards = null;
        room.aiAwardsError = automatic
          ? "保存上限のため、古い受賞作品がギャラリーから整理されました"
          : "受賞作品がギャラリーから削除されました";
        room.aiAwardsAttempts = 2;
      }
    }
  }

  if (room.communityAwardsStatus === "ready") {
    const currentIds = new Set(drawnThisGame(room).map((item) => item.id));
    const updatedCategories = room.communityAwardCategories.map((category) => ({
      ...category,
      candidateIds: category.candidateIds.filter((id) => currentIds.has(id)),
    }));
    const removedAwardWinner = Boolean(
      room.communityAwardsResults?.awards?.some((award) =>
        award.winnerIds?.some((id) => idSet.has(id)),
      ),
    );
    const removedVotedCandidate = [...room.communityAwardVotes.values()].some(
      (ballot) => [...ballot.values()].some((id) => idSet.has(id)),
    );
    if (
      currentIds.size < 2 ||
      removedAwardWinner ||
      removedVotedCandidate ||
      updatedCategories.some((category) => category.candidateIds.length === 0)
    ) {
      resetCommunityAwards(room);
    } else {
      room.communityAwardCategories = updatedCategories;
      room.communityAwardsResults = {
        ...tallyCommunityAwards(
          room.communityAwardCategories,
          room.communityAwardVotes,
          { eligibleCount: room.communityAwardEligibleIds.size },
        ),
        finalizedAt: Date.now(),
        reason: automatic ? "gallery-trimmed" : "gallery-updated",
      };
    }
  }
}

function trimGallery(room) {
  if (room.gallery.length > GALLERY_MAX) {
    const removedIds = room.gallery
      .slice(0, room.gallery.length - GALLERY_MAX)
      .map((item) => item.id);
    room.gallery = room.gallery.slice(-GALLERY_MAX);
    reconcileRemovedGalleryItems(room, removedIds, { automatic: true });
    return removedIds;
  }
  return [];
}

function addGalleryItem(
  room,
  {
    imageDataUrl,
    word,
    drawerNames,
    roundType,
    constraintLabel = "",
    hasDrawing = false,
    aiCrazyPromptMainAnswer = "",
    aiCrazyPromptFullPrompt = "",
  },
) {
  if (
    typeof imageDataUrl !== "string" ||
    imageDataUrl.length > MAX_GALLERY_DATA_URL_LEN ||
    !parseImageDataUrl(imageDataUrl) ||
    !hasGalleryStorageFor(room, imageDataUrl)
  ) {
    return null;
  }

  const item = {
    id: randomUUID(),
    imageDataUrl,
    word: String(word || "").slice(0, 40),
    drawerNames: Array.isArray(drawerNames)
      ? drawerNames.map((n) => String(n).slice(0, 12)).slice(0, 8)
      : [],
    roundType: roundType || "normal",
    constraintLabel: String(constraintLabel || "").slice(0, 24),
    createdAt: Date.now(),
    gameSeq: room.gameSeq,
    hasDrawing: Boolean(hasDrawing),
    aiCrazyPromptMainAnswer: String(aiCrazyPromptMainAnswer || "").slice(
      0,
      24,
    ),
    aiCrazyPromptFullPrompt: String(aiCrazyPromptFullPrompt || "").slice(
      0,
      32,
    ),
  };
  room.gallery.push(item);
  trimGallery(room);
  emitGallery(room);
  emitAiState(room);
  emitCommunityAwardsState(room);
  return item;
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
    gradualReveal: null,
    seenWordIds: new Set(),
    roundsSinceSpecial: 0,
    lastWasSpecial: false,
    constraint: null,
    passesUsed: 0,
    strokeCounts: new Map(),
    blockedDrawers: new Set(),
    roundsSinceConstraint: 0,
    recentConstraints: [],
    lastReplayAt: 0,
    lastHighlightAt: 0,
    gallery: [],
    strokes: [],
    recentWords: [],
    liarId: null,
    liarName: "",
    roundSeq: 0,
    totalRounds: 0,
    completedRounds: 0,
    drawCounts: new Map(),
    lastCompletedRoundSeq: null,
    gameSeq: 0,
    aiAwardsStatus: "idle",
    aiAwards: null,
    aiAwardsError: "",
    aiAwardsAttempts: 0,
    aiAwardsToken: 0,
    communityAwardsStatus: "idle",
    communityAwardCategories: [],
    communityAwardVotes: new Map(),
    communityAwardEligibleIds: new Set(),
    communityAwardsClosesAt: null,
    communityAwardsTimer: null,
    communityAwardsResults: null,
    communityAwardsToken: 0,
    ceremonyPlaybackSeq: 0,
    ceremonyPlayback: null,
    aiSecretGuessStatus: "idle",
    aiSecretGuessGameSeq: null,
    aiSecretGuessRoundSeq: null,
    aiSecretGuessDrawerId: null,
    aiSecretGuessToken: randomUUID(),
    aiSecretGuessTimer: null,
    aiSecretGuessCaptureAt: null,
    aiSecretGuessResult: null,
    aiSecretGuessReveal: null,
    aiSecretGuessImageAccepted: false,
    aiSecretGuessApiAttempted: false,
    aiSecretGuessAnswerRevealed: false,
    aiSecretGuessCount: 0,
    aiSecretGuessLastRoundNumber: null,
    aiCrazyPromptPackStatus: "idle",
    aiCrazyPromptPack: [],
    aiCrazyPromptEnabled: isAiConfigured(),
    currentAiCrazyPrompt: null,
    aiCrazyPromptSelectedThisRound: false,
    roundsSinceAiCrazyPrompt: 0,
    aiCrazyPromptUsedCount: 0,
    aiCrazyPromptLastRoundNumber: null,
    aiCrazyPromptToken: 0,
  };
}

io.on("connection", (socket) => {
  onSocket(socket, "createRoom", (data, cb) => {
    const { name } = data || {};
    try {
      if (getContext(socket)) {
        return reply(cb, { ok: false, error: "すでに部屋に入っています" });
      }
      const trimmed = safeString(name).trim().slice(0, 12);
      if (!trimmed) return reply(cb, { ok: false, error: "名前を入力してください" });
      if (!consumeAiQuota(socket, "room")) {
        return reply(cb, {
          ok: false,
          error: "部屋を続けて作りすぎています。少し待ってください",
        });
      }
      if (rooms.size >= MAX_ROOMS) {
        return reply(cb, {
          ok: false,
          error: "ただいま満室です。少し待って試してください",
        });
      }

      const code = generateCode();
      const playerId = randomUUID();
      const room = createEmptyRoom(code, playerId);
      const player = {
        id: playerId,
        name: trimmed,
        isHost: true,
        resumeToken: createResumeToken(),
        socketId: null,
      };
      room.players.set(playerId, player);
      rooms.set(code, room);
      bindSocket(socket, room, player);

      reply(cb, {
        ok: true,
        code,
        playerId,
        resumeToken: player.resumeToken,
        hostId: room.hostId,
        players: publicPlayers(room),
        phase: room.phase,
        completedRounds: room.completedRounds,
        totalRounds: room.totalRounds,
        extensionRounds: EXTENSION_ROUNDS,
      });
      emitLobby(room);
      emitGallery(room, socket.id);
      emitAiState(room, socket.id);
      emitCommunityAwardsState(room, socket.id, playerId);
    } catch (e) {
      reply(cb, { ok: false, error: e.message || "部屋を作成できませんでした" });
    }
  });

  onSocket(socket, "joinRoom", (data, cb) => {
    const { code, name } = data || {};
    if (getContext(socket)) {
      return reply(cb, { ok: false, error: "すでに部屋に入っています" });
    }
    const trimmed = safeString(name).trim().slice(0, 12);
    const roomCode = normalizeRoomCode(code);
    if (!trimmed) return reply(cb, { ok: false, error: "名前を入力してください" });
    if (!/^\d{4}$/.test(roomCode)) {
      return reply(cb, { ok: false, error: "部屋コードは4桁です" });
    }

    const room = rooms.get(roomCode);
    if (!room) return reply(cb, { ok: false, error: "部屋が見つかりません" });
    if (room.players.size >= MAX_PLAYERS) {
      return reply(cb, { ok: false, error: `部屋が満員です（最大${MAX_PLAYERS}人）` });
    }

    const playerId = randomUUID();
    const player = {
      id: playerId,
      name: trimmed,
      isHost: false,
      resumeToken: createResumeToken(),
      socketId: null,
    };
    room.players.set(playerId, player);
    bindSocket(socket, room, player);

    reply(cb, {
      ok: true,
      code: roomCode,
      playerId,
      resumeToken: player.resumeToken,
      hostId: room.hostId,
      players: publicPlayers(room),
      phase: room.phase,
      completedRounds: room.completedRounds,
      totalRounds: room.totalRounds,
      extensionRounds: EXTENSION_ROUNDS,
    });

    socket.to(roomCode).emit("playerJoined", { name: trimmed });

    if (room.phase !== "lobby") {
      syncPlayerState(socket, room, playerId);
    } else {
      emitGallery(room, socket.id);
      emitAiState(room, socket.id);
      emitCommunityAwardsState(room, socket.id, playerId);
    }
    emitLobby(room);
  });

  onSocket(socket, "rejoinRoom", (data, cb) => {
    const { code, playerId, resumeToken, name } = data || {};
    const roomCode = normalizeRoomCode(code);
    const id = safeString(playerId).trim();
    const trimmed = safeString(name).trim().slice(0, 12);

    if (
      !/^\d{4}$/.test(roomCode) ||
      !id ||
      !/^[A-Za-z0-9_-]{43}$/.test(safeString(resumeToken))
    ) {
      return reply(cb, { ok: false, error: "再入室できません", expired: true });
    }
    const existingContext = getContext(socket);
    if (
      existingContext &&
      (existingContext.code !== roomCode || existingContext.playerId !== id)
    ) {
      return reply(cb, {
        ok: false,
        error: "別の部屋に入っています",
        expired: false,
      });
    }

    const room = rooms.get(roomCode);
    if (!room) {
      return reply(cb, { ok: false, error: "部屋が見つかりません", expired: true });
    }

    const player = room.players.get(id);
    if (!player || !resumeTokenMatches(player, resumeToken)) {
      return reply(cb, {
        ok: false,
        error: "セッションが切れました。もう一度入室してください",
        expired: true,
      });
    }

    if (trimmed) player.name = trimmed;
    const wasDisconnected = !player.socketId;
    bindSocket(socket, room, player);

    reply(cb, {
      ok: true,
      code: roomCode,
      playerId: player.id,
      resumeToken: player.resumeToken,
      hostId: room.hostId,
      players: publicPlayers(room),
      phase: room.phase,
      completedRounds: room.completedRounds,
      totalRounds: room.totalRounds,
      extensionRounds: EXTENSION_ROUNDS,
    });

    syncPlayerState(socket, room, player.id);
    if (wasDisconnected) {
      socket.to(roomCode).emit("playerReturned", { name: player.name });
    }
  });

  onSocket(socket, "leaveRoom", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: true });
    removePlayer(ctx.room, ctx.playerId);
    reply(cb, { ok: true });
  });

  onSocket(socket, "startGame", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが開始できます" });
    }
    if (room.phase !== "lobby") {
      return reply(cb, { ok: false, error: "すでにゲームが始まっています" });
    }
    const activeCount = activePlayers(room).length;
    if (activeCount < 2) {
      return reply(cb, { ok: false, error: "2人以上必要です" });
    }
    room.drawerStreak = null;
    room.roundsSinceSpecial = 0;
    room.lastWasSpecial = false;
    // 最初の2問はしばりなし（先にゲームそのものに慣れてもらう）
    room.roundsSinceConstraint = 0;
    room.gameSeq += 1;
    resetAiForNewGame(room);
    resetAiSecretGuessForNewGame(room);
    resetAiCrazyPromptForNewGame(room);
    resetCommunityAwards(room);
    room.totalRounds = chooseTotalRounds(activeCount);
    room.completedRounds = 0;
    room.drawCounts = new Map();
    room.lastCompletedRoundSeq = null;
    startRound(room);
    startAiCrazyPromptPackGeneration(room, playerId);
    emitAiState(room);
    emitCommunityAwardsState(room);
    reply(cb, { ok: true, totalRounds: room.totalRounds });
  });

  onSocket(socket, "stroke", (data) => {
    const ctx = getContext(socket);
    if (!ctx) return;
    const { code, room, playerId } = ctx;
    if (!canPlayerDraw(room, playerId)) return;

    const type = data?.type;
    if (type !== "start" && type !== "move" && type !== "end") return;

    /** @type {Record<string, unknown>} */
    const event = { type, playerId };
    if (type !== "end") {
      const x = safeNumber(data.x);
      const y = safeNumber(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      event.x = x;
      event.y = y;
      event.color =
        typeof data.color === "string" ? data.color.slice(0, 24) : "#1a1a1a";
      event.width =
        room.constraint?.kind === "pen"
          ? room.constraint.value
          : Math.min(40, Math.max(1, safeNumber(data.width) || 4));
    }

    // 本数しばりを使い切っていたら、ここで捨てる
    if (!allowConstrainedStroke(room, playerId, type)) return;

    room.strokes.push(event);
    if (room.strokes.length > MAX_STROKES) {
      room.strokes = room.strokes.slice(-MAX_STROKES);
    }
    if (type === "move") {
      scheduleAiSecretGuessCapture(room);
    }
    // だんだん見える: 公開までは自分の画面だけに描く（配信しない）
    if (room.roundType === "gradual" && room.drawPhase === "drawing") return;
    socket.to(code).emit("stroke", event);
  });

  onSocket(socket, "submitAiSecretGuessImage", (data, cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: true, stale: true });
    const { room, playerId } = ctx;
    const imageDataUrl =
      typeof data?.imageDataUrl === "string" ? data.imageDataUrl : "";

    // 古い・重複・偽装された提出は、ゲーム画面へエラーを出さず冪等に捨てる。
    if (
      room.phase !== "playing" ||
      room.roundType !== "normal" ||
      room.constraint ||
      room.drawPhase !== "drawing" ||
      !Number.isInteger(data?.roundId) ||
      data.roundId !== room.roundSeq ||
      data.roundId !== room.aiSecretGuessRoundSeq ||
      safeString(data?.token) !== room.aiSecretGuessToken ||
      room.aiSecretGuessGameSeq !== room.gameSeq ||
      room.aiSecretGuessDrawerId !== playerId ||
      room.drawerId !== playerId ||
      room.aiSecretGuessStatus !== "requested" ||
      room.aiSecretGuessImageAccepted ||
      room.aiSecretGuessAnswerRevealed ||
      !hasVisibleDrawing(room.strokes) ||
      !imageDataUrl ||
      imageDataUrl.length > MAX_AI_SECRET_GUESS_DATA_URL_LEN
    ) {
      return reply(cb, { ok: true, stale: true });
    }
    if (!parseImageDataUrl(imageDataUrl)) {
      return reply(cb, { ok: true, stale: true });
    }

    const gameSeq = room.gameSeq;
    const roundSeq = room.roundSeq;
    const token = room.aiSecretGuessToken;
    const drawerId = room.drawerId;
    const word = room.word;
    const candidateWords = buildSecretGuessCandidates(word);
    const safetyIdentifier = aiSafetyIdentifier(playerId);
    room.aiSecretGuessImageAccepted = true;
    room.aiSecretGuessApiAttempted = true;
    room.aiSecretGuessStatus = "generating";

    // 画像を一度受理した時点でACKし、AI待ちでゲーム操作を止めない。
    reply(cb, { ok: true });

    if (!consumeAiQuota(socket, "secretGuess")) {
      room.aiSecretGuessStatus = "skipped";
      return;
    }
    if (candidateWords.length < 2) {
      room.aiSecretGuessStatus = "error";
      return;
    }

    const isCurrent = () => {
      const current = rooms.get(room.code);
      return (
        current === room &&
        current.phase === "playing" &&
        current.gameSeq === gameSeq &&
        current.roundSeq === roundSeq &&
        current.drawerId === drawerId &&
        current.word === word &&
        current.aiSecretGuessToken === token &&
        current.aiSecretGuessStatus === "generating"
      );
    };

    void createSecretGuess(imageDataUrl, candidateWords, {
      safetyIdentifier,
      isCurrent,
    })
      .then((result) => {
        if (!isCurrent()) return;
        room.aiSecretGuessResult = result;
        room.aiSecretGuessStatus = "ready";
        if (
          room.aiSecretGuessAnswerRevealed &&
          room.drawPhase === "reveal"
        ) {
          publishAiSecretGuessResult(room);
        }
      })
      .catch((error) => {
        const current = rooms.get(room.code);
        if (
          current !== room ||
          current.gameSeq !== gameSeq ||
          current.roundSeq !== roundSeq ||
          current.aiSecretGuessToken !== token ||
          current.aiSecretGuessStatus !== "generating"
        ) {
          return;
        }
        logAiFailure("secret guess", error);
        current.aiSecretGuessStatus = "error";
        current.aiSecretGuessResult = null;
        if (
          current.aiSecretGuessAnswerRevealed &&
          current.drawPhase === "reveal"
        ) {
          publishAiSecretGuessFallback(current, "unavailable");
        }
      });
  });

  onSocket(socket, "requestStrokeHistory", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, strokes: [] });
    reply(cb, {
      ok: true,
      roundId: ctx.room.roundSeq,
      strokes: strokesVisibleTo(ctx.room, ctx.playerId),
      gradualReveal: buildGradualRevealPublicState(ctx.room),
    });
  });

  onSocket(socket, "timeSync", (cb) => {
    reply(cb, { now: Date.now() });
  });

  // 爆笑リプレイ: 線そのものは各端末が持っているので、合図だけ配る
  onSocket(socket, "broadcastReplay", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    if (room.phase !== "playing") {
      return reply(cb, { ok: false, error: "いまはリプレイできません" });
    }
    // 流していいのは、こたえを知っている人（＝そのラウンドを次へ進められる人）だけ。
    // 当てっこの最中に全員の画面が白くなると、ただの邪魔になる。
    // リレー・協力・うそつき・だんだんでは、描く時間が終わるまで false になる。
    if (!canPlayerNextRound(room, playerId)) {
      return reply(cb, { ok: false, error: "こたえが出てからリプレイできます" });
    }
    const now = Date.now();
    if (now - room.lastReplayAt < REPLAY_COOLDOWN_MS) {
      return reply(cb, { ok: true, stale: true });
    }
    room.lastReplayAt = now;
    io.to(code).emit("replayStart");
    reply(cb, { ok: true });
  });

  // 今日のハイライト: 絵は全員の端末にもう届いているので、順番だけ配る
  onSocket(socket, "startHighlight", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけがハイライトを始められます" });
    }
    if (room.phase !== "finished") {
      return reply(cb, { ok: false, error: "いまはハイライトを見られません" });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなの投票が終わってからハイライトを見られます",
      });
    }
    const items = drawnThisGame(room);
    if (items.length < 2) {
      return reply(cb, { ok: false, error: "ハイライトには絵が2枚以上必要です" });
    }
    const now = Date.now();
    if (now - room.lastHighlightAt < HIGHLIGHT_COOLDOWN_MS) {
      return reply(cb, { ok: true, stale: true });
    }
    clearCeremonyPlayback(room);
    room.lastHighlightAt = now;
    io.to(code).emit("highlightStart", { ids: items.map((item) => item.id) });
    reply(cb, { ok: true });
  });

  // AI／会場投票の授賞式を、ホストの合図で全端末へ同時に再上映する。
  onSocket(socket, "startCeremonyPlayback", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, {
        ok: false,
        error: "ホストだけが授賞式を再上映できます",
      });
    }
    if (room.phase !== "finished") {
      return reply(cb, {
        ok: false,
        error: "ゲーム終了後に授賞式を見られます",
      });
    }
    if (!Number.isInteger(data?.gameSeq) || data.gameSeq !== room.gameSeq) {
      return reply(cb, {
        ok: false,
        error: "授賞式の情報が古くなりました。画面を開き直してください",
      });
    }
    const kind = data?.kind;
    if (kind !== "ai" && kind !== "community") {
      return reply(cb, { ok: false, error: "授賞式を選べませんでした" });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなの投票が終わってから再上映できます",
      });
    }

    const existing = normalizeCeremonyPlayback(room.ceremonyPlayback);
    if (existing && isCeremonyPlaybackInProgress(existing)) {
      if (existing.kind === kind && existing.gameSeq === room.gameSeq) {
        // 二重押しは全員の画面を触らず、現在の上映をそのまま続ける。
        return reply(cb, {
          ok: true,
          active: true,
          runId: existing.runId,
        });
      }
      return reply(cb, {
        ok: false,
        error: "いま別の授賞式を上映中です",
      });
    }
    if (ceremonyAwardCount(room, kind) < 1) {
      return reply(cb, {
        ok: false,
        error:
          kind === "ai"
            ? "AI授賞式がまだ完成していません"
            : "投票結果がまだ完成していません",
      });
    }

    const playback = startCeremonyPlayback(room, kind);
    if (!playback) {
      return reply(cb, { ok: false, error: "授賞式を開始できませんでした" });
    }
    reply(cb, { ok: true, runId: playback.runId });
  });

  onSocket(socket, "revealLiar", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    // すでに発表済みなら同時押しでもエラーにしない
    if (
      room.phase === "playing" &&
      room.roundType === "liar" &&
      room.drawPhase === "reveal"
    ) {
      return reply(cb, { ok: true });
    }
    if (!canRevealLiar(room, playerId)) {
      return reply(cb, { ok: false, error: "こたえあわせできません" });
    }
    room.drawPhase = "reveal";
    io.to(code).emit("liarReveal", {
      liarName: room.liarName,
      word: room.word,
    });
    emitRoundSync(room);
    reply(cb, { ok: true });
  });

  // ふつうのラウンド: 描き手の「せいかい！」で答えを全員に出す
  onSocket(socket, "revealAnswer", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    const clientRoundId = data?.roundId;
    if (Number.isInteger(clientRoundId) && clientRoundId !== room.roundSeq) {
      return reply(cb, { ok: true, stale: true });
    }
    // 連打や同時押しでもエラーにしない
    if (
      room.phase === "playing" &&
      room.roundType === "normal" &&
      room.drawPhase === "reveal"
    ) {
      return reply(cb, { ok: true, stale: true });
    }
    if (!canRevealAnswer(room, playerId)) {
      return reply(cb, { ok: false, error: "いまは せいかい発表できません" });
    }
    // 時間しばりのカウントダウンが残っていても、ここで描く時間は終わり
    clearTurnTimer(room);
    room.drawPhase = "reveal";
    io.to(code).emit("answerReveal", {
      roundId: room.roundSeq,
      word: room.word,
      drawerName: room.players.get(room.drawerId)?.name || "",
      aiCrazyPrompt: room.currentAiCrazyPrompt
        ? { ...room.currentAiCrazyPrompt }
        : null,
    });
    emitRoundSync(room);
    revealAiSecretGuessAfterAnswer(room);
    reply(cb, { ok: true });
  });

  onSocket(socket, "passWord", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    // 連打や同時押しで、引き直した先のお題までパスしてしまわないようにする。
    // ラウンドは進まない（roundSeq が変わらない）ので、残り回数を合図に使う。
    const clientRoundId = data?.roundId;
    if (Number.isInteger(clientRoundId) && clientRoundId !== room.roundSeq) {
      return reply(cb, { ok: true, stale: true });
    }
    const clientPassesLeft = data?.passesLeft;
    if (
      Number.isInteger(clientPassesLeft) &&
      clientPassesLeft !== PASS_MAX_PER_TURN - room.passesUsed
    ) {
      return reply(cb, { ok: true, stale: true });
    }
    if (!canPassWord(room, playerId)) {
      return reply(cb, { ok: false, error: "いまはパスできません" });
    }
    passWord(room);
    reply(cb, { ok: true });
  });

  // だんだん見える: 描き手の「できた！」で公開スタート
  onSocket(socket, "finishGradualDrawing", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    const clientRoundId = data?.roundId;
    if (Number.isInteger(clientRoundId) && clientRoundId !== room.roundSeq) {
      return reply(cb, { ok: true, stale: true });
    }
    if (
      room.phase !== "playing" ||
      room.roundType !== "gradual" ||
      room.drawerId !== playerId
    ) {
      return reply(cb, { ok: false, error: "いまは公開できません" });
    }
    // タイマー満了や連打と同時でもエラーにしない
    if (room.drawPhase !== "drawing") {
      return reply(cb, { ok: true, stale: true });
    }
    enterGuessing(room);
    reply(cb, { ok: true });
  });

  onSocket(socket, "nextRound", (data, cb) => {
    if (typeof data === "function") {
      cb = data;
      data = {};
    }
    const imageDataUrl =
      typeof data?.imageDataUrl === "string" ? data.imageDataUrl : "";
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    const clientRoundId = data?.roundId;
    if (!Number.isInteger(clientRoundId)) {
      return reply(cb, { ok: false, error: "ラウンド情報がありません" });
    }
    if (clientRoundId === room.lastCompletedRoundSeq) {
      return reply(cb, { ok: true, stale: true });
    }
    if (room.phase === "finished") {
      return reply(cb, { ok: true, finished: true });
    }
    if (room.phase !== "playing") {
      return reply(cb, { ok: false, error: "プレイ中ではありません" });
    }
    // 同時押し対策: 別のラウンドに対する「つぎへ」は黙って無視する
    if (clientRoundId !== room.roundSeq) {
      return reply(cb, { ok: true, stale: true });
    }
    if (!canPlayerNextRound(room, playerId)) {
      return reply(cb, { ok: false, error: "つぎへ進めません" });
    }

    const drawerNames = playerNames(room, room.drawerIds);
    const word = room.word;
    const roundType = room.roundType;
    const constraint = room.constraint;
    const constraintLabel = constraint
      ? `${constraint.emoji} ${constraint.label}`
      : "";
    const aiCrazyPrompt = room.currentAiCrazyPrompt;
    const wasAiCrazyPromptRound = room.aiCrazyPromptSelectedThisRound;
    // 白紙は授賞式の候補から外す
    const drawn = hasVisibleDrawing(room.strokes);

    if (imageDataUrl) {
      addGalleryItem(room, {
        imageDataUrl,
        word,
        drawerNames,
        roundType,
        constraintLabel,
        hasDrawing: drawn,
        aiCrazyPromptMainAnswer: aiCrazyPrompt?.mainAnswer || "",
        aiCrazyPromptFullPrompt: aiCrazyPrompt?.fullPrompt || "",
      });
    }

    recordDrawers(
      room,
      room.drawerIds.filter((id) => room.players.has(id)),
    );
    room.lastCompletedRoundSeq = room.roundSeq;
    room.completedRounds += 1;
    if (wasAiCrazyPromptRound) {
      room.roundsSinceAiCrazyPrompt = 0;
    } else {
      room.roundsSinceAiCrazyPrompt += 1;
    }
    if (room.completedRounds >= room.totalRounds) {
      finishGame(room);
      reply(cb, { ok: true, finished: true });
      return;
    }

    startRound(room);
    reply(cb, { ok: true });
  });

  onSocket(socket, "extendGame", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが延長できます" });
    }
    if (room.phase !== "finished") {
      return reply(cb, { ok: false, error: "いまは延長できません" });
    }
    if (activePlayers(room).length < 2) {
      return reply(cb, { ok: false, error: "延長には2人以上必要です" });
    }
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, {
        ok: false,
        error: "AI授賞式が完成してから延長できます",
      });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなの投票が終わってから延長できます",
      });
    }

    room.totalRounds += EXTENSION_ROUNDS;
    resetAwardsForExtension(room);
    resetCommunityAwards(room);
    io.to(code).emit("gameExtended", {
      addedRounds: EXTENSION_ROUNDS,
      totalRounds: room.totalRounds,
    });
    startRound(room);
    emitAiState(room);
    emitCommunityAwardsState(room);
    reply(cb, { ok: true, totalRounds: room.totalRounds });
  });

  onSocket(socket, "endGame", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { code, room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが終了できます" });
    }
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, {
        ok: false,
        error: "AI授賞式が完成してからロビーへ戻れます",
      });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなの投票が終わってからロビーへ戻れます",
      });
    }
    clearTurnTimer(room);
    room.phase = "lobby";
    resetRoundFields(room);
    resetGameProgress(room);
    room.drawerStreak = null;
    resetAiWhenReturningToLobby(room);
    resetAiCrazyPromptForNewGame(room);
    resetCommunityAwards(room);
    io.to(code).emit("clearCanvas");
    io.to(code).emit("gameEnded");
    emitLobby(room);
    emitAiState(room);
    emitCommunityAwardsState(room);
    // gallery is kept for room lifetime
    reply(cb, { ok: true });
  });

  onSocket(socket, "startCommunityAwards", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, {
        ok: false,
        error: "ホストだけがみんなの授賞式を始められます",
      });
    }
    if (room.phase !== "finished") {
      return reply(cb, {
        ok: false,
        error: "ゲーム終了後にみんなの授賞式を始められます",
      });
    }
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, {
        ok: false,
        error: "AI授賞式が完成してからみんなの投票を始められます",
      });
    }
    if (room.communityAwardsStatus === "ready") {
      return reply(cb, { ok: true, ready: true });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, { ok: true, voting: true });
    }

    const candidates = drawnThisGame(room);
    if (candidates.length < 2) {
      return reply(cb, {
        ok: false,
        error: "みんなの授賞式には絵が2枚以上必要です",
      });
    }
    const categories = selectCommunityAwardCategories(candidates);
    if (categories.length !== 3) {
      return reply(cb, {
        ok: false,
        error: "賞を用意できませんでした。もう一度試してください",
      });
    }
    const eligibleIds = new Set(
      activePlayers(room).map((player) => player.id),
    );
    if (eligibleIds.size === 0) {
      return reply(cb, { ok: false, error: "投票できる参加者がいません" });
    }

    clearCeremonyPlayback(room);
    room.communityAwardsToken += 1;
    room.communityAwardsStatus = "voting";
    room.communityAwardCategories = categories;
    room.communityAwardVotes = new Map();
    room.communityAwardEligibleIds = eligibleIds;
    room.communityAwardsResults = null;
    scheduleCommunityAwardsDeadline(room);
    emitCommunityAwardsState(room);
    io.to(room.code).emit("communityAwardsStarted", {
      gameSeq: room.gameSeq,
    });
    reply(cb, {
      ok: true,
      voting: true,
      closesAt: room.communityAwardsClosesAt,
    });
  });

  onSocket(socket, "submitCommunityAwardsVotes", (data, cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.phase !== "finished" || room.communityAwardsStatus !== "voting") {
      return reply(cb, { ok: false, error: "いまは投票できません" });
    }
    if (!Number.isInteger(data?.gameSeq) || data.gameSeq !== room.gameSeq) {
      return reply(cb, {
        ok: false,
        error: "投票情報が古くなりました。画面を開き直してください",
      });
    }
    if (!room.communityAwardEligibleIds.has(playerId)) {
      return reply(cb, {
        ok: false,
        error: "投票開始後に参加したため、今回は投票できません",
      });
    }

    const parsed = parseCommunityAwardBallot(room, data);
    if (!parsed.ballot) {
      return reply(cb, { ok: false, error: parsed.error });
    }
    const overwritten = room.communityAwardVotes.has(playerId);
    room.communityAwardVotes.set(playerId, parsed.ballot);
    const completed = allCommunityAwardVotesSubmitted(room);
    if (completed) {
      finalizeCommunityAwards(room, "all-voted");
    } else {
      emitCommunityAwardsState(room);
    }
    reply(cb, {
      ok: true,
      overwritten,
      ready: completed,
      votedCount: room.communityAwardVotes.size,
      eligibleCount: room.communityAwardEligibleIds.size,
    });
  });

  onSocket(socket, "finalizeCommunityAwards", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが締め切れます" });
    }
    if (room.phase !== "finished" || room.communityAwardsStatus !== "voting") {
      return reply(cb, { ok: false, error: "いまは投票を締め切れません" });
    }
    if (room.communityAwardVotes.size < 1) {
      return reply(cb, {
        ok: false,
        error: "まだ投票がありません。最初の1票を待ってください",
      });
    }
    finalizeCommunityAwards(room, "host");
    reply(cb, { ok: true, ready: true });
  });

  onSocket(socket, "requestAiAwards", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが授賞式を始められます" });
    }
    if (room.phase !== "finished") {
      return reply(cb, { ok: false, error: "ゲーム終了後に授賞式を始められます" });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなの投票が終わってからAI授賞式を始められます",
      });
    }
    if (!isAiConfigured()) {
      return reply(cb, { ok: false, error: "AI画伯はまだ準備中です" });
    }
    if (room.aiAwardsStatus === "ready") {
      return reply(cb, { ok: true, ready: true });
    }
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, { ok: true, generating: true });
    }
    if (room.aiAwardsAttempts >= 2) {
      return reply(cb, {
        ok: false,
        error: "このゲームの授賞式はこれ以上やり直せません",
      });
    }

    const candidates = drawnThisGame(room).map((item) => ({
      id: item.id,
      word: item.word,
      roundType: item.roundType,
      constraintLabel: item.constraintLabel,
      aiCrazyPromptFullPrompt: item.aiCrazyPromptFullPrompt,
      imageDataUrl: item.imageDataUrl,
    }));
    if (candidates.length < 2) {
      return reply(cb, { ok: false, error: "授賞式には絵が2枚以上必要です" });
    }
    if (!consumeAiQuota(socket, "awards")) {
      return reply(cb, {
        ok: false,
        error: "授賞式の利用上限です。時間をおいて試してください",
      });
    }

    const gameSeq = room.gameSeq;
    const token = room.aiAwardsToken + 1;
    const safetyIdentifier = aiSafetyIdentifier(playerId);
    clearCeremonyPlayback(room);
    room.aiAwardsToken = token;
    room.aiAwardsStatus = "generating";
    room.aiAwards = null;
    room.aiAwardsError = "";
    room.aiAwardsAttempts += 1;
    emitAiState(room);
    reply(cb, { ok: true, generating: true });

    const isCurrent = () => {
      const currentRoom = rooms.get(room.code);
      return (
        currentRoom === room &&
        currentRoom.gameSeq === gameSeq &&
        currentRoom.aiAwardsToken === token &&
        currentRoom.aiAwardsStatus === "generating" &&
        currentRoom.phase === "finished"
      );
    };

    void createAwards(candidates, { safetyIdentifier, isCurrent })
      .then((awards) => {
        const currentRoom = rooms.get(room.code);
        if (
          !currentRoom ||
          currentRoom !== room ||
          currentRoom.gameSeq !== gameSeq ||
          currentRoom.aiAwardsToken !== token ||
          currentRoom.phase !== "finished"
        ) {
          return;
        }
        const currentIds = new Set(
          currentGameGallery(currentRoom).map((item) => item.id),
        );
        if (
          awards.awards.some(
            (award) => !currentIds.has(award.galleryItemId),
          )
        ) {
          throw new Error("Award source drawing was removed");
        }
        currentRoom.aiAwardsStatus = "ready";
        currentRoom.aiAwards = awards;
        currentRoom.aiAwardsError = "";
        emitAiState(currentRoom);
        io.to(currentRoom.code).emit("aiAwardsReady", { gameSeq });
        startCeremonyPlayback(currentRoom, "ai");
      })
      .catch((error) => {
        logAiFailure("awards", error);
        const currentRoom = rooms.get(room.code);
        if (
          !currentRoom ||
          currentRoom !== room ||
          currentRoom.gameSeq !== gameSeq ||
          currentRoom.aiAwardsToken !== token
        ) {
          return;
        }
        currentRoom.aiAwardsStatus = "error";
        currentRoom.aiAwards = null;
        currentRoom.aiAwardsError = friendlyAiError(
          error,
          "授賞式を開けませんでした。もう一度試してください",
        );
        emitAiState(currentRoom);
      });
  });

  onSocket(socket, "deleteGalleryItems", (data, cb) => {
    const { ids } = data || {};
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room } = ctx;
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, {
        ok: false,
        error: "AI画伯が作業中です。完成してから削除してください",
      });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなが投票中です。結果発表後に削除してください",
      });
    }
    const idSet = new Set(
      Array.isArray(ids) ? ids.map(safeString).filter(Boolean) : [],
    );
    if (idSet.size === 0) {
      return reply(cb, { ok: false, error: "削除する絵がありません" });
    }
    room.gallery = room.gallery.filter((g) => !idSet.has(g.id));
    reconcileRemovedGalleryItems(room, idSet);
    emitGallery(room);
    emitAiState(room);
    emitCommunityAwardsState(room);
    reply(cb, { ok: true });
  });

  onSocket(socket, "clearGallery", (cb) => {
    const ctx = getContext(socket);
    if (!ctx) return reply(cb, { ok: false, error: "部屋がありません" });
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) {
      return reply(cb, { ok: false, error: "ホストだけが全部消せます" });
    }
    if (room.aiAwardsStatus === "generating") {
      return reply(cb, {
        ok: false,
        error: "AI画伯が作業中です。完成してから削除してください",
      });
    }
    if (room.communityAwardsStatus === "voting") {
      return reply(cb, {
        ok: false,
        error: "みんなが投票中です。結果発表後に削除してください",
      });
    }
    room.gallery = [];
    clearCeremonyPlayback(room);
    room.aiAwardsToken += 1;
    room.aiAwardsStatus = "idle";
    room.aiAwards = null;
    room.aiAwardsError = "";
    resetCommunityAwards(room);
    emitGallery(room);
    emitAiState(room);
    emitCommunityAwardsState(room);
    reply(cb, { ok: true });
  });

  onSocket(socket, "disconnect", () => {
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

    // ひとりで描くラウンドの描き手が切れたら、全員に知らせて短めに見切る
    const isActiveNormalDrawer =
      room.phase === "playing" &&
      (room.roundType === "normal" || room.roundType === "gradual") &&
      room.drawerId === playerId;
    if (isActiveNormalDrawer) {
      io.to(code).emit("drawerDisconnected", { name: player.name });
      scheduleDisconnect(room, player, DRAWER_DISCONNECT_GRACE_MS);
    } else {
      if (room.hostId === playerId && room.players.size > 1) {
        io.to(code).emit("hostDisconnected", { name: player.name });
      }
      scheduleDisconnect(room, player);
    }

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
