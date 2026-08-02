import assert from "node:assert/strict";
import test from "node:test";
import {
  selectCrazyPromptMainAnswers,
  shouldEnableAiCrazyPrompt,
  takeNextCrazyPrompt,
} from "./ai-crazy-prompt.js";

const WORDS = [
  "ペンギン",
  "冷蔵庫",
  "忍者",
  "ロボット",
  "ゴリラ",
  "宇宙人",
  "おばけ",
  "消防車",
  "ねこ",
  "いぬ",
];

function eligibleRound(overrides = {}) {
  return {
    enabled: true,
    configured: true,
    packStatus: "ready",
    roundType: "normal",
    constraint: null,
    completedRounds: 8,
    roundsSinceAiCrazyPrompt: 4,
    hasPreviousPrompt: true,
    usedCount: 0,
    random: () => 0,
    ...overrides,
  };
}

test("selectCrazyPromptMainAnswers returns the requested number of answers", () => {
  const selected = selectCrazyPromptMainAnswers(WORDS, 8, {
    random: () => 0.5,
  });
  assert.equal(selected.length, 8);
  assert.equal(selected.every((word) => WORDS.includes(word)), true);
});

test("selectCrazyPromptMainAnswers removes duplicates", () => {
  const selected = selectCrazyPromptMainAnswers(
    ["ねこ", "ねこ", " いぬ ", "いぬ", "うさぎ"],
    8,
    { random: () => 0 },
  );
  assert.deepEqual(new Set(selected).size, selected.length);
  assert.deepEqual(new Set(selected), new Set(["ねこ", "いぬ", "うさぎ"]));
});

test("selectCrazyPromptMainAnswers is deterministic with injected randomness", () => {
  const first = selectCrazyPromptMainAnswers(WORDS, 5, { random: () => 0 });
  const second = selectCrazyPromptMainAnswers(WORDS, 5, { random: () => 0 });
  assert.deepEqual(first, second);
  assert.equal(first.length, 5);
});

test("selectCrazyPromptMainAnswers safely returns all usable words when there are too few", () => {
  const selected = selectCrazyPromptMainAnswers(
    ["ねこ", "", null, "いぬ"],
    8,
    {
      random: () => 0.999,
    },
  );
  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected), new Set(["ねこ", "いぬ"]));
  assert.deepEqual(selectCrazyPromptMainAnswers(null, 8), []);
});

test("shouldEnableAiCrazyPrompt is false during the first three rounds", () => {
  for (const completedRounds of [0, 1, 2]) {
    assert.equal(
      shouldEnableAiCrazyPrompt(
        eligibleRound({
          completedRounds,
          roundsSinceAiCrazyPrompt: completedRounds,
          hasPreviousPrompt: false,
        }),
      ),
      false,
    );
  }
});

test("shouldEnableAiCrazyPrompt uses probability after a four-round gap", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({ roundsSinceAiCrazyPrompt: 4, random: () => 0.249 }),
    ),
    true,
  );
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({ roundsSinceAiCrazyPrompt: 4, random: () => 0.25 }),
    ),
    false,
  );
});

test("shouldEnableAiCrazyPrompt is forced after an eight-round gap", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({ roundsSinceAiCrazyPrompt: 8, random: () => 0.999 }),
    ),
    true,
  );
});

test("shouldEnableAiCrazyPrompt is false after two uses", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({ usedCount: 2, roundsSinceAiCrazyPrompt: 8 }),
    ),
    false,
  );
});

test("shouldEnableAiCrazyPrompt rejects every special round type", () => {
  for (const roundType of ["relay", "coop", "liar", "gradual"]) {
    assert.equal(
      shouldEnableAiCrazyPrompt(eligibleRound({ roundType })),
      false,
      roundType,
    );
  }
});

test("shouldEnableAiCrazyPrompt rejects constrained normal rounds", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({ constraint: { id: "non-dominant-hand" } }),
    ),
    false,
  );
});

test("shouldEnableAiCrazyPrompt rejects rooms without AI configuration", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(eligibleRound({ configured: false })),
    false,
  );
  assert.equal(
    shouldEnableAiCrazyPrompt(eligibleRound({ enabled: false })),
    false,
  );
});

test("shouldEnableAiCrazyPrompt requires a ready pack", () => {
  for (const packStatus of ["idle", "generating", "failed"]) {
    assert.equal(
      shouldEnableAiCrazyPrompt(eligibleRound({ packStatus })),
      false,
      packStatus,
    );
  }
});

test("force mode enables every eligible normal round and ignores gaps and limits", () => {
  assert.equal(
    shouldEnableAiCrazyPrompt(
      eligibleRound({
        force: true,
        completedRounds: 0,
        roundsSinceAiCrazyPrompt: 0,
        hasPreviousPrompt: false,
        usedCount: 99,
        random: () => 0.999,
      }),
    ),
    true,
  );
});

test("takeNextCrazyPrompt returns one unused prompt and marks it used", () => {
  const room = {
    aiCrazyPromptPack: [
      {
        id: "crazy-1",
        mainAnswer: "ペンギン",
        fullPrompt: "ラーメンを作るペンギン",
        used: false,
      },
      {
        id: "crazy-2",
        mainAnswer: "冷蔵庫",
        fullPrompt: "かくれんぼ中の冷蔵庫",
        used: false,
      },
    ],
  };

  assert.deepEqual(takeNextCrazyPrompt(room), {
    id: "crazy-1",
    mainAnswer: "ペンギン",
    fullPrompt: "ラーメンを作るペンギン",
  });
  assert.equal(room.aiCrazyPromptPack[0].used, true);
  assert.equal(room.aiCrazyPromptPack[1].used, false);
});

test("takeNextCrazyPrompt returns null when the pack is exhausted", () => {
  assert.equal(
    takeNextCrazyPrompt({
      aiCrazyPromptPack: [
        {
          id: "crazy-1",
          mainAnswer: "ペンギン",
          fullPrompt: "ラーメンを作るペンギン",
          used: true,
        },
      ],
    }),
    null,
  );
  assert.equal(takeNextCrazyPrompt({ aiCrazyPromptPack: [] }), null);
});
