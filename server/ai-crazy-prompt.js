const DEFAULT_MIN_GAP = 4;
const DEFAULT_FORCE_GAP = 8;
const DEFAULT_CHANCE = 0.25;
const DEFAULT_MAX_PER_GAME = 2;

function cleanAnswer(value) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/** AIに渡す主役候補を、重複なし・短い子ども向け語に絞って選ぶ。 */
export function selectCrazyPromptMainAnswers(
  words,
  count = 8,
  { random = Math.random, maxLength = 24 } = {},
) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(words) ? words : []) {
    const word = cleanAnswer(value);
    if (!word || word.length > maxLength || seen.has(word)) continue;
    seen.add(word);
    unique.push(word);
  }
  const shuffled = [...unique];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const roll = Number(random());
    const normalized = Number.isFinite(roll)
      ? Math.max(0, Math.min(0.999999, roll))
      : 0;
    const target = Math.floor(normalized * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled.slice(0, Math.max(0, Math.trunc(count)));
}

/** 現在の通常ラウンドにAIむちゃぶりを付けるか判定する。 */
export function shouldEnableAiCrazyPrompt(options = {}) {
  const {
    enabled = true,
    configured = true,
    packStatus = "ready",
    roundType = "normal",
    constraint = null,
    completedRounds = 0,
    roundsSinceAiCrazyPrompt = 0,
    hasPreviousPrompt = false,
    usedCount = 0,
    maxPerGame = DEFAULT_MAX_PER_GAME,
    minGap = DEFAULT_MIN_GAP,
    forceGap = DEFAULT_FORCE_GAP,
    chance = DEFAULT_CHANCE,
    force = false,
    random = Math.random,
  } = options;

  if (!enabled || !configured || packStatus !== "ready") return false;
  if (roundType !== "normal" || constraint) return false;
  if (force) return true;
  if (usedCount >= maxPerGame) return false;

  const firstPrompt = !hasPreviousPrompt;
  const gap = firstPrompt ? completedRounds : roundsSinceAiCrazyPrompt;
  // 初回だけは「最初の3問を除外」なので、4問目（3問完了後）から抽選する。
  if (gap < (firstPrompt ? minGap - 1 : minGap)) return false;
  if (gap >= forceGap) return true;
  const roll = Number(random());
  return Number.isFinite(roll) && roll < chance;
}

/** パックから未使用のお題を1つだけ取り出し、使用済みにする。 */
export function takeNextCrazyPrompt(room) {
  const pack = Array.isArray(room?.aiCrazyPromptPack)
    ? room.aiCrazyPromptPack
    : [];
  const next = pack.find((item) => item && !item.used);
  if (!next) return null;
  next.used = true;
  return {
    id: cleanAnswer(next.id).slice(0, 64),
    mainAnswer: cleanAnswer(next.mainAnswer).slice(0, 24),
    fullPrompt: cleanAnswer(next.fullPrompt).slice(0, 32),
  };
}
