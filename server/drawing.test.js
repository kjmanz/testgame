import assert from "node:assert/strict";
import test from "node:test";
import {
  hasVisibleDrawing,
  visibleStrokesForPlayer,
} from "./drawing.js";

test("hasVisibleDrawing ignores an untouched canvas and taps", () => {
  assert.equal(hasVisibleDrawing([]), false);
  assert.equal(
    hasVisibleDrawing([
      { type: "start", playerId: "a", x: 0.2, y: 0.3 },
      { type: "end", playerId: "a" },
    ]),
    false,
  );
  assert.equal(
    hasVisibleDrawing([
      { type: "start", playerId: "a", x: 0.2, y: 0.3 },
      { type: "move", playerId: "a", x: 0.2, y: 0.3 },
      { type: "end", playerId: "a" },
    ]),
    false,
  );
});

test("hasVisibleDrawing detects a rendered line for any player", () => {
  assert.equal(
    hasVisibleDrawing([
      { type: "start", playerId: "a", x: 0.2, y: 0.3 },
      { type: "move", playerId: "a", x: 0.25, y: 0.35 },
    ]),
    true,
  );
  assert.equal(
    hasVisibleDrawing([
      { type: "move", playerId: "b", x: 0.1, y: 0.1 },
      { type: "move", playerId: "b", x: 0.15, y: 0.1 },
    ]),
    true,
  );
});

test("parts drawing history stays private until assembly", () => {
  const strokes = [
    { type: "start", playerId: "a", x: 0.1, y: 0.1 },
    { type: "move", playerId: "a", x: 0.2, y: 0.2 },
    { type: "start", playerId: "b", x: 0.7, y: 0.7 },
    { type: "move", playerId: "b", x: 0.8, y: 0.8 },
  ];

  const visible = visibleStrokesForPlayer(strokes, {
    roundType: "parts",
    drawPhase: "drawing",
    playerId: "a",
  });
  assert.deepEqual(
    new Set(visible.map((stroke) => stroke.playerId)),
    new Set(["a"]),
  );
});

test("parts assembly exposes only released layers, then the full drawing", () => {
  const strokes = [
    { type: "move", playerId: "a" },
    { type: "move", playerId: "b" },
    { type: "move", playerId: "c" },
  ];
  const assembling = visibleStrokesForPlayer(strokes, {
    roundType: "parts",
    drawPhase: "assembling",
    playerId: "c",
    visiblePlayerIds: new Set(["a", "b"]),
  });
  assert.deepEqual(
    assembling.map((stroke) => stroke.playerId),
    ["a", "b"],
  );

  const revealed = visibleStrokesForPlayer(strokes, {
    roundType: "parts",
    drawPhase: "reveal",
    playerId: "c",
  });
  assert.equal(revealed, strokes);
});
