import assert from "node:assert/strict";
import test from "node:test";
import {
  canPlayerNextRound,
  canPlayerSeeWord,
  canRevealAnswer,
} from "./round-rules.js";

function peepholeRoom(drawPhase = "drawing") {
  return {
    phase: "playing",
    roundType: "gradual",
    drawPhase,
    drawerId: "drawer",
    drawerIds: ["drawer"],
    hostId: "viewer",
    word: "ねこ",
    seenWordIds: new Set(["drawer"]),
  };
}

function partsRoom(drawPhase = "briefing") {
  return {
    phase: "playing",
    roundType: "parts",
    drawPhase,
    drawerId: "assigned",
    drawerIds: ["assigned"],
    hostId: "host",
    word: "ロボット",
    seenWordIds: new Set(["assigned"]),
  };
}

test("のぞき穴ラウンドは答え発表まで描き手だけがお題を見る", () => {
  const room = peepholeRoom();
  assert.equal(canPlayerSeeWord(room, "drawer"), true);
  assert.equal(canPlayerSeeWord(room, "viewer"), false);

  room.drawPhase = "guessing";
  assert.equal(canPlayerSeeWord(room, "viewer"), false);

  room.drawPhase = "reveal";
  assert.equal(canPlayerSeeWord(room, "viewer"), true);
});

test("のぞき穴ラウンドの描き手は描画中も時間切れ後も正解発表できる", () => {
  const room = peepholeRoom();
  assert.equal(canRevealAnswer(room, "drawer"), true);
  assert.equal(canRevealAnswer(room, "viewer"), false);

  room.drawPhase = "guessing";
  assert.equal(canRevealAnswer(room, "drawer"), true);

  room.drawPhase = "reveal";
  assert.equal(canRevealAnswer(room, "drawer"), false);
});

test("のぞき穴ラウンドは正解発表後だけ描き手が次へ進める", () => {
  const room = peepholeRoom();
  assert.equal(canPlayerNextRound(room, "drawer"), false);

  room.drawPhase = "guessing";
  assert.equal(canPlayerNextRound(room, "drawer"), false);

  room.drawPhase = "reveal";
  assert.equal(canPlayerNextRound(room, "drawer"), true);
  assert.equal(canPlayerNextRound(room, "viewer"), false);
});

test("パーツラウンドは公開前の各フェーズで担当者だけがお題を見る", () => {
  for (const drawPhase of ["briefing", "drawing", "ready", "assembling"]) {
    const room = partsRoom(drawPhase);
    assert.equal(canPlayerSeeWord(room, "assigned"), true, drawPhase);
    assert.equal(canPlayerSeeWord(room, "host"), false, drawPhase);
    assert.equal(canPlayerSeeWord(room, "viewer"), false, drawPhase);
  }
});

test("パーツラウンドは reveal で全員にお題を公開する", () => {
  const room = partsRoom("reveal");
  assert.equal(canPlayerSeeWord(room, "assigned"), true);
  assert.equal(canPlayerSeeWord(room, "host"), true);
  assert.equal(canPlayerSeeWord(room, "viewer"), true);
});

test("パーツラウンドは reveal 後だけホストが次へ進める", () => {
  for (const drawPhase of ["briefing", "drawing", "ready", "assembling"]) {
    const room = partsRoom(drawPhase);
    assert.equal(canPlayerNextRound(room, "host"), false, drawPhase);
    assert.equal(canPlayerNextRound(room, "assigned"), false, drawPhase);
  }

  const room = partsRoom("reveal");
  assert.equal(canPlayerNextRound(room, "host"), true);
  assert.equal(canPlayerNextRound(room, "assigned"), false);
  assert.equal(canPlayerNextRound(room, "viewer"), false);
});

test("パーツラウンドには正解発表操作がない", () => {
  for (const drawPhase of [
    "briefing",
    "drawing",
    "ready",
    "assembling",
    "reveal",
  ]) {
    const room = partsRoom(drawPhase);
    assert.equal(canRevealAnswer(room, "assigned"), false, drawPhase);
    assert.equal(canRevealAnswer(room, "host"), false, drawPhase);
  }
});
