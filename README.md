# Mathesis

Mathesis (Greek μάθησις, "learning") is an [opencode](https://opencode.ai) v2 plugin that teaches you a subject
at the edge of what you already understand, and then keeps it in your memory with spaced repetition.

1. **Probe** finds where your understanding of each prerequisite ends.
2. **Plan** writes a dependency map from what you hold to the goal.
3. **Teach** goes one reasoning step at a time: predict → teach → check.
4. **Practice** gives interleaved problems where you must recall the right idea yourself.
5. **Spaced review** schedules every idea you demonstrated with FSRS, and asks a newly written question each time.

All your data is plain Markdown in a folder (default `~/mathesis`).

> Status: early development. Not published yet.

## Requirements

- opencode 2.2.1 or later 2.x (the v2 plugin API)
- Bun, which opencode uses to load plugins

## Install (from a local checkout, for now)

```bash
git clone https://github.com/AlapinEnjoyer/mathesis
cd mathesis && bun install
```

Add the absolute path of the checkout to `plugins` in `~/.config/opencode/opencode.jsonc` and restart opencode:

```jsonc
{
  "plugins": [
    { "package": "/path/to/mathesis", "options": { "vault": "~/mathesis" } }
  ]
}
```

## Use

1. Run `/mathesis-setup` once. It writes the `mathesis` agent (`~/.config/opencode/agents/mathesis.md`) and the
   vault folders, and asks whether to use one model for everything.
2. Run `/learn <what you want to understand>`, or `/learn` alone to continue a topic. A new session opens: the probe
   finds where your understanding ends, then you confirm a plan, then the teaching goes one step at a time.
3. Questions appear as forms in the chat: your answer (or "I don't know"), your confidence, and your thinking.
   Every idea you demonstrate becomes a card in your vault.

Options (in the `plugins` entry): `vault` (default `~/mathesis`), `models` (`{ teach, recall, background }` as
`provider/model`), `notify` (default `true`), `reviewCap` (default 20), `claimTimeoutMs` (default 4000).

## The vault

```
~/mathesis/
  ideas/<id>.md         one idea = one card (frontmatter: requires, srs; sections: Claim, Why, …)
  topics/<id>.md        goal, probe assessment, plan, links to the ideas
  sessions/<date>-<topic>-<kind>.md   every question with your answer, confidence and thinking
  log/reviews.jsonl     every review, so the schedule can be rebuilt
```

Edit the notes in any editor; Mathesis keeps your edits and keys it does not know.

## License

AGPL-3.0. Mathesis adapts work from [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist.
See `NOTICE.md`.
