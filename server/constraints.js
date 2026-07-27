/**
 * しばりルーレット: ふつうのラウンドにときどき付く「描きかたのしばり」。
 *
 * リレー・協力・うそつきには付けない（ルールが重なると小中学生には難しいため）。
 *
 * kind:
 *  - strokes: 線の本数を制限（サーバーとクライアントの両方で止める）
 *  - time:    描ける秒数を制限（サーバーのタイマーで止める）
 *  - pen:     ペンの太さを固定（サーバーが太さを上書きする）
 *  - blind:   描いている本人にだけ絵を見せない（クライアントで隠す）
 *  - honor:   自己申告（コードでは強制しない）
 *
 * @typedef {{
 *  id: string,
 *  kind: 'strokes' | 'time' | 'pen' | 'blind' | 'honor',
 *  value: number,
 *  emoji: string,
 *  label: string,
 *  rule: string,
 *  hint: string,
 * }} Constraint
 */

/** @type {Constraint[]} */
export const CONSTRAINTS = [
  {
    id: "lines5",
    kind: "strokes",
    value: 5,
    emoji: "🖐️",
    label: "5本しばり",
    rule: "線は5本まで！",
    hint: "指をはなすと1本つかったことになるよ",
  },
  {
    id: "oneStroke",
    kind: "strokes",
    value: 1,
    emoji: "✍️",
    label: "一筆がき",
    rule: "指をはなしたら おしまい！",
    hint: "はなさずに一気に描ききろう",
  },
  {
    id: "speed10",
    kind: "time",
    value: 10,
    emoji: "⏱️",
    label: "10びょう",
    rule: "10びょうで描ききれ！",
    hint: "考えるより先に手をうごかそう",
  },
  {
    id: "fatPen",
    kind: "pen",
    value: 24,
    emoji: "🖌️",
    label: "ふとふでペン",
    rule: "ペンがぶっとい！",
    hint: "こまかいところは あきらめよう",
  },
  {
    id: "blind",
    kind: "blind",
    value: 0,
    emoji: "🙈",
    label: "めかくし",
    rule: "自分の絵が見えない！",
    hint: "みんなには ちゃんと見えてるよ",
  },
  {
    id: "otherHand",
    kind: "honor",
    value: 0,
    emoji: "🤚",
    label: "ぎゃくの手",
    rule: "きき手じゃないほうで描く",
    hint: "ズルはなしだよ！",
  },
  {
    id: "upsideDown",
    kind: "honor",
    value: 0,
    emoji: "🙃",
    label: "さかさま",
    rule: "上下ぎゃくむきに描く",
    hint: "みんなは そのままの向きで見るよ",
  },
  {
    id: "noCircle",
    kind: "honor",
    value: 0,
    emoji: "📐",
    label: "まるきんし",
    rule: "まるい線をつかっちゃダメ",
    hint: "カクカクで がんばれ",
  },
  {
    id: "heartHidden",
    kind: "honor",
    value: 0,
    emoji: "💗",
    label: "ハートまぜ",
    rule: "絵のどこかにハートをまぜる",
    hint: "お題とかんけいなくても まぜる",
  },
];

const byId = new Map(CONSTRAINTS.map((item) => [item.id, item]));

/** @param {string} id */
export function findConstraint(id) {
  return byId.get(String(id || "")) || null;
}

/**
 * @param {Set<string>} [exclude] 直近に出したしばり（候補が尽きたら無視する）
 * @returns {Constraint}
 */
export function randomConstraint(exclude) {
  const pool =
    exclude && exclude.size > 0
      ? CONSTRAINTS.filter((item) => !exclude.has(item.id))
      : CONSTRAINTS;
  const list = pool.length > 0 ? pool : CONSTRAINTS;
  return list[Math.floor(Math.random() * list.length)];
}
