export const GRADUAL_REVEAL_PATTERNS = Object.freeze([
  "line-order",
  "top-down",
  "bottom-up",
  "left-right",
  "right-left",
  "center-out",
  "outside-in",
]);

export const GRADUAL_REVEAL_FAST_MS = 1_000;
export const GRADUAL_REVEAL_SLOW_MS = 2_000;
export const GRADUAL_REVEAL_FAST_STEPS = 8;
export const GRADUAL_REVEAL_SLOW_STEPS = 7;

function normalizedRoll(random) {
  const value = Number(random());
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.999999, value));
}

/** ラウンド中は変わらない、全端末共通の公開方法を決める。 */
export function createGradualRevealPlan({ random = Math.random } = {}) {
  const pattern =
    GRADUAL_REVEAL_PATTERNS[
      Math.floor(normalizedRoll(random) * GRADUAL_REVEAL_PATTERNS.length)
    ];
  const stepMs =
    normalizedRoll(random) < 0.5
      ? GRADUAL_REVEAL_FAST_MS
      : GRADUAL_REVEAL_SLOW_MS;
  return {
    pattern,
    stepMs,
    steps:
      stepMs === GRADUAL_REVEAL_FAST_MS
        ? GRADUAL_REVEAL_FAST_STEPS
        : GRADUAL_REVEAL_SLOW_STEPS,
    startedAt: null,
    completedAt: null,
  };
}

export function gradualRevealDuration(plan) {
  const stepMs = Number(plan?.stepMs);
  const steps = Number(plan?.steps);
  if (!Number.isFinite(stepMs) || !Number.isFinite(steps)) return 0;
  return Math.max(0, stepMs) * Math.max(0, Math.trunc(steps));
}

export function isGradualRevealComplete(plan) {
  const completedAt = Number(plan?.completedAt);
  return Number.isFinite(completedAt) && completedAt > 0;
}
