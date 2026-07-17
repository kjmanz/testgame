import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import DrawingCanvas from "./DrawingCanvas.jsx";

function createSocket() {
  const url = import.meta.env.VITE_SOCKET_URL || undefined;
  return io(url, {
    autoConnect: true,
    transports: ["websocket", "polling"],
  });
}

export default function App() {
  const socketRef = useRef(null);
  const [screen, setScreen] = useState("home"); // home | lobby | play
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [players, setPlayers] = useState([]);
  const [hostId, setHostId] = useState("");
  const [drawerId, setDrawerId] = useState("");
  const [drawerName, setDrawerName] = useState("");
  const [word, setWord] = useState(null);
  const [clearToken, setClearToken] = useState(0);

  const isHost = playerId && playerId === hostId;
  const isDrawer = playerId && playerId === drawerId;

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.on("lobbyUpdate", (data) => {
      setRoomCode(data.code);
      setPlayers(data.players || []);
      setHostId(data.hostId);
      if (data.phase === "lobby") {
        setScreen("lobby");
        setDrawerId("");
        setDrawerName("");
        setWord(null);
      }
    });

    socket.on("roundStart", (data) => {
      setScreen("play");
      setDrawerId(data.drawerId);
      setDrawerName(data.drawerName);
      setWord(data.word ?? null);
      setPlayers(data.players || []);
      setClearToken((n) => n + 1);
    });

    socket.on("clearCanvas", () => {
      setClearToken((n) => n + 1);
    });

    socket.on("gameEnded", () => {
      setScreen("lobby");
      setDrawerId("");
      setDrawerName("");
      setWord(null);
      setClearToken((n) => n + 1);
    });

    socket.on("stroke", (data) => {
      window.dispatchEvent(new CustomEvent("remote-stroke", { detail: data }));
    });

    return () => {
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
    socketRef.current?.emit("createRoom", { name }, (res) => {
      if (!res?.ok) {
        setError(res?.error || "作成に失敗しました");
        return;
      }
      setPlayerId(res.playerId);
      setRoomCode(res.code);
      setPlayers(res.players || []);
      setHostId(res.hostId || res.playerId);
      setScreen("lobby");
    });
  }

  function joinRoom() {
    setError("");
    socketRef.current?.emit(
      "joinRoom",
      { code: joinCode, name },
      (res) => {
        if (!res?.ok) {
          setError(res?.error || "入室に失敗しました");
          return;
        }
        setPlayerId(res.playerId);
        setRoomCode(res.code);
        setPlayers(res.players || []);
        setHostId(res.hostId || "");
        setScreen("lobby");
      }
    );
  }

  function startGame() {
    setError("");
    socketRef.current?.emit("startGame", (res) => {
      if (!res?.ok) setError(res?.error || "開始できません");
    });
  }

  function nextRound() {
    setError("");
    socketRef.current?.emit("nextRound", (res) => {
      if (!res?.ok) setError(res?.error || "次へ進めません");
    });
  }

  function endGame() {
    setError("");
    socketRef.current?.emit("endGame", (res) => {
      if (!res?.ok) setError(res?.error || "終了できません");
    });
  }

  return (
    <div className="app">
      <header className="brand">
        <div className="brand-badge">アトリエオープン</div>
        <h1>おえかきあて</h1>
        <p>キャンバスに描いて、みんなで当てよう</p>
      </header>

      {screen === "home" && (
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
              onChange={(e) =>
                setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 4))
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

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {screen === "lobby" && (
        <div className="card tape-teal">
          <div className="label">部屋コード</div>
          <div className="code-big">{roomCode}</div>
          <p className="hint">このコードをみんなに教えて入室してもらおう</p>

          <div className="label">さんかしゃ（{players.length}/10）</div>
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
          </div>

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {screen === "play" && (
        <>
          <div className="card play-header tape-yellow">
            <div className="meta">部屋 {roomCode}</div>
            {isDrawer ? (
              <>
                <div className="label">あなたのオダイ</div>
                <div className="word">{word}</div>
              </>
            ) : (
              <>
                <div className="label">いま描いている人</div>
                <div className="word">{drawerName}</div>
                <p className="hint">絵を見て、口頭で当てよう！</p>
              </>
            )}
          </div>

          <div className="easel">
            <div className="easel-clip" aria-hidden="true" />
            <div className="canvas-wrap">
              <DrawingCanvas
                enabled={!!isDrawer}
                clearToken={clearToken}
                onStroke={emitStroke}
              />
            </div>
          </div>

          <div className="actions">
            {isDrawer && (
              <button type="button" onClick={nextRound}>
                つぎのお題へ
              </button>
            )}
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
