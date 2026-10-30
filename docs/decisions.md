# Decisions

Decisions made while building Mathesis, with the reason. Newer entries at the bottom. The handoff (`docs/handoff.md`)
and the spike results (`docs/spike.md`) hold the earlier decisions.

## Phase 1 (core)

- **Practice updates the log only, not FSRS** (handoff §11). Practice problems are composition and transfer tasks:
  a miss often means the composition was hard, not that the idea was forgotten. Practice entries are logged with
  `mode: practice` and are skipped when the schedule is rebuilt. Revisit after using it.
- **No fuzz, no short-term steps in FSRS.** Without fuzz, rebuilding from `log/reviews.jsonl` gives exactly the state
  in the notes. Without short-term steps the first passed check schedules the card in days, not in 10 minutes; the
  learner meets the idea again in the same session anyway.
- **A lapse pulls each direct foundation forward to "due now"** (never later than it already was). Its memory state
  (stability, difficulty) does not change, because it was not reviewed. This is logged as a `mode: pull` entry so
  that the rebuild reproduces it. Only direct `requires` are pulled, to avoid a cascade through the whole graph.
- **Dates in `srs` are full ISO timestamps.** A date written by hand (`due: 2026-11-04`) is accepted and read as
  midnight UTC. Hand-written review state without a positive stability starts over as a new card instead of
  producing NaN.
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
