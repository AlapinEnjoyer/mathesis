import { Plugin } from "@opencode/plugin/tui"
import { Mathesis, type ModelRefInput } from "./rpc.ts"

type Context = Plugin.Context
type FormSpec = { id: string; title: string; fields: unknown[]; metadata?: Record<string, unknown> }

const FORM_PREFIX = "frm_mathesis_"
const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error)

export default Plugin.define({
  id: "mathesis.tui",
  setup(context) {
    // Read the client where it is used: it changes when the server restarts.
    const rpc = () => context.client.rpc(Mathesis)
    const stops: Array<() => void> = []

    const viewing = (sessionID: string) => {
      const route = context.ui.router.current()
      return route.type === "session" && route.sessionID === sessionID
    }

    async function showForm(sessionID: string, form: FormSpec) {
      try {
        await context.client.session.form.create({ sessionID, ...form } as never)
      } catch (error) {
        // A form with this id already exists (another TUI, or a restart): nothing to do.
        const existing = await context.client.session.form.get({ sessionID, formID: form.id }).catch(() => undefined)
        if (!existing) throw error
      }
      if (!viewing(sessionID)) {
        context.ui.toast.show({ title: "Mathesis question", message: form.title, sessionID, variant: "info", duration: 8000 })
        void context.attention.notify({ title: "Mathesis", message: form.title, notification: { when: "blurred" }, sound: { name: "question" } })
      }
    }

    async function claimAndShow(questionID: string) {
      const claim = (await rpc().claim({ questionID })) as { accepted: boolean; sessionID?: string; form?: FormSpec }
      if (claim.accepted && claim.sessionID && claim.form) await showForm(claim.sessionID, claim.form)
    }

    /** After a restart: show open questions again, and pass on answers given while nobody was listening. */
    async function recover() {
      const { questions } = (await rpc().pending({})) as {
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
        else if (detail.state?.status === "answered") await rpc().relay({ formID: question.form.id, answer: detail.state.answer })
        else if (detail.state?.status === "cancelled") {
          await rpc().relay({ formID: question.form.id, cancelled: true, ...(detail.state.message ? { message: detail.state.message } : {}) })
        }
      }
    }

    stops.push(
      rpc().events.on("questionAsked", (event) => {
        void claimAndShow((event.data as { questionID: string }).questionID).catch((error) =>
          context.ui.toast.show({ title: "Mathesis", message: `Could not show the question: ${errorText(error)}`, variant: "error" }),
        )
      }),
      rpc().events.on("questionClosed", (event) => {
        const { reason, sessionID, formID } = event.data as { reason: string; sessionID: string; formID: string }
        if (reason === "aborted" || reason === "fallback") {
          void context.client.session.form.cancel({ sessionID, formID, message: "The question was closed." }).catch(() => {})
        }
      }),
      rpc().events.on("cardsChanged", (event) => {
        for (const id of (event.data as { added: string[] }).added) context.ui.toast.show({ message: `+1 card: ${id}`, variant: "success", duration: 3000 })
      }),
      // Relay form outcomes too; the server also watches them, and the first one wins.
      context.data.on("form.replied", (event) => {
        if (event.data.id.startsWith(FORM_PREFIX)) void rpc().relay({ formID: event.data.id, answer: event.data.answer }).catch(() => {})
      }),
      context.data.on("form.cancelled", (event) => {
        if (event.data.id.startsWith(FORM_PREFIX)) void rpc().relay({ formID: event.data.id, cancelled: true }).catch(() => {})
      }),
    )
    void recover().catch(() => {})

    const currentModel = (): ModelRefInput | undefined => {
      const model = context.ui.model.current()
      return model ? { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } : undefined
    }

    async function start(input: { kind: "learn" | "recall" | "practice"; goal?: string; topic?: string }) {
      try {
        const directory = (context.location ?? context.data.location.default()).directory
        const model = currentModel()
        const result = (await rpc().start({ ...input, directory, ...(model ? { model } : {}) })) as {
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
      const { topics } = (await rpc().topics({})) as { topics: { id: string; goal: string; ideas: number; due: number }[] }
      const NEW = "\u0000new"
      const choice = await context.ui.dialog.select({
        title: "Mathesis: learn",
        placeholder: "Search topics",
        options: [
          { title: "New topic…", value: NEW, description: "Learn something new" },
          ...topics.map((t) => ({
            title: t.goal,
            value: t.id,
            description: `${t.ideas} cards${t.due ? `, ${t.due} due` : ""}`,
            category: "Continue",
          })),
        ],
      })
      if (choice === undefined) return
      if (choice !== NEW) return start({ kind: "learn", topic: choice })
      const typed = await context.ui.dialog.prompt({ title: "What do you want to understand?", placeholder: "how binary search finds its bounds" })
      if (typed?.trim()) return start({ kind: "learn", goal: typed.trim() })
    }

    async function setupCommand() {
      const same = await context.ui.dialog.confirm({
        title: "Mathesis setup",
        message: "Use one model for everything? (Recommended: the session's model is used for teaching, review and background work.)",
        label: { confirm: "Yes, one model", cancel: "No, choose models" },
      })
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
        const result = (await rpc().setup(same === undefined ? {} : same ? { sameModel: true } : { sameModel: false, models })) as {
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
          id: "mathesis.setup",
          title: "Mathesis: setup",
          group: "Mathesis",
          palette: true,
          slash: { name: "mathesis-setup" },
          run: () => setupCommand(),
        },
      ],
    }))

    return () => stops.forEach((stop) => stop())
  },
})
