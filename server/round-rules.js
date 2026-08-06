/**
 * お題を見せてよいかを返す。
 * のぞき穴・パーツラウンドは答え発表までは対象者だけ、発表後は全員に見せる。
 */
export function canPlayerSeeWord(room, playerId) {
  if (room.phase !== "playing" || !room.word) return false;
  if (room.roundType === "normal" || room.roundType === "gradual") {
    if (room.drawPhase === "reveal") return true;
    return room.drawerId === playerId;
  }
  if (room.roundType === "coop") {
    return room.drawerIds.includes(playerId);
  }
  if (room.roundType === "liar") {
    if (room.drawPhase === "reveal") return true;
    return room.seenWordIds.has(playerId);
  }
  if (room.roundType === "parts") {
    if (room.drawPhase === "reveal") return true;
    return room.seenWordIds.has(playerId);
  }
  // relay: すでに描いた人、または現在描いている人
  return room.seenWordIds.has(playerId);
}

/** 現在のラウンドを確定して次へ進められるかを返す。 */
export function canPlayerNextRound(room, playerId) {
  if (room.phase !== "playing") return false;
  if (room.roundType === "normal" || room.roundType === "gradual") {
    if (room.drawPhase !== "reveal") return false;
    return room.drawerId === playerId;
  }
  if (room.roundType === "relay") {
    if (room.drawPhase !== "guessing") return false;
    return room.seenWordIds.has(playerId);
  }
  if (room.roundType === "coop") {
    if (room.drawPhase !== "guessing") return false;
    return room.drawerIds.includes(playerId);
  }
  if (room.roundType === "liar") {
    if (room.drawPhase !== "reveal") return false;
    return room.drawerIds.includes(playerId) || room.hostId === playerId;
  }
  if (room.roundType === "parts") {
    if (room.drawPhase !== "reveal") return false;
    return room.hostId === playerId;
  }
  return false;
}

/** ふつう・のぞき穴ラウンドで答えを発表できるかを返す。 */
export function canRevealAnswer(room, playerId) {
  if (
    room.phase !== "playing" ||
    (room.roundType !== "normal" && room.roundType !== "gradual")
  ) {
    return false;
  }
  if (room.drawPhase === "reveal") return false;
  return room.drawerId === playerId;
}
