import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENAI_TEXT_MODEL,
  createAwards,
  createCrazyPromptPack,
  createSecretGuess,
  extractResponseText,
  normalizeAwards,
  normalizeCrazyPrompts,
  normalizeSecretGuess,
  parseImageDataUrl,
  publicAiCapabilities,
} from "./ai.js";

const crazyMainAnswers = [
  "ペンギン",
  "冷蔵庫",
  "忍者",
  "ロボット",
  "ゴリラ",
  "宇宙人",
  "おばけ",
  "消防車",
];

function crazyPrompts() {
  const situations = [
    "ラーメンを作る",
    "かくれんぼ中の",
    "遅刻して走る",
    "温泉に入る",
    "ダンスを踊る",
    "宿題を忘れた",
    "パン屋で働く",
    "遊園地へ行く",
  ];
  return crazyMainAnswers.map((mainAnswer, index) => ({
    mainAnswer,
    fullPrompt: `${situations[index]}${mainAnswer}`,
  }));
}

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const tinyJpeg = dataUrl("image/jpeg", [0xff, 0xd8, 0xff, 0xd9]);
const tinyPng = dataUrl("image/png", [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const tinyWebp = dataUrl("image/webp", [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

test("parseImageDataUrl accepts JPEG, PNG, and WebP magic bytes", () => {
  assert.equal(parseImageDataUrl(tinyJpeg)?.mimeType, "image/jpeg");
  assert.equal(parseImageDataUrl(tinyPng)?.mimeType, "image/png");
  assert.equal(parseImageDataUrl(tinyWebp)?.mimeType, "image/webp");
});

test("parseImageDataUrl rejects unsafe and malformed images", () => {
  assert.equal(parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(parseImageDataUrl("data:image/jpeg;base64,not base64"), null);
  assert.equal(
    parseImageDataUrl(dataUrl("image/jpeg", [0x00, 0x01, 0x02])),
    null,
  );
  assert.equal(parseImageDataUrl(tinyJpeg, { maxBytes: 3 }), null);
});

test("extractResponseText reads the raw Responses API message shape", () => {
  assert.equal(
    extractResponseText({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"ok":true}' }],
        },
      ],
    }),
    '{"ok":true}',
  );
  assert.throws(
    () => extractResponseText({ status: "incomplete", output: [] }),
    /not completed/,
  );
  assert.throws(
    () =>
      extractResponseText({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "no" }],
          },
        ],
      }),
    /refused/,
  );
});

test("normalizeAwards keeps only unique known gallery IDs", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const normalized = normalizeAwards(
    {
      intro: "開幕です",
      awards: [
        { galleryItemId: "a", title: "線の魔術賞", reason: "線が楽しい" },
        { galleryItemId: "b", title: "色の花火賞", reason: "色が元気" },
        { galleryItemId: "c", title: "余白名人賞", reason: "構図が愉快" },
      ],
    },
    items,
  );
  assert.equal(normalized.awards.length, 3);
  assert.deepEqual(
    normalized.awards.map((award) => award.galleryItemId),
    ["a", "b", "c"],
  );
  assert.throws(
    () =>
      normalizeAwards(
        {
          intro: "開幕です",
          awards: [
            { galleryItemId: "a", title: "賞1", reason: "理由1" },
            { galleryItemId: "a", title: "賞2", reason: "理由2" },
            { galleryItemId: "unknown", title: "賞3", reason: "理由3" },
          ],
        },
        items,
      ),
    /incomplete/,
  );
});

test("createAwards sends the drawings themselves and stays server-side", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests = [];
  process.env.OPENAI_API_KEY = "test-key-never-send-to-client";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  intro: "第1回おえかき大賞、開幕！",
                  awards: [
                    { galleryItemId: "a", title: "線の魔術賞", reason: "線が楽しい" },
                    { galleryItemId: "b", title: "余白名人賞", reason: "構図が愉快" },
                  ],
                }),
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "x-request-id": "req_test" } },
    );
  };

  try {
    const awards = await createAwards(
      [
        {
          id: "a",
          word: "りんご",
          roundType: "normal",
          constraintLabel: "🖐️ 5本しばり",
          imageDataUrl: tinyJpeg,
        },
        { id: "b", word: "ねこ", roundType: "coop", imageDataUrl: tinyPng },
        // 画像として読めないものは候補に入れない
        { id: "c", word: "いぬ", roundType: "normal", imageDataUrl: "nope" },
      ],
      { safetyIdentifier: "safe-test-user" },
    );
    assert.equal(awards.awards.length, 2);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].options.headers.Authorization,
      "Bearer test-key-never-send-to-client",
    );

    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.safety_identifier, "safe-test-user");
    assert.match(body.instructions, /クスッ/);
    assert.match(body.instructions, /失敗を笑わず/);
    assert.match(body.instructions, /発表する順番/);

    const content = body.input[0].content;
    const images = content.filter((part) => part.type === "input_image");
    assert.equal(images.length, 2);
    assert.equal(images[0].image_url, tinyJpeg);
    assert.equal(images.every((part) => part.detail === "low"), true);
    assert.equal(
      content.some((part) => part.text?.includes("🖐️ 5本しばり")),
      true,
    );
    assert.equal(
      JSON.stringify(content).includes("nope"),
      false,
    );
    assert.equal(
      JSON.stringify(publicAiCapabilities()).includes(
        "test-key-never-send-to-client",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("createAwards needs at least two usable drawings", async () => {
  await assert.rejects(
    createAwards([{ id: "a", word: "りんご", imageDataUrl: tinyJpeg }]),
    /Not enough drawings/,
  );
});

function completedSecretGuessResponse(overrides = {}) {
  return {
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              bestGuess: "ねこ",
              secondGuess: "いぬ",
              wildGuess: "宇宙ポテト",
              comment: "丸い線が、元気よく空へ飛び出しています！",
              ...overrides,
            }),
          },
        ],
      },
    ],
  };
}

test("createSecretGuess sends one private low-detail structured request", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests = [];
  const candidateWords = [
    "ねこ",
    "いぬ",
    "うさぎ",
    "くま",
    "パンダ",
    "ライオン",
    "きりん",
    "ぞう",
    "さる",
    "ぺんぎん",
    "いるか",
    "くじら",
    "サメ",
    "たこ",
    "いか",
    "かに",
    "エビ",
    "かえる",
  ];
  process.env.OPENAI_API_KEY = "secret-api-key-must-not-enter-body";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(completedSecretGuessResponse()), {
      status: 200,
      headers: { "x-request-id": "req_secret_guess" },
    });
  };

  try {
    const result = await createSecretGuess(tinyJpeg, candidateWords, {
      safetyIdentifier: "safe-secret-player",
      isCurrent: () => true,
      // 呼び出し側が誤って渡しても、個人・部屋情報はAPI本文へ含めない。
      playerName: "秘密の太郎",
      playerId: "player-private-id",
      roomCode: "ROOM42",
      correctWord: "ねこ",
    });

    assert.deepEqual(result, {
      bestGuess: "ねこ",
      secondGuess: "いぬ",
      wildGuess: "宇宙ポテト",
      comment: "丸い線が、元気よく空へ飛び出しています！",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses");

    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, OPENAI_TEXT_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.text.verbosity, "low");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.max_output_tokens, 180);
    assert.equal(body.safety_identifier, "safe-secret-player");
    assert.deepEqual(
      body.text.format.schema.properties.bestGuess.enum,
      candidateWords,
    );
    assert.deepEqual(
      body.text.format.schema.properties.secondGuess.enum,
      candidateWords,
    );
    assert.deepEqual(body.text.format.schema.required, [
      "bestGuess",
      "secondGuess",
      "wildGuess",
      "comment",
    ]);
    assert.equal(body.text.format.schema.additionalProperties, false);

    const images = body.input[0].content.filter(
      (part) => part.type === "input_image",
    );
    assert.equal(images.length, 1);
    const [image] = images;
    assert.deepEqual(image, {
      type: "input_image",
      image_url: tinyJpeg,
      detail: "low",
    });

    const serializedInput = JSON.stringify({
      instructions: body.instructions,
      input: body.input,
    });
    assert.equal(candidateWords.every((word) => serializedInput.includes(word)), true);
    assert.equal(serializedInput.includes("correctWord"), false);
    assert.equal(serializedInput.includes("正解:"), false);
    assert.equal(serializedInput.includes("秘密の太郎"), false);
    assert.equal(serializedInput.includes("player-private-id"), false);
    assert.equal(serializedInput.includes("ROOM42"), false);
    assert.equal(serializedInput.includes("secret-api-key-must-not-enter-body"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("createSecretGuess rejects an invalid image before calling OpenAI", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not be called");
  };

  try {
    await assert.rejects(
      createSecretGuess("not-an-image", ["ねこ", "いぬ"]),
      /Invalid drawing image/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("normalizeSecretGuess rejects duplicate, unknown, and empty output", () => {
  const candidates = ["ねこ", "いぬ", "うさぎ"];
  assert.throws(
    () =>
      normalizeSecretGuess(
        {
          bestGuess: "ねこ",
          secondGuess: "ねこ",
          wildGuess: "宇宙船",
          comment: "丸が見えます",
        },
        candidates,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      normalizeSecretGuess(
        {
          bestGuess: "候補外",
          secondGuess: "いぬ",
          wildGuess: "宇宙船",
          comment: "丸が見えます",
        },
        candidates,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      normalizeSecretGuess(
        {
          bestGuess: "ねこ",
          secondGuess: "いぬ",
          wildGuess: "宇宙船",
          comment: "\u0000\n\t",
        },
        candidates,
      ),
    /incomplete/,
  );
});

test("normalizeSecretGuess rejects non-string and unexpected fields", () => {
  const candidates = ["ねこ", "いぬ", "うさぎ"];
  const valid = {
    bestGuess: "ねこ",
    secondGuess: "いぬ",
    wildGuess: "宇宙船",
    comment: "丸い線が見えます",
  };

  for (const field of Object.keys(valid)) {
    assert.throws(
      () => normalizeSecretGuess({ ...valid, [field]: {} }, candidates),
      /incomplete/,
    );
  }
  assert.throws(
    () => normalizeSecretGuess({ ...valid, answer: "ねこ" }, candidates),
    /unexpected fields/,
  );
});

test("extractResponseText gives refusal priority over mixed output text", () => {
  assert.throws(
    () =>
      extractResponseText({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: '{"looks":"valid"}' },
              { type: "refusal", refusal: "no" },
            ],
          },
        ],
      }),
    /refused/,
  );
});

test("createSecretGuess rejects refusal, broken JSON, and incomplete responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const bodies = [
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "no" }],
        },
      ],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "{broken" }],
        },
      ],
    },
    { status: "incomplete", output: [] },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(bodies.shift()), {
      status: 200,
      headers: { "x-request-id": "req_bad_secret_guess" },
    });

  try {
    await assert.rejects(
      createSecretGuess(tinyJpeg, ["ねこ", "いぬ"]),
      /refused/,
    );
    await assert.rejects(
      createSecretGuess(tinyJpeg, ["ねこ", "いぬ"]),
      /Unexpected token|JSON/,
    );
    await assert.rejects(
      createSecretGuess(tinyJpeg, ["ねこ", "いぬ"]),
      /not completed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("normalizeCrazyPrompts returns eight safe normalized prompts", () => {
  const prompts = crazyPrompts();
  prompts[0] = {
    mainAnswer: "\u0000 ペンギン ",
    fullPrompt: "  ラーメンを作る\n\tペンギン  ",
    ignoredByServer: "extra",
  };

  const normalized = normalizeCrazyPrompts({ prompts }, crazyMainAnswers);
  assert.equal(normalized.prompts.length, 8);
  assert.deepEqual(normalized.prompts[0], {
    mainAnswer: "ペンギン",
    fullPrompt: "ラーメンを作る ペンギン",
  });
  assert.equal("ignoredByServer" in normalized.prompts[0], false);
  assert.deepEqual(
    new Set(normalized.prompts.map((prompt) => prompt.mainAnswer)),
    new Set(crazyMainAnswers),
  );
});

test("normalizeCrazyPrompts rejects an answer outside the allowlist", () => {
  const prompts = crazyPrompts();
  prompts[0] = {
    mainAnswer: "ドラゴン",
    fullPrompt: "ケーキを作るドラゴン",
  };
  assert.throws(
    () => normalizeCrazyPrompts({ prompts }, crazyMainAnswers),
    /invalid answer|incomplete/,
  );
});

test("normalizeCrazyPrompts rejects duplicate answers", () => {
  const prompts = crazyPrompts();
  prompts[7] = {
    mainAnswer: "ペンギン",
    fullPrompt: "遊園地へ行くペンギン",
  };
  assert.throws(
    () => normalizeCrazyPrompts({ prompts }, crazyMainAnswers),
    /invalid answer|incomplete/,
  );
});

test("normalizeCrazyPrompts rejects too few prompts", () => {
  assert.throws(
    () =>
      normalizeCrazyPrompts(
        { prompts: crazyPrompts().slice(0, 7) },
        crazyMainAnswers,
      ),
    /incomplete/,
  );
});

test("normalizeCrazyPrompts rejects too many prompts", () => {
  assert.throws(
    () =>
      normalizeCrazyPrompts(
        {
          prompts: [
            ...crazyPrompts(),
            { mainAnswer: "ペンギン", fullPrompt: "空を飛ぶペンギン" },
          ],
        },
        crazyMainAnswers,
      ),
    /incomplete/,
  );
});

test("normalizeCrazyPrompts rejects an empty fullPrompt", () => {
  const prompts = crazyPrompts();
  prompts[0] = { mainAnswer: "ペンギン", fullPrompt: " \n\t " };
  assert.throws(
    () => normalizeCrazyPrompts({ prompts }, crazyMainAnswers),
    /incomplete/,
  );
});

test("normalizeCrazyPrompts rejects a fullPrompt longer than 32 characters", () => {
  const prompts = crazyPrompts();
  prompts[0] = {
    mainAnswer: "ペンギン",
    fullPrompt: `${"とても".repeat(12)}ペンギン`,
  };
  assert.equal(prompts[0].fullPrompt.length > 32, true);
  assert.throws(
    () => normalizeCrazyPrompts({ prompts }, crazyMainAnswers),
    /incomplete/,
  );
});

test("createCrazyPromptPack sends one private text-only structured request", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests = [];
  process.env.OPENAI_API_KEY = "crazy-api-key-must-not-enter-body";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ prompts: crazyPrompts() }),
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "x-request-id": "req_crazy_prompt" } },
    );
  };

  try {
    const result = await createCrazyPromptPack(crazyMainAnswers, {
      safetyIdentifier: "safe-crazy-player",
      isCurrent: () => true,
      // 呼び出し側が余分な個人・部屋情報を渡しても本文へ混入させない。
      participantName: "秘密の花子",
      roomCode: "CRAZY42",
      playerId: "crazy-private-player-id",
    });

    assert.equal(result.prompts.length, 8);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses");

    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, OPENAI_TEXT_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.text.verbosity, "low");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, "crazy_prompt_pack");
    assert.equal(body.max_output_tokens >= 500, true);
    assert.equal(body.max_output_tokens <= 800, true);
    assert.equal(body.safety_identifier, "safe-crazy-player");

    const schema = body.text.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.prompts.minItems, 8);
    assert.equal(schema.properties.prompts.maxItems, 8);
    assert.deepEqual(
      schema.properties.prompts.items.properties.mainAnswer.enum,
      crazyMainAnswers,
    );
    assert.equal(
      schema.properties.prompts.items.additionalProperties,
      false,
    );

    const serializedBody = JSON.stringify(body);
    assert.equal(
      crazyMainAnswers.every((answer) => serializedBody.includes(answer)),
      true,
    );
    assert.equal(serializedBody.includes("秘密の花子"), false);
    assert.equal(serializedBody.includes("CRAZY42"), false);
    assert.equal(serializedBody.includes("crazy-private-player-id"), false);
    assert.equal(
      serializedBody.includes("crazy-api-key-must-not-enter-body"),
      false,
    );
    assert.equal(
      body.input[0].content.every((part) => part.type === "input_text"),
      true,
    );

    assert.match(body.instructions, /小中学生向け/);
    assert.match(body.instructions, /主役/);
    assert.match(body.instructions, /変更・追加せず/);
    assert.match(body.instructions, /暴力/);
    assert.match(body.instructions, /性的表現/);
    assert.match(body.instructions, /差別/);
    assert.match(body.instructions, /禁止/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("publicAiCapabilities never exposes the API key", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "public-capability-secret-key";
  try {
    const capabilities = publicAiCapabilities();
    assert.equal(capabilities.enabled, true);
    assert.equal(
      JSON.stringify(capabilities).includes("public-capability-secret-key"),
      false,
    );
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
