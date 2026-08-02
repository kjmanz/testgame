export const CEREMONY_START_LEAD_MS = 800;

export const CEREMONY_TIMINGS = Object.freeze({
  ai: Object.freeze({ openingMs: 1_800, drumrollMs: 2_200 }),
  community: Object.freeze({ openingMs: 1_700, drumrollMs: 2_100 }),
});

const CEREMONY_PHASES = new Set([
  "opening",
  "drumroll",
  "reveal",
  "finale",
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** ホストが即時進行した場合に必要な、自動演出部分の最短時間。 */
export function ceremonyPlaybackDuration(kind, awardCount) {
  const timing = CEREMONY_TIMINGS[kind];
  const count = positiveInteger(awardCount);
  if (!timing || !count) return 0;
  return timing.openingMs + count * timing.drumrollMs;
}

export function createCeremonyPlayback({
  kind,
  gameSeq,
  awardCount,
  runId,
  now = Date.now(),
  leadMs = CEREMONY_START_LEAD_MS,
}) {
  const count = positiveInteger(awardCount);
  const sequence = positiveInteger(gameSeq);
  const run = positiveInteger(runId);
  const timing = CEREMONY_TIMINGS[kind];
  if (!count || !sequence || !run || !timing) return null;

  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const safeLead = Math.max(0, Number(leadMs) || 0);
  const startedAt = safeNow + safeLead;
  return {
    kind,
    gameSeq: sequence,
    awardCount: count,
    runId: run,
    phase: "opening",
    index: 0,
    startedAt,
    nextAt: startedAt + timing.openingMs,
  };
}

export function normalizeCeremonyPlayback(value) {
  if (!value || typeof value !== "object") return null;
  const kind = value.kind === "ai" || value.kind === "community"
    ? value.kind
    : null;
  const gameSeq = positiveInteger(value.gameSeq);
  const awardCount = positiveInteger(value.awardCount);
  const runId = positiveInteger(value.runId);
  const phase = CEREMONY_PHASES.has(value.phase) ? value.phase : null;
  const index = Number(value.index);
  const startedAt = Number(value.startedAt);
  const nextAt = value.nextAt == null ? null : Number(value.nextAt);
  const timedPhase = phase === "opening" || phase === "drumroll";
  if (
    !kind ||
    !gameSeq ||
    !awardCount ||
    !runId ||
    !phase ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= awardCount ||
    (phase === "opening" && index !== 0) ||
    (phase === "finale" && index !== awardCount - 1) ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    (timedPhase &&
      (!Number.isFinite(nextAt) || nextAt <= startedAt)) ||
    (!timedPhase && nextAt !== null)
  ) {
    return null;
  }
  return {
    kind,
    gameSeq,
    awardCount,
    runId,
    phase,
    index,
    startedAt,
    nextAt,
  };
}

/** フィナーレへ到達済みなら、その到達時刻を返す。 */
export function ceremonyPlaybackFinaleAt(value) {
  const playback = normalizeCeremonyPlayback(value);
  return playback?.phase === "finale" ? playback.startedAt : 0;
}

/** 受賞作で停止中の時間も含め、まだホスト進行が必要ならtrue。 */
export function isCeremonyPlaybackInProgress(value) {
  const playback = normalizeCeremonyPlayback(value);
  return Boolean(playback && playback.phase !== "finale");
}

/** 終了画面にいる間は、再接続で現在位置へいつでも復帰できる。 */
export function isCeremonyPlaybackAvailable(value) {
  return Boolean(normalizeCeremonyPlayback(value));
}

/**
 * サーバーが保持するphase/indexを表示用に変換する。
 * opening/drumrollだけ進捗を時刻で描き、revealは時間無制限で停止する。
 */
export function ceremonyPlaybackPosition(value, now = Date.now()) {
  const playback = normalizeCeremonyPlayback(value);
  if (!playback) return { ceremony: null, nextAt: null };

  const serverNow = Number(now);
  if (!Number.isFinite(serverNow) || serverNow < playback.startedAt) {
    return { ceremony: null, nextAt: playback.startedAt };
  }

  let progress = 1;
  if (playback.nextAt != null) {
    const duration = playback.nextAt - playback.startedAt;
    progress = Math.max(
      0,
      Math.min(1, (serverNow - playback.startedAt) / duration),
    );
  }
  return {
    ceremony: {
      phase: playback.phase,
      index: playback.index,
      progress,
    },
    nextAt: playback.nextAt,
  };
}

/**
 * trigger=timer は opening→drumroll→reveal、trigger=host は
 * reveal→次のdrumroll（最後だけfinale）に限って進める。
 */
export function transitionCeremonyPlayback(
  value,
  { trigger, now = Date.now() } = {},
) {
  const playback = normalizeCeremonyPlayback(value);
  if (!playback) return null;
  const timing = CEREMONY_TIMINGS[playback.kind];
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  if (trigger === "timer" && playback.phase === "opening") {
    return {
      ...playback,
      phase: "drumroll",
      startedAt: safeNow,
      nextAt: safeNow + timing.drumrollMs,
    };
  }
  if (trigger === "timer" && playback.phase === "drumroll") {
    return {
      ...playback,
      phase: "reveal",
      startedAt: safeNow,
      nextAt: null,
    };
  }
  if (trigger === "host" && playback.phase === "reveal") {
    if (playback.index + 1 >= playback.awardCount) {
      return {
        ...playback,
        phase: "finale",
        index: playback.awardCount - 1,
        startedAt: safeNow,
        nextAt: null,
      };
    }
    return {
      ...playback,
      phase: "drumroll",
      index: playback.index + 1,
      startedAt: safeNow,
      nextAt: safeNow + timing.drumrollMs,
    };
  }
  return null;
}
