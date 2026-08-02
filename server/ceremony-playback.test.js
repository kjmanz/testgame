import assert from "node:assert/strict";
import test from "node:test";
import {
  ceremonyPlaybackDuration,
  ceremonyPlaybackFinaleAt,
  ceremonyPlaybackPosition,
  createCeremonyPlayback,
  isCeremonyPlaybackAvailable,
  isCeremonyPlaybackInProgress,
  normalizeCeremonyPlayback,
} from "../shared/ceremony-playback.js";

test("AI授賞式の共通開始時刻と総時間を作る", () => {
  const playback = createCeremonyPlayback({
    kind: "ai",
    gameSeq: 3,
    awardCount: 2,
    runId: 7,
    now: 10_000,
    leadMs: 800,
  });
  assert.deepEqual(playback, {
    kind: "ai",
    gameSeq: 3,
    awardCount: 2,
    runId: 7,
    startedAt: 10_800,
    expiresAt: 57_000,
  });
  assert.equal(ceremonyPlaybackDuration("ai", 2), 16_200);
  assert.equal(ceremonyPlaybackFinaleAt(playback), 27_000);
});

test("絶対時刻から全端末共通の発表位置を復元する", () => {
  const playback = {
    kind: "community",
    gameSeq: 1,
    awardCount: 2,
    runId: 1,
    startedAt: 1_000,
    expiresAt: 48_100,
  };

  assert.deepEqual(ceremonyPlaybackPosition(playback, 999).ceremony, null);
  assert.deepEqual(ceremonyPlaybackPosition(playback, 1_000).ceremony, {
    phase: "opening",
    index: 0,
    progress: 0,
  });
  assert.deepEqual(ceremonyPlaybackPosition(playback, 2_700).ceremony, {
    phase: "drumroll",
    index: 0,
    progress: 0,
  });
  assert.deepEqual(ceremonyPlaybackPosition(playback, 4_800).ceremony, {
    phase: "reveal",
    index: 0,
    progress: 0,
  });
  assert.deepEqual(ceremonyPlaybackPosition(playback, 10_400).ceremony, {
    phase: "drumroll",
    index: 1,
    progress: 0,
  });
  assert.deepEqual(ceremonyPlaybackPosition(playback, 18_100).ceremony, {
    phase: "finale",
    index: 1,
    progress: 1,
  });
  assert.equal(isCeremonyPlaybackInProgress(playback, 18_099), true);
  assert.equal(isCeremonyPlaybackInProgress(playback, 18_100), false);
  assert.equal(isCeremonyPlaybackAvailable(playback, 48_099), true);
  assert.equal(isCeremonyPlaybackAvailable(playback, 48_100), false);
});

test("壊れた上映データは拒否する", () => {
  assert.equal(normalizeCeremonyPlayback(null), null);
  assert.equal(
    normalizeCeremonyPlayback({
      kind: "other",
      gameSeq: 1,
      awardCount: 3,
      runId: 1,
      startedAt: 1,
      expiresAt: 100_000,
    }),
    null,
  );
  assert.equal(
    createCeremonyPlayback({
      kind: "ai",
      gameSeq: 0,
      awardCount: 3,
      runId: 1,
    }),
    null,
  );
});
