# Mathesis

Mathesis (Greek μάθησις, "learning") is an [opencode](https://opencode.ai) v2 plugin that teaches you a subject at the
edge of what you already understand, and then keeps it in your memory with spaced repetition.

1. **Probe** finds where your understanding of each prerequisite ends: something you reliably get right (a floor) and
   something you get wrong or don't know (a ceiling), from your answers, your confidence and your reasoning.
2. **Plan** writes a dependency map from what you already hold to your goal.
3. **Teach** goes one reasoning step at a time: predict → teach → check. A gap is repaired before anything is built on it.
4. **Spaced review** schedules every idea you demonstrated with [FSRS](https://github.com/open-spaced-repetition/ts-fsrs),
   and asks a newly written question each time.
5. **Practice** gives interleaved problems where you must bring the right idea to mind yourself.

Everything you learn is plain Markdown in a folder (default `~/mathesis`) that you can read and edit in any editor.

> **Disclaimer: this is a heavily AI-assisted port.** Mathesis ports the learning method of
> [LearnHarness](https://github.com/amosblomqvist/learnharness) to opencode and adds spaced repetition. The design and
> the decisions are the maintainer's, but most of the code, prompts, tests and documents were written by an AI model
> (Claude, in Claude Code), reviewed by separate AI review agents and checked by hand in the opencode TUI. It is early
> software: expect rough edges, read `docs/history.md` for what was and was not verified, and please report problems.

## Requirements

- opencode 2.2.1 or a later 2.x release (the v2 plugin API), with the terminal UI.
- Bun, which opencode uses to load plugins.

## Install

Add the package to `plugins` in `~/.config/opencode/opencode.jsonc` and restart opencode:

```jsonc
{
  "plugins": ["opencode-mathesis"]
}
```

With options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-mathesis",
      "options": {
        "vault": "~/mathesis",
        "models": { "teach": "anthropic/claude-opus-5-5", "recall": "anthropic/claude-sonnet-5-5" },
        "notify": true,
        "reviewCap": 20,
        "panelKey": "ctrl+x m"
      }
    }
  ]
}
```

From a checkout: `git clone https://github.com/AlapinEnjoyer/mathesis && cd mathesis && bun install`, then put the
absolute path of the checkout in `plugins`.

## Use

| Command | What it does |
|---|---|
| `/mathesis-setup` | Run once. Writes the `mathesis` agent (`~/.config/opencode/agents/mathesis.md`) and the vault folders, and asks whether to use one model for everything. |
| `/learn <goal>` | Starts a new session, `Mathesis: <goal>`, in the probe phase. `/learn` alone lets you continue a topic. |
| `/recall [topic]` | Spaced review of the cards due today, interleaved across topics (at most 20 per session). |
| `/practice [topic]` | Interleaved practice problems built from the cards you hold, weakest first. |
| `/mathesis` | Status: cards due per topic, recent lapses, misconceptions. |
| `/mathesis panel`, `/mathesis-panel` | Toggles the side panel: the plan with the current node, and the cards due today. |

You don't need the commands every time: switch to the `mathesis` agent and say what you want to learn.

Questions appear as forms in the chat. You give your answer (or "I don't know"), your confidence, and optionally your
thinking. Every idea you demonstrate in a check becomes a card in your vault. The footer shows how many cards are due,
and once a day you get a notification when cards are due and the terminal is in the background (`notify: false` turns
it off).

### Models

By default Mathesis uses the model of the session for everything. `/mathesis-setup` (or the `models` option) can choose
separate models for teaching and for review. A model is only chosen when a session is created and never switched
inside it, so the provider's prompt cache stays warm.

## The vault

```
~/mathesis/
  ideas/<id>.md                        one idea = one card
  topics/<id>.md                       goal, probe assessment, plan, links to the ideas
  sessions/<date>-<topic>-<kind>.md    every question with your answer, confidence and thinking
  log/reviews.jsonl                    every review, so the schedule can be rebuilt
```

An idea note:

```markdown
---
id: chain-rule-intuition
topic: calculus
kind: proposition
requires: [derivative-as-local-slope]
created: 2026-10-30
srs: {state: review, due: 2026-11-04T09:12:00.000Z, stability: 6.2, difficulty: 5.1, reps: 3, lapses: 0, ...}
---

## Claim
...

## Why
...

Builds on: [derivative as local slope](./derivative-as-local-slope.md)

## Known misconceptions

## Asked before
- earlier question stems, so new reviews use new wording
```

Edit notes freely: Mathesis re-reads them every time, keeps keys and sections it does not know, and never overwrites
the Claim or Why you wrote. Setting a card's `due` to a past date makes it due.

## Privacy and permissions

Mathesis sessions may read files (for example your own notes), but they cannot edit files or run shell commands:
Mathesis writes the vault through its own tools. Nothing leaves your machine except the conversation with the model
provider you use in opencode.

## Development

`bun install`, `bun test`, `bun run typecheck`. See `AGENTS.md` for how to test in the TUI, `docs/decisions.md` for the
design decisions, `docs/spike.md` for what the opencode API does in practice, and `docs/history.md` for how Mathesis
was built and what is still open.

Use a separate checkout for daily use: opencode loads the plugin from the folder, and a half-finished change there can
make it fail to load until `opencode service restart`.

## License

AGPL-3.0. Mathesis adapts prompt text and ideas from [LearnHarness](https://github.com/amosblomqvist/learnharness) by
Amos Blomqvist. See `NOTICE.md`.
