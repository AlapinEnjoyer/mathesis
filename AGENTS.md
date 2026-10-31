# Mathesis: notes for agents

Mathesis is an opencode v2 plugin (server part + TUI part + RPC contract). The spec is `docs/handoff.md`.
Phase-0 findings about the real opencode API are in `docs/spike.md`; they win over the handoff when they disagree.

## Toolchain
- Bun 1.3.14 (pinned in `mise.toml`). Run `mise install` if `bun` is missing.
- `bun install`, `bun test`, `bun run typecheck`.
- Types come from `@opencode/plugin` (pinned to the opencode version we target). The host provides
  `@opencode/plugin` and `effect` at runtime, so check `node_modules/@opencode/plugin/dist` for the real API
  before you use a method.

## Load locally
The TUI part loads from `dist/tui.js` (built from `src/tui.tsx` by `bun run build`; `bun install` runs it too). After
editing TUI code, run `bun run build` and restart opencode. The server part loads `src/server.ts` directly.
Add the absolute repo path to `plugins` in `~/.config/opencode/opencode.jsonc`, then restart opencode. Set `MATHESIS_VAULT` to use a throwaway vault while testing.
TUI options (`notify`, `panelKey`, `voice`) are read from `cli.json` (`plugins: [{ package, options }]`), not from
`opencode.jsonc`.

## Test in opencode
- Run `opencode --standalone` from the repo (a private server, so the user's background service is not touched),
  for example in a detached tmux session driven with `send-keys` and `capture-pane`.
- Token usage per step (prompt-cache checks): `opencode api --standalone GET /api/session/<id>/message`.
- Free test models are listed by `opencode models`.

## Conventions
- TypeScript source is shipped as is (no build step). Import local files with the `.ts` extension.
- Learner data is plain Markdown in the vault. Re-read files on every use; keep unknown frontmatter keys and
  user-written body text when you write.
- Prompt cache rules (handoff §2c): the system prompt changes only on a phase change; the tool list is constant for a
  session; dynamic data goes through tool results. Never switch models in a session.
- Files adapted from LearnHarness start with `Adapted from LearnHarness (AGPL-3.0), <path>, <date>; modified`.
- Refer to the learner as "the learner" (they/them).
