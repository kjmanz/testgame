// 通信上の識別子は互換性のため gradual のまま。
process.env.FORCE_ROUND_TYPE = "gradual";
await import("./index.js");
