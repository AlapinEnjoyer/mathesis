// Phase 0 spike: throwaway code that answers the questions in docs/handoff.md §8.0.
// Enabled only when MATHESIS_SPIKE=1. Removed before phase 1 merges.
import type { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { Mathesis, type AnswerInput, type QuestionAsked } from "../rpc.ts"

type Ctx = Plugin.Context

const logFile = process.env.MATHESIS_SPIKE_LOG
export function spikeLog(event: string, data: Record<string, unknown> = {}) {
  if (!logFile) return
  appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n")
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)

export async function setupSpike(ctx: Ctx) {
  const pending = new Map<string, { question: QuestionAsked; resolve: (answer: AnswerInput) => void }>()
  const phases = new Map<string, string>()

  const registration = await ctx.rpc.register(Mathesis, {
    answer: async (input) => {
      const answer = input as AnswerInput
      const open = pending.get(answer.questionID)
      spikeLog("rpc.answer", { answer, found: !!open })
      if (!open) return { accepted: false }
      pending.delete(answer.questionID)
      open.resolve(answer)
      return { accepted: true }
    },
    pending: async (input) => {
      const { sessionID } = (input ?? {}) as { sessionID?: string }
      const questions = [...pending.values()]
        .map((p) => p.question)
        .filter((q) => !sessionID || q.sessionID === sessionID)
      return { questions }
    },
  })

  // (c)/(g): fixed per-phase system text; log hashes so we can see what changes between turns.
  await ctx.session.hook("context", (event) => {
    const phase = phases.get(event.sessionID)
    if (phase) event.system.push({ type: "text", text: `Mathesis spike phase prompt: ${phase}. Keep answers short.` })
    if (phase === "drop-tools") delete event.tools["mathesis_spike_generate"]
    spikeLog("hook.context", {
      sessionID: event.sessionID,
      agent: event.agent,
      model: event.model,
      phase,
      systemHash: hash(event.system.map((s) => s.text)),
      systemParts: event.system.length,
      toolsHash: hash(Object.keys(event.tools).sort()),
      toolCount: Object.keys(event.tools).length,
      messages: event.messages.length,
    })
  })

  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "mathesis", description: "Mathesis learning tools" })
    editor.add({
      name: "spike_ask",
      description:
        "Spike: ask the learner one question through the Mathesis TUI and wait for the answer. mode 'dialog' uses a custom dialog, 'form' uses a native session form.",
      input: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["dialog", "form"] },
        },
        required: ["prompt", "mode"],
        additionalProperties: false,
      },
      options: { namespace: "mathesis", codemode: false },
      execute: async (input, context) => {
        const { prompt, options, mode } = input as { prompt: string; options?: string[]; mode: string }
        const question: QuestionAsked = {
          questionID: crypto.randomUUID(),
          sessionID: context.sessionID,
          kind: options?.length ? "quiz" : "explain",
          prompt,
          ...(options?.length ? { options } : {}),
          mode,
        }
        const started = Date.now()
        const answer = await new Promise<AnswerInput>((resolve, reject) => {
          pending.set(question.questionID, { question, resolve })
          context.signal.addEventListener("abort", () => {
            pending.delete(question.questionID)
            reject(new Error("aborted"))
          })
          spikeLog("tool.spike_ask.emit", { question })
          void registration.events.emit("questionAsked", question)
        })
        void registration.events.emit("questionClosed", { questionID: question.questionID })
        spikeLog("tool.spike_ask.answered", { answer, elapsedMs: Date.now() - started })
        return { content: JSON.stringify({ answer, elapsedMs: Date.now() - started }) }
      },
    })

    editor.add({
      name: "spike_phase",
      description: "Spike: set the phase of this session (changes the injected system text).",
      input: {
        type: "object",
        properties: { phase: { type: "string" } },
        required: ["phase"],
        additionalProperties: false,
      },
      options: { namespace: "mathesis", codemode: false },
      execute: async (input, context) => {
        const { phase } = input as { phase: string }
        phases.set(context.sessionID, phase)
        await ctx.storage.set(`session/${context.sessionID}`, { phase })
        return { content: `phase=${phase}` }
      },
    })

    editor.add({
      name: "spike_instructions",
      description: "Spike: put a value into this session's instruction entries.",
      input: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      options: { namespace: "mathesis", codemode: false },
      execute: async (input, context) => {
        const { value } = input as { value: string }
        await ctx.session.instructions.entry.put({ sessionID: context.sessionID, key: "mathesis-spike", value })
        return { content: "ok" }
      },
    })

    editor.add({
      name: "spike_generate",
      description: "Spike: run a background generation with an optional model 'provider/model'.",
      input: {
        type: "object",
        properties: { model: { type: "string" } },
        additionalProperties: false,
      },
      options: { namespace: "mathesis", codemode: false },
      execute: async (input) => {
        const { model } = input as { model?: string }
        const ref = model ? { providerID: model.split("/")[0]!, id: model.split("/").slice(1).join("/") } : undefined
        const result = await ctx.experimental.generate.text({ prompt: "Reply with the single word: pong", model: ref })
        spikeLog("tool.spike_generate", { model, result })
        return { content: JSON.stringify(result) }
      },
    })

    editor.add({
      name: "spike_session",
      description: "Spike: create a new session with a given agent and model, then read it back.",
      input: {
        type: "object",
        properties: { agent: { type: "string" }, model: { type: "string" } },
        additionalProperties: false,
      },
      options: { namespace: "mathesis", codemode: false },
      execute: async (input) => {
        const { agent, model } = input as { agent?: string; model?: string }
        const ref = model ? { providerID: model.split("/")[0]!, id: model.split("/").slice(1).join("/") } : undefined
        const created = await ctx.session.create({
          title: "Mathesis: spike",
          agent,
          model: ref,
          location: { directory: ctx.location.directory },
        })
        const read = await ctx.session.get({ sessionID: created.id })
        spikeLog("tool.spike_session", { created, read })
        return { content: JSON.stringify(read) }
      },
    })
  })

  await ctx.command.transform((editor) => {
    editor.add({
      name: "mathesis-spike",
      description: "Spike: server command that prompts the current session",
      execute: async ({ sessionID, prompt, delivery }) => {
        spikeLog("command.mathesis-spike", { sessionID, prompt })
        await ctx.session.prompt({ sessionID, text: `Spike command ran with: ${prompt.text}`, delivery })
      },
    })
  })

  // (b): is there any way to add an agent? Record what the editor offers.
  await ctx.agent.transform((editor) => {
    spikeLog("agent.editor", { methods: Object.keys(editor), agents: editor.list().map((a) => a.id) })
  })

  spikeLog("setup", { directory: ctx.location.directory, version: ctx.app.version })
}
