import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSecretGuessCandidates,
  buildSecretGuessReveal,
  isSecretGuessCorrect,
  normalizeSecretGuessWord,
  secretGuessFallbackKind,
} from "./secret-guess.js";

const sampleWords = Array.from({ length: 30 }, (_, index) => `ことば${index + 1}`);

test("buildSecretGuessCandidates creates 18 shuffled unique words with one answer", () => {
  const candidates = buildSecretGuessCandidates("ほんとう", {
    words: [...sampleWords, "ほんとう", "ほんとう"],
    random: () => 0.37,
  });

  assert.equal(candidates.length, 18);
  assert.equal(candidates.filter((word) => word === "ほんとう").length, 1);
  assert.equal(new Set(candidates).size, candidates.length);
});

test("candidate generation is deterministic with injected randomness and does not fix answer position", () => {
  function seededRandom(seed) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  const first = buildSecretGuessCandidates("ほんとう", {
    words: sampleWords,
    random: seededRandom(7),
  });
  const repeated = buildSecretGuessCandidates("ほんとう", {
    words: sampleWords,
    random: seededRandom(7),
  });
  const other = buildSecretGuessCandidates("ほんとう", {
    words: sampleWords,
    random: seededRandom(99),
  });

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, other);
  assert.notEqual(first.indexOf("ほんとう"), other.indexOf("ほんとう"));
});

test("candidate generation stays safe when too few unique words exist", () => {
  assert.deepEqual(
    buildSecretGuessCandidates("ねこ", {
      words: ["いぬ", "いぬ", "ねこ", "  うさぎ  "],
      random: () => 0.999,
    }),
    ["いぬ", "うさぎ", "ねこ"],
  );
  assert.deepEqual(buildSecretGuessCandidates("", { words: sampleWords }), []);
});

test("secret guess comparison applies NFKC, trimming, and ASCII case folding", () => {
  assert.equal(normalizeSecretGuessWord("  ＡＢＣ\u0000  "), "abc");
  assert.equal(
    isSecretGuessCorrect(
      {
        bestGuess: "いぬ",
        secondGuess: " ＡＢＣ ",
        wildGuess: "ロボット",
      },
      "abc",
    ),
    true,
  );
  assert.equal(
    isSecretGuessCorrect(
      { bestGuess: "いぬ", secondGuess: "ねこ", wildGuess: "ロボット" },
      "abc",
    ),
    false,
  );
});

test("fallback distinguishes an early answer from a failed capture", () => {
  assert.equal(secretGuessFallbackKind("armed"), "too_fast");
  assert.equal(secretGuessFallbackKind("countdown"), "too_fast");
  assert.equal(secretGuessFallbackKind("requested"), "unavailable");
  assert.equal(secretGuessFallbackKind("error"), "unavailable");
});

test("buildSecretGuessReveal exposes only the public result", () => {
  const reveal = buildSecretGuessReveal({
    roundId: 12,
    correctWord: "ＡＢＣ",
    result: {
      bestGuess: "いぬ",
      secondGuess: "abc",
      wildGuess: "宇宙船",
      comment: "丸い線が元気に飛び出しています！",
      token: "never-expose-token",
      candidateWords: ["いぬ", "abc"],
      status: "ready",
    },
    token: "also-private",
  });

  assert.deepEqual(reveal, {
    roundId: 12,
    kind: "result",
    correctWord: "ABC",
    bestGuess: "いぬ",
    secondGuess: "abc",
    wildGuess: "宇宙船",
    comment: "丸い線が元気に飛び出しています!",
    isCorrect: true,
  });
  assert.equal("token" in reveal, false);
  assert.equal("candidateWords" in reveal, false);
  assert.equal("status" in reveal, false);
});
