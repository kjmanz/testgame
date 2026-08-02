import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { io } from "socket.io-client";
import {
  CommunityAwardCeremony,
  CommunityAwardsSummary,
  CommunityVoteOverlay,
} from "./CommunityAwards.jsx";
import DrawingCanvas from "./DrawingCanvas.jsx";

const SESSION_KEY = "oekaki-session";
/** ブラウザを閉じても3時間は同じ部屋に戻れる */
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
/** 今日のハイライト: 1枚あたりの表示時間。枚数が多いときは早送りして全体を収める */
const HIGHLIGHT_MS_PER_ITEM = 1100;
const HIGHLIGHT_MIN_MS_PER_ITEM = 500;
const HIGHLIGHT_TOTAL_MS = 24_000;
/** AI授賞式: 無音のドラムロールをはさんで1作品ずつ発表する */
const AWARD_OPENING_MS = 1800;
const AWARD_DRUMROLL_MS = 2200;
const AWARD_REVEAL_MS = 5000;
/** みんなの投票授賞式も、1賞ずつ間を取って発表する */
const COMMUNITY_AWARD_OPENING_MS = 1700;
const COMMUNITY_AWARD_DRUMROLL_MS = 2100;
const COMMUNITY_AWARD_REVEAL_MS = 5600;
/** AIのひみつ予想: APIの都合でゲームを待たせず、結果だけ短く見せる */
const AI_SECRET_GUESS_ACK_TIMEOUT_MS = 6000;
const AI_SECRET_GUESS_REVEAL_MS = 7000;
/** 正解の余韻は残しつつ、次のお題へ進む操作を長く邪魔しない長さ */
const ANSWER_CELEBRATION_MS = 3600;
const ANSWER_CONFETTI_COUNT = 18;
const ANSWER_CELEBRATION_CHEERS = [
  "画伯と名探偵、どちらもお見事！",
  "その答えにたどり着いたみんな、かなり鋭い！",
  "伝わった！ これは立派な名画です。",
  "正解！ キャンバスもにっこりしています。",
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
const EMPTY_COMMUNITY_AWARDS_STATE = {
  gameSeq: 0,
  candidateCount: 0,
  status: "idle",
  categories: [],
  votedCount: 0,
  eligibleCount: 0,
  closesAt: null,
  hasVoted: false,
  canVote: false,
  results: null,
};
const EMPTY_AI_CRAZY_PROMPT_STATE = {
  enabled: false,
  active: false,
  mainAnswer: null,
  fullPrompt: null,
  promptLabel: null,
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
  const playerIdRef = useRef("");
  /** Socket listener から最新ラウンドだけを判定するための箱 */
  const roundIdRef = useRef(null);
  /** 閉じた結果が roundUpdate で再び開かないようにする */
  const dismissedSecretGuessRoundRef = useRef(null);
  /** 正解演出のあとにAI予想を順番に見せるための待ち行列 */
  const answerCelebrationRef = useRef(null);
  const dismissedAnswerRoundRef = useRef(null);
  const answerCloseButtonRef = useRef(null);
  const answerPreviousFocusRef = useRef(null);
  const queuedSecretGuessRevealRef = useRef(null);
  /** 再接続・ギャラリー表示中でも未処理の画像依頼を失わないための箱 */
  const pendingSecretGuessCaptureRef = useRef(null);
  const trySecretGuessCaptureRef = useRef(() => {});
  /** 何か描かれたか（線ごとに再描画しないための箱） */
  const hasDrawingRef = useRef(false);
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
  const [answerCelebration, setAnswerCelebration] = useState(null);
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
  const [revealingAnswer, setRevealingAnswer] = useState(false);
  const [canPassWord, setCanPassWord] = useState(false);
  const [passesLeft, setPassesLeft] = useState(0);
  const [passing, setPassing] = useState(false);
  const [constraint, setConstraint] = useState(null);
  const [strokesUsed, setStrokesUsed] = useState(0);
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
  /** AI授賞式: { phase: 'opening' | 'drumroll' | 'reveal' | 'finale', index: number } */
  const [awardCeremony, setAwardCeremony] = useState(null);
  const [communityAwardsState, setCommunityAwardsState] = useState(
    EMPTY_COMMUNITY_AWARDS_STATE
  );
  const [communityVoteOpen, setCommunityVoteOpen] = useState(false);
  const [communityVoteStep, setCommunityVoteStep] = useState(0);
  const [communityVotes, setCommunityVotes] = useState({});
  const [communityVoteEditing, setCommunityVoteEditing] = useState(false);
  const [communityVoteSubmitting, setCommunityVoteSubmitting] = useState(false);
  const [communityVoteRemainSec, setCommunityVoteRemainSec] = useState(null);
  /** 会場投票の結果発表: opening | drumroll | reveal | finale */
  const [communityCeremony, setCommunityCeremony] = useState(null);
  const [secretGuessActive, setSecretGuessActive] = useState(false);
  const [secretGuessPending, setSecretGuessPending] = useState(false);
  const [secretGuessReveal, setSecretGuessReveal] = useState(null);
  const [aiCrazyPromptState, setAiCrazyPromptState] = useState(
    EMPTY_AI_CRAZY_PROMPT_STATE
  );

  const isHost = playerId && playerId === hostId;
  const isAiFinishBusy = aiState.awardsStatus === "generating";
  const isCommunityVoting = communityAwardsState.status === "voting";
  const isFinishCeremonyBusy = isAiFinishBusy || isCommunityVoting;
  const communityVoteSessionKey =
    communityAwardsState.status === "voting"
      ? `${communityAwardsState.gameSeq}:${(communityAwardsState.categories || [])
          .map((category) => category.id)
          .join(",")}`
      : "";
  const modeClass = `mode-${roundType || "normal"}`;
  const inviteUrl = useMemo(() => buildInviteUrl(roomCode), [roomCode]);
  const canShareInvite =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  /** 線が届くたびに再描画しないよう、変化したときだけ state を動かす */
  function markDrawing(value) {
    if (hasDrawingRef.current === value) return;
    hasDrawingRef.current = value;
    setHasDrawing(value);
  }

  function applyRoundPayload(
    data,
    { forcePlay = true, isNewRound = forcePlay } = {}
  ) {
    setError("");
    if (forcePlay) {
      setScreen("play");
    } else {
      setScreen((prev) => (prev === "gallery" ? "gallery" : "play"));
    }
    const payloadRoundId = data.roundId ?? null;
    const shouldShowAnswerCelebration = Boolean(
      data.drawPhase === "reveal" &&
        data.roundType === "normal" &&
        data.word &&
        String(dismissedAnswerRoundRef.current ?? "") !==
          String(payloadRoundId ?? "")
    );
    if (isNewRound) {
      roundIdRef.current = payloadRoundId;
      answerCelebrationRef.current = null;
      dismissedAnswerRoundRef.current = null;
      queuedSecretGuessRevealRef.current = null;
      setAnswerCelebration(null);
      dismissedSecretGuessRoundRef.current = null;
      pendingSecretGuessCaptureRef.current = null;
      setSecretGuessActive(!!data.aiSecretGuessActive);
      setSecretGuessPending(!!data.aiSecretGuessPending);
      if (shouldShowAnswerCelebration && data.aiSecretGuessReveal) {
        queuedSecretGuessRevealRef.current = data.aiSecretGuessReveal;
        setSecretGuessReveal(null);
      } else {
        setSecretGuessReveal(data.aiSecretGuessReveal || null);
      }
      setAiCrazyPromptState({
        ...EMPTY_AI_CRAZY_PROMPT_STATE,
        ...(data.aiCrazyPrompt || {}),
      });
    } else {
      if (
        Object.prototype.hasOwnProperty.call(data, "aiSecretGuessActive")
      ) {
        setSecretGuessActive(!!data.aiSecretGuessActive);
      }
      if (
        Object.prototype.hasOwnProperty.call(data, "aiSecretGuessPending")
      ) {
        setSecretGuessPending(!!data.aiSecretGuessPending);
      }
      if (
        data.aiSecretGuessReveal &&
        String(dismissedSecretGuessRoundRef.current ?? "") !==
          String(payloadRoundId ?? "")
      ) {
        if (
          shouldShowAnswerCelebration ||
          answerCelebrationRef.current
        ) {
          queuedSecretGuessRevealRef.current = data.aiSecretGuessReveal;
        } else {
          setSecretGuessReveal(data.aiSecretGuessReveal);
        }
      }
    }
    if (!isNewRound && data.aiCrazyPrompt) {
      setAiCrazyPromptState({
        ...EMPTY_AI_CRAZY_PROMPT_STATE,
        ...data.aiCrazyPrompt,
      });
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
    if (isNewRound || data.drawPhase === "reveal") {
      setRevealingAnswer(false);
    }
    setCanPassWord(!!data.canPassWord);
    setPassesLeft(data.passesLeft ?? 0);
    setPassing(false);
    setConstraint(data.constraint || null);
    setStrokesUsed(data.constraintStrokesUsed ?? 0);
    setRoundId(payloadRoundId);
    setRoundNumber(data.roundNumber ?? 0);
    setTotalRounds(data.totalRounds ?? 0);
    setAdvancing(false);
    setFinishBusy(false);
    if (
      shouldShowAnswerCelebration &&
      !answerCelebrationRef.current
    ) {
      showAnswerCelebration({
        roundId: payloadRoundId,
        word: data.word,
        drawerName: data.drawerName || "",
        aiCrazyPrompt: data.aiCrazyPrompt?.active
          ? data.aiCrazyPrompt
          : null,
      });
    }
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
    setRevealingAnswer(false);
    setCanPassWord(false);
    setPassesLeft(0);
    setPassing(false);
    setConstraint(null);
    setStrokesUsed(0);
    markDrawing(false);
    roundIdRef.current = null;
    dismissedSecretGuessRoundRef.current = null;
    answerCelebrationRef.current = null;
    dismissedAnswerRoundRef.current = null;
    answerPreviousFocusRef.current = null;
    queuedSecretGuessRevealRef.current = null;
    pendingSecretGuessCaptureRef.current = null;
    setRoundId(null);
    setSecretGuessActive(false);
    setSecretGuessPending(false);
    setSecretGuessReveal(null);
    setAnswerCelebration(null);
    setAiCrazyPromptState(EMPTY_AI_CRAZY_PROMPT_STATE);
    setAdvancing(false);
  }

  function showAnswerCelebration(value) {
    if (!answerCelebrationRef.current) {
      answerPreviousFocusRef.current = document.activeElement;
    }
    answerCelebrationRef.current = value;
    setAnswerCelebration(value);
  }

  function dismissAnswerCelebration() {
    const previousFocus = answerPreviousFocusRef.current;
    dismissedAnswerRoundRef.current =
      answerCelebrationRef.current?.roundId ?? roundIdRef.current;
    answerCelebrationRef.current = null;
    answerPreviousFocusRef.current = null;
    setAnswerCelebration(null);
    const queuedReveal = queuedSecretGuessRevealRef.current;
    if (queuedReveal) {
      queuedSecretGuessRevealRef.current = null;
      setSecretGuessReveal(queuedReveal);
    }
    if (!queuedReveal) {
      window.requestAnimationFrame(() => {
        if (
          previousFocus?.isConnected &&
          !previousFocus.disabled &&
          typeof previousFocus.focus === "function"
        ) {
          previousFocus.focus();
          return;
        }
        document.querySelector(".actions button:not(:disabled)")?.focus();
      });
    }
  }

  function resetGameProgress() {
    setRoundNumber(0);
    setTotalRounds(0);
    setExtensionRounds(3);
    setFinishBusy(false);
    setHighlight(null);
    setAwardCeremony(null);
    setCommunityAwardsState(EMPTY_COMMUNITY_AWARDS_STATE);
    setCommunityVoteOpen(false);
    setCommunityVoteStep(0);
    setCommunityVotes({});
    setCommunityVoteEditing(false);
    setCommunityVoteSubmitting(false);
    setCommunityVoteRemainSec(null);
    setCommunityCeremony(null);
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
    if (!answerCelebration) return;
    const celebrationRoundId = answerCelebration.roundId;
    function onKeyDown(event) {
      if (event.key === "Escape") {
        dismissAnswerCelebration();
      } else if (event.key === "Tab") {
        event.preventDefault();
        answerCloseButtonRef.current?.focus();
      }
    }
    const timer = setTimeout(() => {
      if (
        String(answerCelebrationRef.current?.roundId ?? "") ===
        String(celebrationRoundId ?? "")
      ) {
        dismissAnswerCelebration();
      }
    }, ANSWER_CELEBRATION_MS);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [answerCelebration]);

  useEffect(() => {
    if (!secretGuessReveal) return;
    const revealedRoundId = secretGuessReveal.roundId ?? roundIdRef.current;
    function dismissReveal() {
      dismissedSecretGuessRoundRef.current = revealedRoundId;
      setSecretGuessReveal(null);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") dismissReveal();
    }
    const timer = setTimeout(() => {
      dismissReveal();
    }, AI_SECRET_GUESS_REVEAL_MS);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [secretGuessReveal]);

  // 今日のハイライト: 1枚ずつめくって、最後まで来たら閉じる
  useEffect(() => {
    if (!highlight) return;
    const perItem = Math.max(
      HIGHLIGHT_MIN_MS_PER_ITEM,
      Math.min(
        HIGHLIGHT_MS_PER_ITEM,
        Math.round(HIGHLIGHT_TOTAL_MS / Math.max(1, highlight.ids.length))
      )
    );
    const t = setTimeout(() => {
      setHighlight((current) => {
        if (!current) return null;
        const next = current.index + 1;
        if (next >= current.ids.length) return null;
        return { ...current, index: next };
      });
    }, perItem);
    return () => clearTimeout(t);
  }, [highlight]);

  // AI授賞式: 開幕 → ためる → 1作品発表、を受賞数だけくり返す
  useEffect(() => {
    if (!awardCeremony) return;
    const awardCount = aiState.awards?.awards?.length || 0;
    if (awardCount === 0 || awardCeremony.phase === "finale") return;

    const delay =
      awardCeremony.phase === "opening"
        ? AWARD_OPENING_MS
        : awardCeremony.phase === "drumroll"
          ? AWARD_DRUMROLL_MS
          : AWARD_REVEAL_MS;

    const timer = setTimeout(() => {
      setAwardCeremony((current) => {
        if (!current) return null;
        if (current.phase === "opening") {
          return { phase: "drumroll", index: 0 };
        }
        if (current.phase === "drumroll") {
          return { ...current, phase: "reveal" };
        }
        const nextIndex = current.index + 1;
        if (nextIndex >= awardCount) {
          return { phase: "finale", index: current.index };
        }
        return { phase: "drumroll", index: nextIndex };
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [awardCeremony, aiState.awards]);

  // 新しい会場投票が始まったときだけ下書きを初期化する。
  // 進捗更新のたびに投票画面を勝手に開き直さないため、文字列キーで判定する。
  useEffect(() => {
    if (!communityVoteSessionKey) {
      if (communityAwardsState.status === "idle") {
        setCommunityVoteOpen(false);
        setCommunityVoteStep(0);
        setCommunityVotes({});
        setCommunityVoteEditing(false);
        setCommunityVoteSubmitting(false);
      }
      if (communityAwardsState.status === "ready") {
        setCommunityVoteOpen(false);
        setCommunityVoteSubmitting(false);
      }
      return;
    }

    setHighlight(null);
    setAwardCeremony(null);
    setCommunityCeremony(null);
    setCommunityVoteStep(0);
    setCommunityVotes({});
    setCommunityVoteEditing(false);
    setCommunityVoteSubmitting(false);
    setCommunityVoteOpen(true);
  }, [communityVoteSessionKey, communityAwardsState.status]);

  useEffect(() => {
    if (
      communityAwardsState.status !== "voting" ||
      !communityAwardsState.closesAt
    ) {
      setCommunityVoteRemainSec(null);
      return;
    }
    function tickCommunityVote() {
      setCommunityVoteRemainSec(
        formatRemain(
          communityAwardsState.closesAt -
            (Date.now() + serverOffsetRef.current)
        )
      );
    }
    tickCommunityVote();
    const timer = setInterval(tickCommunityVote, 250);
    return () => clearInterval(timer);
  }, [communityAwardsState.status, communityAwardsState.closesAt]);

  // みんなの投票結果も、開幕 → ドラムロール → 発表の順に1賞ずつ見せる
  useEffect(() => {
    if (!communityCeremony) return;
    const awardCount = communityAwardsState.results?.awards?.length || 0;
    if (awardCount === 0 || communityCeremony.phase === "finale") return;

    const delay =
      communityCeremony.phase === "opening"
        ? COMMUNITY_AWARD_OPENING_MS
        : communityCeremony.phase === "drumroll"
          ? COMMUNITY_AWARD_DRUMROLL_MS
          : COMMUNITY_AWARD_REVEAL_MS;

    const timer = setTimeout(() => {
      setCommunityCeremony((current) => {
        if (!current) return null;
        if (current.phase === "opening") {
          return { phase: "drumroll", index: 0 };
        }
        if (current.phase === "drumroll") {
          return { ...current, phase: "reveal" };
        }
        const nextIndex = current.index + 1;
        if (nextIndex >= awardCount) {
          return { phase: "finale", index: current.index };
        }
        return { phase: "drumroll", index: nextIndex };
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [communityCeremony, communityAwardsState.results]);

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
    const secretGuessCapturesInFlight = new Set();
    const secretGuessCaptureTimers = new Set();
    socketRef.current = socket;

    function scheduleSecretGuessCaptureAttempt(delayMs = 50) {
      const timer = setTimeout(() => {
        secretGuessCaptureTimers.delete(timer);
        trySecretGuessCaptureRef.current();
      }, delayMs);
      secretGuessCaptureTimers.add(timer);
    }

    trySecretGuessCaptureRef.current = () => {
      const pending = pendingSecretGuessCaptureRef.current;
      if (!pending) return;
      const { roundId: requestedRoundId, token } = pending;
      if (
        String(requestedRoundId) !== String(roundIdRef.current ?? "")
      ) {
        pendingSecretGuessCaptureRef.current = null;
        return;
      }
      if (pending.waitForHistory) return;

      const captureKey = `${requestedRoundId}:${token}`;
      if (secretGuessCapturesInFlight.has(captureKey)) return;

      let imageDataUrl;
      try {
        imageDataUrl = canvasApiRef.current?.exportImage?.({
          maxSize: 448,
          quality: 0.6,
        });
      } catch {
        imageDataUrl = null;
      }

      // 再接続直後やギャラリー表示中はキャンバスがまだない。依頼は保持し、
      // play画面と履歴が戻ったタイミングで下のeffectから再試行する。
      if (
        typeof imageDataUrl !== "string" ||
        !imageDataUrl.startsWith("data:image/")
      ) {
        return;
      }

      secretGuessCapturesInFlight.add(captureKey);
      pending.sendAttempts = (pending.sendAttempts || 0) + 1;
      socket
        .timeout(AI_SECRET_GUESS_ACK_TIMEOUT_MS)
        .emit(
          "submitAiSecretGuessImage",
          { roundId: requestedRoundId, token, imageDataUrl },
          (timeoutError, response) => {
            secretGuessCapturesInFlight.delete(captureKey);
            const current = pendingSecretGuessCaptureRef.current;
            if (
              !current ||
              current.roundId !== requestedRoundId ||
              current.token !== token
            ) {
              return;
            }
            if (!timeoutError || response?.stale) {
              pendingSecretGuessCaptureRef.current = null;
              return;
            }
            // ACKだけ失われた場合もサーバー側が重複をstaleで弾くため、
            // 同じtokenで最大1回だけ安全に再送する。
            if (pending.sendAttempts < 2) {
              scheduleSecretGuessCaptureAttempt(250);
            }
          }
        );
    };

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
      const isNewRound =
        String(data?.roundId ?? "") !==
        String(roundIdRef.current ?? "");
      applyRoundPayload(data, { forcePlay: true, isNewRound });
    });

    socket.on("roundUpdate", (data) => {
      applyRoundPayload(data, { forcePlay: false, isNewRound: false });
    });

    socket.on("aiSecretGuessCaptureRequest", (data) => {
      const requestedRoundId = data?.roundId;
      const token = data?.token;
      if (
        requestedRoundId == null ||
        !token ||
        String(requestedRoundId) !== String(roundIdRef.current ?? "")
      ) {
        return;
      }

      const captureKey = `${requestedRoundId}:${token}`;
      if (secretGuessCapturesInFlight.has(captureKey)) return;
      pendingSecretGuessCaptureRef.current = {
        roundId: requestedRoundId,
        token,
        sendAttempts: 0,
        waitForHistory: !canvasApiRef.current,
      };
      // roundStart / strokeHistory と同時に再送された場合、Reactの描画を
      // 1拍待ってから取得する。
      scheduleSecretGuessCaptureAttempt();
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
      setAwardCeremony(null);
      setCommunityAwardsState(EMPTY_COMMUNITY_AWARDS_STATE);
      setCommunityVoteOpen(false);
      setCommunityCeremony(null);
      setToast(`あと${data?.addedRounds || 3}問、延長！`);
    });

    socket.on("stroke", (data) => {
      window.dispatchEvent(new CustomEvent("remote-stroke", { detail: data }));
      if (data?.type === "move") markDrawing(true);
    });

    socket.on("replayStart", () => {
      canvasApiRef.current?.playReplay();
    });

    // だんだん見える: サーバーから線が届いたら、ゆっくり公開再生する
    socket.on("gradualReveal", (data) => {
      const strokes = data?.strokes || [];
      canvasApiRef.current?.playGradualReveal(strokes);
      markDrawing(strokes.some((ev) => ev?.type === "move"));
    });

    socket.on("playerJoined", (data) => {
      if (data?.name) setToast(`${data.name}が遊びに来たよ！`);
    });

    socket.on("roundFanfare", (data) => {
      setFanfare(data);
    });

    // ふつうのラウンドの答え発表。短いお祝いカードで全員へ同時に見せる。
    socket.on("answerReveal", (data) => {
      if (!data?.word) return;
      if (
        data.roundId != null &&
        String(data.roundId) !== String(roundIdRef.current ?? "")
      ) {
        return;
      }
      if (
        String(dismissedAnswerRoundRef.current ?? "") ===
        String(data.roundId ?? roundIdRef.current ?? "")
      ) {
        return;
      }
      if (data.aiCrazyPrompt) {
        setAiCrazyPromptState({
          ...EMPTY_AI_CRAZY_PROMPT_STATE,
          enabled: true,
          active: true,
          mainAnswer: data.aiCrazyPrompt.mainAnswer || data.word,
          fullPrompt: data.aiCrazyPrompt.fullPrompt || null,
          promptLabel: "AIむちゃぶりお題",
        });
      }
      setToast("");
      setRevealingAnswer(false);
      showAnswerCelebration({
        roundId: data.roundId ?? roundIdRef.current,
        word: data.word,
        drawerName: data.drawerName || "",
        aiCrazyPrompt: data.aiCrazyPrompt || null,
      });
    });

    socket.on("aiSecretGuessPending", (data) => {
      if (
        data?.roundId == null ||
        String(data.roundId) !== String(roundIdRef.current ?? "")
      ) {
        return;
      }
      const pending = pendingSecretGuessCaptureRef.current;
      if (String(pending?.roundId ?? "") === String(data.roundId)) {
        pendingSecretGuessCaptureRef.current = null;
      }
      setSecretGuessPending(true);
    });

    socket.on("aiSecretGuessReveal", (data) => {
      if (
        data?.roundId == null ||
        String(data.roundId) !== String(roundIdRef.current ?? "") ||
        String(dismissedSecretGuessRoundRef.current ?? "") ===
          String(data.roundId)
      ) {
        return;
      }
      const pending = pendingSecretGuessCaptureRef.current;
      if (String(pending?.roundId ?? "") === String(data.roundId)) {
        pendingSecretGuessCaptureRef.current = null;
      }
      setSecretGuessPending(false);
      if (answerCelebrationRef.current) {
        queuedSecretGuessRevealRef.current = data;
      } else {
        setSecretGuessReveal(data);
      }
    });

    // お題のパス。黙って絵が消えると当てる側が混乱するので必ず知らせる
    socket.on("wordPassed", (data) => {
      const name = data?.drawerName;
      setToast(
        name
          ? `🙅 ${name}がパス！あたらしいおだいだよ`
          : "🙅 パス！あたらしいおだいだよ"
      );
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
      setHighlight(null);
      setCommunityCeremony(null);
      setAwardCeremony({ phase: "opening", index: 0 });
    });

    socket.on("communityAwardsStateUpdate", (data) => {
      setCommunityAwardsState({
        ...EMPTY_COMMUNITY_AWARDS_STATE,
        ...data,
      });
    });

    socket.on("communityAwardsStarted", () => {
      setHighlight(null);
      setAwardCeremony(null);
      setCommunityCeremony(null);
      setCommunityVoteOpen(true);
    });

    socket.on("communityAwardsReady", () => {
      setHighlight(null);
      setAwardCeremony(null);
      setCommunityVoteOpen(false);
      setCommunityVoteSubmitting(false);
      setCommunityCeremony({ phase: "opening", index: 0 });
    });

    socket.on("communityAwardsNoVotes", () => {
      setCommunityVoteOpen(false);
      setCommunityVoteSubmitting(false);
      setCommunityCeremony(null);
      setToast("今回は票が集まらず閉幕！ホストからもう一度始められます");
    });

    // 今日のハイライト: 順番だけ届くので、絵は手元のギャラリーから引く
    socket.on("highlightStart", (data) => {
      const ids = Array.isArray(data?.ids) ? data.ids : [];
      if (ids.length === 0) return;
      setAwardCeremony(null);
      setCommunityCeremony(null);
      setHighlight({ ids, index: 0 });
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
      const t0 = Date.now();
      socket.emit("timeSync", (res) => {
        if (!res?.now) return;
        const t1 = Date.now();
        serverOffsetRef.current = res.now - (t0 + t1) / 2;
      });
    }

    if (socket.connected) syncClock();
    socket.on("connect", syncClock);
    socket.on("disconnect", () => {
      // 再接続時にサーバーが同じ依頼を再送できるよう、通信中の印だけ外す
      secretGuessCapturesInFlight.clear();
      pendingSecretGuessCaptureRef.current = null;
      for (const timer of secretGuessCaptureTimers) clearTimeout(timer);
      secretGuessCaptureTimers.clear();
    });

    function tryRejoin() {
      // 投票送信中に回線が切れてackが失われても、再接続後は操作を復帰させる。
      setCommunityVoteSubmitting(false);
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
      for (const timer of secretGuessCaptureTimers) clearTimeout(timer);
      secretGuessCaptureTimers.clear();
      trySecretGuessCaptureRef.current = () => {};
      socket.off("connect", tryRejoin);
      socket.disconnect();
    };
  }, []);

  // ギャラリーから戻ったときや再接続の履歴が描画されたとき、保持していた
  // 依頼をキャンバスのcommit後に再試行する。screen/roundIdだけの変化では
  // 空のキャンバスを早取りしうるため、履歴の反映を合図にする。
  useEffect(() => {
    const pending = pendingSecretGuessCaptureRef.current;
    if (!pending) return;
    pending.waitForHistory = false;
    const timer = setTimeout(() => trySecretGuessCaptureRef.current(), 50);
    return () => clearTimeout(timer);
  }, [historySeed]);

  const emitStroke = useMemo(
    () => (data) => {
      socketRef.current?.emit("stroke", data);
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
    setAwardCeremony(null);
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

  function startAwardCeremony() {
    if (isCommunityVoting || !aiState.awards?.awards?.length) return;
    setHighlight(null);
    setCommunityCeremony(null);
    setAwardCeremony({ phase: "opening", index: 0 });
  }

  function startCommunityAwards() {
    setError("");
    setHighlight(null);
    setAwardCeremony(null);
    setCommunityCeremony(null);
    socketRef.current?.emit("startCommunityAwards", (res) => {
      if (!res?.ok) {
        setError(res?.error || "みんなの投票を始められません");
      }
    });
  }

  function submitCommunityAwardsVotes() {
    const categories = communityAwardsState.categories || [];
    const ballot = categories.map((category) => ({
      categoryId: category.id,
      galleryItemId: communityVotes[category.id] || "",
    }));
    if (ballot.length === 0 || ballot.some((vote) => !vote.galleryItemId)) {
      setError("3つの賞すべてで作品を選んでください");
      return;
    }

    setError("");
    setCommunityVoteSubmitting(true);
    const socket = socketRef.current;
    if (!socket) {
      setCommunityVoteSubmitting(false);
      setError("サーバーへ接続できません。もう一度試してください");
      return;
    }
    socket.timeout(10_000).emit(
      "submitCommunityAwardsVotes",
      { gameSeq: communityAwardsState.gameSeq, votes: ballot },
      (timeoutError, res) => {
        setCommunityVoteSubmitting(false);
        if (timeoutError) {
          setError("投票の応答を確認できませんでした。接続後にもう一度確認してください");
          return;
        }
        if (!res?.ok) {
          setError(res?.error || "投票できませんでした");
          return;
        }
        setCommunityVoteEditing(false);
        setCommunityAwardsState((current) => ({
          ...current,
          hasVoted: true,
        }));
      }
    );
  }

  function finalizeCommunityAwards() {
    const remaining = Math.max(
      0,
      (communityAwardsState.eligibleCount || 0) -
        (communityAwardsState.votedCount || 0)
    );
    if (
      remaining > 0 &&
      !window.confirm(
        `まだ${remaining}人が投票していません。ここで締め切って発表しますか？`
      )
    ) {
      return;
    }
    setError("");
    socketRef.current?.emit("finalizeCommunityAwards", (res) => {
      if (!res?.ok) {
        setError(res?.error || "まだ投票を締め切れません");
      }
    });
  }

  function startCommunityAwardCeremony() {
    if (!communityAwardsState.results?.awards?.length) return;
    setHighlight(null);
    setAwardCeremony(null);
    setCommunityVoteOpen(false);
    setCommunityCeremony({ phase: "opening", index: 0 });
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
      if (!res?.ok) setError(res?.error || "公開できません");
    });
  }

  function revealAnswer() {
    if (revealingAnswer) return;
    const socket = socketRef.current;
    if (!socket) {
      setError("通信がつながっていません。少し待ってもう一度どうぞ");
      return;
    }
    const requestedRoundId = roundId;
    setError("");
    setRevealingAnswer(true);
    socket
      .timeout(8000)
      .emit(
        "revealAnswer",
        { roundId: requestedRoundId },
        (timeoutError, res) => {
          if (timeoutError) {
            setRevealingAnswer(false);
            const answerWasAlreadyHandled =
              String(answerCelebrationRef.current?.roundId ?? "") ===
                String(requestedRoundId ?? "") ||
              String(dismissedAnswerRoundRef.current ?? "") ===
                String(requestedRoundId ?? "") ||
              String(roundIdRef.current ?? "") !==
                String(requestedRoundId ?? "");
            if (!answerWasAlreadyHandled) {
              setError("通信が混み合っています。もう一度押してね");
            }
            return;
          }
          if (!res?.ok) {
            setRevealingAnswer(false);
            setError(res?.error || "せいかい発表できません");
          } else if (res.stale) {
            setRevealingAnswer(false);
          }
        }
      );
  }

  /** お題がわからないとき。ラウンドは進まず、お題だけ引き直す */
  function passWord() {
    if (passing) return;
    setError("");
    setPassing(true);
    socketRef.current?.emit("passWord", { roundId, passesLeft }, (res) => {
      // 成功時は roundUpdate が来て passing が下りる
      if (!res?.ok) {
        setPassing(false);
        setError(res?.error || "いまはパスできません");
      } else if (res.stale) {
        setPassing(false);
      }
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
                decoding="async"
              />
            ) : (
              <div className="highlight-missing">この絵はもうないよ</div>
            )}
          </div>
          <div className="highlight-word">{item?.word || "？？？"}</div>
          {item?.aiCrazyPromptFullPrompt && (
            <div className="highlight-ai-crazy">
              <span className="gallery-ai-crazy-badge">🤖 AIむちゃぶり</span>
              <span>{item.aiCrazyPromptFullPrompt}</span>
            </div>
          )}
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
            onClick={() => setHighlight(null)}
          >
            とじる
          </button>
        </div>
      </div>
    );
  }

  /** AI授賞式: 結果をいったん隠し、無音のドラムロールをはさんで発表する */
  function renderAwardCeremony() {
    const awards = aiState.awards?.awards || [];
    if (!awardCeremony || awards.length === 0) return null;

    const phase = awardCeremony.phase;
    const index = Math.min(awardCeremony.index, awards.length - 1);
    const award = awards[index];
    const item = gallery.find(
      (candidate) => candidate.id === award?.galleryItemId
    );
    const drawers = (item?.drawerNames || []).join("・");
    const announcedCount =
      phase === "finale"
        ? awards.length
        : phase === "reveal"
          ? index + 1
          : index;

    return (
      <div
        className={`award-show award-show-${phase}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="award-show-title"
      >
        <div className="award-show-shell">
          <button
            ref={answerCloseButtonRef}
            type="button"
            className="award-show-close"
            onClick={() => setAwardCeremony(null)}
            aria-label="授賞式を閉じる"
          >
            × とじる
          </button>

          <div className="award-show-progress" aria-hidden="true">
            {awards.map((candidate, dotIndex) => (
              <span
                key={candidate.galleryItemId}
                className={`${dotIndex < announcedCount ? "is-done" : ""}${
                  phase !== "opening" &&
                  phase !== "finale" &&
                  dotIndex === index
                    ? " is-current"
                    : ""
                }`}
              />
            ))}
          </div>

          <div className="award-show-live" aria-live="polite">
            {phase === "opening" && (
              <div className="award-opening" key="award-opening">
                <div className="award-show-eyebrow">AI画伯 presents</div>
                <div className="award-opening-trophy" aria-hidden="true">
                  🏆
                </div>
                <h2 id="award-show-title">みんなの授賞式</h2>
                <p>{aiState.awards?.intro}</p>
                <div className="award-opening-cue">
                  まもなく最初の賞を発表します！
                </div>
              </div>
            )}

            {phase === "drumroll" && (
              <div className="award-drumroll" key={`drumroll-${index}`}>
                <div className="award-step-label">
                  {index + 1}つ目の賞 ／ 全{awards.length}賞
                </div>
                <div className="award-drum-trophy" aria-hidden="true">
                  🏆
                </div>
                <h2 id="award-show-title">つぎの受賞作品は…</h2>
                <div className="award-drum-dots" aria-hidden="true">
                  {Array.from({ length: 9 }, (_, dotIndex) => (
                    <span key={dotIndex} />
                  ))}
                </div>
                <p>ドラムロール中…（音は脳内でどうぞ）</p>
              </div>
            )}

            {phase === "reveal" && award && (
              <div
                className={`award-reveal${item ? "" : " no-image"}`}
                key={`${award.galleryItemId}-${index}`}
              >
                <div className="award-confetti" aria-hidden="true">
                  <span>◆</span><span>●</span><span>▲</span><span>★</span>
                  <span>●</span><span>◆</span><span>★</span><span>▲</span>
                </div>
                <div className="award-step-label">
                  {index + 1}つ目の賞 ／ 全{awards.length}賞
                </div>
                <h2 id="award-show-title">🏆 {award.title}</h2>
                <div className="award-reveal-layout">
                  {item && (
                    <div className="award-reveal-frame">
                      <img
                        src={item.imageDataUrl}
                        alt={item.word || "受賞作品"}
                        decoding="async"
                      />
                    </div>
                  )}
                  <div className="award-reveal-copy">
                    {item && (
                      <div className="award-reveal-work">
                        <strong>「{item.word || "？？？"}」</strong>
                        {drawers && <span>{drawers}</span>}
                      </div>
                    )}
                    <div className="award-comment-label">AI画伯のひとこと</div>
                    <p className="award-comment">{award.reason}</p>
                  </div>
                </div>
                <div className="award-auto-progress" aria-hidden="true">
                  <span />
                </div>
              </div>
            )}

            {phase === "finale" && (
              <div className="award-finale" key="award-finale">
                <div className="award-finale-icons" aria-hidden="true">
                  🎉 🏆 🎉
                </div>
                <h2 id="award-show-title">以上、全{awards.length}賞でした！</h2>
                <p>どの絵も、今日だけの立派な名作です。</p>
                <button
                  type="button"
                  className="award-finale-button"
                  onClick={() => setAwardCeremony(null)}
                >
                  受賞作を一覧で見る
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderAnswerCelebration() {
    if (!answerCelebration) return null;
    const crazyPrompt = answerCelebration.aiCrazyPrompt?.fullPrompt
      ? answerCelebration.aiCrazyPrompt
      : null;
    const mainAnswer =
      crazyPrompt?.mainAnswer || answerCelebration.word || "？？？";
    const cheerIndex =
      Math.abs(Number(answerCelebration.roundId) || 0) %
      ANSWER_CELEBRATION_CHEERS.length;
    const cheer = crazyPrompt
      ? "AIの無茶ぶりを見抜くとは…人類、やりますね！"
      : ANSWER_CELEBRATION_CHEERS[cheerIndex];

    return (
      <div
        className={`answer-celebration${crazyPrompt ? " is-ai-crazy" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="answer-celebration-title"
        aria-describedby="answer-celebration-description"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            dismissAnswerCelebration();
          }
        }}
      >
        <div className="answer-celebration-confetti" aria-hidden="true">
          {Array.from({ length: ANSWER_CONFETTI_COUNT }, (_, index) => (
            <span
              key={index}
              style={{
                "--confetti-x": `${5 + ((index * 37) % 90)}%`,
                "--confetti-delay": `${(index % 6) * 0.06}s`,
                "--confetti-drift": `${((index % 5) - 2) * 20}px`,
                "--confetti-spin": `${420 + (index % 4) * 90}deg`,
              }}
            />
          ))}
        </div>

        <section className="answer-celebration-card">
          <button
            type="button"
            className="answer-celebration-close"
            onClick={dismissAnswerCelebration}
            aria-label="正解発表を閉じる"
            autoFocus
          >
            ×
          </button>

          <div className="answer-celebration-seal" aria-hidden="true">
            <span>✓</span>
          </div>
          <div className="answer-celebration-kicker">ピンポーン！</div>
          <h2 id="answer-celebration-title">せいかい！</h2>
          <div className="answer-celebration-label">
            {crazyPrompt ? "正解の主役" : "こたえ"}
          </div>
          <div className="answer-celebration-word">「{mainAnswer}」</div>

          {crazyPrompt && (
            <div className="answer-celebration-crazy">
              <span>🤖 AIむちゃぶりお題</span>
              <strong>{crazyPrompt.fullPrompt}</strong>
            </div>
          )}

          <p className="answer-celebration-credit">
            {answerCelebration.drawerName ? (
              <>
                <strong>{answerCelebration.drawerName}</strong> が描きました
              </>
            ) : (
              "みんなで見事に当てました"
            )}
          </p>
          <p
            className="answer-celebration-cheer"
            id="answer-celebration-description"
          >
            {cheer}
          </p>
          <div className="answer-celebration-progress" aria-hidden="true">
            <span />
          </div>
        </section>
      </div>
    );
  }

  function dismissAiSecretGuess() {
    dismissedSecretGuessRoundRef.current =
      secretGuessReveal?.roundId ?? roundIdRef.current;
    setSecretGuessReveal(null);
  }

  function renderAiSecretGuessReveal() {
    if (!secretGuessReveal) return null;
    const isResult = secretGuessReveal.kind === "result";
    const isCorrect = isResult && !!secretGuessReveal.isCorrect;
    const correctWord = secretGuessReveal.correctWord || word || "？？？";
    const fallbackIcon =
      secretGuessReveal.kind === "too_fast" ? "⚡" : "🌀";

    return (
      <div
        className={`ai-secret-reveal${
          isResult ? (isCorrect ? " is-correct" : " is-missed") : " is-fallback"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-secret-title"
        aria-describedby="ai-secret-description"
      >
        <div className="ai-secret-reveal-card">
          <button
            type="button"
            className="ai-secret-close"
            onClick={dismissAiSecretGuess}
            aria-label="AIのひみつ予想を閉じる"
            autoFocus
          >
            × とじる
          </button>

          <div className="ai-secret-robot" aria-hidden="true">
            {isResult ? "🤖" : fallbackIcon}
          </div>
          <div className="ai-secret-eyebrow">答え発表まで秘密でした</div>
          <h2 id="ai-secret-title">🤖 AIのひみつ予想</h2>

          {isResult ? (
            <>
              <dl className="ai-secret-guesses">
                <div className="ai-secret-guess best">
                  <dt>本命</dt>
                  <dd>「{secretGuessReveal.bestGuess || "？？？"}」</dd>
                </div>
                <div className="ai-secret-guess second">
                  <dt>対抗</dt>
                  <dd>「{secretGuessReveal.secondGuess || "？？？"}」</dd>
                </div>
                <div className="ai-secret-guess wild">
                  <dt>大穴</dt>
                  <dd>「{secretGuessReveal.wildGuess || "？？？"}」</dd>
                </div>
              </dl>
              <div className="ai-secret-answer">
                <span>本当のこたえ</span>
                <strong>「{correctWord}」</strong>
              </div>
              <p
                className="ai-secret-verdict"
                id="ai-secret-description"
                aria-live="polite"
              >
                {isCorrect ? "🎯 AIも正解！" : "🤖 AI、完全に迷子！"}
              </p>
              {secretGuessReveal.comment && (
                <div className="ai-secret-comment">
                  <span>AIのひとこと</span>
                  <p>{secretGuessReveal.comment}</p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="ai-secret-answer">
                <span>本当のこたえ</span>
                <strong>「{correctWord}」</strong>
              </div>
              <p
                className="ai-secret-fallback-message"
                id="ai-secret-description"
                aria-live="polite"
              >
                {secretGuessReveal.message ||
                  "AI、考え込みすぎて今回は答えが出ませんでした！"}
              </p>
            </>
          )}

          <div className="ai-secret-auto-progress" aria-hidden="true">
            <span />
          </div>
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

    if (roundType === "gradual") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
            {renderRoundProgress()}
            <span className="mode-pill gradual-pill">だんだん</span>
          </div>
          {drawPhase === "drawing" ? (
            word ? (
              <>
                <div className="info-block info-prompt">
                  <div className="info-label">あなたのお題</div>
                  <div className="prompt-value">{word}</div>
                </div>
                <p className="hint">
                  みんなには まだ見えてないよ。描きおわったら「できた！」を押そう
                </p>
              </>
            ) : (
              <div className="info-block info-drawer">
                <div className="info-label">🤫 こっそり おえかき中</div>
                <div className="drawer-value">{drawerName}</div>
                <p className="hint">
                  できあがると、絵が だんだん見えてくるよ…！
                </p>
              </div>
            )
          ) : word ? (
            <>
              <div className="info-block info-prompt">
                <div className="info-label">あなたのお題</div>
                <div className="prompt-value">{word}</div>
              </div>
              <p className="hint">
                みんなの画面に じわじわ出てるよ。当たったら「つぎのお題へ」！
              </p>
            </>
          ) : (
            <div className="info-block info-drawer">
              <div className="info-label">👀 だんだん見えてくる…</div>
              <div className="drawer-value">わかったら さけぼう！</div>
              <p className="hint">はやく当てた人の勝ち！</p>
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
          {secretGuessActive && (
            <span className="mode-pill ai-secret-pill">🤖 AIひみつ予想</span>
          )}
          {aiCrazyPromptState.active && (
            <span className="mode-pill ai-crazy-badge">🤖 AIむちゃぶり</span>
          )}
        </div>
        {drawPhase === "reveal" && aiCrazyPromptState.active ? (
          <div className="info-block info-answer ai-crazy-prompt-card is-reveal">
            <div className="info-label ai-crazy-label">✅ こたえ</div>
            <div className="ai-crazy-main">
              <span>正解の主役</span>
              <strong>{aiCrazyPromptState.mainAnswer || word}</strong>
            </div>
            <div className="ai-crazy-full">
              <span>🤖 AIむちゃぶりお題</span>
              <strong>{aiCrazyPromptState.fullPrompt}</strong>
            </div>
            <p className="hint">{drawerName}が描きました</p>
          </div>
        ) : drawPhase === "reveal" ? (
          <div className="info-block info-answer">
            <div className="info-label">✅ こたえ</div>
            <div className="prompt-value">{word}</div>
            <p className="hint">{drawerName}が描きました</p>
          </div>
        ) : aiCrazyPromptState.active && canDraw ? (
          <div className="info-block ai-crazy-prompt-card">
            <div className="info-label ai-crazy-label">
              🤖 AIむちゃぶりお題
            </div>
            <div className="ai-crazy-full">
              <strong>{aiCrazyPromptState.fullPrompt}</strong>
            </div>
            <p className="ai-crazy-sub">
              主役の「{aiCrazyPromptState.mainAnswer}」が当たれば正解でOK！
            </p>
          </div>
        ) : aiCrazyPromptState.active ? (
          <div className="info-block ai-crazy-prompt-card is-guessing">
            <div className="info-label ai-crazy-label">🤖 AIむちゃぶり中</div>
            <div className="ai-crazy-full">
              <strong>今回はAIが考えた変なお題！</strong>
            </div>
            <p className="ai-crazy-sub">
              {drawerName ? `${drawerName}が描いています。` : ""}
              まずは主役を当てよう！
            </p>
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
        {secretGuessActive && drawPhase === "drawing" && (
          <div className="ai-secret-note" role="note">
            <span aria-hidden="true">🤫</span>
            <p>
              AIが途中の絵をこっそり見ます。予想は答え発表まで秘密！
            </p>
          </div>
        )}
        {secretGuessPending && drawPhase === "reveal" && (
          <div className="ai-secret-pending" role="status" aria-live="polite">
            <span aria-hidden="true">🤖</span>
            <span>AIはまだ考え中…</span>
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

      {renderAwardCeremony()}

      {communityVoteOpen && (
        <CommunityVoteOverlay
          state={communityAwardsState}
          gallery={gallery}
          votes={communityVotes}
          setVotes={setCommunityVotes}
          step={communityVoteStep}
          setStep={setCommunityVoteStep}
          editing={communityVoteEditing}
          setEditing={setCommunityVoteEditing}
          remainSec={communityVoteRemainSec}
          submitting={communityVoteSubmitting}
          error={error}
          isHost={isHost}
          onSubmit={submitCommunityAwardsVotes}
          onFinalize={finalizeCommunityAwards}
          onClose={() => setCommunityVoteOpen(false)}
        />
      )}

      <CommunityAwardCeremony
        ceremony={communityCeremony}
        state={communityAwardsState}
        gallery={gallery}
        onClose={() => setCommunityCeremony(null)}
      />

      {renderAnswerCelebration()}

      {renderAiSecretGuessReveal()}

      {fanfare && (
        <div
          className={`fanfare fanfare-${fanfare.roundType}${fanfare.aiCrazyPrompt ? " fanfare-ai-crazy" : ""}`}
          role="status"
        >
          <div className="fanfare-inner">
            <div className="fanfare-text">{fanfare.message}</div>
            {fanfare.roundType === "coop" && fanfare.names?.length > 0 && (
              <div className="fanfare-sub">{fanfare.names.join("・")}</div>
            )}
            {fanfare.constraint && (
              <div className="fanfare-sub fanfare-constraint-sub">
                {fanfare.constraint.emoji} {fanfare.constraint.label}
                <span>{fanfare.constraint.rule}</span>
              </div>
            )}
            {fanfare.aiCrazyPrompt && (
              <div className="fanfare-sub ai-crazy-fanfare-sub">
                今回はちょっと変なお題！
                <span>まずは主役を当てよう！</span>
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
                    disabled={!!highlight || isCommunityVoting}
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

          <section
            className="community-awards-panel"
            aria-labelledby="community-awards-title"
          >
            <div className="community-panel-eyebrow">会場のみんな presents</div>
            <h2 id="community-awards-title">🙌 みんなで決める3大賞</h2>

            {communityAwardsState.status === "idle" && (
              <>
                <p className="community-panel-note">
                  3つの「○○賞」に匿名投票。結果は最後まで秘密です。
                </p>
                <div className="community-award-samples" aria-hidden="true">
                  <span>じわじわ</span>
                  <span>発想が斜め上</span>
                  <span>飾りたい</span>
                </div>
                {communityAwardsState.candidateCount < 2 ? (
                  <p className="community-panel-note">
                    絵が2枚以上あると、みんなで投票できます
                  </p>
                ) : isHost ? (
                  <button
                    type="button"
                    className="community-start-button"
                    onClick={startCommunityAwards}
                    disabled={isAiFinishBusy}
                  >
                    🗳️ みんなの投票をはじめる
                  </button>
                ) : (
                  <p className="hint">ホストが投票を始められます</p>
                )}
              </>
            )}

            {communityAwardsState.status === "voting" && (
              <>
                <div className="community-panel-status" role="status" aria-live="polite">
                  <span className="community-panel-ballot" aria-hidden="true">🗳️</span>
                  <div>
                    <strong>ただいま匿名投票中！</strong>
                    <span>
                      {communityAwardsState.votedCount} / {communityAwardsState.eligibleCount}人 投票ずみ
                    </span>
                  </div>
                </div>
                <div className="community-panel-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${
                        communityAwardsState.eligibleCount > 0
                          ? (communityAwardsState.votedCount /
                              communityAwardsState.eligibleCount) *
                            100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                {communityVoteRemainSec !== null && (
                  <p className="community-panel-remain">
                    あと{communityVoteRemainSec}秒で自動集計
                  </p>
                )}
                <button
                  type="button"
                  className="community-open-vote"
                  onClick={() => setCommunityVoteOpen(true)}
                >
                  {communityAwardsState.hasVoted
                    ? "投票ずみ・結果を待つ"
                    : communityAwardsState.canVote
                      ? "投票画面を開く"
                      : "投票状況を見る"}
                </button>
                {isHost && communityAwardsState.votedCount > 0 && (
                  <button
                    type="button"
                    className="community-panel-finalize"
                    onClick={finalizeCommunityAwards}
                  >
                    ここで締め切って発表
                  </button>
                )}
              </>
            )}

            {communityAwardsState.status === "ready" &&
              communityAwardsState.results?.awards?.length > 0 && (
                <>
                  <p className="community-panel-note">
                    みんなの票で決まった、本日の3大賞です！
                  </p>
                  <button
                    type="button"
                    className="community-replay-button"
                    onClick={startCommunityAwardCeremony}
                  >
                    🎬 投票結果をもう一度見る
                  </button>
                  <CommunityAwardsSummary
                    state={communityAwardsState}
                    gallery={gallery}
                  />
                </>
              )}
          </section>

          {aiState.enabled && (
            <section className="ai-ceremony" aria-labelledby="ai-awards-title">
              <div className="ai-eyebrow">AI画伯 presents</div>
              <h2 id="ai-awards-title">AI画伯の授賞式</h2>

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
                    <button
                      type="button"
                      className="ai-awards-replay"
                      onClick={startAwardCeremony}
                      disabled={isCommunityVoting}
                    >
                      🎬 授賞式をもう一度見る
                    </button>
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
                      disabled={
                        aiState.awardCandidateCount < 2 || isCommunityVoting
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

          {isAiFinishBusy && (
            <p className="finish-wait" role="status">
              AI授賞式を準備中です。完成すると延長・ロビーへ戻る操作ができます
            </p>
          )}

          {isCommunityVoting && (
            <p className="finish-wait" role="status">
              みんなの投票中です。結果発表後に延長・ロビーへ戻れます
            </p>
          )}

          <div className="actions">
            {isHost ? (
              <>
                <button
                  type="button"
                  onClick={extendGame}
                  disabled={finishBusy || isFinishCeremonyBusy}
                >
                  あと{extensionRounds}問だけ延長！
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={endGame}
                  disabled={finishBusy || isFinishCeremonyBusy}
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
                    {item.aiCrazyPromptFullPrompt && (
                      <>
                        <span className="gallery-ai-crazy-badge">
                          🤖 AIむちゃぶり
                        </span>
                        <span className="gallery-ai-crazy-subtext">
                          {item.aiCrazyPromptFullPrompt}
                        </span>
                      </>
                    )}
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
              <div className="easel-badge gradual-badge" aria-hidden="true">
                だんだん
              </div>
            )}
            <div className={`canvas-wrap ${modeClass}`}>
              <DrawingCanvas
                ref={canvasApiRef}
                enabled={!!canDraw && !replaying}
                clearToken={clearToken}
                onStroke={emitStroke}
                historySeed={historySeed}
                penWidth={constraint?.kind === "pen" ? constraint.value : 4}
                strokeLimit={
                  constraint?.kind === "strokes" ? constraint.value : 0
                }
                strokeUsedSeed={strokesUsed}
                onStrokeUsed={setStrokesUsed}
                onReplayChange={setReplaying}
              />
              {/* めかくししばり: 描いている本人にだけ絵を隠す（線は下を通る） */}
              {constraint?.kind === "blind" && canDraw && !replaying && (
                <div className="canvas-blind" aria-hidden="true">
                  <span className="canvas-blind-face">🙈</span>
                  <span className="canvas-blind-text">見ないで描こう！</span>
                </div>
              )}
              {/* だんだん見える: 公開までは見ている側に幕をかける */}
              {roundType === "gradual" &&
                drawPhase === "drawing" &&
                !canDraw && (
                  <div className="canvas-curtain" aria-hidden="true">
                    <span className="canvas-curtain-face">🤫</span>
                    <span className="canvas-curtain-text">
                      こっそり おえかき中…
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
            {canReveal && (
              <button type="button" onClick={revealLiar}>
                こたえあわせ
              </button>
            )}
            {canFinishGradual && (
              <button type="button" onClick={finishGradualDrawing}>
                できた！みんなに見せる
              </button>
            )}
            {canRevealAnswer && (
              <button
                type="button"
                onClick={revealAnswer}
                disabled={revealingAnswer}
                aria-busy={revealingAnswer}
              >
                {revealingAnswer ? "発表の準備中…" : "✅ せいかい！"}
              </button>
            )}
            {canPassWord && (
              <button
                type="button"
                className="quiet pass-btn"
                onClick={passWord}
                disabled={passing}
              >
                🙅 わからない…パス（あと{passesLeft}回）
              </button>
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
