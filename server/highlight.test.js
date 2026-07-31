import assert from "node:assert/strict";
import test from "node:test";
import {
  createHighlightState,
  HIGHLIGHT_FINAL_HOLD_MS,
  HIGHLIGHT_LEAD_MS,
  highlightMsPerItem,
  isHighlightActive,
} from "./highlight.js";

test("ハイライトは通常2.4秒、枚数が多くても1.8秒未満にならない", () => {
  assert.equal(highlightMsPerItem(12), 2_400);
  assert.equal(highlightMsPerItem(25), 2_400);
  assert.equal(highlightMsPerItem(30), 2_000);
  assert.equal(highlightMsPerItem(60), 1_800);
});

test("ハイライト状態には準備時間と最後の一枚の追加表示時間が入る", () => {
  const now = 10_000;
  const state = createHighlightState(["a", "b", "c"], now);
  assert.equal(state.startedAt, now + HIGHLIGHT_LEAD_MS);
  assert.equal(
    state.endsAt,
    state.startedAt + state.msPerItem * 3 + HIGHLIGHT_FINAL_HOLD_MS,
  );
  assert.equal(isHighlightActive(state, state.endsAt - 1), true);
  assert.equal(isHighlightActive(state, state.endsAt), false);
});

test("空のハイライトは開始しない", () => {
  assert.equal(createHighlightState([], 0), null);
  assert.equal(isHighlightActive(null, 0), false);
});
