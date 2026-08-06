import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { io } from "socket.io-client";
import DrawingCanvas from "./DrawingCanvas.jsx";

const SESSION_KEY = "oekaki-session";
/** ブラウザを閉じても3時間は同じ部屋に戻れる */
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
/** 古いサーバーから時刻情報が来なかった場合にも使える表示時間。 */
const HIGHLIGHT_MS_PER_ITEM = 2_400;
const HIGHLIGHT_MIN_MS_PER_ITEM = 1_800;
const HIGHLIGHT_TOTAL_MS = 60_000;
const HIGHLIGHT_FINAL_HOLD_MS = 2_500;
const PEEPHOLE_POSITIONS = [
  [24, 24],
  [51, 25],
  [76, 27],
  [72, 51],
  [48, 48],
  [25, 55],
  [27, 75],
  [53, 74],
  [75, 73],
  [40, 31],
  [63, 63],
];
const EMPTY_AI_STATE = {
  enabled: false,
  gameSeq: 0,
  currentGalleryCount: 0,
  awardCandidateCount: 0,
  awardsStatus: "idle",
  awards: null,
  awardsError: "",
  canRetryAwards: true,
};

function createSocket() {
  const url = import.meta.env.VITE_SOCKET_URL || undefined;
  return io(url, {
    autoConnect: true,
    transports: ["websocket", "polling"],
  });
}

function readSessionRaw() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadSession() {
  const data = readSessionRaw();
  if (
    !data?.playerId ||
    !data?.resumeToken ||
    !data?.roomCode ||
    !data?.name
  ) {
    return null;
  }
  if (!data.savedAt || Date.now() - data.savedAt > SESSION_TTL_MS) return null;
  return data;
}

function saveSession(data) {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...data, savedAt: Date.now() })
    );
  } catch {
    // ストレージが使えない環境では復帰できないだけ
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function formatRemain(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return sec;
}

function fallbackHighlightMsPerItem(itemCount) {
  const count = Math.max(1, itemCount);
  return Math.max(
    HIGHLIGHT_MIN_MS_PER_ITEM,
    Math.min(HIGHLIGHT_MS_PER_ITEM, Math.round(HIGHLIGHT_TOTAL_MS / count))
  );
}

/** サーバー時刻から、受信時点で表示すべきハイライトの位置を復元する。 */
function parseHighlightState(data, now) {
  const ids = Array.isArray(data?.ids)
    ? data.ids.filter((id) => typeof id === "string" && id)
    : [];
  if (ids.length === 0) return null;

  const msPerItem =
    Number.isFinite(data?.msPerItem) && data.msPerItem > 0
      ? data.msPerItem
      : fallbackHighlightMsPerItem(ids.length);
  const startedAt = Number.isFinite(data?.startedAt) ? data.startedAt : now;
  const endsAt = Number.isFinite(data?.endsAt)
    ? data.endsAt
    : startedAt + msPerItem * ids.length + HIGHLIGHT_FINAL_HOLD_MS;
  if (now >= endsAt) return null;

  const preparing = now < startedAt;
  const elapsed = Math.max(0, now - startedAt);
  return {
    ids,
    startedAt,
    msPerItem,
    endsAt,
    preparing,
    index: Math.min(ids.length - 1, Math.floor(elapsed / msPerItem)),
  };
}

/** 全員で同じ場所を見られるよう、ラウンド番号と経過秒から穴の位置を決める。 */
function getPeepholeStyle(roundId, remainSec, turnDurationSec) {
  const duration = Math.max(1, turnDurationSec || 20);
  const remaining = Math.min(duration, Math.max(0, remainSec ?? duration));
  const progress = 1 - remaining / duration;
  const elapsed = duration - remaining;
  const offset = Number.isInteger(roundId) ? roundId : 0;
  const position =
    PEEPHOLE_POSITIONS[
      (offset + Math.floor(elapsed / 2)) % PEEPHOLE_POSITIONS.length
    ];
  const size = 25 + progress * 27;
  return {
    "--peephole-x": `${position[0]}%`,
    "--peephole-y": `${position[1]}%`,
    "--peephole-size": `${size}%`,
  };
}

/** 全角数字なども半角4桁に正規化 */
function normalizeRoomCode(code) {
  return String(code || "")
    .normalize("NFKC")
    .replace(/\D/g, "")
    .slice(0, 4);
}

function readInviteRoomCode() {
  if (typeof window === "undefined") return "";
  const code = String(
    new URLSearchParams(window.location.search).get("room") || ""
  )
    .normalize("NFKC")
    .trim();
  return /^\d{4}$/.test(code) ? code : "";
}

function buildInviteUrl(code) {
  if (typeof window === "undefined" || !code) return "";
  const url = new URL("/", window.location.origin);
  url.searchParams.set("room", code);
  return url.toString();
}

function removeInviteRoomCodeFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("room")) return;
  url.searchParams.delete("room");
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

export default function App() {
  const socketRef = useRef(null);
  const wakeLockRef = useRef(null);
  const canvasApiRef = useRef(null);
  const easelRef = useRef(null);
  const playerIdRef = useRef("");
  const roundIdRef = useRef(null);
  /** 何か描かれたか（線ごとに再描画しないための箱） */
  const hasDrawingRef = useRef(false);
  /** サーバー時刻 - 端末時刻（タイマー表示のずれ補正用） */
  const serverOffsetRef = useRef(0);
  const clockSyncedRef = useRef(false);
  /** 自分で閉じた同じ上映が、画面復帰時に再び開かないようにする。 */
  const dismissedHighlightRef = useRef(null);
  /** 現在と直後の画像をデコード済みで保持する。 */
  const highlightImageCacheRef = useRef(new Map());
  const highlightImageRunRef = useRef(null);
  const [initialInviteCode] = useState(readInviteRoomCode);
  const [screen, setScreen] = useState("home"); // home | lobby | play | finished | gallery
  // 期限切れセッションでも名前だけは引き継いで入力の手間を省く
  const [name, setName] = useState(() => readSessionRaw()?.name || "");
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [joinCode, setJoinCode] = useState(initialInviteCode);
  const [error, setError] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [players, setPlayers] = useState([]);
  const [hostId, setHostId] = useState("");
  const [drawerId, setDrawerId] = useState("");
  const [drawerName, setDrawerName] = useState("");
  const [drawerNames, setDrawerNames] = useState([]);
  const [word, setWord] = useState(null);
  const [clearToken, setClearToken] = useState(0);
  const [toast, setToast] = useState("");
  const [fanfare, setFanfare] = useState(null);
  const [restoring, setRestoring] = useState(() => {
    const session = loadSession();
    return (
      !!session &&
      (!initialInviteCode || session.roomCode === initialInviteCode)
    );
  });
  const [roundType, setRoundType] = useState("normal");
  const [drawPhase, setDrawPhase] = useState("drawing");
  const [canDraw, setCanDraw] = useState(false);
  const [canNextRound, setCanNextRound] = useState(false);
  const [turnEndsAt, setTurnEndsAt] = useState(null);
  const [remainSec, setRemainSec] = useState(null);
  const [relayIndex, setRelayIndex] = useState(null);
  const [relayTotal, setRelayTotal] = useState(null);
  const [turnDurationSec, setTurnDurationSec] = useState(null);
  const [isLiar, setIsLiar] = useState(false);
  const [canReveal, setCanReveal] = useState(false);
  const [liarName, setLiarName] = useState("");
  const [canFinishGradual, setCanFinishGradual] = useState(false);
  const [canRevealAnswer, setCanRevealAnswer] = useState(false);
  const [canPassRound, setCanPassRound] = useState(false);
  const [constraint, setConstraint] = useState(null);
  const [strokesUsed, setStrokesUsed] = useState(0);
  const [partAssignment, setPartAssignment] = useState(null);
  const [partsVariant, setPartsVariant] = useState("normal");
  const [partsStage, setPartsStage] = useState(-1);
  const [partsStageLabel, setPartsStageLabel] = useState("");
  const [partsCredits, setPartsCredits] = useState([]);
  const [canStartParts, setCanStartParts] = useState(false);
  const [canAssembleParts, setCanAssembleParts] = useState(false);
  const [canHighlightPart, setCanHighlightPart] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [roundId, setRoundId] = useState(null);
  const [roundNumber, setRoundNumber] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [extensionRounds, setExtensionRounds] = useState(3);
  const [advancing, setAdvancing] = useState(false);
  const [finishBusy, setFinishBusy] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [historySeed, setHistorySeed] = useState({ token: 0, strokes: [] });
  const [gallerySelectMode, setGallerySelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [returnScreen, setReturnScreen] = useState("lobby");
  const [aiState, setAiState] = useState(EMPTY_AI_STATE);
  /** 今日のハイライト: { ids: string[], index: number } */
  const [highlight, setHighlight] = useState(null);

  const isHost = playerId && playerId === hostId;
  const isAiFinishBusy = aiState.awardsStatus === "generating";
  const modeClass = `mode-${roundType || "normal"}`;
  const peepholeStyle = getPeepholeStyle(
    roundId,
    remainSec,
    turnDurationSec
  );
  const inviteUrl = useMemo(() => buildInviteUrl(roomCode), [roomCode]);
  const canShareInvite =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  /** 線が届くたびに再描画しないよう、変化したときだけ state を動かす */
  function markDrawing(value) {
    if (hasDrawingRef.current === value) return;
    hasDrawingRef.current = value;
    setHasDrawing(value);
  }

  function applyRoundPayload(data, { forcePlay = true } = {}) {
    setError("");
    if (forcePlay) {
      setScreen("play");
    } else {
      setScreen((prev) => (prev === "gallery" ? "gallery" : "play"));
    }
    setRoundType(data.roundType || "normal");
    setDrawPhase(data.drawPhase || "drawing");
    setDrawerId(data.drawerId || "");
    setDrawerName(data.drawerName || "");
    setDrawerNames(data.drawerNames || data.coopNames || []);
    setWord(data.word ?? null);
    setPlayers(data.players || []);
    setCanDraw(!!data.canDraw);
    setCanNextRound(!!data.canNextRound);
    setTurnEndsAt(data.turnEndsAt ?? null);
    setRelayIndex(data.relayIndex ?? null);
    setRelayTotal(data.relayTotal ?? null);
    setTurnDurationSec(data.turnDurationSec ?? null);
    setIsLiar(!!data.isLiar);
    setCanReveal(!!data.canReveal);
    setLiarName(data.liarName || "");
    setCanFinishGradual(!!data.canFinishGradual);
    setCanRevealAnswer(!!data.canRevealAnswer);
    setCanPassRound(!!data.canPassRound);
    setConstraint(data.constraint || null);
    setStrokesUsed(data.constraintStrokesUsed ?? 0);
    setPartAssignment(data.partAssignment || null);
    setPartsVariant(data.partsVariant || "normal");
    setPartsStage(data.partsStage ?? -1);
    setPartsStageLabel(data.partsStageLabel || "");
    setPartsCredits(data.partsCredits || []);
    setCanStartParts(!!data.canStartParts);
    setCanAssembleParts(!!data.canAssembleParts);
    setCanHighlightPart(!!data.canHighlightPart);
    const nextRoundId = data.roundId ?? null;
    roundIdRef.current = nextRoundId;
    setRoundId(nextRoundId);
    setRoundNumber(data.roundNumber ?? 0);
    setTotalRounds(data.totalRounds ?? 0);
    setAdvancing(false);
    setFinishBusy(false);
  }

  function resetPlayState() {
    setDrawerId("");
    setDrawerName("");
    setDrawerNames([]);
    setWord(null);
    setRoundType("normal");
    setDrawPhase("drawing");
    setCanDraw(false);
    setCanNextRound(false);
    setTurnEndsAt(null);
    setRemainSec(null);
    setRelayIndex(null);
    setRelayTotal(null);
    setTurnDurationSec(null);
    setIsLiar(false);
    setCanReveal(false);
    setLiarName("");
    setCanFinishGradual(false);
    setCanRevealAnswer(false);
    setCanPassRound(false);
    setConstraint(null);
    setStrokesUsed(0);
    setPartAssignment(null);
    setPartsVariant("normal");
    setPartsStage(-1);
    setPartsStageLabel("");
    setPartsCredits([]);
    setCanStartParts(false);
    setCanAssembleParts(false);
    setCanHighlightPart(false);
    markDrawing(false);
    roundIdRef.current = null;
    setRoundId(null);
    setAdvancing(false);
  }

  function resetGameProgress() {
    setRoundNumber(0);
    setTotalRounds(0);
    setExtensionRounds(3);
    setFinishBusy(false);
    dismissedHighlightRef.current = null;
    highlightImageCacheRef.current.clear();
    highlightImageRunRef.current = null;
    setHighlight(null);
  }

  function showFinished(data, { resetBusy = true } = {}) {
    resetPlayState();
    setError("");
    setRoundNumber(data?.completedRounds ?? data?.totalRounds ?? 0);
    setTotalRounds(data?.totalRounds ?? 0);
    setExtensionRounds(data?.extensionRounds ?? 3);
    if (resetBusy) setFinishBusy(false);
    setReturnScreen("finished");
    setScreen((prev) => (prev === "gallery" ? "gallery" : "finished"));
  }

  useEffect(() => {
    playerIdRef.current = playerId;
  }, [playerId]);

  useEffect(() => {
    if (roundType !== "parts" || drawPhase !== "drawing") return;
    const frame = requestAnimationFrame(() => {
      const easel = easelRef.current;
      if (!easel) return;
      const top = easel.getBoundingClientRect().top + window.scrollY - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [roundType, drawPhase, roundId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!fanfare) return;
    const t = setTimeout(() => setFanfare(null), 2200);
    return () => clearTimeout(t);
  }, [fanfare]);

  // 今日のハイライト: サーバーの絶対時刻に合わせ、復帰後も同じ位置へ戻す
  useEffect(() => {
    if (!highlight) return;
    const { ids, startedAt, msPerItem, endsAt } = highlight;

    function syncHighlightPosition() {
      const now = Date.now() + serverOffsetRef.current;
      setHighlight((current) => {
        if (!current || current.startedAt !== startedAt) return current;
        if (now >= endsAt) return null;
        const preparing = now < startedAt;
        const elapsed = Math.max(0, now - startedAt);
        const next = Math.min(
          ids.length - 1,
          Math.floor(elapsed / msPerItem)
        );
        return current.index === next && current.preparing === preparing
          ? current
          : { ...current, index: next, preparing };
      });
    }

    syncHighlightPosition();
    const timer = setInterval(syncHighlightPosition, 200);
    return () => clearInterval(timer);
  }, [
    highlight?.ids,
    highlight?.startedAt,
    highlight?.msPerItem,
    highlight?.endsAt,
  ]);

  // 現在と次の2枚をデコード済みで保持し、表示時間を読み込みに使わせない
  useEffect(() => {
    if (!highlight || typeof Image === "undefined") return;
    const nextIds = new Set(
      highlight.ids.slice(highlight.index, highlight.index + 3)
    );
    const cache = highlightImageCacheRef.current;
    for (const id of cache.keys()) {
      if (!nextIds.has(id)) cache.delete(id);
    }
    for (const item of gallery) {
      if (!nextIds.has(item.id) || !item.imageDataUrl) continue;
      if (cache.has(item.id)) continue;
      const image = new Image();
      image.src = item.imageDataUrl;
      cache.set(item.id, image);
      image.decode?.().catch(() => {});
    }
  }, [gallery, highlight?.ids, highlight?.index, highlight?.startedAt]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (!turnEndsAt) {
      setRemainSec(null);
      return;
    }
    function tick() {
      setRemainSec(
        formatRemain(turnEndsAt - (Date.now() + serverOffsetRef.current))
      );
    }
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [turnEndsAt]);

  useEffect(() => {
    let released = false;

    async function requestWakeLock() {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
        return;
      }
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (released) {
          await lock.release();
          return;
        }
        wakeLockRef.current = lock;
        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) wakeLockRef.current = null;
        });
      } catch {
        // 対応端末以外・権限拒否は無視
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") requestWakeLock();
    }

    requestWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on("lobbyUpdate", (data) => {
      setRoomCode(data.code);
      setPlayers(data.players || []);
      setHostId(data.hostId);
      if (data.phase === "lobby") {
        setReturnScreen("lobby");
        setScreen((prev) => (prev === "gallery" ? "gallery" : "lobby"));
        resetPlayState();
        resetGameProgress();
      } else if (data.phase === "finished") {
        showFinished(data, { resetBusy: false });
      }
    });

    socket.on("roundStart", (data) => {
      applyRoundPayload(data, { forcePlay: true });
    });

    socket.on("roundUpdate", (data) => {
      applyRoundPayload(data, { forcePlay: false });
    });

    socket.on("clearCanvas", () => {
      setClearToken((n) => n + 1);
      setHistorySeed({ token: 0, strokes: [] });
      markDrawing(false);
    });

    socket.on("gameEnded", (data) => {
      setReturnScreen("lobby");
      setScreen((prev) => (prev === "gallery" ? "gallery" : "lobby"));
      resetPlayState();
      resetGameProgress();
      setClearToken((n) => n + 1);
      if (data?.reason === "alone") {
        setToast("みんな出ちゃったのでロビーにもどったよ");
      }
    });

    socket.on("gameFinished", (data) => {
      showFinished(data);
    });

    socket.on("gameExtended", (data) => {
      setTotalRounds(data?.totalRounds ?? 0);
      setFinishBusy(false);
      setToast(`あと${data?.addedRounds || 3}問、延長！`);
    });

    socket.on("stroke", (data) => {
      window.dispatchEvent(new CustomEvent("remote-stroke", { detail: data }));
      if (data?.type === "move") markDrawing(true);
    });

    socket.on("partsLayer", (data) => {
      if (
        Number.isInteger(data?.roundId) &&
        data.roundId !== roundIdRef.current
      ) {
        return;
      }
      setPartsStage(data?.stage ?? -1);
      setPartsStageLabel(data?.label || "");
      const strokes = Array.isArray(data?.strokes) ? data.strokes : [];
      for (const stroke of strokes) {
        window.dispatchEvent(
          new CustomEvent("remote-stroke", { detail: stroke })
        );
      }
      if (strokes.some((stroke) => stroke?.type === "move")) {
        markDrawing(true);
      }
    });

    socket.on("partsHighlight", (data) => {
      if (
        Number.isInteger(data?.roundId) &&
        data.roundId !== roundIdRef.current
      ) {
        return;
      }
      canvasApiRef.current?.flashPlayer?.(data?.playerId);
      if (data?.name && data?.label) {
        setToast(`✨ ${data.label}は ${data.name}作！`);
      }
    });

    socket.on("partsComplete", (data) => {
      if (
        Number.isInteger(data?.roundId) &&
        data.roundId !== roundIdRef.current
      ) {
        return;
      }
      setToast(
        data?.word ? `✨ 合体完了！「${data.word}」` : "✨ 合体完了！"
      );
    });

    socket.on("replayStart", () => {
      canvasApiRef.current?.playReplay();
    });

    socket.on("playerJoined", (data) => {
      if (data?.name) setToast(`${data.name}が遊びに来たよ！`);
    });

    socket.on("roundFanfare", (data) => {
      setFanfare(data);
      if (data?.message) setToast(data.message);
      if (data?.roundType === "coop" && data.names?.length) {
        setToast(`🤝 ${data.names.join("・")}が協力！`);
      }
      if (data?.roundType === "liar" && data.names?.length) {
        setToast(`🕵️ ${data.names.join("・")}のだれかがうそつき…！`);
      }
      if (data?.roundType === "parts") {
        setToast("🚨 全員参加！パーツを描いて強制合体！");
      }
      if (data?.constraint) {
        setToast(
          `${data.constraint.emoji} ${data.constraint.label}：${data.constraint.rule}`
        );
      }
    });

    // ふつう・のぞき穴ラウンドの答え発表
    socket.on("answerReveal", (data) => {
      if (!data?.word) return;
      setToast(`✅ こたえは「${data.word}」！`);
    });

    socket.on("roundPassed", (data) => {
      setToast(`⏭️ ${data?.name || "描き手"}がパス！ つぎのお題へ`);
    });

    socket.on("liarReveal", (data) => {
      if (!data?.liarName) return;
      setFanfare({
        roundType: "liar",
        message: `うそつきは ${data.liarName}！`,
      });
    });

    socket.on("drawerDisconnected", (data) => {
      if (data?.name) setToast(`${data.name}の接続が切れたよ…ちょっと待ってね`);
    });

    socket.on("playerReturned", (data) => {
      if (data?.name) setToast(`${data.name}がもどってきたよ！`);
    });

    socket.on("hostDisconnected", (data) => {
      if (data?.name) setToast(`ホストの${data.name}の接続が切れたよ…`);
    });

    socket.on("hostChanged", (data) => {
      if (data?.name) setToast(`👑 ${data.name}があたらしいホストになったよ！`);
    });

    socket.on("roundAborted", (data) => {
      if (data?.reason === "liarLeft") {
        setToast(`🕵️ うそつきの${data.name}が逃げた！やりなおし！`);
      } else if (data?.name) {
        setToast(`${data.name}がぬけたので、つぎのお題へ！`);
      }
    });

    socket.on("galleryUpdate", (data) => {
      setGallery(data.gallery || []);
    });

    socket.on("galleryItemAdded", (data) => {
      const item = data?.item;
      if (!item?.id) return;
      const removedIds = new Set(
        Array.isArray(data?.removedIds) ? data.removedIds : []
      );
      setGallery((items) => {
        const remaining = items.filter(
          (current) =>
            current.id !== item.id && !removedIds.has(current.id)
        );
        return [...remaining, item];
      });
    });

    socket.on("aiStateUpdate", (data) => {
      setAiState({ ...EMPTY_AI_STATE, ...data });
    });

    socket.on("aiAwardsReady", () => {
      setToast("🏆 AI画伯の授賞式がはじまるよ！");
    });

    // 今日のハイライト: 絶対時刻から現在位置を復元し、途中復帰にも追いつく
    socket.on("highlightStart", (data) => {
      if (Number.isFinite(data?.serverNow) && !clockSyncedRef.current) {
        // 通知の片道遅延ぶんだけ保守的だが、端末時計の大きなずれは防げる。
        serverOffsetRef.current = data.serverNow - Date.now();
      }
      const next = parseHighlightState(
        data,
        Date.now() + serverOffsetRef.current
      );
      if (!next || dismissedHighlightRef.current === next.startedAt) return;
      if (highlightImageRunRef.current !== next.startedAt) {
        highlightImageCacheRef.current.clear();
        highlightImageRunRef.current = next.startedAt;
      }
      setHighlight(next);
    });

    socket.on("highlightStop", () => {
      highlightImageCacheRef.current.clear();
      highlightImageRunRef.current = null;
      setHighlight(null);
    });

    socket.on("strokeHistory", (data) => {
      const strokes = data?.strokes || [];
      setHistorySeed((prev) => ({
        token: prev.token + 1,
        strokes,
      }));
      markDrawing(strokes.some((ev) => ev?.type === "move"));
    });

    function syncClock() {
      clockSyncedRef.current = false;
      const t0 = Date.now();
      socket.emit("timeSync", (res) => {
        if (!res?.now) return;
        const t1 = Date.now();
        serverOffsetRef.current = res.now - (t0 + t1) / 2;
        clockSyncedRef.current = true;
      });
    }

    if (socket.connected) syncClock();
    socket.on("connect", syncClock);

    function tryRejoin() {
      const session = loadSession();
      if (initialInviteCode && session?.roomCode !== initialInviteCode) {
        setRestoring(false);
        return;
      }
      if (!session) {
        setRestoring(false);
        return;
      }
      setName(session.name);
      socket.emit(
        "rejoinRoom",
        {
          code: session.roomCode,
          playerId: session.playerId,
          resumeToken: session.resumeToken,
          name: session.name,
        },
        (res) => {
          setRestoring(false);
          if (!res?.ok) {
            clearSession();
            setScreen("home");
            setPlayerId("");
            setRoomCode("");
            return;
          }
          setPlayerId(res.playerId);
          setRoomCode(res.code);
          setPlayers(res.players || []);
          setHostId(res.hostId || "");
          saveSession({
            playerId: res.playerId,
            resumeToken: res.resumeToken,
            roomCode: res.code,
            name: session.name,
          });
          if (res.phase === "lobby") {
            setScreen("lobby");
          } else if (res.phase === "finished") {
            showFinished(res);
          }
          // playing は roundStart で play へ
        }
      );
    }

    if (socket.connected) tryRejoin();
    socket.on("connect", tryRejoin);

    function requestHighlightWhenVisible() {
      if (document.visibilityState !== "visible") return;
      socket.emit("requestHighlightState");
    }

    document.addEventListener("visibilitychange", requestHighlightWhenVisible);
    window.addEventListener("pageshow", requestHighlightWhenVisible);

    return () => {
      socket.off("connect", tryRejoin);
      document.removeEventListener(
        "visibilitychange",
        requestHighlightWhenVisible
      );
      window.removeEventListener("pageshow", requestHighlightWhenVisible);
      socket.disconnect();
    };
  }, []);

  const emitStroke = useMemo(
    () => (data) => {
      socketRef.current?.emit("stroke", {
        ...data,
        roundId: roundIdRef.current,
      });
      if (data?.type === "move") markDrawing(true);
    },
    []
  );

  /** 爆笑リプレイ: みんなの画面で同時に早送り再生する */
  function requestReplay() {
    if (replaying) return;
    setError("");
    socketRef.current?.emit("broadcastReplay", (res) => {
      // 断られたら流さない（自分だけ再生すると、止めた意味がなくなる）
      if (!res?.ok) setError(res?.error || "いまはリプレイできません");
    });
  }

  function createRoom() {
    setError("");
    const trimmed = name.trim();
    socketRef.current?.emit("createRoom", { name: trimmed }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "作成に失敗しました");
        return;
      }
      setPlayerId(res.playerId);
      setRoomCode(res.code);
      setPlayers(res.players || []);
      setHostId(res.hostId || res.playerId);
      saveSession({
        playerId: res.playerId,
        resumeToken: res.resumeToken,
        roomCode: res.code,
        name: trimmed,
      });
      resetGameProgress();
      setScreen("lobby");
    });
  }

  function joinRoom() {
    setError("");
    const trimmed = name.trim();
    const code = normalizeRoomCode(joinCode);
    socketRef.current?.emit(
      "joinRoom",
      { code, name: trimmed },
      (res) => {
        if (!res?.ok) {
          setError(res?.error || "入室に失敗しました");
          return;
        }
        setPlayerId(res.playerId);
        setRoomCode(res.code);
        setPlayers(res.players || []);
        setHostId(res.hostId || "");
        saveSession({
          playerId: res.playerId,
          resumeToken: res.resumeToken,
          roomCode: res.code,
          name: trimmed,
        });
        setInviteCode("");
        removeInviteRoomCodeFromUrl();
        if (res.phase === "playing") {
          setScreen("play");
        } else if (res.phase === "finished") {
          showFinished(res);
        } else {
          setScreen("lobby");
        }
      }
    );
  }

  function leaveRoom() {
    setError("");
    socketRef.current?.emit("leaveRoom", () => {
      clearSession();
      setScreen("home");
      setInviteCode("");
      setJoinCode("");
      setRoomCode("");
      setPlayerId("");
      setPlayers([]);
      setHostId("");
      setGallery([]);
      setSelectedIds(new Set());
      setAiState(EMPTY_AI_STATE);
      setHighlight(null);
      setHistorySeed({ token: 0, strokes: [] });
      resetPlayState();
      resetGameProgress();
      removeInviteRoomCodeFromUrl();
    });
  }

  function cancelInvite() {
    setError("");
    setInviteCode("");
    setJoinCode("");
    removeInviteRoomCodeFromUrl();
  }

  async function shareInvite() {
    if (!inviteUrl) return;
    setError("");
    const shareData = {
      title: "おえかきあて",
      text: `部屋コード ${roomCode} に入って、一緒に遊ぼう！`,
      url: inviteUrl,
    };

    if (canShareInvite) {
      try {
        await navigator.share(shareData);
        setToast("招待リンクを共有しました");
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }

    try {
      await copyText(inviteUrl);
      setToast("招待リンクをコピーしました");
    } catch {
      setError("招待リンクをコピーできませんでした");
    }
  }

  function startGame() {
    setError("");
    socketRef.current?.emit("startGame", (res) => {
      if (!res?.ok) setError(res?.error || "開始できません");
    });
  }

  function nextRound() {
    if (advancing) return;
    setError("");
    setAdvancing(true);
    const imageDataUrl = canvasApiRef.current?.exportImage?.() || undefined;
    socketRef.current?.emit("nextRound", { imageDataUrl, roundId }, (res) => {
      setAdvancing(false);
      if (!res?.ok) setError(res?.error || "次へ進めません");
    });
  }

  function endGame() {
    setError("");
    if (screen === "finished") setFinishBusy(true);
    socketRef.current?.emit("endGame", (res) => {
      if (!res?.ok) {
        setFinishBusy(false);
        setError(res?.error || "終了できません");
      }
    });
  }

  function extendGame() {
    if (finishBusy) return;
    setError("");
    setFinishBusy(true);
    socketRef.current?.emit("extendGame", (res) => {
      if (!res?.ok) {
        setFinishBusy(false);
        setError(res?.error || "延長できません");
      }
    });
  }

  function requestAiAwards() {
    setError("");
    socketRef.current?.emit("requestAiAwards", (res) => {
      if (!res?.ok) {
        setError(res?.error || "授賞式を始められません");
      }
    });
  }

  function startHighlight() {
    setError("");
    socketRef.current?.emit("startHighlight", (res) => {
      if (!res?.ok) setError(res?.error || "ハイライトを始められません");
    });
  }

  function revealLiar() {
    setError("");
    socketRef.current?.emit("revealLiar", (res) => {
      if (!res?.ok) setError(res?.error || "こたえあわせできません");
    });
  }

  function finishGradualDrawing() {
    setError("");
    socketRef.current?.emit("finishGradualDrawing", (res) => {
      if (!res?.ok) setError(res?.error || "全体を見せられません");
    });
  }

  function startPartsDrawing() {
    if (advancing) return;
    setError("");
    setAdvancing(true);
    socketRef.current?.emit("startPartsDrawing", { roundId }, (res) => {
      setAdvancing(false);
      if (!res?.ok) setError(res?.error || "ミッションを開始できません");
    });
  }

  function assembleParts() {
    if (advancing) return;
    setError("");
    setAdvancing(true);
    socketRef.current?.emit("assembleParts", { roundId }, (res) => {
      setAdvancing(false);
      if (!res?.ok) setError(res?.error || "パーツを合体できません");
    });
  }

  function highlightMyPart() {
    setError("");
    socketRef.current?.emit("highlightMyPart", { roundId }, (res) => {
      if (!res?.ok) setError(res?.error || "自分のパーツを光らせられません");
      else if (res?.stale) setToast("✨ いま別のパーツを光らせています");
    });
  }

  function revealAnswer() {
    if (advancing) return;
    setError("");
    setAdvancing(true);
    socketRef.current?.emit("revealAnswer", { roundId }, (res) => {
      setAdvancing(false);
      if (!res?.ok) setError(res?.error || "せいかい発表できません");
    });
  }

  function closeHighlight() {
    if (highlight?.startedAt != null) {
      dismissedHighlightRef.current = highlight.startedAt;
    }
    highlightImageCacheRef.current.clear();
    highlightImageRunRef.current = null;
    setHighlight(null);
  }

  function passRound() {
    if (advancing) return;
    setError("");
    setAdvancing(true);
    socketRef.current?.emit("passRound", { roundId }, (res) => {
      setAdvancing(false);
      if (!res?.ok) setError(res?.error || "パスできません");
    });
  }

  function leaveRoomWithConfirm() {
    if (!window.confirm("ほんとに部屋からでる？")) return;
    leaveRoom();
  }

  function openGallery(from) {
    setReturnScreen(from || screen);
    setGallerySelectMode(false);
    setSelectedIds(new Set());
    setScreen("gallery");
  }

  function closeGallery() {
    setGallerySelectMode(false);
    setSelectedIds(new Set());
    const next =
      returnScreen === "play"
        ? "play"
        : returnScreen === "finished"
          ? "finished"
          : "lobby";
    setScreen(next);
    if (next === "play") {
      // ギャラリー表示中はキャンバスが外れているので描き直す
      socketRef.current?.emit("requestStrokeHistory", (res) => {
        if (!res?.ok) return;
        const strokes = res.strokes || [];
        setHistorySeed((prev) => ({
          token: prev.token + 1,
          strokes,
        }));
        markDrawing(strokes.some((ev) => ev?.type === "move"));
      });
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    socketRef.current?.emit(
      "deleteGalleryItems",
      { ids: [...selectedIds] },
      (res) => {
        if (!res?.ok) setError(res?.error || "削除できません");
        else {
          setSelectedIds(new Set());
          setGallerySelectMode(false);
        }
      }
    );
  }

  function deleteAllGallery() {
    if (!gallery.length) return;
    if (!window.confirm("ギャラリーの絵を全部消しますか？")) return;
    socketRef.current?.emit("clearGallery", (res) => {
      if (!res?.ok) setError(res?.error || "削除できません");
      else {
        setSelectedIds(new Set());
        setGallerySelectMode(false);
      }
    });
  }

  async function saveImage(item) {
    const word = String(item.word || "").trim();
    const safeWord = (word || "picture").replace(/[\\/:*?"<>|]/g, "_");
    const title = word ? `おえかき「${word}」` : "おえかき";
    const mimeType =
      item.imageDataUrl?.match(/^data:(image\/(?:jpeg|png|webp));/)?.[1] ||
      "image/jpeg";
    const extension =
      { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[
        mimeType
      ] || "jpg";
    const filename = `${safeWord}-${String(item.id || "image").slice(0, 8)}.${extension}`;
    try {
      const res = await fetch(item.imageDataUrl);
      const blob = await res.blob();
      const file = new File([blob], filename, {
        type: blob.type || mimeType,
      });
      if (
        navigator.share &&
        navigator.canShare?.({ files: [file] })
      ) {
        await navigator.share({ files: [file], title, text: title });
        return;
      }
    } catch {
      // fall through to download
    }
    const a = document.createElement("a");
    a.href = item.imageDataUrl;
    a.download = filename;
    a.click();
  }

  function renderRelayOrder() {
    if (!drawerNames.length) return null;
    const current = relayIndex ?? 0;
    const drawing = drawPhase === "drawing";
    const total = drawerNames.length;
    return (
      <div className="info-block info-relay-order">
        <div className="info-label">
          {drawing ? `描く順番 ${Math.min(current + 1, total)}/${total}人目` : "描いた人"}
        </div>
        <div
          className="relay-order"
          style={{ "--relay-total": String(total) }}
          aria-label="描く順番"
        >
          {drawerNames.map((n, i) => {
            const isPast = drawing && i < current;
            const isCurrent = drawing && i === current;
            const label = isPast ? "✓" : isCurrent || !drawing ? n : "？";
            const className = isPast
              ? "relay-order-name is-done"
              : isCurrent
                ? "relay-order-name is-current"
                : drawing
                  ? "relay-order-name is-hidden"
                  : "relay-order-name is-done";
            const statusLabel = isPast
              ? `${i + 1}人目、${n}、完了`
              : isCurrent
                ? `${i + 1}人目、${n}、いま描いています`
                : drawing
                  ? `${i + 1}人目、まだ秘密`
                  : `${i + 1}人目、${n}`;
            return (
              <span key={`${n}-${i}`} className="relay-order-item">
                <span
                  className={className}
                  title={label === n ? n : undefined}
                  aria-label={statusLabel}
                >
                  {label}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  /** しばりは描き手だけでなく全員に見せる（知らないと、ただ下手な人になる） */
  function renderConstraint() {
    if (!constraint) return null;
    const remaining =
      constraint.kind === "strokes"
        ? Math.max(0, constraint.value - strokesUsed)
        : null;
    const mine = drawerId && playerId && drawerId === playerId;
    return (
      <div className="info-block info-constraint">
        <div className="info-label">🎲 このお題のしばり</div>
        <div className="constraint-value">
          {constraint.emoji} {constraint.label}
        </div>
        <p className="constraint-rule">{constraint.rule}</p>
        {mine && drawPhase === "drawing" && (
          <p className="hint">{constraint.hint}</p>
        )}
        {remaining != null && mine && drawPhase === "drawing" && (
          <div
            className={`constraint-gauge${remaining === 0 ? " is-empty" : ""}`}
            aria-label={`のこり${remaining}本`}
          >
            {Array.from({ length: constraint.value }, (_, i) => (
              <span
                key={i}
                className={`constraint-tick${i < remaining ? "" : " is-used"}`}
              />
            ))}
            <span className="constraint-remain">
              {remaining === 0 ? "つかいきった！" : `のこり ${remaining}本`}
            </span>
          </div>
        )}
      </div>
    );
  }

  /** 今日のハイライト: 全員の画面で同時に、今日の絵を1枚ずつめくる */
  function renderHighlight() {
    if (!highlight) return null;
    if (highlight.preparing) {
      return (
        <div className="highlight" role="status" aria-live="polite">
          <div className="highlight-inner">
            <div className="highlight-countdown" aria-hidden="true">
              🎬
            </div>
            <div className="highlight-word">まもなくスタート！</div>
            <div className="highlight-count">全{highlight.ids.length}枚</div>
            <button
              type="button"
              className="highlight-close"
              onClick={closeHighlight}
            >
              とじる
            </button>
          </div>
        </div>
      );
    }
    const total = highlight.ids.length;
    const shown = highlight.index + 1;
    const item = gallery.find((g) => g.id === highlight.ids[highlight.index]);
    const drawers = (item?.drawerNames || []).join("・");
    return (
      <div className="highlight" role="status" aria-live="polite">
        <div className="highlight-inner">
          <div className="highlight-eyebrow">🎬 今日のハイライト</div>
          <div className="highlight-frame">
            {item ? (
              <img
                key={item.id}
                src={item.imageDataUrl}
                alt={item.word || "絵"}
                decoding="sync"
              />
            ) : (
              <div className="highlight-missing">絵を読み込み中…</div>
            )}
          </div>
          <div className="highlight-word">{item?.word || "？？？"}</div>
          {drawers && <div className="highlight-drawers">{drawers}</div>}
          <div className="highlight-track">
            <div
              className="highlight-fill"
              style={{ width: `${(shown / total) * 100}%` }}
            />
          </div>
          <div className="highlight-count">
            {shown} / {total}
          </div>
          <button
            type="button"
            className="highlight-close"
            onClick={closeHighlight}
          >
            とじる
          </button>
        </div>
      </div>
    );
  }

  function renderRoundProgress() {
    if (!roundNumber || !totalRounds) return null;
    const isLast = roundNumber >= totalRounds;
    return (
      <span
        className={`round-progress${isLast ? " is-last" : ""}`}
        aria-label={`お題 ${roundNumber}問目、全${totalRounds}問`}
      >
        お題 {roundNumber}/{totalRounds}
      </span>
    );
  }

  function renderPlayHeader() {
    if (roundType === "parts") {
      const variantLabel =
        partsVariant === "mystery"
          ? "ひとりだけお題なし"
          : partsVariant === "secret"
            ? "秘密指令あり"
            : "全員合体";
      const secretCredits = partsCredits.filter(
        (credit) => credit.secretInstruction
      );
      const mysteryCredit = partsCredits.find(
        (credit) => credit.wasWordHidden
      );
      const contributingCredits = partsCredits.filter(
        (credit) => credit.hasDrawing
      );
      const missingCredits = partsCredits.filter(
        (credit) => !credit.hasDrawing
      );
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill parts-pill">🚨 ハプニング</span>
          </div>

          {drawPhase === "assembling" ? (
            <div className="parts-assembly-status" role="status" aria-live="polite">
              <div className="parts-assembly-kicker">パーツ強制合体中</div>
              <div className="parts-assembly-title">
                {partsStageLabel || "輸送ルートを接続中…"}
              </div>
              <div className="parts-stage-track" aria-label="合体の進み具合">
                {[0, 1, 2, 3].map((stage) => (
                  <span
                    key={stage}
                    className={stage <= partsStage ? "is-active" : ""}
                  />
                ))}
              </div>
            </div>
          ) : drawPhase === "reveal" ? (
            <>
              <div className="parts-complete" role="status">
                <div className="parts-complete-burst" aria-hidden="true">✨</div>
                <div>
                  <div className="info-label">合体完了！ お題は</div>
                  <div className="prompt-value">{word || "？？？"}</div>
                </div>
              </div>
              <p className="hint">
                {contributingCredits.length
                  ? `${contributingCredits.length}人のパーツが1枚になりました`
                  : partsCredits.length
                    ? "今回はパーツが間に合いませんでした"
                  : "みんなのパーツが1枚になりました"}
              </p>
              {partAssignment && (
                <div className="parts-my-credit">
                  あなたは「{partAssignment.label}」を担当
                </div>
              )}
              {(mysteryCredit ||
                secretCredits.length > 0 ||
                missingCredits.length > 0) && (
                <div className="parts-reveal-notes">
                  {mysteryCredit && (
                    <div>
                      🕵️ お題を知らなかったのは
                      <strong>{mysteryCredit.playerName}</strong>！
                    </div>
                  )}
                  {secretCredits.map((credit) => (
                    <div key={credit.playerId}>
                      🤫 {credit.playerName}の「{credit.label}」：
                      <strong>{credit.secretInstruction}</strong>
                    </div>
                  ))}
                  {missingCredits.length > 0 && (
                    <div>
                      ⏳ 未提出パーツ：
                      <strong>
                        {missingCredits
                          .map(
                            (credit) =>
                              `${credit.label}（${credit.playerName}）`
                          )
                          .join("・")}
                      </strong>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="parts-mission-row">
                <span className="parts-variant">{variantLabel}</span>
                {word ? (
                  <span className="parts-word">お題：{word}</span>
                ) : (
                  <span className="parts-word is-mystery">
                    お題は知らされていません
                  </span>
                )}
              </div>

              {partAssignment ? (
                <div className="info-block parts-assignment">
                  <div className="info-label">あなたの担当パーツ</div>
                  <div className="parts-assignment-value">
                    {partAssignment.label}
                  </div>
                  <p className="hint">{partAssignment.hint}</p>
                </div>
              ) : (
                <div className="info-block parts-assignment">
                  <div className="parts-assignment-value">見届け役</div>
                  <p className="hint">途中参加のため、今回は合体を見守ってね</p>
                </div>
              )}

              {partAssignment?.secretInstruction && (
                <div className="parts-secret">
                  <span>🤫 秘密指令</span>
                  {partAssignment.secretInstruction}
                </div>
              )}

              {drawPhase === "briefing" && (
                <p className="hint">ガイドの場所を確認して、開始の合図を待とう！</p>
              )}
              {drawPhase === "drawing" && (
                <p className="hint">ほかの人の絵は合体するまで見えません</p>
              )}
              {drawPhase === "ready" && (
                <div className="parts-ready" role="status">
                  📦 パーツ送信完了！ ホストの合体待ち…
                </div>
              )}
            </>
          )}

          {remainSec != null && drawPhase === "drawing" && (
            <div className="timer-bar" aria-live="polite">
              <div className="timer-label">のこり {remainSec}びょう</div>
              <div className="timer-track">
                <div
                  className="timer-fill parts"
                  style={{
                    width: `${Math.min(
                      100,
                      (remainSec / Math.max(1, turnDurationSec || 8)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
        </>
      );
    }

    if (roundType === "relay") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill relay-pill">リレー</span>
          </div>
          {drawPhase === "drawing" ? (
            canDraw ? (
              <div className="info-block info-prompt">
                <div className="info-label">あなたの番！ お題</div>
                <div className="prompt-value">{word}</div>
              </div>
            ) : (
              <>
                {word && (
                  <div className="info-block info-prompt">
                    <div className="info-label">お題</div>
                    <div className="prompt-value">{word}</div>
                  </div>
                )}
                {renderRelayOrder()}
                <p className="hint">
                  {word
                    ? "つぎの人が継ぎ足してるよ…"
                    : "絵を見て当てよう！"}
                </p>
              </>
            )
          ) : (
            <>
              {word ? (
                <div className="info-block info-prompt">
                  <div className="info-label">お題</div>
                  <div className="prompt-value">{word}</div>
                  <p className="hint">みんなで当てよう！</p>
                </div>
              ) : (
                <div className="info-block info-drawer">
                  <div className="info-label">あてっこタイム</div>
                  <div className="drawer-value">なにだろう？</div>
                  <p className="hint">絵を見て、当てよう！</p>
                </div>
              )}
              {!canDraw && renderRelayOrder()}
            </>
          )}
          {remainSec != null && drawPhase === "drawing" && (
            <div className="timer-bar" aria-live="polite">
              <div className="timer-label">のこり {remainSec}びょう</div>
              <div className="timer-track">
                <div
                  className="timer-fill"
                  style={{
                    width: `${Math.min(
                      100,
                      (remainSec / Math.max(1, turnDurationSec || 10)) * 100
                    )}%`,
                  }}
                />
              </div>
              {relayTotal != null && (
                <div className="timer-sub">
                  {(relayIndex ?? 0) + 1} / {relayTotal} 人目
                </div>
              )}
            </div>
          )}
        </>
      );
    }

    if (roundType === "liar") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill liar-pill">うそつき</span>
          </div>
          {drawPhase === "drawing" && (
            <>
              {isLiar ? (
                <div className="info-block info-drawer">
                  <div className="info-label">🕵️ きみは うそつき！</div>
                  <div className="drawer-value">お題を知らないのは きみだけ</div>
                  <p className="hint">バレないように、それっぽく描こう！</p>
                </div>
              ) : word ? (
                <>
                  <div className="info-block info-prompt">
                    <div className="info-label">みんなのお題</div>
                    <div className="prompt-value">{word}</div>
                  </div>
                  <p className="hint">ひとりだけ、お題を知らずに描いてるよ…</p>
                </>
              ) : (
                <div className="info-block info-drawer">
                  <div className="info-label">うそつきお絵かき中</div>
                  <div className="drawer-value">
                    {drawerNames.length ? drawerNames.join("・") : "？？？"}
                  </div>
                  <p className="hint">
                    この中のひとりは お題を知らない！絵も当てよう！
                  </p>
                </div>
              )}
              {remainSec != null && (
                <div className="timer-bar" aria-live="polite">
                  <div className="timer-label">のこり {remainSec}びょう</div>
                  <div className="timer-track">
                    <div
                      className="timer-fill liar"
                      style={{
                        width: `${Math.min(
                          100,
                          (remainSec / Math.max(1, turnDurationSec || 40)) * 100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
          {drawPhase === "guessing" && (
            <>
              <div className="info-block info-drawer">
                <div className="info-label">さあ、もんだいです</div>
                <div className="drawer-value">
                  お題を知らずに描いたのは だれでしょう？
                </div>
              </div>
              <div className="info-block info-relay-order">
                <div className="info-label">ようぎしゃ</div>
                <div
                  className="relay-order"
                  style={{ "--relay-total": String(drawerNames.length || 1) }}
                >
                  {drawerNames.map((n, i) => (
                    <span key={`${n}-${i}`} className="relay-order-name is-done">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
              <p className="hint">口で話し合って当てよう！</p>
            </>
          )}
          {drawPhase === "reveal" && (
            <>
              <div className="info-block info-drawer">
                <div className="info-label">こたえ</div>
                <div className="drawer-value">🕵️ うそつきは {liarName}！</div>
              </div>
              {word && (
                <div className="info-block info-prompt">
                  <div className="info-label">お題は</div>
                  <div className="prompt-value">{word}</div>
                </div>
              )}
            </>
          )}
        </>
      );
    }

    if (roundType === "coop") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill coop-pill">協力</span>
          </div>
          {word ? (
            <>
              <div className="info-block info-prompt">
                <div className="info-label">みんなのお題</div>
                <div className="prompt-value">{word}</div>
              </div>
              <div className="info-block info-drawer">
                <div className="info-label">描いている人</div>
                <div className="drawer-value">
                  {drawerNames.length ? drawerNames.join("・") : "？？？"}
                </div>
              </div>
            </>
          ) : (
            <div className="info-block info-drawer">
              <div className="info-label">いま協力中</div>
              <div className="drawer-value">
                {drawerNames.length ? drawerNames.join("・") : "？？？"}
              </div>
              <p className="hint">絵を見て、当てよう！</p>
            </div>
          )}
          {remainSec != null && drawPhase === "drawing" && (
            <div className="timer-bar" aria-live="polite">
              <div className="timer-label">のこり {remainSec}びょう</div>
              <div className="timer-track">
                <div
                  className="timer-fill coop"
                  style={{
                    width: `${Math.min(
                      100,
                      (remainSec / Math.max(1, turnDurationSec || 40)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
          {drawPhase === "guessing" && (
            <p className="hint">あてっこタイム！</p>
          )}
        </>
      );
    }

    if (roundType === "gradual") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill peephole-pill">のぞき穴</span>
          </div>
          {drawPhase === "reveal" ? (
            <div className="info-block info-answer">
              <div className="info-label">✅ こたえ</div>
              <div className="prompt-value">{word}</div>
              <p className="hint">{drawerName}が描きました</p>
            </div>
          ) : word ? (
            <>
              <div className="info-block info-prompt">
                <div className="info-label">あなたのお題</div>
                <div className="prompt-value">{word}</div>
              </div>
              <p className="hint">
                {drawPhase === "drawing"
                  ? "みんなには動く穴の中だけ見えてるよ。当たったら「せいかい！」"
                  : "全体オープン！ 当てられたら「せいかい！」を押してね"}
              </p>
            </>
          ) : drawPhase === "drawing" ? (
            <div className="info-block info-drawer">
              <div className="info-label">🔍 のぞき穴おえかき</div>
              <div className="drawer-value">{drawerName}</div>
              <p className="hint">動く穴を追いかけて、絵を当てよう！</p>
            </div>
          ) : (
            <div className="info-block info-drawer">
              <div className="info-label">👀 全体オープン！</div>
              <div className="drawer-value">ラストチャンス！</div>
              <p className="hint">絵を見て、答えをさけぼう！</p>
            </div>
          )}
          {remainSec != null && drawPhase === "drawing" && (
            <div className="timer-bar" aria-live="polite">
              <div className="timer-label">のこり {remainSec}びょう</div>
              <div className="timer-track">
                <div
                  className="timer-fill gradual"
                  style={{
                    width: `${Math.min(
                      100,
                      (remainSec / Math.max(1, turnDurationSec || 40)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
        </>
      );
    }

    // normal
    return (
      <>
        <div className="meta row-meta">
          <span>部屋 {roomCode}</span>
          {renderRoundProgress()}
          {constraint && (
            <span className="mode-pill constraint-pill">しばり</span>
          )}
        </div>
        {drawPhase === "reveal" ? (
          <div className="info-block info-answer">
            <div className="info-label">✅ こたえ</div>
            <div className="prompt-value">{word}</div>
            <p className="hint">{drawerName}が描きました</p>
          </div>
        ) : word ? (
          <>
            <div className="info-block info-prompt">
              <div className="info-label">あなたのお題</div>
              <div className="prompt-value">{word}</div>
            </div>
            <p className="hint">
              当てられたら「せいかい！」を押してね
            </p>
          </>
        ) : (
          <div className="info-block info-drawer">
            <div className="info-label">いま描いている人</div>
            <div className="drawer-value">{drawerName}</div>
            <p className="hint">絵を見て、当てよう！</p>
          </div>
        )}
        {renderConstraint()}
        {remainSec != null && drawPhase === "drawing" && (
          <div className="timer-bar" aria-live="polite">
            <div className="timer-label">のこり {remainSec}びょう</div>
            <div className="timer-track">
              <div
                className="timer-fill constraint"
                style={{
                  width: `${Math.min(
                    100,
                    (remainSec / Math.max(1, turnDurationSec || 10)) * 100
                  )}%`,
                }}
              />
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={`app${screen === "play" ? " is-playing" : ""} ${screen === "play" ? modeClass : ""}`}
    >
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {renderHighlight()}

      {fanfare && (
        <div className={`fanfare fanfare-${fanfare.roundType}`} role="status">
          <div className="fanfare-inner">
            <div className="fanfare-text">{fanfare.message}</div>
            {fanfare.roundType === "coop" && fanfare.names?.length > 0 && (
              <div className="fanfare-sub">{fanfare.names.join("・")}</div>
            )}
            {fanfare.roundType === "parts" && (
              <div className="fanfare-sub">
                {fanfare.subtitle || "バラバラ合体お絵かき！"}
              </div>
            )}
            {fanfare.constraint && (
              <div className="fanfare-sub fanfare-constraint-sub">
                {fanfare.constraint.emoji} {fanfare.constraint.label}
                <span>{fanfare.constraint.rule}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <header className="brand">
        <h1>おえかきあて</h1>
        <p>キャンバスに描いて、みんなで当てよう</p>
      </header>

      {restoring && (
        <div className="card">
          <p className="hint">部屋に戻っています…</p>
        </div>
      )}

      {!restoring && screen === "home" && (
        <div className="card">
          {inviteCode && (
            <div className="invite-join-summary">
              <div className="label">招待された部屋</div>
              <div className="invite-room-code">部屋 {inviteCode}</div>
              <p className="hint">なまえを入れるだけで参加できます</p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="player-name">
              なまえ
            </label>
            <input
              id="player-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  inviteCode &&
                  name.trim() &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  joinRoom();
                }
              }}
              placeholder="例：たろう"
              maxLength={12}
              autoComplete="off"
              enterKeyHint={inviteCode ? "go" : "next"}
              autoFocus={!!inviteCode}
            />
          </div>

          {inviteCode ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={joinRoom}
                disabled={!name.trim()}
              >
                この部屋にはいる
              </button>
              <button type="button" className="quiet" onClick={cancelInvite}>
                ほかの方法で参加する
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={createRoom} disabled={!name.trim()}>
                部屋をつくる
              </button>

              <div className="divider-or">または</div>

              <div>
                <label className="label" htmlFor="join-code">
                  部屋コード（4桁）
                </label>
                <input
                  id="join-code"
                  value={joinCode}
                  onChange={(e) =>
                    setJoinCode(normalizeRoomCode(e.target.value))
                  }
                  placeholder="1234"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="off"
                />
              </div>

              <button
                type="button"
                className="secondary"
                onClick={joinRoom}
                disabled={!name.trim() || joinCode.length !== 4}
              >
                部屋にはいる
              </button>
            </>
          )}

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {!restoring && screen === "lobby" && (
        <div className="card tape-teal">
          <div className="label">部屋コード</div>
          <div className="code-big">{roomCode}</div>
          <p className="hint">このコードをみんなに教えて入室してもらおう</p>
          {aiState.enabled && (
            <div className="ai-enabled-badge">✨ AI画伯が参加します</div>
          )}

          {isHost && inviteUrl && (
            <section className="invite-panel" aria-labelledby="invite-title">
              <div className="label" id="invite-title">
                QRコードで招待
              </div>
              <div className="qr-frame">
                <QRCodeCanvas
                  value={inviteUrl}
                  size={184}
                  level="M"
                  marginSize={2}
                  role="img"
                  aria-label={`部屋 ${roomCode} の招待QRコード`}
                />
              </div>
              <p className="hint">
                QRを読んだ人は、なまえを入れるだけで参加できます
              </p>
              <button
                type="button"
                className="secondary"
                onClick={shareInvite}
              >
                {canShareInvite
                  ? "招待リンクを送る"
                  : "招待リンクをコピー"}
              </button>
            </section>
          )}

          <div className="label">さんかしゃ（{players.length}/20）</div>
          <ul className="players">
            {players.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                {p.isHost && <span className="badge">ホスト</span>}
              </li>
            ))}
          </ul>

          <div className="actions">
            {isHost && (
              <>
                <button
                  type="button"
                  onClick={startGame}
                  disabled={players.length < 2}
                >
                  はじめる！
                </button>
                <p className="hint">2人以上で開始できます</p>
              </>
            )}
            {!isHost && <p className="hint">ホストの開始待ち…</p>}
            <button
              type="button"
              className="secondary"
              onClick={() => openGallery("lobby")}
            >
              ギャラリー（{gallery.length}）
            </button>
            <button type="button" className="secondary" onClick={leaveRoom}>
              部屋をでる
            </button>
          </div>

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {!restoring && screen === "finished" && (
        <div className="card tape-yellow finish-card">
          <div className="finish-icon" aria-hidden="true">
            🎉
          </div>
          <div className="finish-title">全{totalRounds}問 おしまい！</div>
          <p className="finish-summary">
            みんなで{totalRounds}このお題を描きました
          </p>

          {aiState.awardCandidateCount >= 2 && (
            <section className="highlight-panel">
              {isHost ? (
                <>
                  <button
                    type="button"
                    className="highlight-btn"
                    onClick={startHighlight}
                    disabled={!!highlight}
                  >
                    🎬 今日のハイライトを見る（{aiState.awardCandidateCount}枚）
                  </button>
                  <p className="hint">
                    みんなの画面で いっしょに流れます
                  </p>
                </>
              ) : (
                <p className="hint">
                  🎬 ホストがハイライトを流せます
                </p>
              )}
            </section>
          )}

          {aiState.enabled && (
            <section className="ai-ceremony" aria-labelledby="ai-awards-title">
              <div className="ai-eyebrow">AI画伯 presents</div>
              <h2 id="ai-awards-title">みんなの授賞式</h2>

              {aiState.awardsStatus === "generating" && (
                <div className="ai-busy" role="status">
                  <span className="ai-busy-icon" aria-hidden="true">
                    🎨
                  </span>
                  作品を見ながら賞を考えています…
                </div>
              )}

              {aiState.awardsStatus === "ready" &&
                aiState.awards?.awards?.length > 0 && (
                  <>
                    <p className="ai-ceremony-intro">
                      {aiState.awards.intro}
                    </p>
                    <ol className="ai-award-list">
                      {aiState.awards.awards.map((award) => {
                        const item = gallery.find(
                          (candidate) =>
                            candidate.id === award.galleryItemId
                        );
                        return (
                          <li
                            key={`${award.galleryItemId}-${award.title}`}
                            className={`ai-award-item${item ? "" : " no-image"}`}
                          >
                            {item && (
                              <img
                                src={item.imageDataUrl}
                                alt={item.word || "受賞作品"}
                                loading="lazy"
                                decoding="async"
                              />
                            )}
                            <div>
                              <strong>🏆 {award.title}</strong>
                              {item && (
                                <span className="ai-award-work">
                                  「{item.word}」
                                  {(item.drawerNames || []).length > 0 &&
                                    `／${item.drawerNames.join("・")}`}
                                </span>
                              )}
                              <p>{award.reason}</p>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </>
                )}

              {(aiState.awardsStatus === "idle" ||
                aiState.awardsStatus === "error") && (
                <>
                  {aiState.awardCandidateCount < 2 ? (
                    <p className="ai-ceremony-note">
                      絵が2枚以上あると授賞式を開けます
                    </p>
                  ) : (
                    <p className="ai-ceremony-note">
                      それぞれ違う魅力を、楽しい賞にして発表します
                    </p>
                  )}
                  {aiState.awardsError && (
                    <p className="error" role="alert">
                      {aiState.awardsError}
                    </p>
                  )}
                  {isHost &&
                  (aiState.awardsStatus === "idle" ||
                    aiState.canRetryAwards) ? (
                    <button
                      type="button"
                      className="ai-awards-button"
                      onClick={requestAiAwards}
                      disabled={aiState.awardCandidateCount < 2}
                    >
                      {aiState.awardsStatus === "error"
                        ? "授賞式をもう一度ためす"
                        : "AI授賞式をはじめる"}
                    </button>
                  ) : !isHost ? (
                    <p className="hint">ホストが授賞式を始められます</p>
                  ) : (
                    <p className="hint">
                      このゲームの授賞式は終了しました
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {isAiFinishBusy && (
            <p className="finish-wait" role="status">
              AI授賞式を準備中です。完成すると延長・ロビーへ戻る操作ができます
            </p>
          )}

          <div className="actions">
            {isHost ? (
              <>
                <button
                  type="button"
                  onClick={extendGame}
                  disabled={finishBusy || isAiFinishBusy}
                >
                  あと{extensionRounds}問だけ延長！
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={endGame}
                  disabled={finishBusy || isAiFinishBusy}
                >
                  ロビーへ戻る
                </button>
              </>
            ) : (
              <p className="finish-wait" role="status" aria-live="polite">
                ホストが決めています…
              </p>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => openGallery("finished")}
              disabled={finishBusy}
            >
              ギャラリーを見る（{gallery.length}）
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={leaveRoomWithConfirm}
              disabled={finishBusy}
            >
              部屋をでる
            </button>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {!restoring && screen === "gallery" && (
        <div className="card tape-yellow gallery-card">
          <div className="gallery-top">
            <div className="label">ギャラリー</div>
            <button
              type="button"
              className="ghost-btn"
              onClick={closeGallery}
            >
              もどる
            </button>
          </div>
          <p className="hint">
            {gallery.length
              ? "長押しや保存で端末に残せます"
              : "まだ絵がありません。ラウンドを進めるとここに残ります"}
          </p>

          {gallery.length > 0 && (
            <div className="gallery-toolbar">
              <button
                type="button"
                className="secondary small-btn"
                onClick={() => {
                  setGallerySelectMode((v) => !v);
                  setSelectedIds(new Set());
                }}
              >
                {gallerySelectMode ? "選択やめる" : "選択する"}
              </button>
              {gallerySelectMode && (
                <button
                  type="button"
                  className="danger small-btn"
                  onClick={deleteSelected}
                  disabled={selectedIds.size === 0}
                >
                  えらんだのを消す
                </button>
              )}
              {isHost && (
                <button
                  type="button"
                  className="danger small-btn"
                  onClick={deleteAllGallery}
                >
                  全部消す
                </button>
              )}
            </div>
          )}

          <div className="gallery-grid">
            {gallery
              .slice()
              .reverse()
              .map((item) => (
                <div
                  key={item.id}
                  className={`gallery-item${selectedIds.has(item.id) ? " selected" : ""}`}
                  onClick={() => {
                    if (gallerySelectMode) toggleSelect(item.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    saveImage(item);
                  }}
                  onTouchStart={(e) => {
                    const target = e.currentTarget;
                    target._longPress = setTimeout(() => {
                      saveImage(item);
                    }, 550);
                  }}
                  onTouchEnd={(e) => {
                    clearTimeout(e.currentTarget._longPress);
                  }}
                  onTouchMove={(e) => {
                    clearTimeout(e.currentTarget._longPress);
                  }}
                >
                  {gallerySelectMode && (
                    <span className="gallery-check" aria-hidden="true">
                      {selectedIds.has(item.id) ? "✓" : ""}
                    </span>
                  )}
                  <div className="gallery-image-wrap">
                    <img
                      src={item.imageDataUrl}
                      alt={item.word || "絵"}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <div className="gallery-meta">
                    <span className="gallery-word">{item.word}</span>
                    {item.constraintLabel && (
                      <span className="gallery-constraint">
                        {item.constraintLabel}
                      </span>
                    )}
                  </div>
                  <div className="gallery-foot">
                    <div className="gallery-drawers">
                      {(item.drawerNames || []).join("・")}
                    </div>
                    {!gallerySelectMode && (
                      <button
                        type="button"
                        className="gallery-save"
                        onClick={(e) => {
                          e.stopPropagation();
                          saveImage(item);
                        }}
                      >
                        保存
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {!restoring && screen === "play" && (
        <>
          <div className={`card play-header tape-yellow ${modeClass}`}>
            {renderPlayHeader()}
          </div>

          <div
            ref={easelRef}
            className={`easel ${modeClass}${constraint ? " has-constraint" : ""}`}
          >
            <div className="easel-clip" aria-hidden="true" />
            {constraint && (
              <div className="easel-badge constraint-badge" aria-hidden="true">
                {constraint.emoji} {constraint.label}
              </div>
            )}
            {roundType === "relay" && (
              <div className="easel-badge relay-badge" aria-hidden="true">
                リレー
              </div>
            )}
            {roundType === "coop" && (
              <div className="easel-badge coop-badge" aria-hidden="true">
                協力
              </div>
            )}
            {roundType === "liar" && (
              <div className="easel-badge liar-badge" aria-hidden="true">
                うそつき
              </div>
            )}
            {roundType === "gradual" && (
              <div className="easel-badge peephole-badge" aria-hidden="true">
                のぞき穴
              </div>
            )}
            {roundType === "parts" && (
              <div className="easel-badge parts-badge" aria-hidden="true">
                全員合体
              </div>
            )}
            <div className={`canvas-wrap ${modeClass}`}>
              <DrawingCanvas
                ref={canvasApiRef}
                enabled={!!canDraw && !replaying}
                clearToken={clearToken}
                onStroke={emitStroke}
                historySeed={historySeed}
                localPlayerId={playerId}
                penWidth={constraint?.kind === "pen" ? constraint.value : 4}
                strokeLimit={
                  constraint?.kind === "strokes" ? constraint.value : 0
                }
                strokeUsedSeed={strokesUsed}
                onStrokeUsed={setStrokesUsed}
                onReplayChange={setReplaying}
              />
              {roundType === "parts" &&
                partAssignment?.area &&
                (drawPhase === "briefing" || drawPhase === "drawing") && (
                  <div className="parts-guide" aria-hidden="true">
                    <div
                      className={`parts-guide-area${
                        partAssignment.area.width < 0.18 ||
                        partAssignment.area.height < 0.14
                          ? " is-small"
                          : ""
                      }`}
                      style={{
                        left: `${partAssignment.area.x * 100}%`,
                        top: `${partAssignment.area.y * 100}%`,
                        width: `${partAssignment.area.width * 100}%`,
                        height: `${partAssignment.area.height * 100}%`,
                      }}
                    >
                      <span>{partAssignment.label}</span>
                    </div>
                    {(partAssignment.anchors || []).map((anchor, index) => (
                      <span
                        key={`${anchor.x}-${anchor.y}-${index}`}
                        className="parts-anchor"
                        style={{
                          left: `${anchor.x * 100}%`,
                          top: `${anchor.y * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                )}
              {roundType === "parts" && drawPhase === "briefing" && (
                <div className="parts-canvas-note" aria-hidden="true">
                  <span>担当エリアを確認！</span>
                  ホストの開始合図で描こう
                </div>
              )}
              {roundType === "parts" && drawPhase === "ready" && (
                <div className="parts-canvas-note is-ready" aria-hidden="true">
                  <span>強制提出！</span>
                  みんなのパーツを輸送中…
                </div>
              )}
              {/* めかくししばり: 描いている本人にだけ絵を隠す（線は下を通る） */}
              {constraint?.kind === "blind" && canDraw && !replaying && (
                <div className="canvas-blind" aria-hidden="true">
                  <span className="canvas-blind-face">🙈</span>
                  <span className="canvas-blind-text">見ないで描こう！</span>
                </div>
              )}
              {/* のぞき穴: 見ている側は、動く丸の中だけリアルタイムで見える */}
              {roundType === "gradual" &&
                drawPhase === "drawing" &&
                playerId !== drawerId && (
                  <div
                    className="canvas-peephole"
                    style={peepholeStyle}
                    aria-hidden="true"
                  >
                    <div className="canvas-peephole-window" />
                    <span className="canvas-peephole-label">
                      🔍 穴を追いかけよう！
                    </span>
                  </div>
                )}
              {replaying && (
                <div className="canvas-replay" aria-hidden="true">
                  ▶ リプレイ
                </div>
              )}
              {remainSec != null && drawPhase === "drawing" && (
                <div
                  className={`canvas-timer${remainSec <= 5 ? " is-urgent" : ""}`}
                  aria-hidden="true"
                >
                  {remainSec}
                </div>
              )}
            </div>
          </div>

          <div className="actions">
            {canStartParts && (
              <button
                type="button"
                className="parts-action-btn"
                onClick={startPartsDrawing}
                disabled={advancing || !!fanfare}
              >
                🚨 ミッション開始！
              </button>
            )}
            {roundType === "parts" &&
              drawPhase === "briefing" &&
              !canStartParts && (
                <p className="parts-action-wait" role="status">
                  進行役が全員の準備を確認しています…
                </p>
              )}
            {canAssembleParts && (
              <button
                type="button"
                className="parts-action-btn assemble"
                onClick={assembleParts}
                disabled={advancing}
              >
                🧩 全パーツを合体させる！
              </button>
            )}
            {roundType === "parts" &&
              drawPhase === "ready" &&
              !canAssembleParts && (
                <p className="parts-action-wait" role="status">
                  進行役の「合体！」を待っています…
                </p>
              )}
            {canHighlightPart && (
              <button
                type="button"
                className="quiet parts-highlight-btn"
                onClick={highlightMyPart}
              >
                ✨ 自分のパーツを光らせる
              </button>
            )}
            {canReveal && (
              <button type="button" onClick={revealLiar}>
                こたえあわせ
              </button>
            )}
            {(canRevealAnswer || canPassRound || canFinishGradual) && (
              <div className="answer-actions">
                {canRevealAnswer && (
                  <button
                    type="button"
                    onClick={revealAnswer}
                    disabled={advancing}
                  >
                    ✅ せいかい！
                  </button>
                )}
                {canPassRound && (
                  <button
                    type="button"
                    className="quiet pass-btn"
                    onClick={passRound}
                    disabled={advancing}
                  >
                    ⏭️ パス
                  </button>
                )}
                {canFinishGradual && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={finishGradualDrawing}
                    disabled={advancing}
                  >
                    👀 ぜんぶ見せる
                  </button>
                )}
              </div>
            )}
            {canNextRound && (
              <button type="button" onClick={nextRound} disabled={advancing}>
                {roundNumber >= totalRounds ? "けっかを見る" : "つぎのお題へ"}
              </button>
            )}
            {/* リプレイは、こたえを知っている人（＝つぎへ進められる人）だけに出す */}
            {canNextRound && hasDrawing && (
              <button
                type="button"
                className="quiet replay-btn"
                onClick={requestReplay}
                disabled={replaying}
              >
                {replaying ? "▶ さいせい中…" : "▶ 描いた順にリプレイ"}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => openGallery("play")}
            >
              ギャラリー（{gallery.length}）
            </button>
            {isHost && (
              <button type="button" className="danger" onClick={endGame}>
                おわり
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              onClick={leaveRoomWithConfirm}
            >
              部屋をでる
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
