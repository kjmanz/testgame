import assert from "node:assert/strict";
import test from "node:test";
import { CONSTRAINTS, findConstraint, randomConstraint } from "./constraints.js";

test("すべてのしばりが必要な項目をもっている", () => {
  const ids = new Set();
  for (const item of CONSTRAINTS) {
    assert.ok(item.id, "id が必要");
    assert.equal(ids.has(item.id), false, `id が重複: ${item.id}`);
    ids.add(item.id);
    assert.ok(
      ["strokes", "time", "pen", "blind", "honor"].includes(item.kind),
      `kind が不明: ${item.kind}`,
    );
    assert.ok(item.emoji && item.label && item.rule && item.hint);
    assert.equal(typeof item.value, "number");
    // 強制するタイプは数値が要る
    if (item.kind === "strokes" || item.kind === "time" || item.kind === "pen") {
      assert.ok(item.value > 0, `${item.id} には value が必要`);
    }
  }
});

test("ペンの太さはサーバーの上限(40)におさまる", () => {
  for (const item of CONSTRAINTS.filter((c) => c.kind === "pen")) {
    assert.ok(item.value >= 1 && item.value <= 40);
  }
});

test("findConstraint は id で引ける", () => {
  assert.equal(findConstraint("blind")?.kind, "blind");
  assert.equal(findConstraint("なにこれ"), null);
  assert.equal(findConstraint(""), null);
});

test("randomConstraint は直近のしばりを避ける", () => {
  const exclude = new Set(CONSTRAINTS.slice(0, -1).map((item) => item.id));
  const last = CONSTRAINTS[CONSTRAINTS.length - 1];
  for (let i = 0; i < 20; i++) {
    assert.equal(randomConstraint(exclude).id, last.id);
  }
});

test("randomConstraint は候補が尽きたら全部から選び直す", () => {
  const all = new Set(CONSTRAINTS.map((item) => item.id));
  const picked = randomConstraint(all);
  assert.ok(all.has(picked.id));
});
