import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import DrawingCanvas from "./DrawingCanvas.jsx";

const SESSION_KEY = "oekaki-session";
/** ブラウザを閉じても3時間は同じ部屋に戻れる */
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

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
  if (!data?.playerId || !data?.roomCode || !data?.name) return null;
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

export default function App() {
  const socketRef = useRef(null);
  const wakeLockRef = useRef(null);
  const canvasApiRef = useRef(null);
  /** サーバー時刻 - 端末時刻（タイマー表示のずれ補正用） */
  const serverOffsetRef = useRef(0);
  const [screen, setScreen] = useState("home"); // home | lobby | play | gallery
  // 期限切れセッションでも名前だけは引き継いで入力の手間を省く
  const [name, setName] = useState(() => readSessionRaw()?.name || "");
  const [joinCode, setJoinCode] = useState("");
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
  const [restoring, setRestoring] = useState(() => !!loadSession());
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
  const [advancing, setAdvancing] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [historySeed, setHistorySeed] = useState({ token: 0, strokes: [] });
  const [gallerySelectMode, setGallerySelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [returnScreen, setReturnScreen] = useState("lobby");

  const isHost = playerId && playerId === hostId;
  const modeClass = `mode-${roundType || "normal"}`;

  function applyRoundPayload(data, { forcePlay = true } = {}) {
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
    setAdvancing(false);
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
        setScreen((prev) => (prev === "gallery" ? "gallery" : "lobby"));
        resetPlayState();
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

    socket.on("gameEnded", () => {
      setScreen((prev) => (prev === "gallery" ? "gallery" : "lobby"));
      resetPlayState();
      setClearToken((n) => n + 1);
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
            roomCode: res.code,
            name: session.name,
          });
          if (res.phase === "lobby") setScreen("lobby");
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
        roomCode: res.code,
        name: trimmed,
      });
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
          roomCode: res.code,
          name: trimmed,
        });
        if (res.phase === "playing") {
          setScreen("play");
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
      setRoomCode("");
      setPlayerId("");
      setPlayers([]);
      setHostId("");
      setGallery([]);
      setSelectedIds(new Set());
      setHistorySeed({ token: 0, strokes: [] });
      resetPlayState();
    });
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
    socketRef.current?.emit("endGame", (res) => {
      if (!res?.ok) setError(res?.error || "終了できません");
    });
  }

  function revealLiar() {
    setError("");
    socketRef.current?.emit("revealLiar", (res) => {
      if (!res?.ok) setError(res?.error || "こたえあわせできません");
    });
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
    const next = returnScreen === "play" ? "play" : "lobby";
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
    const title = word ? `おえかき「${word}」` : "おえかき";
    const filename = `${safeWord}-${item.id.slice(0, 8)}.jpg`;
    try {
      const res = await fetch(item.imageDataUrl);
      const blob = await res.blob();
      if (navigator.share && navigator.canShare?.({ files: [new File([blob], filename, { type: blob.type })] })) {
        const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
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
    // 終わった人だけ名前、いま／これから描く人は ？
    return (
      <div className="info-block info-relay-order">
        <div className="info-label">描く順番</div>
        <div className="relay-order" aria-label="描く順番">
          {drawerNames.map((n, i) => {
            // 先頭〜いま描いている人まで名前表示、これから描く人は ？
            const revealed = !drawing || i <= current;
            const label = revealed ? n : "？";
            const className = !revealed
              ? "relay-order-name is-hidden"
              : drawing && i === current
                ? "relay-order-name is-current"
                : "relay-order-name is-done";
            return (
              <span key={`${n}-${i}`} className="relay-order-item">
                {i > 0 && <span className="relay-order-arrow">→</span>}
                <span className={className}>{label}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  function renderPlayHeader() {
    if (roundType === "relay") {
      return (
        <>
          <div className="meta row-meta">
            <span>部屋 {roomCode}</span>
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
                <div className="relay-order">
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
        <div className="meta">部屋 {roomCode}</div>
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
          <div>
            <div className="label">なまえ</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：たろう"
              maxLength={12}
              autoComplete="off"
            />
          </div>

          <button type="button" onClick={createRoom} disabled={!name.trim()}>
            部屋をつくる
          </button>

          <div className="divider-or">または</div>

          <div>
            <div className="label">部屋コード（4桁）</div>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value))}
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

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {!restoring && screen === "lobby" && (
        <div className="card tape-teal">
          <div className="label">部屋コード</div>
          <div className="code-big">{roomCode}</div>
          <p className="hint">このコードをみんなに教えて入室してもらおう</p>

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
                    <img src={item.imageDataUrl} alt={item.word || "絵"} />
                  </div>
                  <div className="gallery-meta">
                    <span className="gallery-word">{item.word}</span>
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
                つぎのお題へ
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
            {error && <p className="error">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
