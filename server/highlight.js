export const HIGHLIGHT_LEAD_MS = 1_500;
export const HIGHLIGHT_MS_PER_ITEM = 2_400;
export const HIGHLIGHT_MIN_MS_PER_ITEM = 1_800;
export const HIGHLIGHT_TARGET_TOTAL_MS = 60_000;
export const HIGHLIGHT_FINAL_HOLD_MS = 2_500;

/** 枚数が多くても速くなりすぎない、1枚あたりの表示時間を返す。 */
export function highlightMsPerItem(itemCount) {
  const count = Math.max(1, Number(itemCount) || 1);
  return Math.max(
    HIGHLIGHT_MIN_MS_PER_ITEM,
    Math.min(
      HIGHLIGHT_MS_PER_ITEM,
      Math.round(HIGHLIGHT_TARGET_TOTAL_MS / count),
    ),
  );
}

/** 全端末が同じ位置を再生できる、絶対時刻つきの状態を作る。 */
export function createHighlightState(ids, now = Date.now()) {
  const safeIds = Array.isArray(ids)
    ? ids.filter((id) => typeof id === "string" && id)
    : [];
  if (safeIds.length === 0) return null;

  const msPerItem = highlightMsPerItem(safeIds.length);
  const startedAt = now + HIGHLIGHT_LEAD_MS;
  return {
    ids: safeIds,
    startedAt,
    msPerItem,
    endsAt:
      startedAt + msPerItem * safeIds.length + HIGHLIGHT_FINAL_HOLD_MS,
  };
}

export function isHighlightActive(highlight, now = Date.now()) {
  return Boolean(
    highlight &&
      Array.isArray(highlight.ids) &&
      highlight.ids.length > 0 &&
      Number.isFinite(highlight.startedAt) &&
      Number.isFinite(highlight.msPerItem) &&
      highlight.msPerItem > 0 &&
      Number.isFinite(highlight.endsAt) &&
      now < highlight.endsAt,
  );
}
