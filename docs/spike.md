# Phase 0 spike results

Date: 2026-10-30. opencode `2.2.1` (TUI, `--standalone` private server), `@opencode/plugin@2.2.1`,
model `github-copilot/gpt-6-luna` (a provider with automatic prompt caching). Spike code: `src/spike/` in commit
`4df1849` (tag `spike-phase-0`), removed afterwards. Raw evidence: `docs/spike/spike-log.jsonl` (plugin log) and
`docs/spike/cache-test-messages.json` (token usage per step of the cache test).
These results win over `docs/handoff.md` when they disagree.

Status words: **tested** = run in the TUI and seen in the log; **design** = derived from types and docs, not run yet.

## Summary

| Question | Result |
|---|---|
| (a) Tool executor awaits an RPC `answer()` from the TUI | **Tested, yes.** The executor waited ~27–32 s on a promise; the TUI called `rpc.answer`; the tool returned the answer. |
| (b) Plugin registers an agent | **Tested, no.** `AgentEditor` has only `list/get/default/update/remove`. Keep the agent file written by `/mathesis-setup`. Note: `session.create` also takes `permissions` and `metadata`, so sessions that Mathesis creates can carry their own permission rules even without the agent file. |
| (c) `context` hook prompt injection / tool removal per session | **Tested, yes.** `event.system.push(...)` and `delete event.tools[...]` apply per request; we key on `event.sessionID`. |
| (d) Server tool creates a session form | **Not directly** (server `ctx.session` has no `form`). **Tested:** the TUI can, with `context.client.session.form.create(...)`, and the native form works well (see below). |
| (e) TUI opens UI from a server event while the agent is mid-turn | **Tested, yes.** RPC event `questionAsked` → TUI handler ran within 2 ms, while the tool call was running. Custom dialogs and native forms both work. |
| (f) Model at session creation; background model | **Tested:** the TUI client's `session.create({ title, agent: "plan", model, location })` set agent and model. A server-side `session.create` set the model (`agent: "build"` was asked and returned, which is also the default, so the server-side agent is not proven). `ctx.experimental.generate.text({ prompt, model })` works with a second model (`github-copilot/claude-haiku-5.5` → "pong"). `session.create` accepted `opencode/mimo-v2.5-free`, which is not in `opencode models` (generate with it failed "Model not found"), so **validate models against `ctx.model.list()` first**. **The model variant was dropped** because the spike did not pass `variant`; pass it. Creating a session with an agent that does not exist was not tested. |
| (g) Prefix cache stays stable | **Tested on one provider.** See the table below. |
| TUI slash command creates and opens a new session | **Tested, yes.** `keymap.layer({ commands: [{ slash: { name, arguments: true }, run }] })` + `client.session.create` + `ui.router.navigate({ type: "session", sessionID })` + `client.session.prompt`. |
| Server command | **Tested.** Works, but runs in the **current** session (`execute({ sessionID, prompt, delivery })`) and cannot move the TUI. |

## Cache measurements (g)

One session, one model, short turns. `cached` = `tokens.cache.read`, `input` = uncached input tokens.
`cache.write` was always 0 (automatic caching).

| Turn | Change before the request | input | cached |
|---|---|---|---|
| A | first request | 7133 | 0 |
| B, C | none | 19–34 | 7130–7146 |
| tool call | none | 31 | 7177 |
| D | **context hook adds a system part (phase change)** | 7258 | **0** |
| E, F | none | 28–30 | 7255–7282 |
| tool call | none | 35 | 7307 |
| G | **one `instructions.entry.put`** | 78 | **7339** |
| H, I | none | 19–50 | 7414–7461 |
| J | **system text changed AND one tool removed** | 7526 | **0** |
| K, L | none | 19–42 | 7523–7539 |

Conclusions:
- A phase change costs one uncached request, as planned (§2c). (Measured as "no phase → probe"; probe → teach is
  the same kind of change.)
- One `instructions.entry.put` did **not** break the cache: the entry is appended at the next step boundary.
  **Not tested:** a second put with the same key (does it rewrite the earlier block?). Until that is tested, do not
  use instruction entries for data that changes often; return dynamic data in tool results.
- Turn J changed the system text and the tool list together, so it does not isolate the tool-list effect. The rule
  "keep all Mathesis tools registered for the whole session" stays, because a tool list is part of the cached prefix
  in every provider.
- Not tested: providers with explicit cache breakpoints (Anthropic). Re-measure with one when it is available.

## Selected question path

**Native session form, created by the TUI.** Tested once with a multiple-choice question ("Paris", confidence 70,
thinking): the form shows inline in the chat with tabs and a summary before submit, and `when` hides the confidence
field until an answer is picked. The custom JSX dialog also works, but it is three modal steps and is lost if the TUI
restarts.

### Design for phase 2 (from the phase 0 review; to be spiked first in phase 2)

1. **Claim first, then create.** `mathesis_quiz` / `mathesis_explain` commit the answer, store the open question,
   and emit `questionAsked`. Every TUI that receives it (filter by `event.location`) calls RPC `claim({ questionID })`.
   The server accepts only the first claim, and none after it chose the fallback. Only the TUI whose claim was accepted
   creates the form, with the fixed ID `frm_mathesis_<questionID>` and `metadata: { questionID }`, so a second
   create cannot make a duplicate (check how a create with an existing ID behaves).
2. **The server watches the form, not the TUI.** The server subscribes to `form.replied` / `form.cancelled` with
   `ctx.event.subscribe` and filters by the known form ID, so the answer reaches the executor even if the TUI dies
   after submit. On a restart, the TUI calls RPC `pending()` and `client.session.form.get(...)`, and creates the form
   only when it does not exist. (Check that a plugin subscriber receives these events.)
3. **Answer values.** Multiple-choice options use index values (`"0"`, `"1"`, …) mapped back on the server; both
   question kinds offer "I don't know". Confidence must not be `required` while `when` hides it (check that a
   hidden required field does not reject the "I don't know" answer). The RPC answer shape is discriminated:
   `status: answered | dont_know | cancelled`.
4. **Abort.** Check `signal.aborted` before waiting, use `{ once: true }` listeners and remove them after the answer.
   On abort the server emits `questionClosed` (with a reason) and the TUI cancels the form.
5. **No TUI claims within a few seconds:** return `fallback: true`. The built-in `question` tool needs a client that
   renders forms (Desktop, web), so the fallback instruction also allows a plain chat question; the agent records the
   learner's reply with `mathesis_answer_record`. Non-interactive runs (`opencode run`) cannot answer questions.
6. **Question in a session the learner is not viewing:** toast + `attention.notify` with the session, and a progress
   update on the tool call.
7. **Answer leak:** the TUI shows a tool call's scalar input fields next to its name
   (`mathesis_spike_ask [mode=dialog, prompt=…]`). A committed `correctIndex` or `correctAnswer` may be visible
   while the form is open. Check what is shown before the tool schema is final, and keep the committed answer out of
   the visible fields.

## Commands

- `/learn`, `/recall`, `/practice`, `/mathesis`, `/mathesis-setup` are **TUI slash commands**, because they must create
  and open a new session (or show dialogs).
- The server registers no commands with the same names. In clients without the TUI part the learner talks to the
  `mathesis` agent, which uses `mathesis_topic_start` / `mathesis_topic_list` / `mathesis_phase_set`.

## Other findings

- Plugin tools with `options: { namespace: "mathesis", codemode: false }` appear as direct tools named
  `mathesis_<name>`.
- Event names in `data.on`: `form.replied` (`event.data.id`, `event.data.answer`), `form.cancelled`. These events are
  not stored, so a client that is not listening misses them.
- Form answer values have the type of the field (`string`, `number`, `boolean`, `string[]`); the spike used string
  fields only.
- Session messages with token usage: `GET /api/session/<id>/message` (`tokens.input`, `tokens.cache.read`), for
  example `opencode api --standalone GET /api/session/<id>/message`.
- `opencode --standalone` runs a private server, so tests do not touch the user's background service.
- The host provides `@opencode/plugin` and `effect` at runtime (`runtime-modules`). The version in `package.json` only
  gives types and a fallback; the supported opencode range is stated in the README.
