import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const MAX_HISTORY = 20000;
/** 爆笑リプレイ: 全体が数秒で終わる速さに丸める（線が多いほど早送りになる） */
const REPLAY_MS_PER_EVENT = 9;
const REPLAY_MIN_MS = 1400;
const REPLAY_MAX_MS = 5000;

/**
 * 正規化座標 (0-1) で線を送受信するキャンバス。
 * 描画イベントを履歴として保持し、リサイズ時や履歴受信時に再描画する。
 */
const DrawingCanvas = forwardRef(function DrawingCanvas(
  {
    enabled,
    clearToken,
    onStroke,
    historySeed,
    penWidth = 4,
    strokeLimit = 0,
    strokeUsedSeed = 0,
    onStrokeUsed,
    onReplayChange,
  },
  ref
) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  /** @type {React.MutableRefObject<object[]>} 全描画イベント（自分＋他人） */
  const historyRef = useRef([]);
  /** @type {React.MutableRefObject<Map<string, {x:number,y:number}|null>>} */
  const remoteLastMapRef = useRef(new Map());
  /** 本数しばりで、自分がこのラウンドに引いた線の数 */
  const strokeUsedRef = useRef(0);
  const replayingRef = useRef(false);
  const replayRafRef = useRef(0);
  // 最新の値をハンドラから読むための箱（再購読を避ける）
  const penWidthRef = useRef(penWidth);
  const strokeLimitRef = useRef(strokeLimit);
  const onStrokeUsedRef = useRef(onStrokeUsed);
  const onReplayChangeRef = useRef(onReplayChange);

  penWidthRef.current = penWidth;
  strokeLimitRef.current = strokeLimit;
  onStrokeUsedRef.current = onStrokeUsed;
  onReplayChangeRef.current = onReplayChange;

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
    /** 描いた順に早送り再生する。再生できたら true */
    playReplay() {
      return startReplay();
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

  /** 履歴イベントを1つ描く（描き手ごとの最終点を lastMap で持ち回る） */
  function applyHistoryEvent(ev, lastMap) {
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

  function clearSurface() {
    const ready = setupContext();
    if (!ready) return null;
    const { ctx, rect } = ready;
    ctx.fillStyle = "#fbf4e4";
    ctx.fillRect(0, 0, rect.width, rect.height);
    return ready;
  }

  /** キャンバスを初期化し、履歴を先頭から描き直す */
  function redrawFromHistory() {
    if (!clearSurface()) return;

    const lastMap = new Map();
    for (const ev of historyRef.current) {
      applyHistoryEvent(ev, lastMap);
    }

    // 描きかけの線が途切れないように現在位置を引き継ぐ
    remoteLastMapRef.current = new Map(
      [...lastMap].filter(([key]) => key !== "local")
    );
    lastRef.current = lastMap.get("local") || null;
  }

  function stopReplay() {
    if (replayRafRef.current) {
      cancelAnimationFrame(replayRafRef.current);
      replayRafRef.current = 0;
    }
    if (replayingRef.current) {
      replayingRef.current = false;
      onReplayChangeRef.current?.(false);
    }
  }

  /** 履歴を先頭から早送りで描き直す。終わったら本来の状態に戻す */
  function startReplay() {
    const events = historyRef.current.slice();
    if (events.length < 2) return false;

    stopReplay();
    if (!clearSurface()) return false;

    replayingRef.current = true;
    onReplayChangeRef.current?.(true);

    const duration = Math.min(
      REPLAY_MAX_MS,
      Math.max(REPLAY_MIN_MS, events.length * REPLAY_MS_PER_EVENT)
    );
    const startedAt = performance.now();
    const lastMap = new Map();
    let index = 0;

    function step(now) {
      replayRafRef.current = 0;
      if (!replayingRef.current) return;

      const progress = Math.min(1, (now - startedAt) / duration);
      const target = Math.min(events.length, Math.ceil(progress * events.length));
      while (index < target) {
        applyHistoryEvent(events[index], lastMap);
        index += 1;
      }

      if (progress < 1) {
        replayRafRef.current = requestAnimationFrame(step);
        return;
      }
      // 再生中に届いた線もふくめて、本当の今の絵に戻す
      stopReplay();
      redrawFromHistory();
    }

    replayRafRef.current = requestAnimationFrame(step);
    return true;
  }

  function pushHistory(ev) {
    historyRef.current.push(ev);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY);
    }
  }

  function resetStrokeBudget() {
    strokeUsedRef.current = 0;
    onStrokeUsedRef.current?.(0);
  }

  function clearBoard() {
    stopReplay();
    historyRef.current = [];
    drawingRef.current = false;
    resetStrokeBudget();
    redrawFromHistory();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    redrawFromHistory();
    const ro = new ResizeObserver(() => {
      // 再生中にサイズが変わったら、続きは描けないので今の絵に戻す
      stopReplay();
      redrawFromHistory();
    });
    ro.observe(canvas.parentElement || canvas);
    return () => {
      ro.disconnect();
      stopReplay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    clearBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken]);

  // 再読み込みや再接続のあとは、サーバーが数えている本数に合わせる
  // （ローカルの方が進んでいるときは巻き戻さない）
  useEffect(() => {
    const next = Math.max(strokeUsedRef.current, strokeUsedSeed || 0);
    if (next === strokeUsedRef.current) return;
    strokeUsedRef.current = next;
    onStrokeUsedRef.current?.(next);
  }, [strokeUsedSeed]);

  // サーバーからの履歴（途中参加・再接続・ギャラリーから復帰）
  useEffect(() => {
    if (!historySeed || !historySeed.token) return;
    stopReplay();
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
      // 再生中は描かない（再生後の redrawFromHistory でまとめて反映される）
      if (!replayingRef.current) drawRemote(data);
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
    if (!enabled || replayingRef.current) return;
    e.preventDefault();
    // 本数しばりを使い切ったら、もう描けない
    const limit = strokeLimitRef.current;
    if (limit > 0 && strokeUsedRef.current >= limit) return;
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
    if (limit > 0) {
      strokeUsedRef.current += 1;
      onStrokeUsedRef.current?.(strokeUsedRef.current);
    }
    const ev = {
      type: "start",
      x: pos.x,
      y: pos.y,
      width: penWidthRef.current,
      color: "#1a1a1a",
    };
    pushHistory(ev);
    onStroke?.(ev);
  }

  function handleMove(e) {
    if (!enabled || !drawingRef.current || replayingRef.current) return;
    e.preventDefault();
    const pos = getNormPos(e);
    if (!pos) return;
    const last = lastRef.current;
    if (last) {
      strokeSegment(last, pos, "#1a1a1a", penWidthRef.current);
      const ev = {
        type: "move",
        x: pos.x,
        y: pos.y,
        width: penWidthRef.current,
        color: "#1a1a1a",
      };
      pushHistory(ev);
      onStroke?.(ev);
    }
    lastRef.current = pos;
  }

  function handleEnd(e) {
    if (!enabled) return;
    // キャンバスの外に指がはみ出しただけなら、線は続ける
    // （一筆がき・本数しばりで事故りやすいため）
    if (
      e.type === "pointerleave" &&
      e.pointerId != null &&
      e.currentTarget?.hasPointerCapture?.(e.pointerId)
    ) {
      return;
    }
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
