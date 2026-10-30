# Decisions

Decisions made while building Mathesis, with the reason. Newer entries at the bottom. The handoff (`docs/handoff.md`)
and the spike results (`docs/spike.md`) hold the earlier decisions.

## Phase 1 (core)

- **Practice updates the log only, not FSRS** (handoff §11). Practice problems are composition and transfer tasks:
  a miss often means the composition was hard, not that the idea was forgotten. Practice entries are logged with
  `mode: practice, scheduled: false`. Revisit after using it.
- **Each log entry says whether it changed the schedule** (`scheduled: true|false`; pulls always do). The rebuild
  replays only scheduled entries, so a failed check or a prediction about an idea can be logged without creating
  or moving a card.
- **The notes are the truth; the log is the history.** Tools read the `srs` in the note. A due date edited by hand
  takes effect immediately, and the rebuild agrees again after the next review. The rebuild is for recovery.
- **FSRS weights, retention 0.9 and maximum interval 36500 days are pinned** in `src/srs/fsrs.ts`, so a ts-fsrs
  upgrade cannot change how the log replays.
- **No fuzz, no short-term steps in FSRS.** Without fuzz, rebuilding from `log/reviews.jsonl` gives exactly the state
  in the notes. Without short-term steps the first passed check schedules the card in days, not in 10 minutes; the
  learner meets the idea again in the same session anyway.
- **A lapse pulls each direct foundation forward to "due now"** (never later than it already was). Its memory state
  (stability, difficulty) does not change, because it was not reviewed. This is logged as a `mode: pull` entry so
  that the rebuild reproduces it. Only direct `requires` are pulled, to avoid a cascade through the whole graph.
- **Dates in `srs` are full ISO timestamps.** A date written by hand (`due: 2026-11-04`) is accepted and read as
  midnight UTC. Hand-written review state without a positive stability starts over as a new card instead of
  producing NaN.
- **Updating an existing idea never removes what the learner wrote.** `requires` and `about` are merged; Claim and
  Why are only filled when empty (the tools pass `replace: true` to overwrite); "Known misconceptions" grows.
  The "Builds on:" line is rewritten only while it still has the exact form Mathesis writes; once the learner changes
  it, it is theirs. It links only ideas that have a note, so every link resolves; `requires` keeps all ids.
- **Note formats:** a byte-order mark and CRLF line endings are kept. `## ` headings inside fenced code are not
  sections. Level-1/2 headings in text the tools write are demoted to `###`, so they cannot split a note. When a
  heading occurs twice, the first one is used.
- **Locks are per process.** Two opencode processes writing the same note at the same moment can lose one update.
  This is rare (one learner) and accepted for now.
- **Dates for people are local** (`created`, session note names); FSRS timestamps are UTC ISO strings.
- **A relative `vault` option is resolved against the home directory**, so the vault does not move with the
  project opencode runs in.
- **Frontmatter is edited through a yaml Document**, so comments, key order and unknown keys survive. The `yaml`
  library writes flow collections in one compact style (`{a: 1, b: [x]}`), so spacing inside `{ }` written by hand can
  change when Mathesis updates the note. Values do not change.
- **Each note write is atomic** (temporary file + rename) and serialized per file inside the process, so parallel tool
  calls cannot lose updates.
- **Ids are slugs** (`^[a-z0-9]+(-[a-z0-9]+)*$`). Anything else is rejected before a path is built, so a model cannot
  write outside the vault.
- **Leading HTML comments in prompt fragments are stripped** before they go to the model. They hold the attribution
  header for adapted LearnHarness text, which stays in the source files.
- **Phase transitions:** probe → teach, and teach → probe (re-probe a topic). Review and practice sessions keep their
  phase. A session without a phase can enter any phase.
