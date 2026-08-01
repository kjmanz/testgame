/**
 * 参加者投票のUI。票の内容は端末内の下書きだけに置き、
 * サーバーからは投票済み人数と最終結果だけを受け取る。
 */

function currentGameCandidates(state, gallery, category) {
  const categoryIds = new Set(
    Array.isArray(category?.candidateIds) ? category.candidateIds : []
  );
  return gallery.filter((item) => {
    if (item.gameSeq !== state.gameSeq || !item.hasDrawing) return false;
    return categoryIds.size === 0 || categoryIds.has(item.id);
  });
}

function voteProgress(state) {
  const eligible = Math.max(0, state.eligibleCount || 0);
  const voted = Math.min(eligible, Math.max(0, state.votedCount || 0));
  return {
    eligible,
    voted,
    percent: eligible > 0 ? (voted / eligible) * 100 : 0,
  };
}

export function CommunityVoteOverlay({
  state,
  gallery,
  votes,
  setVotes,
  step,
  setStep,
  editing,
  setEditing,
  remainSec,
  submitting,
  error,
  isHost,
  onSubmit,
  onFinalize,
  onClose,
}) {
  const categories = state.categories || [];
  const progress = voteProgress(state);
  const showBallot = state.canVote && (!state.hasVoted || editing);
  const safeStep = Math.min(Math.max(0, step), Math.max(0, categories.length - 1));
  const category = categories[safeStep];
  const candidates = currentGameCandidates(state, gallery, category);
  const selectedId = category ? votes[category.id] : "";

  if (state.status !== "voting") return null;

  if (!showBallot) {
    return (
      <div
        className="community-vote-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-wait-title"
      >
        <div className="community-vote-wait-card">
          <button
            type="button"
            className="community-overlay-close"
            onClick={onClose}
            aria-label="投票画面を閉じる"
          >
            × とじる
          </button>
          <div className="community-ballot-box" aria-hidden="true">🗳️</div>
          <div className="community-vote-eyebrow">みんなの投票</div>
          <h2 id="community-wait-title">
            {state.hasVoted ? "投票ありがとう！" : "ただいま投票中！"}
          </h2>
          <p>
            結果はまだ秘密。全員そろったら、1つずつ発表します。
          </p>
          {error && (
            <p className="community-vote-error" role="alert">
              {error}
            </p>
          )}
          <div className="community-voter-count" aria-live="polite">
            <strong>{progress.voted}</strong>
            <span> / {progress.eligible}人 投票ずみ</span>
          </div>
          <div className="community-vote-track" aria-hidden="true">
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          {remainSec !== null && (
            <div className="community-vote-remain">
              ⏳ あと {remainSec}秒で自動集計
            </div>
          )}

          <div className="community-wait-actions">
            {state.hasVoted && state.canVote && (
              <button
                type="button"
                className="community-edit-vote"
                onClick={() => {
                  setStep(0);
                  setEditing(true);
                }}
              >
                投票を変更する
              </button>
            )}
            {isHost && progress.voted > 0 && progress.voted < progress.eligible && (
              <button
                type="button"
                className="community-finalize-now"
                onClick={onFinalize}
              >
                ここで締め切って発表
              </button>
            )}
            <button type="button" className="quiet" onClick={onClose}>
              終了画面で待つ
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="community-vote-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="community-vote-title"
    >
      <div className="community-vote-shell">
        <header className="community-vote-header">
          <button
            type="button"
            className="community-overlay-close"
            onClick={onClose}
            aria-label="投票画面を閉じる"
          >
            × とじる
          </button>
          <div className="community-vote-eyebrow">みんなで決める3大賞</div>
          <div className="community-category-progress" aria-hidden="true">
            {categories.map((item, index) => (
              <span
                key={item.id}
                className={`${index < safeStep ? "is-done" : ""}${
                  index === safeStep ? " is-current" : ""
                }`}
              />
            ))}
          </div>
          {category && (
            <>
              <div className="community-category-count">
                {safeStep + 1} / {categories.length}
              </div>
              <h2 id="community-vote-title">
                <span aria-hidden="true">{category.emoji || "🏆"}</span>{" "}
                {category.prompt || `${category.title}といえば？`}
              </h2>
              <p>いちばんピンときた絵を1つ選んでね</p>
            </>
          )}
        </header>

        {error && (
          <p className="community-vote-error community-vote-error-inline" role="alert">
            {error}
          </p>
        )}

        <div className="community-candidate-grid">
          {candidates.map((item) => {
            const selected = selectedId === item.id;
            return (
              <button
                type="button"
                className={`community-vote-card${selected ? " is-selected" : ""}`}
                key={item.id}
                onClick={() =>
                  setVotes((current) => ({
                    ...current,
                    [category.id]: item.id,
                  }))
                }
                aria-pressed={selected}
              >
                <span className="community-vote-image">
                  <img
                    src={item.imageDataUrl}
                    alt={item.word || "投票候補の絵"}
                    decoding="async"
                  />
                  {selected && (
                    <span className="community-selected-mark" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </span>
                <span className="community-vote-word">
                  「{item.word || "？？？"}」
                </span>
              </button>
            );
          })}
        </div>

        <footer className="community-vote-footer">
          <button
            type="button"
            className="community-vote-back"
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            disabled={safeStep === 0 || submitting}
          >
            ← もどる
          </button>
          {safeStep < categories.length - 1 ? (
            <button
              type="button"
              className="community-vote-next"
              onClick={() => setStep((current) => current + 1)}
              disabled={!selectedId || submitting}
            >
              この絵に決定 →
            </button>
          ) : (
            <button
              type="button"
              className="community-vote-submit"
              onClick={onSubmit}
              disabled={!selectedId || submitting}
            >
              {submitting ? "投票中…" : "🗳️ 3つの票を投じる！"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function winnerItemsFor(award, gallery) {
  const ids = new Set(award?.winnerIds || []);
  return gallery.filter((item) => ids.has(item.id));
}

export function CommunityAwardCeremony({
  ceremony,
  state,
  gallery,
  onClose,
}) {
  const awards = state.results?.awards || [];
  if (!ceremony || awards.length === 0) return null;

  const phase = ceremony.phase;
  const index = Math.min(ceremony.index, awards.length - 1);
  const award = awards[index];
  const winners = winnerItemsFor(award, gallery);
  const announcedCount =
    phase === "finale" ? awards.length : phase === "reveal" ? index + 1 : index;

  return (
    <div
      className={`award-show community-award-show community-award-${phase}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="community-award-title"
    >
      <div className="award-show-shell community-award-shell">
        <button
          type="button"
          className="award-show-close"
          onClick={onClose}
          aria-label="みんなの授賞式を閉じる"
        >
          × とじる
        </button>
        <div className="award-show-progress" aria-hidden="true">
          {awards.map((item, dotIndex) => (
            <span
              key={item.categoryId}
              className={`${dotIndex < announcedCount ? "is-done" : ""}${
                phase !== "opening" &&
                phase !== "finale" &&
                dotIndex === index
                  ? " is-current"
                  : ""
              }`}
            />
          ))}
        </div>

        <div className="award-show-live" aria-live="polite">
          {phase === "opening" && (
            <div className="award-opening community-award-opening">
              <div className="award-show-eyebrow">みんなの投票で決定！</div>
              <div className="community-opening-icons" aria-hidden="true">
                🗳️ 🏆
              </div>
              <h2 id="community-award-title">会場投票 授賞式</h2>
              <p>
                {state.votedCount || state.results?.voterCount || 0}人の票が
                集まりました。いよいよ発表です！
              </p>
            </div>
          )}

          {phase === "drumroll" && (
            <div className="award-drumroll" key={`community-drum-${index}`}>
              <div className="award-step-label">
                {index + 1}つ目の賞 ／ 全{awards.length}賞
              </div>
              <div className="award-drum-trophy" aria-hidden="true">🗳️</div>
              <h2 id="community-award-title">
                {award.emoji || "🏆"} {award.title}
              </h2>
              <div className="award-drum-dots" aria-hidden="true">
                {Array.from({ length: 9 }, (_, dotIndex) => (
                  <span key={dotIndex} />
                ))}
              </div>
              <p>票を数えています…結果はまだ秘密！</p>
            </div>
          )}

          {phase === "reveal" && award && (
            <div
              className="community-award-reveal"
              key={`${award.categoryId}-${index}`}
            >
              <div className="award-confetti" aria-hidden="true">
                <span>◆</span><span>●</span><span>▲</span><span>★</span>
                <span>●</span><span>◆</span><span>★</span><span>▲</span>
              </div>
              <div className="award-step-label">
                {index + 1}つ目の賞 ／ 全{awards.length}賞
              </div>
              <h2 id="community-award-title">
                {award.emoji || "🏆"} {award.title}
              </h2>
              {award.winnerIds?.length > 1 && (
                <div className="community-tie-ribbon">
                  同票！{award.winnerIds.length}作品が同時受賞
                </div>
              )}
              <div
                className={`community-winner-strip${
                  winners.length === 1 ? " is-single" : ""
                }`}
              >
                {winners.map((item) => (
                  <article className="community-winner-card" key={item.id}>
                    <div className="community-winner-frame">
                      <img
                        src={item.imageDataUrl}
                        alt={item.word || "受賞作品"}
                        decoding="async"
                      />
                    </div>
                    <strong>「{item.word || "？？？"}」</strong>
                    {(item.drawerNames || []).length > 0 && (
                      <span>{item.drawerNames.join("・")}</span>
                    )}
                  </article>
                ))}
                {winners.length === 0 && (
                  <div className="community-winner-missing">
                    受賞作品はギャラリーから移動しました
                  </div>
                )}
              </div>
              <div className="community-vote-result">
                <strong>{award.voteCount || 0}票</strong>
                <span>／ 全{award.totalVotes || 0}票</span>
              </div>
              <p className="community-result-comment">{award.comment}</p>
              <div className="award-auto-progress community-auto-progress" aria-hidden="true">
                <span />
              </div>
            </div>
          )}

          {phase === "finale" && (
            <div className="award-finale community-award-finale">
              <div className="award-finale-icons" aria-hidden="true">
                🎉 🗳️ 🏆 🎉
              </div>
              <h2 id="community-award-title">みんなの3大賞、決定！</h2>
              <p>投票した人も、受賞した絵も、みんなに大きな拍手！</p>
              <button
                type="button"
                className="award-finale-button community-finale-button"
                onClick={onClose}
              >
                受賞作を一覧で見る
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function CommunityAwardsSummary({ state, gallery }) {
  const awards = state.results?.awards || [];
  if (awards.length === 0) return null;

  return (
    <ol className="community-award-summary-list">
      {awards.map((award) => {
        const winners = winnerItemsFor(award, gallery);
        return (
          <li key={award.categoryId} className="community-award-summary-item">
            <div className="community-summary-images" aria-hidden="true">
              {winners.slice(0, 3).map((item) => (
                <img src={item.imageDataUrl} alt="" key={item.id} loading="lazy" />
              ))}
            </div>
            <div>
              <strong>{award.emoji || "🏆"} {award.title}</strong>
              <span>
                {winners.map((item) => `「${item.word || "？？？"}」`).join("・")}
                {award.winnerIds?.length > 1 ? "（同票）" : ""}
              </span>
              <p>{award.comment}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
