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
