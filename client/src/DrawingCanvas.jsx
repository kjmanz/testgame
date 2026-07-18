import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const MAX_HISTORY = 20000;

/**
 * 正規化座標 (0-1) で線を送受信するキャンバス。
 * 描画イベントを履歴として保持し、リサイズ時や履歴受信時に再描画する。
 */
const DrawingCanvas = forwardRef(function DrawingCanvas(
  { enabled, clearToken, onStroke, historySeed },
  ref
) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  /** @type {React.MutableRefObject<object[]>} 全描画イベント（自分＋他人） */
  const historyRef = useRef([]);
  /** @type {React.MutableRefObject<Map<string, {x:number,y:number}|null>>} */
  const remoteLastMapRef = useRef(new Map());

  useImperativeHandle(ref, () => ({
    /**
     * JPEG 圧縮した data URL を返す（ギャラリー用）
     * @param {{ maxSize?: number, quality?: number }} [opts]
     */
    exportImage({ maxSize = 640, quality = 0.72 } = {}) {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const srcW = canvas.width;
      const srcH = canvas.height;
      if (!srcW || !srcH) return null;

      const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));

      const tmp = document.createElement("canvas");
      tmp.width = outW;
      tmp.height = outH;
      const ctx = tmp.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fbf4e4";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(canvas, 0, 0, outW, outH);
      try {
        return tmp.toDataURL("image/jpeg", quality);
      } catch {
        return null;
      }
    },
  }));

  function setupContext() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return { ctx, rect };
  }

  function strokeSegment(from, to, color = "#1a1a1a", width = 4) {
    const canvas = canvasRef.current;
    if (!canvas || !from || !to) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x * rect.width, from.y * rect.height);
    ctx.lineTo(to.x * rect.width, to.y * rect.height);
    ctx.stroke();
  }

  /** キャンバスを初期化し、履歴を先頭から描き直す */
  function redrawFromHistory() {
    const ready = setupContext();
    if (!ready) return;
    const { ctx, rect } = ready;
    ctx.fillStyle = "#fbf4e4";
    ctx.fillRect(0, 0, rect.width, rect.height);

    const lastMap = new Map();
    for (const ev of historyRef.current) {
      const key = ev.playerId || "local";
      if (ev.type === "start") {
        lastMap.set(key, { x: ev.x, y: ev.y });
      } else if (ev.type === "end") {
        lastMap.delete(key);
      } else if (ev.type === "move") {
        const last = lastMap.get(key);
        if (last) {
          strokeSegment(last, { x: ev.x, y: ev.y }, ev.color, ev.width);
        }
        lastMap.set(key, { x: ev.x, y: ev.y });
      }
    }

    // 描きかけの線が途切れないように現在位置を引き継ぐ
    remoteLastMapRef.current = new Map(
      [...lastMap].filter(([key]) => key !== "local")
    );
    lastRef.current = lastMap.get("local") || null;
  }

  function pushHistory(ev) {
    historyRef.current.push(ev);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY);
    }
  }

  function clearBoard() {
    historyRef.current = [];
    drawingRef.current = false;
    redrawFromHistory();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    redrawFromHistory();
    const ro = new ResizeObserver(() => redrawFromHistory());
    ro.observe(canvas.parentElement || canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    clearBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken]);

  // サーバーからの履歴（途中参加・再接続・ギャラリーから復帰）
  useEffect(() => {
    if (!historySeed || !historySeed.token) return;
    historyRef.current = [...(historySeed.strokes || [])];
    drawingRef.current = false;
    redrawFromHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySeed]);

  useEffect(() => {
    function onRemote(e) {
      const data = e.detail;
      if (!data) return;
      pushHistory(data);
      drawRemote(data);
    }
    window.addEventListener("remote-stroke", onRemote);
    return () => window.removeEventListener("remote-stroke", onRemote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // iOS: React の preventDefault が効かないため native でスクロールを止める
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const opts = { passive: false };
    const preventScroll = (e) => {
      e.preventDefault();
    };
    canvas.addEventListener("touchstart", preventScroll, opts);
    canvas.addEventListener("touchmove", preventScroll, opts);
    canvas.addEventListener("touchend", preventScroll, opts);
    return () => {
      canvas.removeEventListener("touchstart", preventScroll, opts);
      canvas.removeEventListener("touchmove", preventScroll, opts);
      canvas.removeEventListener("touchend", preventScroll, opts);
    };
  }, []);

  function getNormPos(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const point = "clientX" in e ? e : e.touches?.[0];
    if (!point) return null;
    return {
      x: (point.clientX - rect.left) / rect.width,
      y: (point.clientY - rect.top) / rect.height,
    };
  }

  function drawRemote(data) {
    const key = data.playerId || "default";
    if (data.type === "start") {
      remoteLastMapRef.current.set(key, { x: data.x, y: data.y });
      return;
    }
    if (data.type === "end") {
      remoteLastMapRef.current.delete(key);
      return;
    }
    if (data.type === "move") {
      const last = remoteLastMapRef.current.get(key);
      if (last) {
        strokeSegment(last, { x: data.x, y: data.y }, data.color, data.width);
      }
      remoteLastMapRef.current.set(key, { x: data.x, y: data.y });
    }
  }

  function handleStart(e) {
    if (!enabled) return;
    e.preventDefault();
    if (e.currentTarget?.setPointerCapture && e.pointerId != null) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    drawingRef.current = true;
    const pos = getNormPos(e);
    if (!pos) return;
    lastRef.current = pos;
    const ev = {
      type: "start",
      x: pos.x,
      y: pos.y,
      width: 4,
      color: "#1a1a1a",
    };
    pushHistory(ev);
    onStroke?.(ev);
  }

  function handleMove(e) {
    if (!enabled || !drawingRef.current) return;
    e.preventDefault();
    const pos = getNormPos(e);
    if (!pos) return;
    const last = lastRef.current;
    if (last) {
      strokeSegment(last, pos);
      const ev = {
        type: "move",
        x: pos.x,
        y: pos.y,
        width: 4,
        color: "#1a1a1a",
      };
      pushHistory(ev);
      onStroke?.(ev);
    }
    lastRef.current = pos;
  }

  function handleEnd(e) {
    if (!enabled) return;
    e.preventDefault();
    if (drawingRef.current) {
      pushHistory({ type: "end" });
      onStroke?.({ type: "end" });
    }
    drawingRef.current = false;
    lastRef.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handleStart}
      onPointerMove={handleMove}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
      onPointerLeave={handleEnd}
    />
  );
});

export default DrawingCanvas;
