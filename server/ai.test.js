import assert from "node:assert/strict";
import test from "node:test";
import {
  critiqueDrawing,
  extractResponseText,
  normalizeAwards,
  parseImageDataUrl,
  publicAiCapabilities,
  stylizeDrawing,
} from "./ai.js";

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

test("OpenAI requests stay server-side and use strict structured output", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const requests = [];
  const longComment =
    "元気な丸が画面いっぱいに踊り、足の勢いに対して顔だけが冷静です。\n" +
    "少ない線なのに今にも走り出しそうな雰囲気があります。";
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
                  title: "まるの魔術師",
                  comment: longComment,
                  strength: "勢いのある丸い線",
                  awardSeed: "まるが踊るで賞",
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
    const critique = await critiqueDrawing({
      imageDataUrl: tinyJpeg,
      word: "りんご",
      roundType: "normal",
      safetyIdentifier: "safe-test-user",
    });
    assert.equal(critique.title, "まるの魔術師");
    assert.equal(critique.comment.length, 40);
    assert.equal(critique.comment.includes("\n"), false);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].options.headers.Authorization,
      "Bearer test-key-never-send-to-client",
    );
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.text.verbosity, "low");
    assert.equal(body.safety_identifier, "safe-test-user");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].content[1].detail, "low");
    assert.match(body.instructions, /40字以内/);
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

test("stylizeDrawing validates styles and requests compressed WebP", async () => {
  await assert.rejects(
    stylizeDrawing({
      imageDataUrl: tinyJpeg,
      word: "りんご",
      style: "arbitrary-user-prompt",
    }),
    /Invalid masterpiece style/,
  );

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let form;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async (_url, options) => {
    form = options.body;
    return new Response(
      JSON.stringify({
        data: [{ b64_json: tinyWebp.split(",")[1] }],
      }),
      { status: 200 },
    );
  };

  try {
    const result = await stylizeDrawing({
      imageDataUrl: tinyJpeg,
      word: "りんご",
      style: "storybook",
    });
    assert.equal(result, tinyWebp);
    assert.equal(form.get("size"), "816x816");
    assert.equal(form.get("quality"), "low");
    assert.equal(form.get("output_format"), "webp");
    assert.equal(form.get("output_compression"), "60");
    assert.match(form.get("prompt"), /Do not add captions/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
