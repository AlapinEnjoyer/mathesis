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

## Phase 2 (probe and teach)

- **Question path, as built and tested in the TUI (2026-10-30):** the tool commits the answer key, the broker emits
  `questionAsked`, the first TUI to `claim` creates the native form with the fixed id `frm_mathesis_<questionID>`,
  and the server watches `form.replied` / `form.cancelled` itself; a TUI also relays them (the first outcome wins).
  A restarted TUI calls `pending` and `form.get` to show or settle open questions. No claim within `claimTimeoutMs`
  (default 4 s) → `fallback: true`, then `mathesis_answer_record`.
- **The answer key is a nested `answerKey` object.** The TUI's tool-call line shows only scalar inputs (`question`,
  `type`, `nodeId`), so the committed answer stays hidden while the form is open (checked in the TUI).
- **Only a passed check creates a card**, and only through the answer record that the question tool stored in the
  session: `idea_upsert` needs the `questionID` of a `check` that was answered correctly (multiple choice) or graded
  correct/partial by the agent (free recall). One answer can be used once.
- **Free-recall grading stays with the conversation model** (handoff §2c): the tool returns the learner's words next
  to the committed answer, and the agent passes its verdict to the tool that records the outcome.
- **`/learn`, `/mathesis-setup` are TUI commands** that call RPC `start` / `setup`; the server creates the session
  with the model (validated against the model list), the `mathesis` agent when it exists, and per-session permissions
  (edit only the vault, no shell).
- **`topic_start` never creates a second topic in a session that has one**, unless `topic` is passed explicitly
  (found in the TUI test: the agent restated the goal in other words).
- **`/mathesis-setup` rewrites the agent file only while it still has the `<!-- mathesis-agent v… -->` marker.**
  Remove the marker to keep your own edits.
- **Misconception cards** have `kind: misconception`, `about: [ids]`, the right model as Claim and the wrong model
  under "Known misconceptions"; the ideas they corrupt link to them. Recording one again rates it Again.

### Phase 2 review fixes

- **A question cannot lock a session.** If the broker no longer knows the open question (server restart), the next
  tool call turns it into a fallback question instead of refusing. Unloading the plugin aborts open questions.
- **Claim, then show, in time.** After a claim the TUI must report `shown` within 15 s; a TUI that dies or cannot
  create the form makes the question fall back instead of hanging. A failed form creation hands the question back.
- **State changes that check something are atomic** (`mutateSession` under the session lock): one open question per
  session, one use per answer (released again if the card write fails), one misconception card per answer and id.
- **`idea_upsert` can only prove the check's own node or a new idea**; it refuses misconception cards and cards of
  another topic. `misconception_record` with a `questionID` needs a real answer that was not right.
- **`answer_record` needs a reply from the learner** after the fallback: a chat message (session `prompt` hook) or an
  answer to the built-in `question` tool (tool `execute.after` hook). Fallback answers are marked in the session note.
- **Mathesis tools are hidden in sessions that are not Mathesis sessions** (another agent and no Mathesis state).
  This depends only on the session, so the tool list stays constant within it.
- **Mathesis sessions and the agent deny all file edits and shell commands.** The Mathesis tools write the vault
  themselves; reading the learner's files stays allowed.
- **TUI calls go to the location of the event**, and the TUI subscribes again after `server.connected`.
- **Not verified yet:** whether the TUI sends its own selected model with the learner's next message in a session
  that Mathesis created with another model (that would switch the model mid-session).

## Phase 3 (spaced review)

- **Review is bound to the served card.** `review_next` sets the session's current card; review questions and
  `review_grade` must be about it, so the model cannot grade another card, an undue card, or one card twice.
- **Grading is atomic per card** (`Vault.updateSrs` under the note's lock). The answer is released only if nothing
  was written; once the card is rescheduled the review counts even if a later write fails.
- **"Due" for people means due today** (before the end of the learner's local day): `/recall`, the footer, the panel
  and `review_next` use it, so a card due at 20:00 comes up in the morning. FSRS and the rebuild use exact times.
- **A lapse** is an Again on a card that had been reviewed before. It is logged with `lapse: true` (status counts only
  these). Its direct foundations become due now, unless they were reviewed today; for a misconception card the ideas
  it corrupts (`about`) are pulled instead of `requires`.
- **A dismissed review question skips the card for the session** without changing its schedule; its wording counts as
  asked before.
- **A misconception recorded without a session topic** takes the topic of the idea it corrupts.

## Phase 4 (practice)

- **A practice problem is a series of attempts**, each a form. "I don't know" or a wrong attempt is a request for a
  hint, not a logged miss; the agent records the concluded problem once with `practice_record` (last attempt, highest
  hint rung `none`/`R0`–`R5`, miss type). The log keeps `hints` and `miss`; ratings use the §5.3 table but are not
  scheduled.
- **Targets rank by current weakness** (time since the last review over stability), misconceptions first while not
  stable, most-served foundations on ties, and cards practised in the last day at the back, so each session differs.
  `practice_targets` shows the full card content, this session's outcomes per target and what to retest.
- **The practice cap is `reviewCap`** (default 20 problems). After a problem the agent continues in the same turn; the
  learner pauses by dismissing a form.
- **The practice phase uses the four modes as question types** (`recall`, `discrimination`, `reverse`,
  `composition`); misconception targets use `discrimination`.

## After the first real use

- **`type` is accepted at the top level or inside `answerKey`.** Models put it inside `answerKey`; the schema no
  longer requires it at the top level (the host rejected those calls before Mathesis saw them), and the tool refuses a
  call without either.
- **The fallback text does not guess a cause.** It says the form could not be shown and tells the agent not to give
  the learner a reason.
- **Ids are cut at a word end**, and **topic ids from a goal keep only the content words** (`topicSlug`). Ids are
  computed once, at creation, so existing notes are not affected.

## Question deadlines (to-do 1)

- **A shown form has no deadline.** `shown` clears the timer instead of re-arming it for ~24.8 days.
- **A plugin reload says so.** `abortAll` (plugin unload) ends questions with cause `unload`; the tool tells the agent
  the form still works and to ask again. In the reload spike (`docs/spike.md`) the generic "interrupted" text made the
  agent give up on forms after three reloads.
- **A fallback is announced.** The tool sets its progress to "the form could not be shown; asking in the chat", and the
  agent tells the learner in one sentence before asking another way.
- **No TUI presence (hello / heartbeat) and no `ready` event.** The missed claim after a reload did not reproduce in
  five attempts; the claim always arrived within 2 ms. The 4 s claim deadline stays. Revisit if a missed claim happens
  again, with the spike's debug logging.

## Voice (to-dos 2 and 3)

- **Mathesis has its own small voice path; it does not use opencode's.** opencode 2.2.1's voice API
  (`experimental.voice`) brokers realtime speech-to-speech sessions with OpenAI, xAI or Google and needs a stored API
  key. Clients with a microphone (Desktop, web) stream audio to it; the TUI and plugins can't use it, and it has no
  local models, no plain transcription and no TTS.
- **It runs in the TUI process**, where the microphone and speakers are. Audio never reaches the opencode server.
  Engines are a local command (whisper.cpp, `say`, piper) or any OpenAI-compatible endpoint (local or cloud, with the
  key read from a named environment variable). Everything is off until `voice.stt` or `voice.tts` is set.
- **Dictated text is attached on the side** (the learner's choice). The native form can't be changed after it's
  created, so the TUI sends the transcript to the server (`dictation`), and the broker adds it to the typed thinking
  as `Spoken: …` when the form is answered, including "I don't know". Text for a closed question is refused.
- **Read-aloud covers the open question only** (title and choices, not "I don't know"). Teaching steps can follow.
- **Keys:** `<leader>v` dictate and `<leader>o` read aloud, both free in opencode 2.2.1. They're bound only when the
  feature is configured, sit in their own high-priority layer, and work while a form is focused.
- **TUI options come from `cli.json`**, not `opencode.jsonc` (found while testing: `voice` was empty in the TUI). This
  also applies to `notify` and `panelKey`; the README now says so.
