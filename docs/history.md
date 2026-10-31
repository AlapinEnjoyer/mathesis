# How Mathesis was built

This is a record of how Mathesis was built and how far it got: what was done, how it was checked, and what is still
open. It was written at the end of the first build (2026-10-30 to 2026-10-31).

Mathesis was built with heavy AI assistance (see the README disclaimer). The maintainer wrote the design brief
(`docs/handoff.md`), made the decisions and approved each outward step. Claude (Anthropic's model, in Claude Code)
wrote most of the code, prompts, tests and documents. A separate AI review agent reviewed each phase, and the results
were checked by hand in the real opencode TUI.

## Starting point

- **Goal:** recreate the learning loop of [LearnHarness](https://github.com/amosblomqvist/learnharness) (probe → plan →
  teach → practice) as an opencode v2 plugin, and add real spaced repetition (FSRS), with all learner data as plain
  Markdown.
- **Spec:** `docs/handoff.md`, written before the build. It fixed the name, the AGPL-3.0 license, the storage format,
  the four modes, the answer format (answer + confidence + thinking + "I don't know") and the prompt-cache rules.
- **Environment:** opencode 2.2.1 (TUI), `@opencode/plugin` 2.2.1, Bun 1.3.14, test model
  `github-copilot/gpt-6-luna`.

## Phases

| Phase | What | Merged | Tag |
|---|---|---|---|
| 0 | Repository, scaffold, API spike | PR #1 | (spike commit tagged `spike-phase-0`) |
| 1 | Core without LLM: vault, review log, FSRS, session state, prompt loading | PR #2 | `v0.1.0` |
| 2 | Probe and teach: question forms, tools, prompts, `/learn`, `/mathesis-setup` | PR #3 | `v0.2.0` |
| 3 | Spaced review: `/recall`, `/mathesis` | PR #4 | |
| 4 | Practice: `/practice` | PR #4 | |
| 5 | TUI: due count, side panel, daily notification | PR #4 | `v0.5.0` |
| 6 | README, version 0.5.0, this history | branch `phase-6-publish` | |
| after use | Live fixes, question deadlines, voice, note links, UX, diagrams, npm packaging | PRs #6–#11 | `v0.6.0` |

Every phase went the same way: build on a branch, test (`bun test`, `tsc`), a review by a separate review agent,
fixes in an "Apply phase N review fixes" commit, then merge. Phases 3–5 were merged together in one PR, each with its
own commits, to avoid repeated rebases.

### Phase 0: the API spike

The handoff's API notes came from the docs, so phase 0 tested them against the real opencode with throwaway code
(`docs/spike.md`, raw evidence in `docs/spike/`). Main findings:

- A plugin cannot add an agent, so `/mathesis-setup` writes an agent file.
- A tool can wait for an answer that the TUI sends through RPC, and the TUI can open UI while the agent is mid-turn.
- **Native session forms** (created by the TUI) are the best way to ask a question: inline in the chat, with tabs, a
  summary before submit, and fields that appear only when needed. This became the question path.
- A model can be set when a session is created; a background model works for separate calls.
- Prompt cache (measured): a phase change costs one uncached request; an instruction entry does not break the cache.

### Phase 1: the core

Markdown notes with YAML frontmatter that keep the learner's edits and unknown keys, atomic writes, an append-only
review log that can rebuild the schedule, the FSRS wrapper with the rating table from the handoff, session state and
the prompt loader. The review found two data-loss bugs (headings inside code blocks, a byte-order mark or empty
frontmatter) and ten more problems; all were fixed and covered by tests.

### Phase 2: probe and teach

Prompts adapted from LearnHarness (attribution in every adapted file and in `NOTICE.md`; the learner is "they"), the
question broker (claim → create form → shown), the topic, question and teaching tools, and the TUI commands. The
review found, among others, that a server restart could lock a session forever, that one answer could create two cards,
and that the model could record an answer for the learner. All were fixed.

### Phases 3–5

Spaced review bound to the card the scheduler serves, lapses that make foundations due, practice as problems with a
hint ladder, and the TUI panel and due count. The reviews found, among others, that the model could grade any card
early, that practice counted hint requests as misses, and that the panel stopped updating after a server restart.
All were fixed.

## How it was checked

- **Tests:** 145 bun tests at the end, covering the rating table, scheduling with a fake clock, rebuilding from the
  log, vault round trips, the question broker, and every tool's flow with a fake TUI, including the cases the
  reviews reproduced.
- **Reviews:** one review agent per phase, each reading the diff against the spec and reproducing what it claimed
  with scripts. Together they reported about 90 findings; the high and medium ones were fixed, the rest fixed or
  recorded in `docs/decisions.md`.
- **Live in the TUI** (opencode `--standalone` with a test vault, driven through tmux):
  `/mathesis-setup`; `/learn` with probe questions as forms (multiple choice and free recall), `probe_done`, the plan,
  plan confirmation, predict and check, the first card with its FSRS state and log line; a question still waiting
  after 20 s (the "shown" handshake); `/recall` with a newly worded question, graded and rescheduled; `/practice`
  logged without changing the schedule; the footer count, `/mathesis` and the side panel.

## What does not work yet, or is not known

- **Not published.** `opencode-mathesis` is not on npm, and it is not in the opencode ecosystem list. Install it from
  a checkout for now.
- **Not verified:** whether the TUI sends its own selected model with the learner's next message in a session that
  Mathesis created with another model (that would switch models in the middle of a session); prompt-cache behaviour
  with providers that use explicit cache breakpoints (Anthropic).
- **Known limits:** two opencode processes writing the same note at the same moment can lose one update (locks are per
  process); answer quality depends on the model, for example a model may give a correction directly where the practice
  doctrine asks for a hint first.
- **Demo GIF:** recording a live session with `vhs` is not reliable yet, because the model decides the kind of the
  first question.

## A lesson from the build

opencode loaded the plugin straight from the folder that was being changed. Once, it started while a rebase was half
done, kept that broken state in its module cache, and reported "Plugin failed to load" until `opencode service
restart`. Use a separate checkout for daily use, and develop in another one.
