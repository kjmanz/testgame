// 毎ラウンド、ふつうのラウンド＋しばりで始める（しばりのIDを指定してもよい）
// 例: FORCE_CONSTRAINT=blind npm run dev:constraint
process.env.FORCE_ROUND_TYPE = "normal";
process.env.FORCE_CONSTRAINT = process.env.FORCE_CONSTRAINT || "random";
await import("./index.js");
