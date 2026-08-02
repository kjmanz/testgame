process.env.FORCE_ROUND_TYPE = "normal";
process.env.FORCE_CONSTRAINT = "none";
process.env.FORCE_AI_SECRET_GUESS = "1";

await import("./index.js");
