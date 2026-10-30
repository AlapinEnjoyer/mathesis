// Phase 0 spike (TUI side). Enabled only when MATHESIS_SPIKE=1. Removed before phase 1 merges.
import type { Plugin } from "@opencode/plugin/tui"
type Context = Plugin.Context
import { appendFileSync } from "node:fs"
import { Mathesis, type AnswerInput, type QuestionAsked } from "../rpc.ts"

const logFile = process.env.MATHESIS_SPIKE_LOG
function spikeLog(event: string, data: Record<string, unknown> = {}) {
  if (!logFile) return
  appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), side: "tui", event, ...data }) + "\n")
}

const CONFIDENCE = ["10", "30", "50", "70", "90", "100"]

export function setupSpikeTui(context: Context) {
  const rpc = context.client.rpc(Mathesis)
  const stops: Array<() => void> = []

  async function viaDialog(q: QuestionAsked): Promise<AnswerInput> {
    let choice: string | undefined
    let text: string | undefined
    if (q.options?.length) {
      choice = await context.ui.dialog.select({
        title: q.prompt,
        options: [
          ...q.options.map((o) => ({ title: o, value: o })),
          { title: "I don't know", value: "__dont_know__" },
        ],
      })
      if (choice === undefined) return { questionID: q.questionID, cancelled: true }
      if (choice === "__dont_know__") return { questionID: q.questionID, dontKnow: true }
    } else {
      text = await context.ui.dialog.prompt({ title: q.prompt, placeholder: "Your answer (empty = I don't know)" })
      if (text === undefined) return { questionID: q.questionID, cancelled: true }
      if (text.trim() === "") return { questionID: q.questionID, dontKnow: true }
    }
    const confidence = await context.ui.dialog.select({
      title: "How sure are you?",
      options: CONFIDENCE.map((c) => ({ title: `${c}%`, value: Number(c) })),
    })
    const thinking = await context.ui.dialog.prompt({ title: "Your thinking (optional)", placeholder: "Why?" })
    return { questionID: q.questionID, choice, text, confidence, thinking: thinking || undefined }
  }

  async function viaForm(q: QuestionAsked): Promise<AnswerInput> {
    const form = await context.client.session.form.create({
      sessionID: q.sessionID,
      title: q.prompt,
      fields: [
        {
          key: "answer",
          type: "string",
          title: q.prompt,
          required: true,
          ...(q.options?.length
            ? { options: [...q.options.map((o) => ({ value: o, label: o })), { value: "__dont_know__", label: "I don't know" }], custom: false }
            : { placeholder: "Your answer" }),
        },
        {
          key: "confidence",
          type: "string",
          title: "How sure are you?",
          required: true,
          options: CONFIDENCE.map((c) => ({ value: c, label: `${c}%` })),
          when: [{ key: "answer", op: "neq", value: "__dont_know__" }],
        },
        { key: "thinking", type: "string", title: "Your thinking (optional)", required: false },
      ],
    })
    spikeLog("form.created", { form })
    return new Promise((resolve) => {
      const stop = context.data.on("form.replied", (event) => {
        if (event.data.id !== form.id) return
        stop()
        const a = event.data.answer as Record<string, unknown>
        spikeLog("form.replied", { answer: a })
        const raw = String(a.answer ?? "")
        resolve({
          questionID: q.questionID,
          dontKnow: raw === "__dont_know__" || undefined,
          ...(q.options?.length ? { choice: raw } : { text: raw }),
          confidence: a.confidence ? Number(a.confidence) : undefined,
          thinking: a.thinking ? String(a.thinking) : undefined,
        })
      })
      const stopCancel = context.data.on("form.cancelled", (event) => {
        if (event.data.id !== form.id) return
        stopCancel()
        resolve({ questionID: q.questionID, cancelled: true })
      })
    })
  }

  stops.push(
    rpc.events.on("questionAsked", async (event) => {
      const q = event.data as QuestionAsked
      const route = context.ui.router.current()
      spikeLog("questionAsked", { q, route })
      try {
        const answer = q.mode === "form" ? await viaForm(q) : await viaDialog(q)
        const result = await rpc.answer(answer)
        spikeLog("answer.sent", { answer, result })
      } catch (error) {
        spikeLog("error", { message: String(error) })
      }
    }),
  )

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "mathesis.spike.new",
        title: "Mathesis spike: new session",
        slash: { name: "mathesis-spike-new", arguments: true },
        run: async (input) => {
          const model = context.ui.model.current()
          const location = context.location ?? context.data.location.default()
          const session = await context.client.session.create({
            title: "Mathesis: spike",
            agent: "plan",
            model: model ? { providerID: model.providerID, id: model.modelID } : undefined,
            location: { directory: location.directory },
          })
          spikeLog("slash.created", { session })
          context.ui.router.navigate({ type: "session", sessionID: session.id })
          await context.client.session.prompt({ sessionID: session.id, text: input?.trim() || "Say hello in five words." })
        },
      },
    ],
  }))

  spikeLog("setup", { version: context.app.version })
  context.ui.toast.show({ message: "Mathesis spike TUI loaded", variant: "info" })
  return () => stops.forEach((stop) => stop())
}
