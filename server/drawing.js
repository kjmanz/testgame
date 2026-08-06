export function hasVisibleDrawing(strokes) {
  if (!Array.isArray(strokes)) return false;

  const lastPoints = new Map();
  for (const stroke of strokes) {
    const playerId =
      typeof stroke?.playerId === "string" && stroke.playerId
        ? stroke.playerId
        : "unknown";

    if (stroke?.type === "end") {
      lastPoints.delete(playerId);
      continue;
    }

    if (stroke?.type !== "start" && stroke?.type !== "move") continue;
    const x = Number(stroke.x);
    const y = Number(stroke.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const previous = lastPoints.get(playerId);
    if (
      stroke.type === "move" &&
      previous &&
      (previous.x !== x || previous.y !== y)
    ) {
      return true;
    }
    lastPoints.set(playerId, { x, y });
  }

  return false;
}

/**
 * パーツ合体ラウンドで、各端末へ返してよい線だけを選ぶ。
 * 描画・待機中は本人分だけ、合体中は公開済み、完成後は全部を返す。
 */
export function visibleStrokesForPlayer(
  strokes,
  { roundType, drawPhase, playerId, visiblePlayerIds = new Set() } = {},
) {
  if (!Array.isArray(strokes)) return [];
  if (roundType !== "parts" || drawPhase === "reveal") return strokes;

  if (drawPhase === "assembling") {
    const visible =
      visiblePlayerIds instanceof Set
        ? visiblePlayerIds
        : new Set(visiblePlayerIds || []);
    return strokes.filter((stroke) => visible.has(stroke?.playerId));
  }

  return strokes.filter((stroke) => stroke?.playerId === playerId);
}
