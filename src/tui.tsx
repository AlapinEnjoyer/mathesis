import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { localDate, shouldNotify } from "./notify.ts"
import { Mathesis, type ModelRefInput } from "./rpc.ts"

type Context = Plugin.Context
type FormSpec = { id: string; title: string; fields: unknown[]; metadata?: Record<string, unknown> }

const FORM_PREFIX = "frm_mathesis_"
const PANEL = "mathesis.panel"
const DUE_REFRESH_MS = 10 * 60 * 1000
const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error)

export default Plugin.define({
  id: "mathesis.tui",
  setup(context) {
    // Read the client where it is used: it changes when the server restarts.
    const rpc = () => context.client.rpc(Mathesis)
    const stops: Array<() => void> = []
    type Location = { directory: string; workspaceID?: string }
    const here = (): Location => context.location ?? context.data.location.default()
    /**
     * The server part runs once per location, each with its own questions. Calls about a question go to the location
     * its event came from; other calls go to this TUI's location.
     */
    const at = (location?: Location) => ({ location: (location ?? here()) as never })
    const locationOf = (event: unknown) => (event as { location?: Location }).location
    const formLocations = new Map<string, Location | undefined>()

    const viewing = (sessionID: string) => {
      const route = context.ui.router.current()
      return route.type === "session" && route.sessionID === sessionID
    }

    async function showForm(sessionID: string, form: FormSpec, location?: Location) {
      formLocations.set(form.id, location)
      try {
        try {
          await context.client.session.form.create({ sessionID, ...form } as never)
        } catch (error) {
          // A form with this id already exists (another TUI, or a restart): nothing to do.
          const existing = await context.client.session.form.get({ sessionID, formID: form.id }).catch(() => undefined)
          if (!existing) throw error
        }
        await rpc().shown({ formID: form.id }, at(location))
      } catch (error) {
        // Without a form the question must not wait forever: hand it back, so the agent asks another way.
        await rpc().relay({ formID: form.id, cancelled: true, message: `the form could not be shown: ${errorText(error)}` }, at(location)).catch(() => {})
        throw error
      }
      if (!viewing(sessionID)) {
        context.ui.toast.show({ title: "Mathesis question", message: form.title, sessionID, variant: "info", duration: 8000 })
        void context.attention.notify({ title: "Mathesis", message: form.title, notification: { when: "blurred" }, sound: { name: "question" } })
      }
    }

    async function claimAndShow(questionID: string, location?: Location) {
      const claim = (await rpc().claim({ questionID }, at(location))) as { accepted: boolean; sessionID?: string; form?: FormSpec }
      if (claim.accepted && claim.sessionID && claim.form) await showForm(claim.sessionID, claim.form, location)
    }

    /** After a restart: show open questions again, and pass on answers given while nobody was listening. */
    async function recover() {
      const { questions } = (await rpc().pending({}, at())) as {
        questions: { questionID: string; sessionID: string; claimed: boolean; form: FormSpec }[]
      }
      for (const question of questions) {
        if (!question.claimed) {
          await claimAndShow(question.questionID)
          continue
        }
        const detail = (await context.client.session.form
          .get({ sessionID: question.sessionID, formID: question.form.id })
          .catch(() => undefined)) as { state?: { status: string; answer?: Record<string, unknown>; message?: string } } | undefined
        if (!detail) await showForm(question.sessionID, question.form)
        else if (detail.state?.status === "answered") await rpc().relay({ formID: question.form.id, answer: detail.state.answer }, at())
        else if (detail.state?.status === "cancelled") {
          await rpc().relay({ formID: question.form.id, cancelled: true, ...(detail.state.message ? { message: detail.state.message } : {}) }, at())
        }
        else await rpc().shown({ formID: question.form.id }, at())
      }
    }

    // Bumped on every server event that can change what the panel and the footer show.
    const [tick, bump] = createSignal(0)
    const changed = () => void bump((n) => n + 1)

    /** Subscriptions to the server's events. They belong to one client, so they are renewed when the server restarts. */
    function subscribe(): Array<() => void> {
      return [
        rpc().events.on("planUpdated", changed),
        rpc().events.on("sessionChanged", changed),
        rpc().events.on("questionAsked", (event) => {
          changed()
          void claimAndShow((event.data as { questionID: string }).questionID, locationOf(event)).catch((error) =>
            context.ui.toast.show({ title: "Mathesis", message: `Could not show the question: ${errorText(error)}`, variant: "error" }),
          )
        }),
        rpc().events.on("questionClosed", (event) => {
          const { reason, sessionID, formID } = event.data as { reason: string; sessionID: string; formID: string }
          formLocations.delete(formID)
          changed()
          if (reason === "aborted" || reason === "fallback") {
            void context.client.session.form.cancel({ sessionID, formID, message: "The question was closed." }).catch(() => {})
          }
        }),
        rpc().events.on("cardsChanged", (event) => {
          for (const id of (event.data as { added: string[] }).added) context.ui.toast.show({ message: `+1 card: ${id}`, variant: "success", duration: 3000 })
          changed()
          void refreshDue().catch(() => {})
        }),
      ]
    }
    let subscriptions = subscribe()
    stops.push(
      () => subscriptions.forEach((off) => off()),
      context.data.on("server.connected" as never, () => {
        subscriptions.forEach((off) => off())
        subscriptions = subscribe()
        void recover().catch(() => {})
        changed()
        void refreshDue({ notify: true }).catch(() => {})
      }),
      // Relay form outcomes too; the server also watches them, and the first one wins.
      context.data.on("form.replied", (event) => {
        const id = event.data.id
        if (id.startsWith(FORM_PREFIX)) void rpc().relay({ formID: id, answer: event.data.answer }, at(formLocations.get(id) ?? locationOf(event))).catch(() => {})
      }),
      context.data.on("form.cancelled", (event) => {
        const id = event.data.id
        if (id.startsWith(FORM_PREFIX)) void rpc().relay({ formID: id, cancelled: true }, at(formLocations.get(id) ?? locationOf(event))).catch(() => {})
      }),
    )
    void recover().catch(() => {})

    const currentModel = (): ModelRefInput | undefined => {
      const model = context.ui.model.current()
      return model ? { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } : undefined
    }

    async function start(input: { kind: "learn" | "recall" | "practice"; goal?: string; topic?: string }) {
      try {
        const directory = here().directory
        const model = currentModel()
        const result = (await rpc().start({ ...input, directory, ...(model ? { model } : {}) }, at())) as {
          sessionID: string
          title: string
          notice?: string
        }
        context.ui.router.navigate({ type: "session", sessionID: result.sessionID })
        if (result.notice) context.ui.toast.show({ title: "Mathesis", message: result.notice, variant: "warning", duration: 8000 })
      } catch (error) {
        context.ui.toast.show({ title: "Mathesis", message: errorText(error), variant: "error", duration: 8000 })
      }
    }

    async function learn(input?: string) {
      const goal = input?.trim()
      if (goal) return start({ kind: "learn", goal })
      let topics: { id: string; goal: string; ideas: number; due: number }[]
      try {
        topics = ((await rpc().topics({}, at())) as { topics: typeof topics }).topics
      } catch (error) {
        return context.ui.toast.show({ title: "Mathesis", message: errorText(error), variant: "error" })
      }
      const NEW = "\u0000new"
      const choice = await context.ui.dialog.select({
        title: "Mathesis: learn",
        placeholder: "Search topics",
        options: [
          { title: "New topic…", value: NEW, description: "Learn something new" },
          ...topics.map((t) => ({
            title: t.goal,
            value: t.id,
            description: `${t.ideas} card${t.ideas === 1 ? "" : "s"}${t.due ? `, ${t.due} due` : ""}`,
            category: "Continue",
          })),
        ],
      })
      if (choice === undefined) return
      if (choice !== NEW) return start({ kind: "learn", topic: choice })
      const typed = await context.ui.dialog.prompt({ title: "What do you want to understand?", placeholder: "how binary search finds its bounds" })
      if (typed?.trim()) return start({ kind: "learn", goal: typed.trim() })
    }

    const topicArg = (input: string | undefined) => (input?.trim() ? input.trim() : undefined)

    async function showStatus() {
      try {
        const result = (await rpc().status({}, at())) as { text: string }
        await context.ui.dialog.alert({ title: "Mathesis", message: result.text })
      } catch (error) {
        context.ui.toast.show({ title: "Mathesis", message: errorText(error), variant: "error" })
      }
    }

    async function setupCommand() {
      const same = await context.ui.dialog.confirm({
        title: "Mathesis setup",
        message: "Use one model for everything? (Recommended: the session's model is used for teaching, review and background work.)",
        label: { confirm: "Yes, one model", cancel: "No, choose models" },
      })
      if (same === undefined) return
      let models: Record<string, ModelRefInput> | undefined
      if (same === false) {
        await context.data.location.model.sync(context.location)
        const available = context.data.location.model.list(context.location) ?? []
        models = {}
        for (const [role, label] of [
          ["teach", "teaching (probe, plan, teach, practice)"],
          ["recall", "spaced review (/recall)"],
          ["background", "background work (summaries)"],
        ] as const) {
          const DEFAULT = "\u0000default"
          const value = await context.ui.dialog.select({
            title: `Model for ${label}`,
            options: [
              { title: "Same as the session's model", value: DEFAULT },
              ...available.map((m) => ({ title: m.name, value: `${m.providerID}/${m.id}`, category: m.providerID })),
            ],
          })
          if (value === undefined) return
          if (value !== DEFAULT) {
            const slash = value.indexOf("/")
            models[role] = { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
          }
        }
      }
      try {
        const result = (await rpc().setup(same ? { sameModel: true } : { sameModel: false, models }, at())) as {
          agentFile: string
          vault: string
        }
        context.ui.toast.show({
          title: "Mathesis is set up",
          message: `Agent: ${context.ui.format.path(result.agentFile)} · Vault: ${context.ui.format.path(result.vault)}. Start with /learn.`,
          variant: "success",
          duration: 8000,
        })
      } catch (error) {
        context.ui.toast.show({ title: "Mathesis", message: errorText(error), variant: "error" })
      }
    }

    // Due count for the footer and sidebar, refreshed on card changes, on reconnect and every few minutes.
    const [due, setDue] = createSignal(0)
    const [notified, setNotified] = context.storage.store("notify", { initial: { last: "" } })
    let notifying = false
    const reviewing = () => {
      const route = context.ui.router.current()
      return route.type === "session" && !!context.data.session.get(route.sessionID)?.title?.startsWith("Mathesis: review")
    }
    async function refreshDue(options: { notify?: boolean } = {}) {
      const { due: count } = (await rpc().due({}, at())) as { due: number }
      setDue(count)
      // One system notification a day while cards are due and the terminal is not focused (option `notify`). Only
      // from the timer, startup and reconnect, never in the middle of a review. The day is claimed before sending.
      const today = localDate(new Date())
      if (!options.notify || notifying) return
      if (!shouldNotify({ due: count, last: notified.last, today, enabled: context.options.notify !== false, reviewing: reviewing() })) return
      notifying = true
      const previous = notified.last
      try {
        await setNotified((draft) => void (draft.last = today))
        const sent = await context.attention.notify({
          title: "Mathesis",
          message: `${count} card${count === 1 ? "" : "s"} due. Run /recall.`,
          notification: { when: "blurred" },
        })
        // Skipped (for example because the terminal is focused): give the day back, the next check tries again.
        if (!sent.notification) await setNotified((draft) => void (draft.last = previous))
      } finally {
        notifying = false
      }
    }
    void refreshDue({ notify: true }).catch(() => {})
    const timer = setInterval(() => {
      changed()
      void refreshDue({ notify: true }).catch(() => {})
    }, DUE_REFRESH_MS)
    stops.push(() => clearInterval(timer))

    const dueText = () => `Mathesis: ${due()} due`
    stops.push(
      context.ui.slot({
        append: "home.footer.status",
        render: () => (
          <Show when={due() > 0}>
            <text fg={context.theme.text.muted}>{dueText()}</text>
          </Show>
        ),
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <Show when={due() > 0}>
            <text fg={context.theme.text.muted}>{dueText()} · /recall</text>
          </Show>
        ),
      }),
      context.ui.slot({
        append: "session.panel",
        render: (input) => (
          <Show when={input.name === PANEL}>
            <MathesisPanel input={input} />
          </Show>
        ),
      }),
    )

    type Row = { depth: number; text: string; tone?: "heading" | "muted" | "current" }

    /** The side panel: phase, the plan as an indented dependency list with the current node, and the due cards. */
    function MathesisPanel(props: { input: PanelInput }) {
      const [view, setView] = createSignal<{ title: string; rows: Row[] }>({ title: "Mathesis", rows: [{ depth: 0, text: "Loading…" }] })
      let request = 0
      // Reload when the session changes or the server reports a change; a late answer to an older request is dropped.
      createEffect(
        on([() => props.input.sessionID, tick], ([sessionID]) => {
          const id = ++request
          const location = context.data.session.get(sessionID)?.location as Location | undefined
          void rpc()
            .panel({ sessionID }, at(location))
            .then((result) => id === request && setView(result as { title: string; rows: Row[] }))
            .catch((error) => id === request && setView({ title: "Mathesis", rows: [{ depth: 0, text: `Could not load: ${errorText(error)}` }] }))
        }),
      )
      const color = (tone?: Row["tone"]) =>
        tone === "current" ? context.theme.text.action.primary.base : tone === "muted" ? context.theme.text.muted : context.theme.text.base
      return (
        <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
          <text fg={context.theme.text.action.primary.base}>
            <b>{view().title}</b>
          </text>
          <scrollbox focused={props.input.focused} flexGrow={1}>
            <For each={view().rows}>
              {(row) => (
                // One text per row inside an indented box, so wrapped lines keep the indentation.
                <box paddingLeft={row.depth * 2}>
                  <text fg={color(row.tone)}>{row.tone === "heading" ? <b>{row.text}</b> : row.text || " "}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      )
    }

    function togglePanel() {
      const route = context.ui.router.current()
      const current = context.ui.panel.current()
      if (current?.name === PANEL && route.type === "session" && current.sessionID === route.sessionID) return context.ui.panel.close()
      if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ message: "Open a session first.", variant: "info" })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mathesis.learn",
          title: "Mathesis: learn a topic",
          group: "Mathesis",
          palette: true,
          slash: { name: "learn", arguments: true },
          run: (input) => learn(input),
        },
        {
          id: "mathesis.recall",
          title: "Mathesis: spaced review of due cards",
          group: "Mathesis",
          palette: true,
          slash: { name: "recall", arguments: true },
          run: async (input) => {
            const topic = topicArg(input)
            if (!topic) {
              const count = (await rpc().due({}, at()).catch(() => undefined)) as { due: number } | undefined
              if (count?.due === 0) return context.ui.toast.show({ title: "Mathesis", message: "No cards are due.", variant: "info" })
            }
            return start({ kind: "recall", topic })
          },
        },
        {
          id: "mathesis.practice",
          title: "Mathesis: practice with what you hold",
          group: "Mathesis",
          palette: true,
          slash: { name: "practice", arguments: true },
          run: (input) => start({ kind: "practice", topic: topicArg(input) }),
        },
        {
          id: "mathesis.status",
          title: "Mathesis: status",
          group: "Mathesis",
          palette: true,
          slash: { name: "mathesis", arguments: true },
          // `/mathesis panel` toggles the side panel; `/mathesis` shows the status.
          run: (input) => (input?.trim() === "panel" ? togglePanel() : showStatus()),
        },
        {
          id: "mathesis.panel",
          title: "Mathesis: toggle the side panel",
          group: "Mathesis",
          palette: true,
          slash: { name: "mathesis-panel" },
          // Bind a key with the plugin option `panelKey` (for example "ctrl+x m"), or through the keybind config by id.
          ...(typeof context.options.panelKey === "string" ? { bind: context.options.panelKey } : {}),
          run: () => togglePanel(),
        },
        {
          id: "mathesis.setup",
          title: "Mathesis: setup",
          group: "Mathesis",
          palette: true,
          slash: { name: "mathesis-setup" },
          run: () => setupCommand(),
        },
      ],
      bindings: ["mathesis.panel"],
    }))

    return () => stops.forEach((stop) => stop())
  },
})
