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

## License

AGPL-3.0. Mathesis adapts work from [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist.
See `NOTICE.md`.
