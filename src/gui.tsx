/** @jsxImportSource solid-js */
/// <reference lib="dom" />
import { Command, ComposerPill, Panel, Plugin, type PanelProps, type PanelTab, type SessionRef } from "@opencode/plugin/gui"
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { layoutPlan, MAP_PADDING, NODE_HEIGHT, NODE_WIDTH } from "./plan-layout.ts"
import type { FormField, FormSpec } from "./questions.ts"
import { Mathesis, type StartInput } from "./rpc.ts"
import { encodeWav, toBase64 } from "./wav.ts"

const TAB = "main"
const QUESTION_TAB = "question"
const SAMPLE_RATE = 16_000
const DUE_REFRESH_MS = 10 * 60 * 1000
/** Each state's look, from the app's own theme, so light and dark both work. */
const STATES: Record<string, { label: string; fill: string; stroke: string; text: string }> = {
  held: { label: "Learned", fill: "var(--v2-state-bg-success)", stroke: "var(--v2-state-border-success)", text: "var(--v2-state-fg-success)" },
  due: { label: "Due for review", fill: "var(--v2-state-bg-warning)", stroke: "var(--v2-state-border-warning)", text: "var(--v2-state-fg-warning)" },
  current: { label: "Learning now", fill: "var(--v2-state-bg-info)", stroke: "var(--v2-border-border-focus)", text: "var(--v2-state-fg-info)" },
  none: { label: "To learn", fill: "var(--v2-background-bg-layer-01)", stroke: "var(--v2-border-border-base)", text: "var(--v2-text-text-muted)" },
}
const MUTED = { color: "var(--v2-text-text-muted)" }

type Location = unknown
type Row = { text: string; tone?: string; plan?: boolean; step?: { n: number; mark: string; needs: string } }
type View = { title: string; rows: Row[]; progress?: { learned: number; total: number } }
type Step = { n: number; title: string; mark: string; needs: number[] }
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Records from the microphone as 16 kHz samples; `stop` returns a WAV. */
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const audio = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = audio.createMediaStreamSource(stream)
  const processor = audio.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (event) => void chunks.push(event.inputBuffer.getChannelData(0).slice())
  source.connect(processor)
  processor.connect(audio.destination)
  return async () => {
    processor.disconnect()
    source.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await audio.close()
    const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return encodeWav(samples, SAMPLE_RATE)
  }
}

export default Plugin.define({
  setup(ctx) {
    // Read the client where it is used: it changes when the server restarts.
    const rpc = () => ctx.client.rpc(Mathesis)
    const at = (location?: Location) => (location ? { location: location as never } : undefined)
    const key = `${ctx.id}:${TAB}`
    const tab: PanelTab = { id: TAB, title: "Mathesis" }
    const [tick, bump] = createSignal(0)
    const changed = () => void bump((n) => n + 1)
    const questionTab: PanelTab = { id: QUESTION_TAB, title: "Question", closable: false }
    const questionKey = `${ctx.id}:${QUESTION_TAB}`
    /** The open question of each session. */
    const [questions, setQuestions] = createSignal<Record<string, { form: FormSpec; location?: Location }>>({})
    /** Half-written answers, so leaving the tab loses nothing. */
    const drafts = new Map<string, Record<string, string>>()
    const broughtForward = new Set<string>()
    /** The notice of a question in another session, gone once that question is seen or closed. */
    const waiting = new Map<string, { dismiss(): void }>()
    /** The question on screen, for the keyboard commands. */
    let current: { dictate(): void; undo(): void } | undefined

    /** The plan drawn by hand: state colours, and a line only where a step really needs another. */
    function PlanMap(props: { steps: Step[] }) {
      const layout = () => layoutPlan(props.steps)
      const step = (n: number) => props.steps.find((candidate) => candidate.n === n)!
      const learned = (n: number) => ["held", "due"].includes(step(n)?.mark)
      return (
        <svg viewBox={`${-MAP_PADDING} -2 ${layout().width + 2 * MAP_PADDING} ${layout().height + 4}`} style={{ width: "100%", "max-width": `${layout().width * 1.15}px`, display: "block", margin: "0 auto" }}>
          <For each={layout().edges}>
            {(edge) => (
              <path
                d={edge.path}
                fill="none"
                stroke={learned(edge.from) ? "var(--v2-state-border-success)" : "var(--v2-border-border-strong)"}
                stroke-width="1.5"
                stroke-dasharray={learned(edge.from) ? undefined : "4 4"}
              />
            )}
          </For>
          <For each={layout().nodes}>
            {(node) => {
              const state = () => STATES[step(node.n).mark] ?? STATES.none!
              return (
                <g transform={`translate(${node.x} ${node.y})`}>
                  <title>{`${step(node.n).title}: ${state().label}`}</title>
                  <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="12" fill={state().fill} stroke={state().stroke} stroke-width={step(node.n).mark === "current" ? 2 : 1} />
                  <circle cx="24" cy={NODE_HEIGHT / 2} r="12" fill="var(--v2-background-bg-layer-03)" />
                  <text x="24" y={NODE_HEIGHT / 2 + 4} text-anchor="middle" font-size="11" font-weight="600" fill={state().text}>
                    {step(node.n).mark === "held" ? "✓" : node.n}
                  </text>
                  <foreignObject x="44" y="4" width={NODE_WIDTH - 52} height={NODE_HEIGHT - 8}>
                    <div style={{ display: "flex", "align-items": "center", height: "100%", "font-size": "12.5px", "line-height": "1.25", color: "var(--v2-text-text-base)" }}>
                      {step(node.n).title}
                    </div>
                  </foreignObject>
                </g>
              )
            }}
          </For>
        </svg>
      )
    }

    function PlanView(props: { sessionID: string; location?: Location }) {
      const [view] = createResource(
        () => [props.sessionID, tick()] as const,
        ([sessionID]) => rpc().panel({ sessionID }, at(props.location)) as Promise<View>,
      )
      const rows = () => view()?.rows ?? []
      const steps = (): Step[] =>
        rows().flatMap((row) =>
          row.step ? [{ n: row.step.n, title: row.text, mark: row.step.mark, needs: (row.step.needs.match(/\d+/g) ?? []).map(Number) }] : [],
        )
      const notes = () => rows().filter((row) => !row.step && !row.plan && row.text)
      const percent = () => (view()?.progress?.total ? (100 * view()!.progress!.learned) / view()!.progress!.total : 0)
      const used = () => Object.keys(STATES).filter((mark) => steps().some((step) => step.mark === mark))
      return (
        <div style={{ padding: "20px", "overflow-y": "auto", height: "100%", "font-size": "13px", "box-sizing": "border-box" }}>
          <Show when={view()} fallback={<div style={MUTED}>Loading…</div>}>
            <div style={{ "font-size": "15px", "font-weight": 600 }}>{view()!.title.replace(/^Mathesis: /, "")}</div>
            <Show when={view()!.progress}>
              <div style={{ display: "flex", "align-items": "center", gap: "10px", "margin-top": "12px" }}>
                <div style={{ flex: 1, height: "6px", "border-radius": "3px", background: "var(--v2-background-bg-layer-03)", overflow: "hidden" }}>
                  <div style={{ width: `${percent()}%`, height: "100%", "border-radius": "3px", background: "var(--v2-state-fg-success)", transition: "width .3s" }} />
                </div>
                <span style={MUTED}>
                  {view()!.progress!.learned} of {view()!.progress!.total} learned
                </span>
              </div>
            </Show>
            <Show when={steps().length}>
              <div style={{ margin: "24px 0 16px" }}>
                <PlanMap steps={steps()} />
              </div>
              <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px 14px", "justify-content": "center", "font-size": "12px", ...MUTED }}>
                <For each={used()}>
                  {(mark) => (
                    <span style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}>
                      <span style={{ width: "9px", height: "9px", "border-radius": "3px", background: STATES[mark]!.fill, border: `1px solid ${STATES[mark]!.stroke}` }} />
                      {STATES[mark]!.label}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div style={{ "margin-top": "20px", "padding-top": "12px", "border-top": "1px solid var(--v2-border-border-muted)" }}>
              <For each={notes()}>
                {(row) => <div style={{ ...(row.tone === "heading" ? { "font-weight": 600, "margin-top": "6px" } : MUTED) }}>{row.text}</div>}
              </For>
            </div>
          </Show>
        </div>
      )
    }

    /**
     * The question as a side-panel tab: the chat and the rest of the app stay usable, and unlike a native form the fields
     * can change while it is open. Closing or leaving the tab does not cancel it; only Skip does.
     */
    function Question(props: { form: FormSpec; location?: Location }) {
      const [values, setValues] = createSignal<Record<string, string>>(drafts.get(props.form.id) ?? {})
      // One recording at a time; its text goes into the field it was started from.
      const [recording, setRecording] = createSignal<{ field: string; stop?: () => Promise<Uint8Array> } | undefined>()
      const [status, setStatus] = createSignal<{ field: string; text: string } | undefined>()
      const set = (field: string, value: string) => {
        setValues((v) => ({ ...v, [field]: value }))
        drafts.set(props.form.id, values())
      }
      const active = (field: FormField) =>
        (field.when ?? []).every((rule) => ((values()[rule.key] ?? "") === rule.value) === (rule.op === "eq"))
      const submit = () => void rpc().relay({ formID: props.form.id, answer: values() }, at(props.location))
      const skip = () => void rpc().relay({ formID: props.form.id, cancelled: true }, at(props.location))
      const canRecord = () => !!navigator.mediaDevices?.getUserMedia
      /** What each dictation added, so undo can take the last one out again. */
      const dictated: { field: string; text: string }[] = []
      const toggle = async (field: string) => {
        const active = recording()
        try {
          if (!active) {
            setRecording({ field })
            const stop = await startRecording()
            setRecording({ field, stop })
            setStatus({ field, text: "Recording…" })
            return
          }
          if (active.field !== field || !active.stop) return
          setRecording(undefined)
          setStatus({ field, text: "Transcribing…" })
          const result = (await rpc().transcribe({ audio: toBase64(await active.stop()) }, at(props.location))) as { text: string }
          const before = (values()[field] ?? "").trim()
          set(field, before ? `${before} ${result.text}` : result.text)
          if (result.text) dictated.push({ field, text: result.text })
          setStatus(undefined)
        } catch (error) {
          setRecording(undefined)
          setStatus({ field, text: errorText(error) })
        }
      }
      const textFields = () => props.form.fields.filter((field) => !field.options).map((field) => field.key)
      /** The field the cursor is in; else the answer, or the thinking on a multiple-choice question. */
      const focusedField = () => {
        const inField = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-field]")?.dataset.field
        return inField && textFields().includes(inField) ? inField : textFields()[0]
      }
      const handle = {
        dictate: () => {
          const field = recording()?.field ?? focusedField()
          if (field && canRecord()) void toggle(field)
        },
        undo: () => {
          const last = dictated.pop()
          if (!last) return
          const value = values()[last.field] ?? ""
          if (value.endsWith(last.text)) set(last.field, value.slice(0, value.length - last.text.length).trimEnd())
          else setStatus({ field: last.field, text: "This field changed since the dictation, so it stays." })
        },
      }
      current = handle
      onCleanup(() => {
        if (current === handle) current = undefined
      })
      let firstField: HTMLTextAreaElement | undefined
      onMount(() => setTimeout(() => firstField?.focus()))
      return (
        <div style={{ display: "flex", "flex-direction": "column", height: "100%", "font-size": "14px" }}>
          <div style={{ flex: 1, "overflow-y": "auto", padding: "16px" }}>
            <ctx.ui.Markdown text={props.form.title} />
            <For each={props.form.fields}>
              {(field) => (
                <Show when={active(field)}>
                  <div style={{ "margin-top": "16px" }} data-field={field.key}>
                    <div style={{ "font-weight": 600 }}>{field.title}</div>
                    <Show when={field.description}>
                      <div style={MUTED}>{field.description}</div>
                    </Show>
                    <Show
                      when={field.options}
                      fallback={
                        <textarea
                          ref={(element) => {
                            if (!firstField) firstField = element
                          }}
                          rows={field.key === "thinking" ? 5 : 3}
                          placeholder={field.placeholder}
                          value={values()[field.key] ?? ""}
                          onInput={(event) => set(field.key, event.currentTarget.value)}
                          style={{ width: "100%", "margin-top": "4px", background: "transparent", color: "inherit", border: "1px solid var(--v2-border-border-base)", "border-radius": "6px", padding: "8px", "box-sizing": "border-box" }}
                        />
                      }
                    >
                      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px 16px", "margin-top": "6px" }}>
                        <For each={field.options}>
                          {(option) => (
                            <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }}>
                              <input type="radio" name={field.key} checked={values()[field.key] === option.value} onChange={() => set(field.key, option.value)} />
                              <ctx.ui.Markdown text={option.label} />
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={!field.options}>
                      <div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "6px" }}>
                        <ctx.ui.Button
                          disabled={!canRecord() || (!!recording() && recording()!.field !== field.key)}
                          onClick={() => void toggle(field.key)}
                        >
                          {recording()?.field === field.key ? "Stop" : "Speak"}
                        </ctx.ui.Button>
                        <ctx.ui.Keybind keys={ctx.keybinds.keybind(`${ctx.id}.dictate`)} />
                        <span style={MUTED}>
                          {canRecord() ? (status()?.field === field.key ? status()!.text : "") : "The microphone needs localhost or HTTPS."}
                        </span>
                      </div>
                    </Show>
                  </div>
                </Show>
              )}
            </For>
          </div>
          <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px", padding: "12px 16px", "border-top": "1px solid var(--v2-border-border-muted)" }}>
            <ctx.ui.Button variant="ghost-muted" onClick={skip}>
              Skip
            </ctx.ui.Button>
            <ctx.ui.Button variant="contrast" onClick={submit}>
              Submit
            </ctx.ui.Button>
          </div>
        </div>
      )
    }

    /** Puts the question's tab in front when its session is on screen; otherwise it waits and the learner is told. */
    function show(sessionID: string, form: FormSpec, location?: Location) {
      setQuestions((all) => ({ ...all, [sessionID]: { form, location } }))
      const session = ctx.sessions.current()
      if (session?.id === sessionID) bringForward(session, form.id)
      else {
        const server = session?.server.id ?? ctx.servers.list()[0]
        waiting.get(form.id)?.dismiss()
        const toast = ctx.toast.show({
          title: "Mathesis asks you something",
          description: "A question is waiting in another session.",
          persistent: true,
          ...(server ? { actions: [{ label: "Open", run: () => ctx.tabs.open({ server, id: sessionID }, { focus: true }) }] } : {}),
        })
        waiting.set(form.id, toast)
        void ctx.attention.notify({ title: "Mathesis question", message: "A question is waiting in another session." })
      }
    }

    /** Once per question, so the learner can move to the plan and stay there. */
    function bringForward(session: SessionRef, formID?: string) {
      if (!formID || broughtForward.has(formID)) return
      broughtForward.add(formID)
      dismissWaiting(formID)
      ctx.layout.open(questionKey, session)
    }

    function dismissWaiting(formID: string) {
      waiting.get(formID)?.dismiss()
      waiting.delete(formID)
    }

    function closeQuestion(formID: string) {
      dismissWaiting(formID)
      drafts.delete(formID)
      broughtForward.delete(formID)
      const entry = Object.entries(questions()).find(([, question]) => question.form.id === formID)
      if (!entry) return
      setQuestions(({ [entry[0]]: _, ...rest }) => rest)
      const session = ctx.sessions.current()
      if (session?.id === entry[0]) {
        ctx.layout.close(questionKey, session)
        ctx.layout.open(key, session)
      }
    }

    async function claimAndShow(questionID: string, location?: Location) {
      const claim = (await rpc().claim({ questionID }, at(location))) as { accepted: boolean; sessionID?: string; form?: FormSpec }
      if (!claim.accepted || !claim.form || !claim.sessionID) return
      await rpc().shown({ formID: claim.form.id }, at(location))
      show(claim.sessionID, claim.form, location)
    }

    const failed = (error: unknown) => void ctx.toast.show({ title: "Mathesis", description: errorText(error), variant: "error" })
    let setupOffered = false

    /** Writes the agent and the vault folders; every session model stays the one in use. */
    async function setup() {
      try {
        const result = (await rpc().setup({ sameModel: true }, at(ctx.sessions.current()?.location))) as { vault: string }
        ctx.toast.show({ title: "Mathesis is set up", description: `Notes go to ${result.vault}`, variant: "success" })
      } catch (error) {
        failed(error)
      }
    }

    async function offerSetup() {
      if (setupOffered) return
      const { setupNeeded } = (await rpc().due({}, at(ctx.sessions.current()?.location)).catch(() => ({}))) as { setupNeeded?: boolean }
      if (!setupNeeded) return
      setupOffered = true
      const run = await ctx.dialogs.confirm({
        title: "Mathesis is not set up yet",
        description: "Setup writes the mathesis agent (its permission rules) and the vault folders. Without it, sessions use the default agent.",
        confirm: "Set up now",
      })
      if (run) await setup()
    }

    async function start(input: Omit<StartInput, "directory" | "math">) {
      await offerSetup()
      const session = ctx.sessions.current()
      try {
        const result = (await rpc().start(
          { ...input, ...(session ? { directory: session.directory } : {}), math: true },
          at(session?.location),
        )) as { sessionID: string; notice?: string }
        const server = session?.server.id ?? ctx.servers.list()[0]
        if (server) ctx.tabs.open({ server, id: result.sessionID }, { focus: true })
        if (result.notice) ctx.toast.show({ title: "Mathesis", description: result.notice })
      } catch (error) {
        failed(error)
      }
    }

    async function learn(input?: string) {
      const goal = input?.trim()
      if (goal) return start({ kind: "learn", goal })
      let topics: { id: string; goal: string; ideas: number; due: number }[]
      try {
        topics = ((await rpc().topics({}, at(ctx.sessions.current()?.location))) as { topics: typeof topics }).topics
      } catch (error) {
        return failed(error)
      }
      const NEW = "\u0000new"
      const choice = await ctx.dialogs.select({
        title: "Mathesis: learn",
        placeholder: "Search topics",
        options: [
          { title: "New topic…", value: NEW, description: "Learn something new" },
          ...topics.map((topic) => ({
            title: topic.goal,
            value: topic.id,
            description: `${topic.ideas} card${topic.ideas === 1 ? "" : "s"}${topic.due ? `, ${topic.due} due` : ""}`,
          })),
        ],
      })
      if (choice === undefined) return
      if (choice !== NEW) return start({ kind: "learn", topic: choice })
      const typed = await ctx.dialogs.prompt({ title: "What do you want to understand?", placeholder: "how binary search finds its bounds" })
      if (typed?.trim()) return start({ kind: "learn", goal: typed.trim() })
    }

    const topicOf = (input?: string) => (input?.trim() ? { topic: input.trim() } : {})
    const add = (id: string, title: string, slash: string, run: (input?: string) => void | Promise<void>, args = true) =>
      ctx.add(Command, { id, title, group: "Mathesis", section: "session", slash: { name: slash, ...(args ? { arguments: true as const } : {}) }, run: (input) => void run(input) })
    add("learn", "Mathesis: learn a topic", "learn", learn)
    add("recall", "Mathesis: spaced review of due cards", "recall", (input) => start({ kind: "recall", ...topicOf(input) }))
    add("practice", "Mathesis: practice with what you hold", "practice", (input) => start({ kind: "practice", ...topicOf(input) }))
    add("status", "Mathesis: status", "mathesis", async () => {
      try {
        const { text } = (await rpc().status({}, at(ctx.sessions.current()?.location))) as { text: string }
        await ctx.dialogs.alert({ title: "Mathesis", description: text })
      } catch (error) {
        failed(error)
      }
    }, false)
    add("setup", "Mathesis: setup", "mathesis-setup", setup, false)

    // The due count above the composer; a click starts the review.
    const [due] = createResource(tick, () =>
      (rpc().due({}, at(ctx.sessions.current()?.location)) as Promise<{ due: number }>).then((result) => result.due).catch(() => 0),
    )
    const dueTimer = setInterval(changed, DUE_REFRESH_MS)
    onCleanup(() => clearInterval(dueTimer))
    ctx.add(ComposerPill, {
      id: "due",
      show: () => (due() ? { label: `${due()} due`, tone: "warning" as const, run: () => void start({ kind: "recall" }) } : undefined),
    })

    ctx.add(Panel, {
      id: TAB,
      region: "side",
      list: (input) => [...(input.open.includes(TAB) ? [tab] : []), ...(questions()[input.session.id] ? [questionTab] : [])],
      render: (props: PanelProps) => (
        <Show
          when={props.tab.id === QUESTION_TAB && questions()[props.session.id]}
          keyed
          fallback={<PlanView sessionID={props.session.id} location={props.session.location} />}
        >
          {(question) => <Question form={question.form} location={question.location} />}
        </Show>
      ),
    })
    ctx.add(Command, {
      id: "panel",
      title: "Mathesis: toggle the side panel",
      group: "Mathesis",
      section: "session",
      bind: "mod+shift+m",
      run: () => {
        const session = ctx.sessions.current()
        if (!session) ctx.toast.show({ title: "Open a session first." })
        // With a question open the key flips between it and the plan; closing the tab would hide neither.
        else if (!questions()[session.id]) ctx.layout.toggle(key, session)
        else if (ctx.layout.state(key, session) === "visible") ctx.layout.open(questionKey, session)
        else ctx.layout.open(key, session, { tab: "select" })
      },
    })
    // Declined without a question on screen, so these keys keep their usual meaning there.
    ctx.add(Command, {
      id: "dictate",
      title: "Mathesis: dictate into the question",
      group: "Mathesis",
      section: "session",
      bind: "mod+alt+v",
      run: () => (current ? current.dictate() : false),
    })
    ctx.add(Command, {
      id: "dictate-undo",
      title: "Mathesis: remove the last dictation",
      group: "Mathesis",
      section: "session",
      bind: "mod+alt+z",
      run: () => (current ? current.undo() : false),
    })

    const events = rpc().events
    const stops = [
      events.on("sessionChanged", changed),
      events.on("cardsChanged", changed),
      events.on("planUpdated", (event) => {
        changed()
        const session = ctx.sessions.current()
        if (session?.id === (event.data as { sessionID: string }).sessionID) ctx.layout.open(key, session)
      }),
      events.on("questionAsked", (event) => {
        const location = (event as { location?: Location }).location
        void claimAndShow((event.data as { questionID: string }).questionID, location).catch((error) =>
          ctx.toast.show({ title: "Mathesis", description: errorText(error) }),
        )
      }),
      events.on("questionClosed", (event) => {
        closeQuestion((event.data as { formID: string }).formID)
      }),
    ]
    onCleanup(() => stops.forEach((stop) => stop()))

    // A question that was asked before this window started, or while another session was on screen.
    createEffect(() => {
      const session = ctx.sessions.current()
      if (session) bringForward(session, questions()[session.id]?.form.id)
      const location = session?.location
      if (!location) return
      void (rpc().pending({}, at(location)) as Promise<{ questions: { questionID: string; claimed: boolean }[] }>).then(({ questions }) => {
        for (const question of questions) if (!question.claimed) void claimAndShow(question.questionID, location)
      })
    })
  },
})
