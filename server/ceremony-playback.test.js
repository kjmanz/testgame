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
  transitionCeremonyPlayback,
} from "../shared/ceremony-playback.js";

test("AI授賞式をopeningから開始する", () => {
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
    phase: "opening",
    index: 0,
    startedAt: 10_800,
    nextAt: 12_600,
  });
  assert.equal(ceremonyPlaybackDuration("ai", 2), 6_200);
  assert.equal(ceremonyPlaybackFinaleAt(playback), 0);
});

test("短い自動演出の後は、ホスト操作まで受賞作で停止する", () => {
  const opening = createCeremonyPlayback({
    kind: "community",
    gameSeq: 1,
    awardCount: 2,
    runId: 1,
    now: 1_000,
    leadMs: 0,
  });

  assert.deepEqual(ceremonyPlaybackPosition(opening, 999).ceremony, null);
  assert.deepEqual(ceremonyPlaybackPosition(opening, 1_850).ceremony, {
    phase: "opening",
    index: 0,
    progress: 0.5,
  });

  const firstDrumroll = transitionCeremonyPlayback(opening, {
    trigger: "timer",
    now: opening.nextAt,
  });
  assert.deepEqual(ceremonyPlaybackPosition(firstDrumroll, 3_750).ceremony, {
    phase: "drumroll",
    index: 0,
    progress: 0.5,
  });
  const firstReveal = transitionCeremonyPlayback(firstDrumroll, {
    trigger: "timer",
    now: firstDrumroll.nextAt,
  });
  assert.equal(firstReveal.phase, "reveal");
  assert.equal(firstReveal.index, 0);
  assert.equal(firstReveal.nextAt, null);

  // 30秒以上たっても自動では次へ進まず、同じ受賞作へ復帰できる。
  assert.deepEqual(ceremonyPlaybackPosition(firstReveal, 100_000).ceremony, {
    phase: "reveal",
    index: 0,
    progress: 1,
  });
  assert.equal(isCeremonyPlaybackInProgress(firstReveal), true);
  assert.equal(isCeremonyPlaybackAvailable(firstReveal), true);

  const secondDrumroll = transitionCeremonyPlayback(firstReveal, {
    trigger: "host",
    now: 100_000,
  });
  assert.equal(secondDrumroll.phase, "drumroll");
  assert.equal(secondDrumroll.index, 1);
  const secondReveal = transitionCeremonyPlayback(secondDrumroll, {
    trigger: "timer",
    now: secondDrumroll.nextAt,
  });
  const finale = transitionCeremonyPlayback(secondReveal, {
    trigger: "host",
    now: 110_000,
  });
  assert.equal(finale.phase, "finale");
  assert.equal(finale.index, 1);
  assert.equal(isCeremonyPlaybackInProgress(finale), false);
  assert.equal(ceremonyPlaybackFinaleAt(finale), 110_000);
});

test("違うphaseの操作と壊れた上映データは拒否する", () => {
  const opening = createCeremonyPlayback({
    kind: "ai",
    gameSeq: 1,
    awardCount: 3,
    runId: 1,
  });
  assert.equal(
    transitionCeremonyPlayback(opening, { trigger: "host" }),
    null,
  );
  assert.equal(normalizeCeremonyPlayback(null), null);
  assert.equal(
    normalizeCeremonyPlayback({
      kind: "other",
      gameSeq: 1,
      awardCount: 3,
      runId: 1,
      phase: "opening",
      index: 0,
      startedAt: 1,
      nextAt: 2,
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
