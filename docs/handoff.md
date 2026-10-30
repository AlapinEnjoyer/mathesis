# HANDOFF: Mathesis, an opencode v2 plugin for probing, teaching, practice and spaced repetition

> Paste or attach this whole file into a fresh local Claude Code session. It is self-contained: it holds the research,
> the decisions already made, the architecture, the API notes and the task list. Start at **§9 First steps**.

---

## 1. Goal

Build **Mathesis** (Greek μάθησις, "learning"), a public, open-source **opencode v2 plugin** that recreates the
learning loop of [LearnHarness](https://github.com/amosblomqvist/learnharness) inside opencode, and adds **real
spaced repetition**:

1. **Probe** finds where the learner's understanding ends for each prerequisite topic. It brackets a floor (reliably right) and a ceiling (wrong or unknown) using answers, confidence and the learner's reasoning.
2. **Plan** writes a dependency map from what the learner already holds to the goal.
3. **Teach** goes one reasoning step at a time, as a cycle: **predict → teach → check**. Gaps are repaired before anything is built on them.
4. **Practice** gives interleaved problems where the learner has to recall the right idea without being told which one applies.
5. **Spaced review (new):** every idea the learner has demonstrated becomes an FSRS-scheduled card. Each review asks a newly written question.

All learner data is **plain Markdown** in a folder (default `~/mathesis`), readable in any editor. No Obsidian-specific syntax.

## 2. Decisions already made (don't re-litigate)

| Topic | Decision |
|---|---|
| Name | **Mathesis**. npm package `opencode-mathesis` (both `mathesis` and `opencode-mathesis` were free on npm on 2026-10-30), plugin id `mathesis`, GitHub repo `mathesis` |
| License | **AGPL-3.0**. LearnHarness's prompt text may be adapted directly. Attribution is required (see §7) |
| Repo | Public GitHub repo under the user's account, created from the local session with `gh repo create` |
| Interface | **TUI first**: server part + TUI part. No Desktop GUI part in v1 |
| Storage | Plain Markdown folder, YAML frontmatter, standard relative `[text](./x.md)` links |
| Modes in v1 | All four: probe, teach, spaced review (FSRS), practice. Improving on LearnHarness's ideas is welcome |
| Answers | Multiple choice **and** free recall, both with **confidence %** and an optional **thinking** note, plus "I don't know" |

## 2b. How it feels to use (day to day)

**You don't type `/learn` every time.** Commands are shortcuts. The real state lives in the vault and in opencode sessions.

| Situation | What you do | What happens |
|---|---|---|
| New subject | `/learn how TCP congestion control works`, or switch to the `mathesis` agent (Tab) and just say "teach me X" | A new opencode session titled `Mathesis: <topic>` starts in the probe phase. The agent calls `mathesis_topic_start` itself if you didn't use the command |
| Continue a subject later | Reopen that session from opencode's session list, or run `/learn` with no argument to pick a topic from a list | The phase, plan and current node are restored from storage. The agent recaps where you were and asks the next question. A long session is compacted by opencode; the plan and probe assessment live in the topic note, so nothing is lost |
| Daily review | Open opencode. The footer shows `Mathesis: 7 due`, and you get one notification a day if cards are due. Run `/recall` | Due cards from all topics, interleaved, about 5–10 minutes. Each card gets a newly written question |
| Want harder use of what you learned | `/practice` or `/practice tcp` | Interleaved problems built from cards you already hold |
| Check progress | `/mathesis`, or open the panel with a keybind | Topics, due counts, recent lapses, misconceptions |
| Edit or inspect your knowledge | Open `~/mathesis` in any editor | One Markdown note per idea. Edits are respected |

### What appears where (TUI)
- **Chat (the main surface):** all teaching prose, plans and feedback appear in the normal opencode chat. No separate app.
- **Questions:**
  - **Preferred:** a **pop-up dialog** over the chat showing the question, options or a text box, a confidence picker, an optional thinking field, and "I don't know". The answer and verdict then show in the chat.
  - **Fallback:** opencode's built-in inline question form, which shows the question with choices and a confidence choice in one form.
  - Phase 0 decides which.
- **Side panel `mathesis.panel`** (optional, toggled by keybind or `/mathesis panel`): the plan as a dependency tree with the current node highlighted, and today's due cards.
- **Status:** a due count in the sidebar and home footer, toasts like "+1 card: chain-rule-intuition", and a daily system notification via `context.attention.notify` when the terminal isn't focused.

## 2c. Models and prompt caching

### Default: one model, zero config
Out of the box, Mathesis uses **whatever model the session is already using**, for everything. You don't need to configure any models to start.

### Optional: separate models, set through a setup dialog
`/mathesis-setup` (and later `/mathesis models`) asks, using TUI `dialog.select` over `ctx.model.list()`:
1. "Use one model for everything?" Recommended: yes.
2. If no, choose models for **teach** (probe, plan, teach, practice), **recall** (`/recall` sessions) and **background** (summaries, duplicate checks, "asked before" stems). Each can be left as "same as default".

The choices are saved in `ctx.storage` under `config/models`. Precedence: plugin `options.models` in `opencode.jsonc` (for people who prefer config files) > what setup saved > the session's model.

```jsonc
// optional, equivalent to what /mathesis-setup stores
{ "package": "opencode-mathesis", "options": {
    "vault": "~/mathesis",
    "models": { "teach": "anthropic/claude-opus-5-5", "recall": "anthropic/claude-sonnet-5-5", "background": "anthropic/claude-haiku-5-5" }
} }
```

### Cache rule: never switch models within a session
Provider prompt caches are **per model and per exact prefix** (tools → system prompt → messages). Any model switch, system-prompt edit or tool-list change in the middle of a session means the next request pays full input price for the whole transcript. So:
- **Models are chosen once, when a session is created, and never switched within it.** A `/learn` session uses the teach model for both probe and teach. A `/recall` session uses the recall model. `/practice` uses the teach model. A new session has no cache anyway, so choosing the model there is free. Never call `switchModel` mid-session.
- **Background calls** (`ctx.experimental.generate.text({ model, prompt })`, with a fallback to `ctx.session.generate`) are small, independent requests that share no prefix with the conversation, so they don't affect its cache. Use them sparingly, and batch them at the end of a session where possible (for example, writing the session summary).
- **Grading free-recall answers stays with the conversation model**, which has the context. Never send the transcript to another model just for grading.

### Keeping the prompt prefix stable
- **The system prompt changes only when the phase changes.** It is fixed for each phase: probe → teach happens once per `/learn` session, and recall and practice sessions keep one phase. That means at most one cache miss per learn session.
- **Dynamic data never goes into the system prompt.** Due counts, the held/shaky summary, the current plan node and the open question go through **tool results** (for example, `mathesis_topic_status` called at the start of a turn when needed) or `ctx.session.instructions.entry`, if the spike shows that's appended without rewriting the prefix.
- **The tool list stays constant for the whole session.** Instead of removing tools for other phases from `event.tools` (which rewrites the cached prefix), register every Mathesis tool for the whole session. Each executor checks the phase and refuses with a corrective message, the same refuse-and-correct pattern LearnHarness uses for `probe_done`. The phase prompt only describes the tools for that phase.
- **The spike measures this:** compare cached and uncached input tokens per turn (from session usage and cost data) before and after a phase switch.

## 3. Why this is feasible (research summary)

- **LearnHarness** (cloned at commit HEAD, 2026-10-30) is a large Electron + Next.js app. Most of it is app shell (chat UI, provider/BYOK plumbing, cost meter, graph canvas, dictation), and opencode already provides all of that. What actually makes it work is small:
  - Prompt doctrine, about 500 lines of Markdown in `src/agent/prompts/` (see §7 for the file map).
  - Structured question tools: `quiz` (multiple choice) and `explain` (free recall). Both carry `confidence` (0–100), `thinking`, `dontKnow`, `nodeId` and `type: predict|check`.
  - `probe_done`, whose input *is* the learner assessment: per topic, the floor, ceiling, misconceptions and what to build from. It hands off from the prober to the teacher.
  - `plan_init`, a mermaid `graph TD` dependency map with strict node slugs.
  - Graph extraction into "propositions" and "reasoning chains", stored as append-only JSONL.
- **LearnHarness has no spaced repetition scheduler.** Grepping for FSRS, SM-2, interval, due and nextReview finds nothing; its practice sessions only run when the user starts one. FSRS scheduling is Mathesis's main addition.
- **opencode v2 has the hooks we need** (details in §6): server tools, commands, a `context` hook for prompts per phase, plugin storage, session control, TUI panels, slots and dialogs, typed RPC between server and TUI, and a built-in `question` tool.
- **Estimate:** about 1.5–2.5k lines of TypeScript plus prompts. Without the TUI it is usable in about 1–2 weeks part-time; the TUI adds about a week. The real difficulty is quality: smooth confidence/thinking input in the TUI, good card extraction, and fresh review questions.

## 4. Architecture

### 4.1 Package layout
```
mathesis/
  package.json           name "opencode-mathesis", type module,
                         exports: "." → ./src/server.ts, "./tui" → ./src/tui.tsx, "./rpc" → ./src/rpc.ts
                         deps: @opencode/plugin, ts-fsrs, yaml        devDeps: typescript, @types/bun
  LICENSE                AGPL-3.0
  NOTICE.md              attribution to LearnHarness (see §7)
  README.md              install, commands, vault format, screenshots later
  AGENTS.md / CLAUDE.md  dev notes for future agent sessions (how to load locally, test, conventions)
  src/server.ts          Plugin.define({ id: "mathesis", setup }) – wires everything
  src/rpc.ts             Rpc.define({ id: "mathesis" }): methods answer(), dueSummary(), sessionState();
                         events questionAsked, planUpdated, cardsChanged
  src/state.ts           per-session state in ctx.storage, key "session/<sessionID>":
                         { phase: probe|teach|review|practice, topic, plan, currentNode, openQuestion }
  src/store/vault.ts     read/write idea/topic/session notes (frontmatter via `yaml`), atomic write (tmp + rename)
  src/store/log.ts       append-only log/reviews.jsonl (the record of every review; FSRS state can be rebuilt from it)
  src/srs/fsrs.ts        ts-fsrs wrapper + rating mapping (§5.3)
  src/compose.ts         builds the system prompt for the current phase from src/prompts (numbered-fragment loader, like LearnHarness)
  src/tools/             quiz.ts explain.ts probe-done.ts plan.ts idea.ts misconception.ts review.ts practice.ts
  src/prompts/           base.md, probe/*.md, teach/*.md, review/*.md, practice/*.md, shared/*.md
  src/tui.tsx            quiz dialog, "mathesis.panel" session panel, due count in sidebar/footer, toasts
  test/                  bun test suites
```

### 4.2 One agent, prompts chosen by phase
- The documented v2 `AgentEditor` has `list/get/default/update/remove` but **no `add`**, so a plugin probably can't create an agent. Check the real `@opencode/plugin` types in phase 0.
- Fallback: a `/mathesis-setup` command writes `~/.config/opencode/agents/mathesis.md`. That file is a minimal system prompt with permissions denying `edit`/`shell` everywhere except the vault.
- `ctx.session.hook("context", …)` reads the session's `phase` from storage and pushes the composed prompt for that phase into `event.system`. That prompt is **fixed for each phase**, so it changes at most once per session (see §2c on caching).
- **Tools stay registered all session.** LearnHarness's rule that the prober and teacher never share tools is enforced inside each executor (a refusal outside its phase), not by removing tools from `event.tools`, which would break the prompt cache.
- The summary of the store for the topic ("held/stable" vs "shaky/lapsed/due") comes from the `mathesis_topic_status` tool result, not the system prompt. That way the probe can still skip solid topics and teaching can repair weak foundations first, without busting the cache.
- Phase changes come from tool events: `probe_done` → teach. The `/recall` and `/practice` commands set their own phase.

### 4.3 Commands
`/recall` is used instead of `/review` because `/review` collides with code-review commands.

| Command | Effect |
|---|---|
| `/learn <goal>` | Start a topic in a new session titled `Mathesis: <topic>`, set phase=probe, `ctx.session.switchAgent({agent:"mathesis"})`, send the opening prompt. With no argument: `dialog.select` over the existing topics, then continue that topic |
| `/recall [topic]` | Spaced review of due cards, interleaved across topics, capped at 20 per session by default |
| `/practice [topic]` | Practice session built from held ideas, weighted toward low stability |
| `/mathesis` | Status: due counts, recent lapses, topics |
| `/mathesis-setup` | Write the agent file, create the vault folders |

Commands are optional. In a session with the `mathesis` agent the learner can just talk, and the agent calls `mathesis_topic_start` / `mathesis_topic_list` / `mathesis_phase_set` itself.

Tools are registered under `editor.namespace({ name: "mathesis", … })`, so their ids are `mathesis_topic_start`, `mathesis_topic_list`, `mathesis_phase_set`, `mathesis_quiz`, `mathesis_explain`, `mathesis_probe_done`, `mathesis_plan_set`, `mathesis_idea_upsert`, `mathesis_misconception_record`, `mathesis_review_next`, `mathesis_review_grade` and `mathesis_practice_targets`.

### 4.4 Question UX: the main risk, settled by the phase 0 spike
- **Preferred path:**
  1. The `quiz`/`explain` executor commits the correct answer and explanation **before** the learner sees anything, and stores the open question.
  2. It emits the RPC event `questionAsked`.
  3. The TUI part opens a custom JSX dialog: options or a free-text field, a confidence picker (10/30/50/70/90/100, or "I don't know"), and an optional thinking field.
  4. The dialog calls RPC `answer()`.
  5. The executor `await`s that answer, honouring `context.signal`. It grades multiple choice mechanically; for free recall it returns the committed answer so the agent grades strictly.
  6. It returns the verdict, confidence and thinking to the model, and writes to the session note and log.
- **Fallback path:** the tool returns an instruction to call the built-in **`question`** tool. That tool supports several questions per form and always allows a free-form answer, so the agent asks the answer and a confidence bucket in one form, with thinking going in the free-form field. A `mathesis_answer_record` tool then grades and logs it.
- **Rules carried over from LearnHarness:**
  - one question per turn
  - every question has a `nodeId` and a `type` (`predict` before teaching a step, `check` after it)
  - teach first, check second
  - a wrong answer means repair before moving on
  - "I don't know" counts as a gap, not a wrong answer

## 5. Data model

### 5.1 Vault layout (option `vault`, default `~/mathesis`)
```
~/mathesis/
  ideas/<slug>.md          one idea = one card
  topics/<topic>.md        goal, probe assessment (per-topic floor/ceiling/misconceptions), plan (mermaid), links to ideas
  sessions/YYYY-MM-DD-<topic>-<kind>.md   questions, verdicts, confidence, thinking
  log/reviews.jsonl        {ts, ideaId, sessionID, mode, type, questionStem, correct, confidence, dontKnow, rating, elapsedMs}
```

### 5.2 Idea note
```markdown
---
id: chain-rule-intuition
topic: calculus
kind: proposition        # proposition | chain | misconception
requires: [derivative-as-local-slope]
created: 2026-10-30
source: sessions/2026-10-30-calculus-teach.md
srs: { state: review, due: 2026-11-04, stability: 6.2, difficulty: 5.1, reps: 3, lapses: 0, last: 2026-10-29 }
---
## Claim
...
## Why
Reasoning chain, linking prerequisites: [derivative as local slope](./derivative-as-local-slope.md) ...
## Known misconceptions
...
## Asked before
- <last N question stems, so reviews avoid repeating wording>
```
Users may edit notes freely. Re-read files on every use, never cache note bodies, and keep unknown frontmatter keys and body text unchanged when writing.

### 5.3 Spaced repetition rules
- **Creating cards:** after a teaching step's `check` passes, the teacher calls `idea_upsert(claim, why, requires, nodeId)`. Only demonstrated ideas become cards. That passing check counts as the card's first FSRS review.
- **Writing review questions:** `review_next` returns the most overdue card plus the ideas it `requires` and its "Asked before" stems. The agent writes a **new** question in recall, discrimination or reverse mode (taken from the practice doctrine).
- **Rating mapping:**

  | Answer | FSRS rating | Extra |
  |---|---|---|
  | "I don't know", or wrong | Again | |
  | Wrong with confidence ≥ 70 | Again | Create or bump a `misconception` card |
  | Correct with confidence < 50, or partial free recall | Hard | |
  | Correct with confidence 50–89 | Good | |
  | Correct with confidence ≥ 90 and clean reasoning | Easy | |
- **A lapse pulls in its foundations:** forgetting an idea moves the due date of the ideas it `requires` forward, because a failure often means a weak foundation.
- **Misconceptions are first-class cards**, reviewed with discrimination questions that pit the wrong model against the right one.
- **Practice outcomes** are logged as lighter reviews (`mode: practice`). Decide in phase 4 whether they update FSRS or only the log.

## 6. opencode v2 API notes

These were checked against the docs source in the opencode repo, `services/www/src/docs/content/` at commit `c65bb26`, 2026-10-30 (published at https://opencode.ai/v2/docs/ and https://opencode.ai/v2/docs/api). The v1 docs live in `packages/web/src/content/docs/`; ignore those. **Check against the installed `@opencode/plugin` types before relying on any of this.**

- **Loading:** plugins in `.opencode/plugins/<name>/` load automatically. Otherwise add `"plugins": ["/abs/path/mathesis"]` (or an npm name, or `{package, options}`) to `opencode.json(c)`. Without `exports`, a local directory uses root files named `server|index`, `tui` and `rpc` (`.ts`, `.tsx` or `.js`). The TUI loads the TUI parts of plugins its server loads. Options are read from `ctx.options`.
- **Server** (`build/plugins/server.mdx`):
  - `Plugin.define({ id, setup(ctx) })`; `setup` may return a cleanup function.
  - `ctx.location.directory` gives the location; `ctx.storage.get/set/remove/scan({prefix})` gives durable JSON storage scoped to the plugin.
  - Tools: `ctx.tool.transform(editor => { editor.namespace({name, description}); editor.add({ name, description, input: <JSON schema>, options: { namespace }, execute: async (input, context) => ({ content }) }) })`. `context.signal` and `context.progress()` are available inside `execute`.
  - Commands: `ctx.command.transform(e => e.add({ name, description, execute: async ({ sessionID, prompt, delivery }) => … }))`.
  - Sessions:
    - `ctx.session.create/get/context/list/prompt({sessionID,text})/synthetic/generate/command/switchAgent/switchModel/interrupt/wait/compact`
    - `ctx.session.instructions.entry.put({sessionID,key,value})` renders as a `<context key>` block in that session's instructions.
  - Hooks:
    - `ctx.session.hook("context", e => { e.system.push({type:"text",text}); delete e.tools.x; e.options… })` runs on every agent-loop model call and affects only the outgoing request.
    - `ctx.session.hook("prompt", …)` mutates user prompts at admission.
    - `ctx.tool.hook("execute.before"|"execute.after", …)`.
  - Others: `ctx.skill.transform` (add skills, with `autoinvoke`) and `ctx.agent.transform` (no `add` in the docs).
- **TUI** (`build/plugins/cli.mdx`):
  - `context.ui.slot({ append: "session.panel" | "sidebar.content" | "home.footer.status" | "prompt.footer.status" | …, render })`
  - Panels: `context.ui.panel.open("mathesis.panel", {presentation})`.
  - Dialogs: `context.ui.dialog.alert/confirm/prompt/select`, or custom JSX with `dialog.show(() => <box>…</box>)`.
  - `context.ui.toast.show`, `context.keymap.layer(() => ({ commands: [{ id, title, slash: {name}, bind, run }] }))`, plus storage and Solid components (OpenTUI).
- **RPC** (`build/plugins/rpc.mdx`): `Rpc.define({ id, methods: { name: { input, output, errors } }, events: { name: { schema } } })`, with JSON schemas. The server implements it; the TUI and clients call it.
- **Built-in tools** (`tools.mdx`): `question` takes one or more questions, each with a header, prompt and choices; `multiple` allows several choices and a free-form answer is always available. Its permission is `question`.
- **Agents** (`agents.mdx`): Markdown in `~/.config/opencode/agents/<name>.md` or `.opencode/agents/`. Frontmatter takes `description`, `mode` (primary or subagent), `model` and `permissions: [{action, resource, effect}]`; the body is the system prompt.
- Also worth reading: `build/plugins/index.mdx` (overview and publishing), `build/plugins/migrate-v1.mdx`, `skills.mdx`, `commands.mdx` and `build/client/index.mdx`.

## 7. LearnHarness: what to adapt (AGPL-3.0, attribution required)

Clone it with `git clone --depth 1 https://github.com/amosblomqvist/learnharness`. Files to read and adapt:

| LearnHarness file | Use in Mathesis |
|---|---|
| `src/agent/system-prompt.md` | `prompts/base.md`: the philosophy (teach at the edge of the learner's understanding; the system handles the logistics) |
| `src/agent/prompts/prober/10-probe-doctrine.md` | `prompts/probe/`: binary-search each topic; enter near the top; correct + confident means jump up; `probe_done` once |
| `src/agent/prompts/teacher/05-method.md` | `prompts/teach/`: unconditional truths first; ask "how could I have discovered this?" |
| `teacher/10-planning.md`, `20-teaching.md`, `28-predictions.md`, `30-question-principles.md` | `prompts/teach/`: minimal plan tree, one step = one fact = one check, predict→teach→check, the plan changes as the learner does |
| `src/agent/prompts/shared/20-question-tools.md`, `25-confidence.md` | `prompts/shared/`: building multiple-choice options (distractors are believable misconceptions), strict free-recall grading, reading confidence against the verdict |
| `src/agent/prompts/practice/00-base.md`, `10-doctrine.md` | `prompts/practice/` and `prompts/review/`: the target idea is not "active" in the learner's mind when the problem arrives; decision points per minute; aim for ~85% success per retrieval; recall → discrimination → composition; reverse and probe-the-premises templates |
| `src/agent/tools/probe.ts`, `src/core/contracts/probe.ts` | Schema shape for `probe_done` (per-topic floor, ceiling, misconceptions, buildFrom) |
| `src/agent/tools/plan.ts`, `mermaid-plan.ts`, `src/core/plan-tree.ts` | `plan_set`: mermaid parsing and slug rules |
| `src/agent/tools/practice.ts`, `src/core/contracts/practice.ts` | Practice target selection and shapes |
| `src/agent/subagents/extraction.ts` | Ideas for how to extract propositions and chains (Mathesis extracts inline via `idea_upsert` instead) |
| `skills/learnharness/references/data-format.md` | The answer-detail fields (`confidence`, `thinking`, `readingThinking`, `dontKnow`) |

**Adaptation rules:**
- Rewrite the learner as **"the learner" (they/them)**. LearnHarness prompts say "he".
- Rename tools to the Mathesis names.
- Drop references to LearnHarness-only UI (the "Check your understanding" button and similar) unless the TUI implements an equivalent.
- Keep a header comment in each adapted file: `Adapted from LearnHarness (AGPL-3.0), <path>, <date>; modified`.
- `NOTICE.md` credits LearnHarness by Amos Blomqvist, with a link to the repo.

## 8. Implementation phases (one PR or commit series each; tag `v0.x` releases to test iterations)

0. **Repo + spike (½–1 day).**
   - Scaffold, `git init`, push the public repo (§9). Load the plugin locally and confirm a hello tool works.
   - **Spike questions:**
     - (a) Can a tool executor `await` an RPC `answer()` from the TUI?
     - (b) Can a plugin register an agent, or is the agent file needed?
     - (c) Does `context` hook prompt injection and tool removal work for each session?
     - (d) Can a server tool create a **session form** (the mechanism behind the built-in `question` tool; the TUI exposes `context.data.session.form.list/reply`)? If so, that may be the cleanest question path: native form UI, no custom RPC.
     - (e) Can a TUI part open a dialog in response to a server event (`context.data.on(...)` or an RPC event) while the agent is mid-turn?
     - (f) Can the model be set when a session is created (via `ctx.session.create`, or `switchModel` before the first prompt), and does `ctx.experimental.generate.text({ model })` work with a separate background model (§2c)?
     - (g) **Cache check:** do the `context` hook's `event.system` edits and `instructions.entry` keep the cached prefix stable between turns? Measure cached vs uncached input tokens per turn, and across one probe → teach switch.
   - Record the results in `docs/spike.md` and choose the question path from §4.4.
1. **Core, no LLM.** `vault.ts`, `log.ts`, `fsrs.ts`, `state.ts`, `compose.ts`, with bun tests.
2. **Probe + teach.** Tools quiz/explain/probe_done/plan_set/idea_upsert/misconception_record, the adapted prompts, `/learn`, `/mathesis-setup`, the context hook.
3. **Spaced review.** review_next/review_grade, review prompts, `/recall`, `/mathesis`, lapses pulling in foundations.
4. **Practice.** practice_targets, practice prompts, logging practice outcomes.
5. **TUI.**
   - the quiz dialog (if the spike passes)
   - `mathesis.panel`: the plan as an indented dependency tree with the current node marked (mermaid doesn't render in a terminal), plus the due list
   - due count in `sidebar.content` and `home.footer.status`
   - toasts when cards are added
6. **Publish.** README with a GIF, `npm publish` as `opencode-mathesis`, add to the opencode ecosystem list.

**Testing iterations:** develop on branches and tag releases. Point the global `opencode.jsonc` at the local checkout (`"plugins": ["/path/to/mathesis"]`) for live testing. Later, test the published package (`"opencode-mathesis@0.x"`), as the opencode docs recommend testing the installed package rather than only a linked one.

## 9. First steps for the local session

1. Check the toolchain: `opencode --version` (must be v2), `bun --version`, `gh auth status`.
2. Create the repo:
   ```bash
   mkdir mathesis && cd mathesis && git init -b main
   ```
   ```bash
   gh repo create mathesis --public --source . --description "Mathesis: probe, teach, practice and spaced repetition for opencode" --license agpl-3.0
   ```
   If `--license` doesn't work together with `--source`, add the AGPL-3.0 `LICENSE` file manually.
3. Scaffold `package.json`, `tsconfig.json`, `src/server.ts` (hello tool), `LICENSE`, `NOTICE.md`, `README.md`, `AGENTS.md`, `.gitignore`, and copy this file to `docs/handoff.md`. Make the first commit and push with `git push -u origin main`.
4. `bun add @opencode/plugin ts-fsrs yaml`. Read `node_modules/@opencode/plugin` types to confirm the APIs in §6.
5. Clone LearnHarness into a sibling directory for reference (not inside the repo).
6. Run the phase 0 spike, then continue phase by phase.

## 10. Verification
- **`bun test`:**
  - the rating-mapping table
  - FSRS scheduling with a fake clock
  - rebuilding state from `reviews.jsonl` matches the frontmatter
  - vault round-trips keep user edits and unknown keys
  - prompt composition for each phase, with the right tools filtered
- **Manual end-to-end in the TUI:**
  1. Run `/mathesis-setup`, then `/learn how binary search finds its bounds`.
  2. Check that probe questions arrive one at a time with confidence; `probe_done` writes `topics/binary-search.md`; the plan is presented and confirmed; predict and check questions alternate; `ideas/*.md` appear after passed checks.
  3. Set a card's `due` in the past and run `/recall`. Check that the wording is new; the `srs` frontmatter and `reviews.jsonl` update; and a confident wrong answer creates a misconception card and moves its foundations forward.
  4. Run `/practice` and check that problems interleave across ideas.
  5. Open the vault in any editor and confirm the links resolve.

## 11. Open questions to settle along the way
- Should practice outcomes update FSRS, or only the log?
- Is there a daily new-card limit, or just the 20-per-session review cap?
- Should `/learn` start in a new opencode session or reuse the current one? Decided for now: a new session titled `Mathesis: <topic>`; revisit after using it.
- Models: decided. The default is one model, the session's own. Separate teach/recall/background models are an optional choice in `/mathesis-setup`, and are only ever applied when a session is created (§2c).
- Daily notification: once per day at first launch, or never by default? Proposal: on, configurable with `notify: false`.
- Should the TUI panel show the plan as a tree or as a list of nodes with status?
