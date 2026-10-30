import { Plugin } from "@opencode/plugin"
import { QuestionBroker } from "./broker.ts"
import { promptCache } from "./compose.ts"
import { resolveConfig } from "./config.ts"
import { Mathesis, type SetupInput, type StartInput } from "./rpc.ts"
import type { Runtime } from "./runtime.ts"
import { AGENT_NAME, setup, startSession } from "./sessions.ts"
import { status } from "./status.ts"
import { getSession } from "./state.ts"
import { Vault } from "./store/vault.ts"
import { isDue } from "./srs/fsrs.ts"
import { NAMESPACE, registerTools } from "./tools/define.ts"
import { practiceTools } from "./tools/practice.ts"
import { noteLearnerReply, questionTools } from "./tools/questions.ts"
import { reviewTools } from "./tools/review.ts"
import { teachTools } from "./tools/teach.ts"
import { topicTools } from "./tools/topics.ts"
import { topicIdeas } from "./runtime.ts"

type Emit = <N extends "questionAsked" | "questionClosed" | "planUpdated" | "cardsChanged">(name: N, data: Record<string, unknown>) => void

export default Plugin.define({
  id: "mathesis",
  async setup(ctx) {
    const config = resolveConfig(ctx.options)
    const vault = new Vault(config.vault)
    const stop = new AbortController()

    // Events go out through the RPC registration, which exists only after register(); queue nothing before it.
    let emit: Emit = () => {}
    const broker = new QuestionBroker(
      {
        asked: (data) => emit("questionAsked", data),
        closed: (data) => emit("questionClosed", data),
      },
      { claimTimeoutMs: Number(ctx.options.claimTimeoutMs) > 0 ? Number(ctx.options.claimTimeoutMs) : 4000, showTimeoutMs: 15_000 },
    )

    const rt: Runtime = {
      config,
      vault,
      store: ctx.storage,
      broker,
      prompt: promptCache(),
      now: () => new Date(),
      events: {
        planUpdated: (data) => emit("planUpdated", data),
        cardsChanged: (data) => emit("cardsChanged", data),
      },
      renameSession: async (sessionID, title) => {
        const session = await ctx.session.get({ sessionID })
        if (!session.title?.startsWith("Mathesis:")) await ctx.session.update({ sessionID, title })
      },
    }

    const registration = await ctx.rpc.register(Mathesis, {
      claim: async (input) => {
        const { questionID } = input as { questionID: string }
        return broker.claim(questionID) as never
      },
      shown: async (input) => ({ accepted: broker.shown((input as { formID: string }).formID) }),
      relay: async (input) => {
        const { formID, answer, cancelled, message } = input as {
          formID: string
          answer?: Record<string, unknown>
          cancelled?: boolean
          message?: string
        }
        const accepted = cancelled ? broker.formCancelled(formID, message) : answer ? broker.formReplied(formID, answer) : false
        return { accepted }
      },
      pending: async (input) => {
        const { sessionID } = (input ?? {}) as { sessionID?: string }
        return { questions: broker.pending(sessionID) } as never
      },
      start: async (input, context) => {
        try {
          return await startSession(ctx, rt, input as StartInput)
        } catch (error) {
          return context.error("invalid", (error as Error).message, { reason: (error as Error).message })
        }
      },
      topics: async () => {
        const now = rt.now()
        const [{ topics }, { ideas }] = await Promise.all([vault.listTopics(), vault.listIdeas()])
        return {
          topics: topics.map((topic) => {
            const own = topicIdeas(topic, ideas)
            return { id: topic.id, goal: topic.goal, ideas: own.length, due: own.filter((i) => isDue(i.srs, now)).length }
          }),
        }
      },
      status: async () => status(rt),
      setup: async (input) => setup(rt, (input ?? {}) as SetupInput),
    })
    emit = (name, data) => void registration.events.emit(name as never, data as never).catch(() => {})

    // The server watches the forms itself, so an answer reaches the waiting tool even if the TUI is gone.
    void (async () => {
      while (!stop.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ types: ["form.replied", "form.cancelled"], signal: stop.signal })) {
            if (event.type === "form.replied") broker.formReplied(event.data.id, event.data.answer as Record<string, unknown>)
            else if (event.type === "form.cancelled") broker.formCancelled(event.data.id)
          }
        } catch {
          if (stop.signal.aborted) return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    // The phase prompt: fixed per phase, so the cached prompt prefix changes at most once per session (handoff §2c).
    // Sessions that are not Mathesis sessions (another agent, no Mathesis state) do not see the Mathesis tools; this
    // depends only on the session, so the tool list stays the same within it.
    await ctx.session.hook("context", async (event) => {
      const state = await getSession(rt.store, event.sessionID)
      if (state) event.system.push({ type: "text", text: rt.prompt(state.phase) })
      else if (event.agent !== AGENT_NAME) {
        for (const name of Object.keys(event.tools)) if (name.startsWith(`${NAMESPACE}_`)) delete event.tools[name]
      }
    })

    // After a fallback, a reply from the learner (a message, or the built-in question form) unlocks answer_record.
    await ctx.session.hook("prompt", (event) => noteLearnerReply(rt, event.sessionID))
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool === "question" && event.status === "completed") await noteLearnerReply(rt, event.sessionID)
    })

    await ctx.tool.transform((editor) => registerTools(editor, rt, [...topicTools, ...questionTools, ...teachTools, ...reviewTools, ...practiceTools]))

    return () => {
      stop.abort()
      broker.abortAll()
    }
  },
})
