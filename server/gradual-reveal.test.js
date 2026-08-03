import assert from "node:assert/strict";
import test from "node:test";
import {
  createGradualRevealPlan,
  GRADUAL_REVEAL_PATTERNS,
  gradualRevealDuration,
  isGradualRevealComplete,
} from "./gradual-reveal.js";
import { gradualRevealProgress } from "../shared/gradual-reveal-progress.js";

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
    completedAt: null,
  });
  assert.deepEqual(slow, {
    pattern: "line-order",
    stepMs: 2_000,
    steps: 7,
    startedAt: null,
    completedAt: null,
  });
  assert.equal(gradualRevealDuration(fast), 8_000);
  assert.equal(gradualRevealDuration(slow), 14_000);
});

test("描画終了時刻が入るまで公開完了にしない", () => {
  const plan = {
    pattern: "center-out",
    stepMs: 2_000,
    steps: 7,
    startedAt: 10_000,
    completedAt: null,
  };
  assert.equal(isGradualRevealComplete(plan), false);
  plan.completedAt = 12_345;
  assert.equal(isGradualRevealComplete(plan), true);
});

test("だんだん公開率は経過時間に沿って0から1まで連続して進む", () => {
  const plan = {
    pattern: "center-out",
    stepMs: 1_000,
    steps: 8,
    startedAt: 10_000,
    completedAt: null,
  };

  assert.equal(gradualRevealProgress(plan, 9_000), 0);
  assert.equal(gradualRevealProgress(plan, 10_000), 0);
  assert.equal(gradualRevealProgress(plan, 12_000), 0.25);
  assert.equal(gradualRevealProgress(plan, 13_333), 0.416625);
  assert.equal(gradualRevealProgress(plan, 18_000), 1);
  assert.equal(gradualRevealProgress(plan, 99_000), 1);
});

test("壊れた公開計画の進行率は安全に0へ戻す", () => {
  assert.equal(gradualRevealProgress(null, 10_000), 0);
  assert.equal(
    gradualRevealProgress({ startedAt: 10_000, stepMs: 0, steps: 8 }, 11_000),
    0
  );
  assert.equal(
    gradualRevealProgress(
      { startedAt: 10_000, stepMs: 1_000, steps: 8 },
      Number.NaN
    ),
    0
  );
});
