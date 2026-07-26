import assert from "node:assert/strict";
import test from "node:test";
import { hasVisibleDrawing } from "./drawing.js";

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
