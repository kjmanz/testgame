import { WORDS } from "./words.js";

const DEFAULT_CANDIDATE_COUNT = 18;

function cleanDisplayText(value, maxLength = 70) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** 比較専用。表示文字列はこの値で上書きしない。 */
export function normalizeSecretGuessWord(value) {
  return cleanDisplayText(value, 80).toLocaleLowerCase("ja-JP");
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    let sample;
    try {
      sample = Number(random());
    } catch {
      sample = 0;
    }
    const bounded = Number.isFinite(sample)
      ? Math.min(Math.max(sample, 0), 0.9999999999999999)
      : 0;
    const swapIndex = Math.floor(bounded * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * 本当のお題を1個だけ混ぜた、順不同・重複なしの候補語を作る純粋関数。
 * 語彙が不足する場合は、重複で水増しせず利用可能な語だけを返す。
 */
export function buildSecretGuessCandidates(
  correctWord,
  { words = WORDS, count = DEFAULT_CANDIDATE_COUNT, random = Math.random } = {},
) {
  const correct = cleanDisplayText(correctWord, 40);
  if (!correct) return [];

  const desiredCount = Math.max(1, Math.floor(Number(count) || 0));
  const correctKey = normalizeSecretGuessWord(correct);
  const seen = new Set([correctKey]);
  const alternatives = [];

  for (const value of Array.isArray(words) ? words : []) {
    const word = cleanDisplayText(value, 40);
    const key = normalizeSecretGuessWord(word);
    if (!word || !key || seen.has(key)) continue;
    seen.add(key);
    alternatives.push(word);
  }

  const selected = shuffled(alternatives, random).slice(0, desiredCount - 1);
  return shuffled([...selected, correct], random);
}

/** 本命・対抗・大穴のどれかが本当のお題と一致したかを判定する。 */
export function isSecretGuessCorrect(result, correctWord) {
  const correct = normalizeSecretGuessWord(correctWord);
  if (!correct) return false;
  return [result?.bestGuess, result?.secondGuess, result?.wildGuess].some(
    (guess) => normalizeSecretGuessWord(guess) === correct,
  );
}

/** 7秒を待つ前の正解だけを「速すぎ」にし、取得失敗とは区別する。 */
export function secretGuessFallbackKind(status) {
  return status === "armed" || status === "countdown"
    ? "too_fast"
    : "unavailable";
}

/**
 * クライアントへ送ってよい情報だけを選んだ公開用payloadを作る。
 * 内部token、候補一覧、非同期処理の状態は意図的に受け渡さない。
 */
export function buildSecretGuessReveal({ roundId, correctWord, result }) {
  const safeCorrectWord = cleanDisplayText(correctWord, 40);
  const bestGuess = cleanDisplayText(result?.bestGuess, 40);
  const secondGuess = cleanDisplayText(result?.secondGuess, 40);
  const wildGuess = cleanDisplayText(result?.wildGuess, 18);
  const comment = cleanDisplayText(result?.comment, 70);

  if (
    !safeCorrectWord ||
    !bestGuess ||
    !secondGuess ||
    !wildGuess ||
    !comment
  ) {
    throw new Error("AI secret guess reveal was incomplete");
  }

  return {
    roundId,
    kind: "result",
    correctWord: safeCorrectWord,
    bestGuess,
    secondGuess,
    wildGuess,
    comment,
    isCorrect: isSecretGuessCorrect(
      { bestGuess, secondGuess, wildGuess },
      safeCorrectWord,
    ),
  };
}
