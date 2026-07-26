import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { io } from "socket.io-client";
import DrawingCanvas from "./DrawingCanvas.jsx";

const SESSION_KEY = "oekaki-session";
/** ブラウザを閉じても3時間は同じ部屋に戻れる */
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const EMPTY_AI_STATE = {
  enabled: false,
  styles: [],
  gameSeq: 0,
  currentGalleryCount: 0,
  pendingCritiques: 0,
  readyCritiques: 0,
  awardsStatus: "idle",
  awards: null,
  awardsError: "",
  canRetryAwards: true,
  masterpieceStatus: "idle",
  masterpiece: null,
  masterpieceError: "",
  canRetryMasterpiece: true,
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
  const styleDialogRef = useRef(null);
  const stylizeReturnFocusRef = useRef(null);
  /** サーバー時刻 - 端末時刻（タイマー表示のずれ補正用） */
  const serverOffsetRef = useRef(0);
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
  const [aiCritiqueSpotlight, setAiCritiqueSpotlight] = useState(null);
  const [stylizeTargetId, setStylizeTargetId] = useState("");

  const isHost = playerId && playerId === hostId;
  const isMasterpieceGenerating =
    aiState.masterpieceStatus === "generating";
  const modeClass = `mode-${roundType || "normal"}`;
  const inviteUrl = useMemo(() => buildInviteUrl(roomCode), [roomCode]);
  const stylizeTarget = useMemo(
    () => gallery.find((item) => item.id === stylizeTargetId) || null,
    [gallery, stylizeTargetId]
  );
  const masterpieceItem = useMemo(
    () =>
      gallery.find(
        (item) => item.id === aiState.masterpiece?.galleryItemId
      ) || null,
    [gallery, aiState.masterpiece]
  );
  const canShareInvite =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  function closeStylizeDialog({ restoreFocus = true } = {}) {
    setStylizeTargetId("");
    if (restoreFocus) {
      window.setTimeout(() => stylizeReturnFocusRef.current?.focus(), 0);
    }
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
    setRoundId(data.roundId ?? null);
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
    setRoundId(null);
    setAdvancing(false);
  }

  function resetGameProgress() {
    setRoundNumber(0);
    setTotalRounds(0);
    setExtensionRounds(3);
    setFinishBusy(false);
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
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!fanfare) return;
    const t = setTimeout(() => setFanfare(null), 2200);
    return () => clearTimeout(t);
  }, [fanfare]);

  useEffect(() => {
    if (!aiCritiqueSpotlight) return;
    const t = setTimeout(() => setAiCritiqueSpotlight(null), 7000);
    return () => clearTimeout(t);
  }, [aiCritiqueSpotlight]);

  useEffect(() => {
    if (!stylizeTargetId) return;
    if (!gallery.some((item) => item.id === stylizeTargetId)) {
      closeStylizeDialog({ restoreFocus: false });
    }
  }, [gallery, stylizeTargetId]);

  useEffect(() => {
    if (!stylizeTargetId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleDialogKeys(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeStylizeDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(styleDialogRef.current?.querySelectorAll(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) || []),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDialogKeys);
    };
  }, [stylizeTargetId]);

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
    });

    socket.on("gameEnded", (data) => {
      setReturnScreen("lobby");
      setScreen((prev) => (prev === "gallery" ? "gallery" : "lobby"));
      resetPlayState();
      resetGameProgress();
      setAiCritiqueSpotlight(null);
      closeStylizeDialog({ restoreFocus: false });
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
      closeStylizeDialog({ restoreFocus: false });
      setToast(`あと${data?.addedRounds || 3}問、延長！`);
    });

    socket.on("stroke", (data) => {
      window.dispatchEvent(new CustomEvent("remote-stroke", { detail: data }));
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

    socket.on("galleryItemAiUpdate", (data) => {
      if (!data?.id) return;
      setGallery((items) =>
        items.map((item) =>
          item.id === data.id
            ? {
                ...item,
                aiCritiqueStatus: data.aiCritiqueStatus,
                aiCritique: data.aiCritique || null,
              }
            : item
        )
      );
    });

    socket.on("aiStateUpdate", (data) => {
      setAiState({
        ...EMPTY_AI_STATE,
        ...data,
        styles: Array.isArray(data?.styles) ? data.styles : [],
      });
      if (data?.masterpieceStatus === "ready") {
        closeStylizeDialog();
      }
    });

    socket.on("aiCritiqueReady", (data) => {
      if (!data?.critique) return;
      setAiCritiqueSpotlight(data);
    });

    socket.on("aiAwardsReady", () => {
      setToast("🏆 AI画伯の授賞式がはじまるよ！");
    });

    socket.on("aiMasterpieceReady", (data) => {
      closeStylizeDialog();
      setToast(`✨ ${data?.styleLabel || "名画"}が完成しました！`);
    });

    socket.on("strokeHistory", (data) => {
      setHistorySeed((prev) => ({
        token: prev.token + 1,
        strokes: data?.strokes || [],
      }));
    });

    function syncClock() {
      const t0 = Date.now();
      socket.emit("timeSync", (res) => {
        if (!res?.now) return;
        const t1 = Date.now();
        serverOffsetRef.current = res.now - (t0 + t1) / 2;
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

    return () => {
      socket.off("connect", tryRejoin);
      socket.disconnect();
    };
  }, []);

  const emitStroke = useMemo(
    () => (data) => {
      socketRef.current?.emit("stroke", data);
    },
    []
  );

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
      setAiCritiqueSpotlight(null);
      setStylizeTargetId("");
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

  function requestMasterpiece(style) {
    if (!stylizeTarget || aiState.masterpieceStatus === "generating") return;
    setError("");
    socketRef.current?.emit(
      "stylizeGalleryItem",
      { id: stylizeTarget.id, style },
      (res) => {
        if (!res?.ok) {
          setError(res?.error || "名画化できません");
          return;
        }
        closeStylizeDialog();
        setToast("✨ AI画伯が名画を制作中です。少し待ってね");
      }
    );
  }

  function revealLiar() {
    setError("");
    socketRef.current?.emit("revealLiar", (res) => {
      if (!res?.ok) setError(res?.error || "こたえあわせできません");
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
    setStylizeTargetId("");
    setScreen("gallery");
  }

  function closeGallery() {
    setGallerySelectMode(false);
    setSelectedIds(new Set());
    setStylizeTargetId("");
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
        setHistorySeed((prev) => ({
          token: prev.token + 1,
          strokes: res.strokes || [],
        }));
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
    const titlePrefix = item.isMasterpiece ? "AI名画" : "おえかき";
    const title = word ? `${titlePrefix}「${word}」` : titlePrefix;
    const mimeType =
      item.imageDataUrl?.match(/^data:(image\/(?:jpeg|png|webp));/)?.[1] ||
      "image/jpeg";
    const extension =
      { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[
        mimeType
      ] || "jpg";
    const styleSuffix = item.isMasterpiece ? `-${item.style || "masterpiece"}` : "";
    const filename = `${safeWord}${styleSuffix}-${String(item.id || "image").slice(0, 8)}.${extension}`;
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

    // normal
    return (
      <>
        <div className="meta row-meta">
          <span>部屋 {roomCode}</span>
          {renderRoundProgress()}
        </div>
        {word ? (
          <div className="info-block info-prompt">
            <div className="info-label">あなたのお題</div>
            <div className="prompt-value">{word}</div>
          </div>
        ) : (
          <div className="info-block info-drawer">
            <div className="info-label">いま描いている人</div>
            <div className="drawer-value">{drawerName}</div>
            <p className="hint">絵を見て、当てよう！</p>
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

      {aiCritiqueSpotlight && screen !== "play" && (
        <aside
          className="ai-critique-toast"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="ai-eyebrow">✨ AI画伯のひとこと</div>
          <strong>{aiCritiqueSpotlight.critique.title}</strong>
          <p>{aiCritiqueSpotlight.critique.comment}</p>
          <span>
            「{aiCritiqueSpotlight.word}」
            {(aiCritiqueSpotlight.drawerNames || []).length > 0 &&
              `／${aiCritiqueSpotlight.drawerNames.join("・")}`}
          </span>
        </aside>
      )}

      {fanfare && (
        <div className={`fanfare fanfare-${fanfare.roundType}`} role="status">
          <div className="fanfare-inner">
            <div className="fanfare-text">{fanfare.message}</div>
            {fanfare.roundType === "coop" && fanfare.names?.length > 0 && (
              <div className="fanfare-sub">{fanfare.names.join("・")}</div>
            )}
          </div>
        </div>
      )}

      {stylizeTarget && (
        <div
          className="ai-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeStylizeDialog();
          }}
        >
          <section
            ref={styleDialogRef}
            className="ai-style-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-style-title"
          >
            <div className="ai-dialog-head">
              <div>
                <div className="ai-eyebrow">AI名画化</div>
                <h2 id="ai-style-title">どんな名画にする？</h2>
              </div>
              <button
                type="button"
                className="ghost-btn ai-dialog-close"
                onClick={() => closeStylizeDialog()}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <img
              className="ai-style-preview"
              src={stylizeTarget.imageDataUrl}
              alt={`名画化する「${stylizeTarget.word || "絵"}」`}
            />
            <p className="hint">
              元の楽しい線を残したまま変身します。名画化は1ゲームに1枚です。
            </p>
            <div className="ai-style-options">
              {(aiState.styles || []).map((style, index) => (
                <button
                  key={style.id}
                  type="button"
                  className="ai-style-option"
                  onClick={() => requestMasterpiece(style.id)}
                  autoFocus={index === 0}
                >
                  <span aria-hidden="true">{style.emoji}</span>
                  {style.label}
                </button>
              ))}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </section>
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
            <>
              <div className="ai-enabled-badge">✨ AI画伯が参加します</div>
              <p className="ai-privacy-note">
                講評のため絵とお題をOpenAIへ送ります（名前は送りません）
              </p>
            </>
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
                    <p className="hint">
                      ギャラリーから、お気に入りの1枚をAI名画にもできます
                    </p>
                  </>
                )}

              {(aiState.awardsStatus === "idle" ||
                aiState.awardsStatus === "error") && (
                <>
                  {aiState.pendingCritiques > 0 ? (
                    <p className="ai-ceremony-note" role="status">
                      AI画伯があと{aiState.pendingCritiques}
                      枚を鑑賞しています…
                    </p>
                  ) : aiState.readyCritiques < 2 ? (
                    <p className="ai-ceremony-note">
                      講評できた作品が2枚以上あると授賞式を開けます
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
                      disabled={
                        aiState.pendingCritiques > 0 ||
                        aiState.readyCritiques < 2
                      }
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

          {isMasterpieceGenerating && (
            <p className="finish-wait" role="status">
              AI名画を制作中です。完成すると延長・ロビーへ戻る操作ができます
            </p>
          )}

          <div className="actions">
            {isHost ? (
              <>
                <button
                  type="button"
                  onClick={extendGame}
                  disabled={finishBusy || isMasterpieceGenerating}
                >
                  あと{extensionRounds}問だけ延長！
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={endGame}
                  disabled={finishBusy || isMasterpieceGenerating}
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

          {aiState.enabled &&
            aiState.masterpieceStatus === "generating" && (
              <section className="ai-masterpiece ai-masterpiece-busy">
                <div className="ai-busy" role="status">
                  <span className="ai-busy-icon" aria-hidden="true">
                    🖌️
                  </span>
                  AI画伯が名画を制作中…完成まで少しかかります
                </div>
              </section>
            )}

          {aiState.enabled &&
            aiState.masterpieceStatus === "ready" &&
            masterpieceItem && (
              <section
                className="ai-masterpiece"
                aria-labelledby="masterpiece-title"
              >
                <div className="ai-eyebrow">✨ AI名画が完成！</div>
                <h2 id="masterpiece-title">
                  {aiState.masterpiece?.styleLabel || "名画"}になった「
                  {masterpieceItem.word}」
                </h2>
                <img
                  src={masterpieceItem.imageDataUrl}
                  alt={`${masterpieceItem.word || "絵"}のAI名画`}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => saveImage(masterpieceItem)}
                >
                  名画を保存・共有
                </button>
              </section>
            )}

          {aiState.enabled &&
            (aiState.masterpieceStatus === "error" ||
              aiState.masterpieceStatus === "used") &&
            aiState.masterpieceError && (
              <p className="ai-masterpiece-error" role="status">
                {aiState.masterpieceError}
              </p>
            )}

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
                  className={`gallery-item${selectedIds.has(item.id) ? " selected" : ""}${item.isMasterpiece ? " is-masterpiece" : ""}`}
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
                    <img src={item.imageDataUrl} alt={item.word || "絵"} />
                    {item.isMasterpiece && (
                      <span className="gallery-masterpiece-badge">
                        ✨ {item.styleLabel || "AI名画"}
                      </span>
                    )}
                  </div>
                  <div className="gallery-meta">
                    <span className="gallery-word">{item.word}</span>
                  </div>
                  {!item.isMasterpiece &&
                    aiState.enabled &&
                    item.aiCritiqueStatus === "pending" && (
                      <div className="gallery-ai-pending" role="status">
                        🎨 AI画伯が鑑賞中…
                      </div>
                    )}
                  {!item.isMasterpiece &&
                    aiState.enabled &&
                    item.aiCritiqueStatus === "ready" &&
                    item.aiCritique && (
                      <div className="gallery-ai-critique">
                        <strong>✨ {item.aiCritique.title}</strong>
                        <p>{item.aiCritique.comment}</p>
                      </div>
                    )}
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
                  {!gallerySelectMode &&
                    !item.isMasterpiece &&
                    isHost &&
                    returnScreen === "finished" &&
                    aiState.enabled &&
                    item.gameSeq === aiState.gameSeq &&
                    (aiState.masterpieceStatus === "idle" ||
                      (aiState.masterpieceStatus === "error" &&
                        aiState.canRetryMasterpiece)) && (
                      <button
                        type="button"
                        className="gallery-masterpiece-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setError("");
                          stylizeReturnFocusRef.current =
                            event.currentTarget;
                          setStylizeTargetId(item.id);
                        }}
                      >
                        ✨ この絵を名画化
                      </button>
                    )}
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
            {aiCritiqueSpotlight && (
              <div
                className="ai-critique-inline"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <strong>✨ {aiCritiqueSpotlight.critique.title}</strong>
                <span>{aiCritiqueSpotlight.critique.comment}</span>
              </div>
            )}
          </div>

          <div className={`easel ${modeClass}`}>
            <div className="easel-clip" aria-hidden="true" />
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
            <div className={`canvas-wrap ${modeClass}`}>
              <DrawingCanvas
                ref={canvasApiRef}
                enabled={!!canDraw}
                clearToken={clearToken}
                onStroke={emitStroke}
                historySeed={historySeed}
              />
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
            {canReveal && (
              <button type="button" onClick={revealLiar}>
                こたえあわせ
              </button>
            )}
            {canNextRound && (
              <button type="button" onClick={nextRound} disabled={advancing}>
                {roundNumber >= totalRounds ? "けっかを見る" : "つぎのお題へ"}
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
