# Phase 0 spike results

Date: 2026-10-30. opencode `2.2.1` (TUI, `--standalone` private server), `@opencode/plugin@2.2.1`,
model `github-copilot/gpt-6-luna`. Spike code: `src/spike/` in the commit "Add phase 0 spike" (removed afterwards).
These results win over `docs/handoff.md` when they disagree.

## Summary

| Question | Result |
|---|---|
| (a) Tool executor awaits an RPC `answer()` from the TUI | **Yes.** The executor waited ~30 s on a promise; the TUI called `rpc.answer`; the tool returned the answer. |
| (b) Plugin registers an agent | **No.** `AgentEditor` has only `list/get/default/update/remove`. Keep the agent file written by `/mathesis-setup`. |
| (c) `context` hook prompt injection / tool removal per session | **Yes.** `event.system.push(...)` and `delete event.tools[...]` apply per request; we key on `event.sessionID`. |
| (d) Server tool creates a session form | **Not directly** (server `ctx.session` has no `form`), **but the TUI can**: `context.client.session.form.create(...)`. The native form works well (see below). |
| (e) TUI opens UI from a server event while the agent is mid-turn | **Yes.** RPC event `questionAsked` → TUI handler ran within 2 ms, while the tool call was running. Both custom dialogs and native forms work. |
| (f) Model at session creation; background model | **Yes.** `session.create({ title, agent, model, location })` sets agent and model (server and TUI client). `ctx.experimental.generate.text({ prompt, model })` works with a second model. **Note:** `session.create` does **not** validate the model; an unknown model is stored as is. Validate against `ctx.model.list()` first. |
| (g) Prefix cache stays stable | **Yes, with the planned rules.** See the table below. |
| TUI slash command creates and opens a new session | **Yes.** `keymap.layer({ commands: [{ slash: { name, arguments: true }, run }] })` + `client.session.create` + `ui.router.navigate({ type: "session", sessionID })` + `client.session.prompt`. |
| Server command | Works, but runs in the **current** session (`execute({ sessionID, prompt, delivery })`) and cannot move the TUI. |

## Cache measurements (g)

One session, one model, short turns. `cached` = `tokens.cache.read`, `input` = uncached input tokens.

| Turn | Change before the request | input | cached |
|---|---|---|---|
| A | first request | 7133 | 0 |
| B, C | none | 19–34 | 7130–7146 |
| tool call | none | 31 | 7177 |
| D | **context hook adds a system part (phase change)** | 7258 | **0** |
| E, F | none | 28–30 | 7255–7282 |
| tool call | none | 35 | 7307 |
| G | **`instructions.entry.put`** | 78 | **7339** |
| H, I | none | 19–50 | 7414–7461 |
| J | **system part changed + one tool removed** | 7526 | **0** |
| K, L | none | 19–42 | 7523–7539 |

Conclusions:
- A phase change costs exactly one uncached request, as planned (§2c).
- `instructions.entry.put` does **not** break the cache: the entry is appended at the next step boundary. It is safe for
  dynamic data (current node, open question), but each put adds tokens to the history, so use it sparingly.
- Tool-list changes break the cache: keep all Mathesis tools registered for the whole session.
- With the hook pushing nothing, the system and tool hashes were identical across all turns.

## Selected question path

**Native session form, created by the TUI** (preferred over the custom JSX dialog and over the built-in `question`
tool):

1. `mathesis_quiz` / `mathesis_explain` commit the correct answer, store the open question (`ctx.storage`), and emit
   RPC event `questionAsked`.
2. The TUI creates a form with `client.session.form.create({ sessionID, title, fields })`:
   - `answer`: `string` with `options` (+ an "I don't know" option) for multiple choice; free `string` for recall.
   - `confidence`: `string` options 10/30/50/70/90/100, `when: answer != "__dont_know__"`.
   - `thinking`: optional `string`.
   The form shows inline in the chat with tabs and a summary before submit.
3. The TUI calls RPC `ack({ questionID, formID })`, waits for `form.replied` / `form.cancelled`, then calls RPC
   `answer(...)`.
4. The executor awaits the answer (honours `context.signal`; on abort it emits `questionClosed` and the TUI cancels the
   form), grades, logs and returns the result.

Robustness rules from the spike:
- **No TUI attached** (for example `opencode run`, Desktop): if no `ack` arrives within a few seconds, the tool returns
  an instruction to ask with the built-in `question` tool and record the answer with `mathesis_answer_record`
  (the handoff's fallback path).
- **TUI restart while a question is open:** the server keeps waiting. On setup the TUI calls RPC `pending()`; for a
  question that already has a `formID` it only re-attaches its listeners; otherwise it creates the form.
- Custom JSX dialog: works too (`dialog.select` → `dialog.select` → `dialog.prompt`), but it is three modal steps and
  is lost if the TUI restarts. Not used.

## Commands

- `/learn`, `/recall`, `/practice`, `/mathesis`, `/mathesis-setup` are **TUI slash commands**, because they must create
  and open a new session (or show dialogs).
- The server registers no commands with the same names. In clients without the TUI the learner talks to the
  `mathesis` agent, which uses `mathesis_topic_start` / `mathesis_topic_list` / `mathesis_phase_set`.

## Other findings

- Plugin tools need `options: { namespace: "mathesis", codemode: false }` to appear as direct tools named
  `mathesis_<name>`.
- Event names in `data.on`: `form.replied` (`event.data.id`, `event.data.answer`), `form.cancelled`.
- Form answers come back as strings (`"70"`), so parse numbers.
- Session messages with token usage: `GET /api/session/<id>/message` (`tokens.input`, `tokens.cache.read`).
- `opencode --standalone` runs a private server, so tests do not touch the user's background service.
- The host provides `@opencode/plugin` and `effect` at runtime (`runtime-modules`), so `@opencode/plugin` is pinned to
  the targeted opencode version.
