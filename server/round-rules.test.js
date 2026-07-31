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
