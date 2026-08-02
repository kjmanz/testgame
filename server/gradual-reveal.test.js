import assert from "node:assert/strict";
import test from "node:test";
import {
  createGradualRevealPlan,
  GRADUAL_REVEAL_PATTERNS,
  gradualRevealDuration,
  isGradualRevealComplete,
} from "./gradual-reveal.js";

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("だんだん公開は7種類すべてから決まる", () => {
  for (let index = 0; index < GRADUAL_REVEAL_PATTERNS.length; index += 1) {
    const plan = createGradualRevealPlan({
      random: sequenceRandom([
        (index + 0.1) / GRADUAL_REVEAL_PATTERNS.length,
        0,
      ]),
    });
    assert.equal(plan.pattern, GRADUAL_REVEAL_PATTERNS[index]);
  }
});

test("1秒公開は8段階、2秒公開は7段階になる", () => {
  const fast = createGradualRevealPlan({
    random: sequenceRandom([0, 0.49]),
  });
  const slow = createGradualRevealPlan({
    random: sequenceRandom([0, 0.5]),
  });

  assert.deepEqual(fast, {
    pattern: "line-order",
    stepMs: 1_000,
    steps: 8,
    startedAt: null,
  });
  assert.deepEqual(slow, {
    pattern: "line-order",
    stepMs: 2_000,
    steps: 7,
    startedAt: null,
  });
  assert.equal(gradualRevealDuration(fast), 8_000);
  assert.equal(gradualRevealDuration(slow), 14_000);
});

test("公開完了はサーバー開始時刻から判定する", () => {
  const plan = {
    pattern: "center-out",
    stepMs: 2_000,
    steps: 7,
    startedAt: 10_000,
  };
  assert.equal(isGradualRevealComplete(plan, 23_999), false);
  assert.equal(isGradualRevealComplete(plan, 24_000), true);
});
