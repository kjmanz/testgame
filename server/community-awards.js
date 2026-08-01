const BASE_CATEGORIES = [
  {
    id: "slow_burn",
    emoji: "😏",
    title: "じわじわくる賞",
    prompt: "今日いちばん、見るほどクセになる作品といえば？",
  },
  {
    id: "double_take",
    emoji: "👀",
    title: "二度見した賞",
    prompt: "お題を知ってから、思わずもう一度見た作品は？",
  },
  {
    id: "unexpected",
    emoji: "🛸",
    title: "発想が斜め上賞",
    prompt: "その発想はどこから来たの？と思った作品は？",
  },
  {
    id: "display_worthy",
    emoji: "🖼️",
    title: "部屋に飾りたい賞",
    prompt: "額に入れて毎日眺めたい作品は？",
  },
  {
    id: "merch_ready",
    emoji: "🛍️",
    title: "グッズ化待ったなし賞",
    prompt: "ステッカーになったら欲しい作品は？",
  },
  {
    id: "main_character",
    emoji: "👑",
    title: "今日の主役感賞",
    prompt: "会場の視線をいちばん集めた作品は？",
  },
  {
    id: "confident_lines",
    emoji: "✍️",
    title: "線に迷いがなさすぎる賞",
    prompt: "勢いまで作品になっている一枚は？",
  },
  {
    id: "storybook",
    emoji: "📖",
    title: "絵本の1ページ賞",
    prompt: "この先のお話まで見たくなる作品は？",
  },
  {
    id: "replay",
    emoji: "🔁",
    title: "何度でも見返したい賞",
    prompt: "ギャラリーでつい戻って見てしまう作品は？",
  },
];

const SPECIAL_CATEGORIES = [
  {
    id: "relay_landing",
    emoji: "🏃",
    title: "リレー奇跡の着地賞",
    prompt: "バトンをつないで見事に着地した作品は？",
    matches: (item) => item.roundType === "relay",
  },
  {
    id: "coop_chemistry",
    emoji: "🧪",
    title: "協力プレーの化学反応賞",
    prompt: "みんなの線が奇跡的に混ざり合った作品は？",
    matches: (item) => item.roundType === "coop",
  },
  {
    id: "liar_confusion",
    emoji: "🎭",
    title: "混乱を味方につけた賞",
    prompt: "うそつき騒動まで作品の味になった一枚は？",
    matches: (item) => item.roundType === "liar",
  },
  {
    id: "gradual_reveal",
    emoji: "🌅",
    title: "じわじわ名画賞",
    prompt: "少しずつ姿を現した瞬間が忘れられない作品は？",
    matches: (item) => item.roundType === "gradual",
  },
  {
    id: "constraint_master",
    emoji: "🎯",
    title: "しばりを味方につけた賞",
    prompt: "むずかしいしばりを魅力に変えた作品は？",
    matches: (item) => Boolean(String(item.constraintLabel || "").trim()),
  },
];

function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const value = Number(random());
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(0.999999999999, value))
      : 0;
    const j = Math.floor(normalized * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function publicCategory(category, candidateIds) {
  return {
    id: category.id,
    title: category.title,
    prompt: category.prompt,
    emoji: category.emoji,
    candidateIds,
  };
}

/**
 * 3つの賞を選ぶ。特殊ラウンド（またはしばり）の絵が2枚以上ある場合は、
 * そのゲームらしい賞を最大1つ採用し、残りを誰でも選べる賞で埋める。
 */
export function selectCommunityAwardCategories(
  galleryItems,
  { count = 3, random = Math.random } = {},
) {
  const items = Array.isArray(galleryItems) ? galleryItems : [];
  const allCandidateIds = items.map((item) => item.id).filter(Boolean);
  if (allCandidateIds.length < 2 || count <= 0) return [];

  const eligibleSpecials = SPECIAL_CATEGORIES.flatMap((category) => {
    const candidateIds = items
      .filter(category.matches)
      .map((item) => item.id)
      .filter(Boolean);
    return candidateIds.length >= 2
      ? [publicCategory(category, candidateIds)]
      : [];
  });

  const selected = [];
  if (eligibleSpecials.length > 0) {
    selected.push(shuffled(eligibleSpecials, random)[0]);
  }
  const baseCount = Math.max(0, count - selected.length);
  selected.push(
    ...shuffled(BASE_CATEGORIES, random)
      .slice(0, baseCount)
      .map((category) => publicCategory(category, allCandidateIds)),
  );
  return selected.slice(0, count);
}

function countCategoryVotes(category, ballots, eligibleCount) {
  const allowedIds = new Set(category.candidateIds);
  const counts = new Map();
  let totalVotes = 0;
  for (const ballot of ballots) {
    const galleryItemId = ballot?.get?.(category.id);
    if (!allowedIds.has(galleryItemId)) continue;
    counts.set(galleryItemId, (counts.get(galleryItemId) || 0) + 1);
    totalVotes += 1;
  }

  const voteCount = Math.max(0, ...counts.values());
  const winnerIds =
    voteCount > 0
      ? category.candidateIds.filter((id) => counts.get(id) === voteCount)
      : [];
  const runnerUpVotes = Math.max(
    0,
    ...[...counts.entries()]
      .filter(([id]) => !winnerIds.includes(id))
      .map(([, value]) => value),
  );
  return {
    categoryId: category.id,
    title: category.title,
    prompt: category.prompt,
    emoji: category.emoji,
    winnerIds,
    voteCount,
    totalVotes,
    voteMargin: winnerIds.length > 1 ? 0 : voteCount - runnerUpVotes,
    isTie: winnerIds.length > 1,
    isUnanimous:
      totalVotes > 0 &&
      totalVotes === eligibleCount &&
      winnerIds.length === 1 &&
      voteCount === totalVotes,
  };
}

function buildHostComment(award, crownCount) {
  if (award.totalVotes === 0) {
    return "投票用紙が静かすぎました。拍手だけ先にお届けします！";
  }

  const parts = [];
  if (award.isTie) {
    parts.push(
      `会場、決めきれません！トロフィーを${award.winnerIds.length}個に増やします！`,
    );
  } else if (award.isUnanimous) {
    parts.push("会場、迷いゼロ。満場一致です！拍手まで独り占め！");
  } else if (award.winnerIds.length === 1 && award.voteCount === award.totalVotes) {
    parts.push("集まった票は、この作品へ一直線！迷いのない指名です！");
  } else if (award.voteMargin === 1 && award.totalVotes >= 2) {
    parts.push("わずか1票差！会場がきれいに真っ二つになりました！");
  } else {
    parts.push("票が集まりました！会場の「これだ！」が見事に一致！");
  }

  if (crownCount >= 3) {
    parts.push("まさかの三冠！もうトロフィー置き場がありません！");
  } else if (crownCount === 2) {
    parts.push("まさかの二冠！額縁が足りません！");
  }
  return parts.join(" ");
}

/** 個別票を一切返さず、公開してよい集計結果だけを作る。 */
export function tallyCommunityAwards(categories, ballots, options = {}) {
  const safeCategories = Array.isArray(categories) ? categories : [];
  const safeBallots = ballots instanceof Map ? [...ballots.values()] : [];
  const eligibleCount = Number.isInteger(options.eligibleCount)
    ? Math.max(safeBallots.length, options.eligibleCount)
    : safeBallots.length;
  const awards = safeCategories.map((category) =>
    countCategoryVotes(category, safeBallots, eligibleCount),
  );
  const announcedCrownCounts = new Map();

  return {
    awards: awards.map((award) => {
      let crownCount = 0;
      for (const winnerId of award.winnerIds) {
        const nextCount = (announcedCrownCounts.get(winnerId) || 0) + 1;
        announcedCrownCounts.set(winnerId, nextCount);
        crownCount = Math.max(crownCount, nextCount);
      }
      return {
        ...award,
        comment: buildHostComment(award, crownCount),
      };
    }),
  };
}
