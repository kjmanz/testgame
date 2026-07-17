import { useEffect, useRef } from "react";

/**
 * 正規化座標 (0-1) で線を送受信するキャンバス
 */
export default function DrawingCanvas({ enabled, clearToken, onStroke }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const remoteLastRef = useRef(null);

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

  function clearBoard() {
    const ready = setupContext();
    if (!ready) return;
    const { ctx, rect } = ready;
    ctx.fillStyle = "#fbf4e4";
    ctx.fillRect(0, 0, rect.width, rect.height);
    drawingRef.current = false;
    lastRef.current = null;
    remoteLastRef.current = null;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    clearBoard();
    const ro = new ResizeObserver(() => clearBoard());
    ro.observe(canvas.parentElement || canvas);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    clearBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken]);

  useEffect(() => {
    function onRemote(e) {
      drawRemote(e.detail);
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

  function drawRemote(data) {
    if (!data) return;
    if (data.type === "start") {
      remoteLastRef.current = { x: data.x, y: data.y };
      return;
    }
    if (data.type === "end") {
      remoteLastRef.current = null;
      return;
    }
    if (data.type === "move") {
      const last = remoteLastRef.current;
      if (last) {
        strokeSegment(last, { x: data.x, y: data.y }, data.color, data.width);
      }
      remoteLastRef.current = { x: data.x, y: data.y };
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
    onStroke?.({
      type: "start",
      x: pos.x,
      y: pos.y,
      width: 4,
      color: "#1a1a1a",
    });
  }

  function handleMove(e) {
    if (!enabled || !drawingRef.current) return;
    e.preventDefault();
    const pos = getNormPos(e);
    if (!pos) return;
    const last = lastRef.current;
    if (last) {
      strokeSegment(last, pos);
      onStroke?.({
        type: "move",
        x: pos.x,
        y: pos.y,
        width: 4,
        color: "#1a1a1a",
      });
    }
    lastRef.current = pos;
  }

  function handleEnd(e) {
    if (!enabled) return;
    e.preventDefault();
    if (drawingRef.current) {
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
}
