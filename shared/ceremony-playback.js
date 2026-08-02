export const CEREMONY_START_LEAD_MS = 800;
/** 発表終了直後に再接続しても、フィナーレへ戻れる猶予。 */
export const CEREMONY_FINALE_RESUME_MS = 30_000;

export const CEREMONY_TIMINGS = Object.freeze({
  ai: Object.freeze({ openingMs: 1_800, drumrollMs: 2_200, revealMs: 5_000 }),
  community: Object.freeze({
    openingMs: 1_700,
    drumrollMs: 2_100,
    revealMs: 5_600,
  }),
});

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function ceremonyPlaybackDuration(kind, awardCount) {
  const timing = CEREMONY_TIMINGS[kind];
  const count = positiveInteger(awardCount);
  if (!timing || !count) return 0;
  return timing.openingMs + count * (timing.drumrollMs + timing.revealMs);
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
  const duration = ceremonyPlaybackDuration(kind, count);
  if (!count || !sequence || !run || duration <= 0) return null;

  const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const safeLead = Math.max(0, Number(leadMs) || 0);
  return {
    kind,
    gameSeq: sequence,
    awardCount: count,
    runId: run,
    startedAt: safeNow + safeLead,
    expiresAt:
      safeNow + safeLead + duration + CEREMONY_FINALE_RESUME_MS,
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
  const startedAt = Number(value.startedAt);
  const expiresAt = Number(value.expiresAt);
  const duration = ceremonyPlaybackDuration(kind, awardCount);
  if (
    !kind ||
    !gameSeq ||
    !awardCount ||
    !runId ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    !Number.isFinite(expiresAt) ||
    expiresAt < startedAt + duration
  ) {
    return null;
  }
  return { kind, gameSeq, awardCount, runId, startedAt, expiresAt };
}

export function ceremonyPlaybackFinaleAt(value) {
  const playback = normalizeCeremonyPlayback(value);
  if (!playback) return 0;
  return (
    playback.startedAt +
    ceremonyPlaybackDuration(playback.kind, playback.awardCount)
  );
}

/** 開幕前を含め、まだ発表シーケンスの途中ならtrue。 */
export function isCeremonyPlaybackInProgress(value, now = Date.now()) {
  const finaleAt = ceremonyPlaybackFinaleAt(value);
  return finaleAt > 0 && Number(now) < finaleAt;
}

/** 再接続で上映またはフィナーレへ復帰できる期間。 */
export function isCeremonyPlaybackAvailable(value, now = Date.now()) {
  const playback = normalizeCeremonyPlayback(value);
  return Boolean(playback && Number(now) < playback.expiresAt);
}

/**
 * サーバー絶対時刻から、全端末で同じphase/indexを復元する。
 * 開始前はceremony=null、全賞の発表後はfinaleを返す。
 */
export function ceremonyPlaybackPosition(value, now = Date.now()) {
  const playback = normalizeCeremonyPlayback(value);
  if (!playback) return { ceremony: null, nextAt: null };

  const serverNow = Number(now);
  if (!Number.isFinite(serverNow) || serverNow < playback.startedAt) {
    return { ceremony: null, nextAt: playback.startedAt };
  }

  const timing = CEREMONY_TIMINGS[playback.kind];
  let boundary = playback.startedAt + timing.openingMs;
  if (serverNow < boundary) {
    return {
      ceremony: {
        phase: "opening",
        index: 0,
        progress: Math.max(
          0,
          Math.min(1, (serverNow - playback.startedAt) / timing.openingMs),
        ),
      },
      nextAt: boundary,
    };
  }

  for (let index = 0; index < playback.awardCount; index += 1) {
    const drumrollStartedAt = boundary;
    boundary += timing.drumrollMs;
    if (serverNow < boundary) {
      return {
        ceremony: {
          phase: "drumroll",
          index,
          progress: Math.max(
            0,
            Math.min(
              1,
              (serverNow - drumrollStartedAt) / timing.drumrollMs,
            ),
          ),
        },
        nextAt: boundary,
      };
    }
    const revealStartedAt = boundary;
    boundary += timing.revealMs;
    if (serverNow < boundary) {
      return {
        ceremony: {
          phase: "reveal",
          index,
          progress: Math.max(
            0,
            Math.min(1, (serverNow - revealStartedAt) / timing.revealMs),
          ),
        },
        nextAt: boundary,
      };
    }
  }

  return {
    ceremony: {
      phase: "finale",
      index: playback.awardCount - 1,
      progress: 1,
    },
    nextAt: null,
  };
}
