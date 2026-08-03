/**
 * サーバー時刻を基準に、だんだん公開の連続した進行率を返す。
 * 再接続した端末も startedAt から同じ位置を復元できるよう、端末内の
 * フレーム数や前回値には依存させない。
 */
export function gradualRevealProgress(plan, serverNow) {
  const startedAt = Number(plan?.startedAt);
  const stepMs = Number(plan?.stepMs);
  const steps = Number(plan?.steps);
  const now = Number(serverNow);

  if (
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    !Number.isFinite(stepMs) ||
    stepMs <= 0 ||
    !Number.isFinite(steps) ||
    steps <= 0 ||
    !Number.isFinite(now)
  ) {
    return 0;
  }

  const totalMs = stepMs * steps;
  return Math.max(0, Math.min(1, (now - startedAt) / totalMs));
}
