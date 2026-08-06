import assert from "node:assert/strict";
import test from "node:test";
import {
  PARTS_MAX_PLAYERS,
  PARTS_MIN_PLAYERS,
  PARTS_PROMPTS,
  PARTS_SECRET_INSTRUCTIONS,
  createPartPlan,
  createPartsRound,
  partsDurationSec,
  randomPartsPrompt,
  randomPartsVariant,
} from "./parts.js";

function players(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `参加者${index + 1}`,
  }));
}

function sequenceRng(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("人数に応じた描画時間を返す", () => {
  assert.equal(partsDurationSec(3), 10);
  assert.equal(partsDurationSec(4), 10);
  assert.equal(partsDurationSec(5), 8);
  assert.equal(partsDurationSec(8), 8);
  assert.equal(partsDurationSec(9), 7);
  assert.equal(partsDurationSec(12), 7);
  assert.equal(partsDurationSec(13), 6);
  assert.equal(partsDurationSec(15), 6);
  assert.throws(() => partsDurationSec(2), RangeError);
  assert.throws(() => partsDurationSec(16), RangeError);
});

test("3〜15人の全プランが人数と同数の安全な担当を返す", () => {
  for (
    let count = PARTS_MIN_PLAYERS;
    count <= PARTS_MAX_PLAYERS;
    count += 1
  ) {
    const plan = createPartPlan(count);
    assert.equal(plan.length, count);
    assert.equal(new Set(plan.map((part) => part.id)).size, count);

    for (const part of plan) {
      assert.ok(part.id && part.label && part.hint);
      assert.ok(Number.isInteger(part.stage));
      assert.ok(part.stage >= 0 && part.stage <= 3);
      assert.ok(part.area.x >= 0 && part.area.x <= 1);
      assert.ok(part.area.y >= 0 && part.area.y <= 1);
      assert.ok(part.area.width > 0 && part.area.width <= 1);
      assert.ok(part.area.height > 0 && part.area.height <= 1);
      assert.ok(part.area.x + part.area.width <= 1);
      assert.ok(part.area.y + part.area.height <= 1);
      assert.ok(part.anchors.length > 0);
      for (const anchor of part.anchors) {
        assert.ok(anchor.x >= 0 && anchor.x <= 1);
        assert.ok(anchor.y >= 0 && anchor.y <= 1);
      }
    }
  }
});

test("15人では4段階すべてを使い、体の15部位が重複しない", () => {
  const plan = createPartPlan(15);
  assert.deepEqual(
    [...new Set(plan.map((part) => part.stage))].sort(),
    [0, 1, 2, 3],
  );
  assert.equal(new Set(plan.map((part) => part.id)).size, 15);
});

test("お題は既存作品に依存せず、共通キャラクタープランを使う", () => {
  assert.ok(PARTS_PROMPTS.length >= 5);
  assert.equal(new Set(PARTS_PROMPTS.map((prompt) => prompt.id)).size, PARTS_PROMPTS.length);
  assert.ok(PARTS_PROMPTS.every((prompt) => prompt.planId === "common-character-v1"));
  assert.ok(
    PARTS_PROMPTS.every(
      (prompt) => prompt.word && prompt.description && prompt.emoji,
    ),
  );
});

test("直近のお題を避け、候補が尽きたら全件へ戻る", () => {
  const allowed = PARTS_PROMPTS.at(-1);
  const excluded = new Set(PARTS_PROMPTS.slice(0, -1).map((prompt) => prompt.id));
  assert.equal(randomPartsPrompt({ excludeIds: excluded, rng: () => 0 }).id, allowed.id);

  const allExcluded = new Set(PARTS_PROMPTS.map((prompt) => prompt.id));
  assert.equal(
    randomPartsPrompt({ excludeIds: allExcluded, rng: () => 0 }).id,
    PARTS_PROMPTS[0].id,
  );
});

test("乱数注入でバリエーションとラウンド全体を再現できる", () => {
  assert.equal(randomPartsVariant(() => 0), "normal");
  assert.equal(randomPartsVariant(() => 0.4), "secret");
  assert.equal(randomPartsVariant(() => 0.99), "mystery");

  const first = createPartsRound(players(10), { rng: seededRng(12345) });
  const second = createPartsRound(players(10), { rng: seededRng(12345) });
  assert.deepEqual(first, second);
});

test("normal は全員に固有パーツを配り、追加指令や非公開役を作らない", () => {
  const input = players(8);
  const round = createPartsRound(input, {
    variant: "normal",
    rng: seededRng(1),
  });

  assert.equal(round.assignments.length, input.length);
  assert.deepEqual(
    round.assignments.map((assignment) => assignment.playerId),
    input.map((player) => player.id),
  );
  assert.equal(new Set(round.assignments.map((assignment) => assignment.id)).size, input.length);
  assert.equal(round.hiddenWordPlayerId, null);
  assert.ok(round.assignments.every((assignment) => assignment.secretInstruction === null));
  assert.ok(round.assignments.every((assignment) => assignment.isWordHidden === false));
});

test("secret は約25%の参加者だけに秘密指令を配る", () => {
  for (const count of [3, 4, 5, 8, 12, 15]) {
    const round = createPartsRound(players(count), {
      variant: "secret",
      rng: seededRng(count),
    });
    const secretAssignments = round.assignments.filter(
      (assignment) => assignment.secretInstruction,
    );
    assert.equal(secretAssignments.length, Math.max(1, Math.round(count * 0.25)));
    assert.ok(
      secretAssignments.every((assignment) =>
        PARTS_SECRET_INSTRUCTIONS.includes(assignment.secretInstruction),
      ),
    );
    assert.equal(round.hiddenWordPlayerId, null);
  }
});

test("mystery はちょうど1人だけお題を非公開にする", () => {
  const round = createPartsRound(players(15), {
    variant: "mystery",
    rng: sequenceRng([0.2, 0.8, 0.4, 0.6]),
  });
  const hidden = round.assignments.filter((assignment) => assignment.isWordHidden);
  assert.equal(hidden.length, 1);
  assert.equal(round.hiddenWordPlayerId, hidden[0].playerId);
  assert.ok(round.assignments.every((assignment) => assignment.secretInstruction === null));
});

test("入力・定義を変更せず、返却データも次回へ共有しない", () => {
  const input = players(6).map(Object.freeze);
  Object.freeze(input);
  const inputBefore = JSON.stringify(input);
  const promptsBefore = JSON.stringify(PARTS_PROMPTS);

  const first = createPartsRound(input, {
    variant: "secret",
    rng: seededRng(99),
  });
  assert.equal(JSON.stringify(input), inputBefore);
  assert.equal(JSON.stringify(PARTS_PROMPTS), promptsBefore);

  first.prompt.word = "書きかえ";
  first.assignments[0].area.x = 999;
  first.assignments[0].anchors[0].x = 999;
  const second = createPartsRound(input, {
    variant: "secret",
    rng: seededRng(99),
  });
  assert.notEqual(second.prompt.word, "書きかえ");
  assert.notEqual(second.assignments[0].area.x, 999);
  assert.notEqual(second.assignments[0].anchors[0].x, 999);
  assert.equal(JSON.stringify(PARTS_PROMPTS), promptsBefore);
});

test("人数・参加者ID・variant・rngの不正値を拒否する", () => {
  assert.throws(() => createPartsRound(players(2)), RangeError);
  assert.throws(() => createPartsRound(players(15).concat({ id: "p16" })), RangeError);
  assert.throws(
    () => createPartsRound([{ id: "same" }, { id: "same" }, { id: "third" }]),
    RangeError,
  );
  assert.throws(
    () => createPartsRound(players(3), { variant: "unknown" }),
    RangeError,
  );
  assert.throws(() => randomPartsVariant(() => 1), RangeError);
});
