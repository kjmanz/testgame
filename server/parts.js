/**
 * 全員参加の「バラバラ合体お絵かき」で使う純粋なデータと割り当て処理。
 *
 * すべてのお題は、同じ正規化キャンバス上のキャラクター構成を使う。
 * 少人数では複数の部位をひとまとめにし、人数が増えるほど担当を細かく分ける。
 */

export const PARTS_MIN_PLAYERS = 3;
export const PARTS_MAX_PLAYERS = 15;
export const PARTS_VARIANTS = Object.freeze([
  "normal",
  "secret",
  "mystery",
]);

const COMMON_PLAN_ID = "common-character-v1";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * 既存キャラクターを模倣せずに遊べる、オリジナル向けのお題。
 * 全件が頭・胴体・手足・顔・飾りからなる共通プランを使う。
 */
export const PARTS_PROMPTS = deepFreeze([
  {
    id: "cosmic-creature",
    word: "宇宙からきたふしぎな生きもの",
    description: "どの星にもいなさそうな、新しい生きものを作ろう",
    emoji: "🪐",
    planId: COMMON_PLAN_ID,
  },
  {
    id: "future-pet-robot",
    word: "未来のペットロボット",
    description: "いっしょに遊びたくなる、へんてこなロボットを作ろう",
    emoji: "🤖",
    planId: COMMON_PLAN_ID,
  },
  {
    id: "forest-guardian",
    word: "森のふしぎな守り神",
    description: "木や葉っぱから生まれた、やさしい守り神を作ろう",
    emoji: "🌳",
    planId: COMMON_PLAN_ID,
  },
  {
    id: "deep-sea-monster",
    word: "深海のゆかいなかいじゅう",
    description: "暗い海でのんびり暮らす、楽しいかいじゅうを作ろう",
    emoji: "🌊",
    planId: COMMON_PLAN_ID,
  },
  {
    id: "cloud-dragon",
    word: "雲の上にすむドラゴン",
    description: "空をふわふわ旅する、新しいドラゴンを作ろう",
    emoji: "☁️",
    planId: COMMON_PLAN_ID,
  },
  {
    id: "candy-monster",
    word: "おかしの国のモンスター",
    description: "甘いものが大好きな、こわくないモンスターを作ろう",
    emoji: "🍭",
    planId: COMMON_PLAN_ID,
  },
]);

export const PARTS_SECRET_INSTRUCTIONS = Object.freeze([
  "担当パーツを、とにかく大きく描いて",
  "担当パーツを、びっくりするほど小さく描いて",
  "担当パーツを、カクカクの形にして",
  "担当パーツに、ふわふわの毛を足して",
  "担当パーツを、ちょっとななめに描いて",
  "担当パーツに、ぐるぐるを1つ混ぜて",
  "担当パーツを、ものすごく元気そうにして",
  "担当パーツに、星の形を1つ混ぜて",
]);

/** @typedef {{x:number, y:number}} Anchor */
/** @typedef {{x:number, y:number, width:number, height:number}} Area */
/**
 * @typedef {{
 *  id: string,
 *  label: string,
 *  hint: string,
 *  area: Area,
 *  anchors: Anchor[],
 *  stage: 0 | 1 | 2 | 3,
 * }} Part
 */

/** @type {Record<string, Part>} */
const LEAF_PARTS = deepFreeze({
  head: {
    id: "head",
    label: "頭の輪郭",
    hint: "首につながる2つの点を意識して、頭の外側を描こう",
    area: { x: 0.28, y: 0.08, width: 0.44, height: 0.32 },
    anchors: [
      { x: 0.4, y: 0.38 },
      { x: 0.6, y: 0.38 },
    ],
    stage: 0,
  },
  torso: {
    id: "torso",
    label: "胴体",
    hint: "肩と足のつけ根をつないで、からだの形を描こう",
    area: { x: 0.32, y: 0.36, width: 0.36, height: 0.38 },
    anchors: [
      { x: 0.35, y: 0.42 },
      { x: 0.65, y: 0.42 },
      { x: 0.4, y: 0.71 },
      { x: 0.6, y: 0.71 },
    ],
    stage: 0,
  },
  leftArm: {
    id: "left-arm",
    label: "左うで",
    hint: "肩の点から、画面の左へうでを伸ばそう",
    area: { x: 0.08, y: 0.38, width: 0.29, height: 0.3 },
    anchors: [{ x: 0.35, y: 0.42 }],
    stage: 1,
  },
  rightArm: {
    id: "right-arm",
    label: "右うで",
    hint: "肩の点から、画面の右へうでを伸ばそう",
    area: { x: 0.63, y: 0.38, width: 0.29, height: 0.3 },
    anchors: [{ x: 0.65, y: 0.42 }],
    stage: 1,
  },
  leftLeg: {
    id: "left-leg",
    label: "左あし",
    hint: "つけ根の点から、画面の左下へあしを描こう",
    area: { x: 0.24, y: 0.68, width: 0.27, height: 0.3 },
    anchors: [{ x: 0.4, y: 0.71 }],
    stage: 1,
  },
  rightLeg: {
    id: "right-leg",
    label: "右あし",
    hint: "つけ根の点から、画面の右下へあしを描こう",
    area: { x: 0.49, y: 0.68, width: 0.27, height: 0.3 },
    anchors: [{ x: 0.6, y: 0.71 }],
    stage: 1,
  },
  leftEye: {
    id: "left-eye",
    label: "左目",
    hint: "左側の目印を中心に、表情が出る目を描こう",
    area: { x: 0.35, y: 0.16, width: 0.13, height: 0.12 },
    anchors: [{ x: 0.415, y: 0.22 }],
    stage: 2,
  },
  rightEye: {
    id: "right-eye",
    label: "右目",
    hint: "右側の目印を中心に、表情が出る目を描こう",
    area: { x: 0.52, y: 0.16, width: 0.13, height: 0.12 },
    anchors: [{ x: 0.585, y: 0.22 }],
    stage: 2,
  },
  nose: {
    id: "nose",
    label: "鼻",
    hint: "顔のまんなかの点を使って、鼻を描こう",
    area: { x: 0.46, y: 0.23, width: 0.08, height: 0.08 },
    anchors: [{ x: 0.5, y: 0.27 }],
    stage: 2,
  },
  mouth: {
    id: "mouth",
    label: "口",
    hint: "2つの点のあいだに、楽しい口を描こう",
    area: { x: 0.4, y: 0.29, width: 0.2, height: 0.09 },
    anchors: [
      { x: 0.42, y: 0.33 },
      { x: 0.58, y: 0.33 },
    ],
    stage: 2,
  },
  leftEar: {
    id: "left-ear",
    label: "左耳",
    hint: "頭の左側の点から、好きな形の耳を生やそう",
    area: { x: 0.18, y: 0.06, width: 0.17, height: 0.25 },
    anchors: [{ x: 0.31, y: 0.18 }],
    stage: 3,
  },
  rightEar: {
    id: "right-ear",
    label: "右耳",
    hint: "頭の右側の点から、好きな形の耳を生やそう",
    area: { x: 0.65, y: 0.06, width: 0.17, height: 0.25 },
    anchors: [{ x: 0.69, y: 0.18 }],
    stage: 3,
  },
  tail: {
    id: "tail",
    label: "しっぽ",
    hint: "からだの右側の点から、自由なしっぽを伸ばそう",
    area: { x: 0.66, y: 0.46, width: 0.31, height: 0.34 },
    anchors: [{ x: 0.66, y: 0.56 }],
    stage: 3,
  },
  headDecoration: {
    id: "head-decoration",
    label: "頭のかざり",
    hint: "頭のてっぺんの点から、角・毛・アンテナなどを足そう",
    area: { x: 0.36, y: 0, width: 0.28, height: 0.16 },
    anchors: [{ x: 0.5, y: 0.1 }],
    stage: 3,
  },
  bodyEmblem: {
    id: "body-emblem",
    label: "からだのもよう",
    hint: "からだの中心に、マークや服のもようを描こう",
    area: { x: 0.39, y: 0.45, width: 0.22, height: 0.19 },
    anchors: [{ x: 0.5, y: 0.54 }],
    stage: 3,
  },
});

const GROUPS = deepFreeze({
  headPack: {
    id: "head-pack",
    label: "頭・耳・頭のかざり",
    hint: "頭の輪郭を描いて、耳や角なども自由に足そう",
    keys: ["head", "leftEar", "rightEar", "headDecoration"],
    stage: 0,
  },
  bodyPack: {
    id: "body-pack",
    label: "からだ・手足・しっぽ",
    hint: "胴体から手足としっぽがつながるように描こう",
    keys: ["torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "tail"],
    stage: 1,
  },
  detailPack: {
    id: "detail-pack",
    label: "顔・からだのもよう",
    hint: "目・鼻・口で表情を作り、からだにもマークを足そう",
    keys: ["leftEye", "rightEye", "nose", "mouth", "bodyEmblem"],
    stage: 2,
  },
  limbPack: {
    id: "limb-pack",
    label: "手足・しっぽ",
    hint: "肩と足のつけ根から、手足としっぽを伸ばそう",
    keys: ["leftArm", "rightArm", "leftLeg", "rightLeg", "tail"],
    stage: 1,
  },
  headExtras: {
    id: "head-extras",
    label: "耳・頭のかざり",
    hint: "頭の左右とてっぺんに、耳や角などを足そう",
    keys: ["leftEar", "rightEar", "headDecoration"],
    stage: 3,
  },
  facePack: {
    id: "face-pack",
    label: "顔",
    hint: "目・鼻・口を入れて、楽しい表情を作ろう",
    keys: ["leftEye", "rightEye", "nose", "mouth"],
    stage: 2,
  },
  armPack: {
    id: "arm-pack",
    label: "両うで",
    hint: "左右の肩の点から、うでを伸ばそう",
    keys: ["leftArm", "rightArm"],
    stage: 1,
  },
  lowerPack: {
    id: "lower-pack",
    label: "両あし・しっぽ",
    hint: "足のつけ根とからだの横から、あしとしっぽを伸ばそう",
    keys: ["leftLeg", "rightLeg", "tail"],
    stage: 1,
  },
  eyesPack: {
    id: "eyes-pack",
    label: "両目",
    hint: "左右の目印に、セットになる目を描こう",
    keys: ["leftEye", "rightEye"],
    stage: 2,
  },
  noseMouth: {
    id: "nose-mouth",
    label: "鼻・口",
    hint: "顔の中心に鼻と口を描いて、表情を仕上げよう",
    keys: ["nose", "mouth"],
    stage: 2,
  },
  earsPack: {
    id: "ears-pack",
    label: "両耳",
    hint: "頭の左右の点から、セットになる耳を描こう",
    keys: ["leftEar", "rightEar"],
    stage: 3,
  },
  legsPack: {
    id: "legs-pack",
    label: "両あし",
    hint: "左右のつけ根から、あしを下へ伸ばそう",
    keys: ["leftLeg", "rightLeg"],
    stage: 1,
  },
});

const SPLITS = deepFreeze([
  ["bodyPack", ["torso", "limbPack"]],
  ["headPack", ["head", "headExtras"]],
  ["detailPack", ["facePack", "bodyEmblem"]],
  ["limbPack", ["armPack", "lowerPack"]],
  ["facePack", ["eyesPack", "noseMouth"]],
  ["headExtras", ["earsPack", "headDecoration"]],
  ["lowerPack", ["legsPack", "tail"]],
  ["armPack", ["leftArm", "rightArm"]],
  ["eyesPack", ["leftEye", "rightEye"]],
  ["noseMouth", ["nose", "mouth"]],
  ["earsPack", ["leftEar", "rightEar"]],
  ["legsPack", ["leftLeg", "rightLeg"]],
]);

function assertPlayerCount(playerCount) {
  if (
    !Number.isInteger(playerCount) ||
    playerCount < PARTS_MIN_PLAYERS ||
    playerCount > PARTS_MAX_PLAYERS
  ) {
    throw new RangeError(
      `パーツ合体は${PARTS_MIN_PLAYERS}〜${PARTS_MAX_PLAYERS}人で遊べます`,
    );
  }
}

function randomIndex(length, rng) {
  const value = Number(rng());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("rng は 0以上1未満の数を返す必要があります");
  }
  return Math.floor(value * length);
}

function shuffled(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, rng);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function roundCoord(value) {
  return Math.round(value * 1000) / 1000;
}

function clonePart(part) {
  return {
    id: part.id,
    label: part.label,
    hint: part.hint,
    area: { ...part.area },
    anchors: part.anchors.map((anchor) => ({ ...anchor })),
    stage: part.stage,
  };
}

function materializePart(key) {
  const leaf = LEAF_PARTS[key];
  if (leaf) return clonePart(leaf);

  const group = GROUPS[key];
  if (!group) throw new Error(`不明なパーツ定義: ${key}`);
  const leaves = group.keys.map((leafKey) => LEAF_PARTS[leafKey]);
  const x = Math.min(...leaves.map((part) => part.area.x));
  const y = Math.min(...leaves.map((part) => part.area.y));
  const right = Math.max(
    ...leaves.map((part) => part.area.x + part.area.width),
  );
  const bottom = Math.max(
    ...leaves.map((part) => part.area.y + part.area.height),
  );
  const seenAnchors = new Set();
  const anchors = [];
  for (const part of leaves) {
    for (const anchor of part.anchors) {
      const anchorKey = `${anchor.x}:${anchor.y}`;
      if (seenAnchors.has(anchorKey)) continue;
      seenAnchors.add(anchorKey);
      anchors.push({ ...anchor });
    }
  }

  return {
    id: group.id,
    label: group.label,
    hint: group.hint,
    area: {
      x: roundCoord(x),
      y: roundCoord(y),
      width: roundCoord(right - x),
      height: roundCoord(bottom - y),
    },
    anchors: anchors.slice(0, 4),
    stage: group.stage,
  };
}

/** 参加人数に応じた描画時間。 */
export function partsDurationSec(playerCount) {
  assertPlayerCount(playerCount);
  if (playerCount <= 4) return 10;
  if (playerCount <= 8) return 8;
  if (playerCount <= 12) return 7;
  return 6;
}

/**
 * 3つの大きな担当から順番に分割し、人数と同数の重複しない担当を返す。
 * @param {number} playerCount
 * @returns {Part[]}
 */
export function createPartPlan(playerCount) {
  assertPlayerCount(playerCount);
  const keys = ["headPack", "bodyPack", "detailPack"];
  for (let count = PARTS_MIN_PLAYERS; count < playerCount; count += 1) {
    const [target, replacements] = SPLITS[count - PARTS_MIN_PLAYERS];
    const index = keys.indexOf(target);
    if (index < 0) throw new Error(`パーツを分割できません: ${target}`);
    keys.splice(index, 1, ...replacements);
  }
  return keys.map(materializePart);
}

/** 通常・秘密指令・ミステリーから1つ選ぶ。 */
export function randomPartsVariant(rng = Math.random) {
  return PARTS_VARIANTS[randomIndex(PARTS_VARIANTS.length, rng)];
}

/**
 * 直近のお題を避けて1つ選ぶ。候補が尽きた場合は全件から選び直す。
 * @param {{excludeIds?: Set<string> | string[], rng?: () => number}} [options]
 */
export function randomPartsPrompt({
  excludeIds = new Set(),
  rng = Math.random,
} = {}) {
  const excluded =
    excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const available = PARTS_PROMPTS.filter((prompt) => !excluded.has(prompt.id));
  const pool = available.length > 0 ? available : PARTS_PROMPTS;
  const prompt = pool[randomIndex(pool.length, rng)];
  return {
    ...prompt,
  };
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) {
    throw new TypeError("players は配列で指定してください");
  }
  assertPlayerCount(players.length);
  const ids = new Set();
  return players.map((player) => {
    const id = typeof player?.id === "string" ? player.id.trim() : "";
    if (!id) throw new TypeError("すべての参加者に id が必要です");
    if (ids.has(id)) throw new RangeError(`参加者 id が重複しています: ${id}`);
    ids.add(id);
    return {
      id,
      name: typeof player.name === "string" ? player.name : "",
    };
  });
}

/**
 * 全員分のラウンドデータを作る。返却順は入力した players と同じ。
 *
 * secret: 約25%の人だけに秘密指令を付ける。
 * mystery: 1人だけお題を見られない。
 *
 * @param {{id:string, name?:string}[]} players
 * @param {{
 *  variant?: 'normal' | 'secret' | 'mystery',
 *  excludePromptIds?: Set<string> | string[],
 *  rng?: () => number,
 * }} [options]
 */
export function createPartsRound(
  players,
  {
    variant,
    excludePromptIds = new Set(),
    rng = Math.random,
  } = {},
) {
  const normalizedPlayers = normalizePlayers(players);
  const selectedVariant = variant ?? randomPartsVariant(rng);
  if (!PARTS_VARIANTS.includes(selectedVariant)) {
    throw new RangeError(`不明なパーツ合体バリエーション: ${selectedVariant}`);
  }

  const prompt = randomPartsPrompt({ excludeIds: excludePromptIds, rng });
  const parts = shuffled(createPartPlan(normalizedPlayers.length), rng);
  const assignments = normalizedPlayers.map((player, index) => ({
    playerId: player.id,
    playerName: player.name,
    ...parts[index],
    secretInstruction: null,
    isWordHidden: false,
  }));

  if (selectedVariant === "secret") {
    const secretCount = Math.max(1, Math.round(assignments.length * 0.25));
    const selectedIndexes = shuffled(
      assignments.map((_, index) => index),
      rng,
    ).slice(0, secretCount);
    const instructions = shuffled(PARTS_SECRET_INSTRUCTIONS, rng);
    selectedIndexes.forEach((assignmentIndex, index) => {
      assignments[assignmentIndex].secretInstruction =
        instructions[index % instructions.length];
    });
  }

  let hiddenWordPlayerId = null;
  if (selectedVariant === "mystery") {
    const hiddenIndex = randomIndex(assignments.length, rng);
    assignments[hiddenIndex].isWordHidden = true;
    hiddenWordPlayerId = assignments[hiddenIndex].playerId;
  }

  return {
    prompt,
    variant: selectedVariant,
    durationSec: partsDurationSec(normalizedPlayers.length),
    hiddenWordPlayerId,
    assignments,
  };
}
