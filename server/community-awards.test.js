import assert from "node:assert/strict";
import test from "node:test";
import {
  selectCommunityAwardCategories,
  tallyCommunityAwards,
} from "./community-awards.js";

const drawings = [
  { id: "drawing-a", roundType: "normal", constraintLabel: "" },
  { id: "drawing-b", roundType: "normal", constraintLabel: "" },
  { id: "drawing-c", roundType: "normal", constraintLabel: "" },
];

test("selectCommunityAwardCategories creates three distinct general awards", () => {
  const categories = selectCommunityAwardCategories(drawings, {
    random: () => 0.25,
  });

  assert.equal(categories.length, 3);
  assert.equal(new Set(categories.map((category) => category.id)).size, 3);
  for (const category of categories) {
    assert.deepEqual(category.candidateIds, [
      "drawing-a",
      "drawing-b",
      "drawing-c",
    ]);
  }
});

test("selectCommunityAwardCategories includes one relevant special award", () => {
  const categories = selectCommunityAwardCategories(
    [
      { id: "relay-a", roundType: "relay", constraintLabel: "" },
      { id: "relay-b", roundType: "relay", constraintLabel: "" },
      ...drawings,
    ],
    { random: () => 0 },
  );

  const relayAward = categories.find(
    (category) => category.id === "relay_landing",
  );
  assert.ok(relayAward);
  assert.deepEqual(relayAward.candidateIds, ["relay-a", "relay-b"]);
  assert.equal(
    categories.filter((category) => category.id === "relay_landing").length,
    1,
  );
});

test("special awards are skipped when fewer than two matching works exist", () => {
  const categories = selectCommunityAwardCategories(
    [{ id: "relay-a", roundType: "relay", constraintLabel: "" }, ...drawings],
    { random: () => 0 },
  );

  assert.equal(
    categories.some((category) => category.id === "relay_landing"),
    false,
  );
});

test("tallyCommunityAwards reports margins, unanimity, and multiple crowns", () => {
  const categories = [
    {
      id: "one",
      title: "賞1",
      prompt: "その1",
      emoji: "1️⃣",
      candidateIds: ["a", "b", "c"],
    },
    {
      id: "two",
      title: "賞2",
      prompt: "その2",
      emoji: "2️⃣",
      candidateIds: ["a", "b", "c"],
    },
    {
      id: "three",
      title: "賞3",
      prompt: "その3",
      emoji: "3️⃣",
      candidateIds: ["a", "b", "c"],
    },
  ];
  const ballots = new Map([
    ["player-1", new Map([["one", "a"], ["two", "a"], ["three", "a"]])],
    ["player-2", new Map([["one", "a"], ["two", "b"], ["three", "a"]])],
    ["player-3", new Map([["one", "a"], ["two", "b"], ["three", "b"]])],
  ]);

  const { awards } = tallyCommunityAwards(categories, ballots);
  assert.deepEqual(awards[0].winnerIds, ["a"]);
  assert.equal(awards[0].isUnanimous, true);
  assert.equal(awards[0].totalVotes, 3);
  assert.match(awards[0].comment, /満場一致/);
  assert.doesNotMatch(awards[0].comment, /二冠/);

  assert.deepEqual(awards[1].winnerIds, ["b"]);
  assert.equal(awards[1].voteMargin, 1);
  assert.match(awards[1].comment, /1票差/);

  assert.deepEqual(awards[2].winnerIds, ["a"]);
  assert.equal(awards[2].voteMargin, 1);
  assert.match(awards[2].comment, /二冠/);
});

test("tallyCommunityAwards keeps every work tied for first place", () => {
  const category = {
    id: "tie",
    title: "同票賞",
    prompt: "どっち？",
    emoji: "🤝",
    candidateIds: ["a", "b", "c"],
  };
  const ballots = new Map([
    ["player-1", new Map([["tie", "a"]])],
    ["player-2", new Map([["tie", "b"]])],
  ]);

  const { awards } = tallyCommunityAwards([category], ballots);
  assert.deepEqual(awards[0].winnerIds, ["a", "b"]);
  assert.equal(awards[0].isTie, true);
  assert.equal(awards[0].voteMargin, 0);
  assert.match(awards[0].comment, /トロフィーを2個/);
});

test("tallyCommunityAwards safely handles a timeout with no ballots", () => {
  const category = {
    id: "quiet",
    title: "しずか賞",
    prompt: "どれ？",
    emoji: "🤫",
    candidateIds: ["a", "b"],
  };
  const { awards } = tallyCommunityAwards([category], new Map());

  assert.deepEqual(awards[0].winnerIds, []);
  assert.equal(awards[0].voteCount, 0);
  assert.equal(awards[0].totalVotes, 0);
  assert.match(awards[0].comment, /投票用紙/);
});

test("a partial early close is not reported as unanimous", () => {
  const category = {
    id: "partial",
    title: "途中締切賞",
    prompt: "どれ？",
    emoji: "⏱️",
    candidateIds: ["a", "b"],
  };
  const ballots = new Map([
    ["player-1", new Map([["partial", "a"]])],
  ]);
  const { awards } = tallyCommunityAwards([category], ballots, {
    eligibleCount: 4,
  });

  assert.equal(awards[0].isUnanimous, false);
  assert.doesNotMatch(awards[0].comment, /満場一致/);
  assert.match(awards[0].comment, /一直線/);
});
