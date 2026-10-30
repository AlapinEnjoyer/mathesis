import { PHASES, type Phase } from "../phases.ts"
import { renderPlanTree, type NodeMark } from "../plan.ts"
import { dueLabel, ideaState, Refusal, topicIdeas, topicPlan, type Runtime } from "../runtime.ts"
import { isDue } from "../srs/fsrs.ts"
import { setPhase, type SessionState } from "../state.ts"
import { isSlug, slugify, type Idea } from "../store/vault.ts"
import { oneOf, schema, text, type ToolSpec } from "./define.ts"

const firstLine = (value: string) => value.split("\n").find((line) => line.trim())?.trim() ?? ""
const OTHER_CARDS_SHOWN = 40

export function refuseWhileOpen(state: SessionState | undefined) {
  if (state?.openQuestion && !state.openQuestion.fallback) {
    throw new Refusal(`a question is still open (${state.openQuestion.questionID}). Wait for the learner's answer first.`)
  }
}

export async function statusText(rt: Runtime, state: SessionState | undefined, topicId?: string): Promise<string> {
  const now = rt.now()
  const id = topicId ?? state?.topic
  const { ideas, errors } = await rt.vault.listIdeas()
  const lines: string[] = []
  const topic = id ? await rt.vault.readTopic(id) : undefined
  if (id && !topic) throw new Refusal(`there is no topic "${id}". Use mathesis_topic_list or mathesis_topic_start.`)
  let own: Idea[] = []
  if (topic) {
    lines.push(`# ${topic.goal} (\`${topic.id}\`)`)
    if (state && state.topic === topic.id) lines.push(`Session phase: ${state.phase}${state.currentNode ? ` · current node: \`${state.currentNode}\`` : ""}`)
    lines.push("", "## Assessment", topic.assessment?.trim() || "(not probed yet)")
    own = topicIdeas(topic, ideas)
    const byId = new Map(ideas.map((idea) => [idea.id, idea]))
    const plan = topicPlan(topic)
    lines.push("", "## Plan")
    if (plan) {
      const mark = (nodeId: string): NodeMark => {
        if (state?.topic === topic.id && state.currentNode === nodeId) return "current"
        const idea = byId.get(nodeId)
        if (!idea?.srs) return "none"
        return isDue(idea.srs, now) ? "due" : "held"
      }
      lines.push("Legend: ✓ held card · ↻ card due · ▶ current node · · not yet a card", renderPlanTree(plan, mark))
    } else lines.push("(no plan yet)")
    lines.push("", "## Cards in this topic")
    if (own.length === 0) lines.push("(none yet)")
    for (const idea of own) {
      lines.push(`- \`${idea.id}\` (${idea.kind}, ${ideaState(idea, now)}, ${dueLabel(idea, now)}): ${firstLine(idea.claim)}`)
    }
  }
  const ownIds = new Set(own.map((idea) => idea.id))
  const others = ideas.filter((idea) => !ownIds.has(idea.id) && idea.srs)
  if (others.length) {
    lines.push("", topic ? "## Other cards the learner holds" : "## Cards the learner holds")
    const order = { due: 0, shaky: 1, held: 2, stable: 3, new: 4 }
    const sorted = others.sort((a, b) => order[ideaState(a, now)] - order[ideaState(b, now)])
    for (const idea of sorted.slice(0, OTHER_CARDS_SHOWN)) {
      lines.push(`- \`${idea.id}\`${idea.topic ? ` [${idea.topic}]` : ""} (${ideaState(idea, now)}): ${firstLine(idea.claim)}`)
    }
    if (sorted.length > OTHER_CARDS_SHOWN) lines.push(`- … and ${sorted.length - OTHER_CARDS_SHOWN} more`)
  }
  if (errors.length) {
    lines.push("", "## Notes Mathesis could not read (tell the learner)")
    for (const error of errors) lines.push(`- ${error.file}: ${error.message}`)
  }
  return lines.join("\n").trim() || "The vault is empty: no topics and no cards yet."
}

export const topicTools: ToolSpec[] = [
  {
    name: "topic_start",
    description:
      "Start or continue a Mathesis topic in this session. Use it when the learner asks to learn something and the session has no topic yet, or to switch to another topic. A new topic starts in the probe phase; a topic that already has a plan continues in the teach phase. Returns the topic status.",
    input: schema.object(
      {
        goal: schema.str("What the learner wants to understand, in their words (one sentence)."),
        topic: schema.str("Optional id of an existing topic to continue (from mathesis_topic_list)."),
      },
      ["goal"],
    ),
    async run(input, call, rt) {
      refuseWhileOpen(call.state)
      const goal = text(input, "goal", { max: 300 })!
      const requested = text(input, "topic", { optional: true })
      if (call.state?.topic && !requested) {
        // The session already has a topic (for example from /learn): never create a second one from a reworded goal.
        return `This session already works on the topic \`${call.state.topic}\` (phase ${call.state.phase}). Continue it. To switch to another topic, pass its id as \`topic\` (a new id starts a new topic).\n\n${await statusText(rt, call.state)}`
      }
      const id = requested ? (isSlug(requested) ? requested : slugify(requested, 40)) : slugify(goal, 40)
      if (call.state && (call.state.phase === "review" || call.state.phase === "practice")) {
        throw new Refusal(`this is a ${call.state.phase} session. Ask the learner to start a new session with /learn.`)
      }
      let topic = await rt.vault.readTopic(id)
      const created = !topic
      if (!topic) topic = await rt.vault.updateTopic(id, { goal }, rt.now())
      const phase: Phase = call.state?.topic === id ? call.state.phase : topicPlan(topic) ? "teach" : "probe"
      const state = await setPhase(rt.store, call.sessionID, phase, { topic: id, currentNode: undefined }, rt.now())
      await rt.renameSession?.(call.sessionID, `Mathesis: ${topic.goal}`).catch(() => {})
      const head = created ? `Created topic \`${id}\`. Phase: probe.` : `Continuing topic \`${id}\`. Phase: ${phase}.`
      return `${head}\n\n${await statusText(rt, state, id)}`
    },
  },
  {
    name: "topic_list",
    description: "List the learner's topics with their number of cards and how many are due.",
    input: schema.object({}),
    async run(_input, _call, rt) {
      const now = rt.now()
      const [{ topics, errors }, { ideas }] = await Promise.all([rt.vault.listTopics(), rt.vault.listIdeas()])
      if (topics.length === 0) return "No topics yet."
      const lines = topics.map((topic) => {
        const own = topicIdeas(topic, ideas)
        const due = own.filter((idea) => isDue(idea.srs, now)).length
        return `- \`${topic.id}\`: ${topic.goal} (${own.length} cards, ${due} due${topicPlan(topic) ? "" : ", no plan yet"})`
      })
      for (const error of errors) lines.push(`- (unreadable) ${error.file}: ${error.message}`)
      return lines.join("\n")
    },
  },
  {
    name: "topic_status",
    description:
      "Where the learner stands: the session phase, the topic's assessment, the plan with the current node and which nodes are already cards, and the cards the learner holds (held, stable, shaky, due). Call it at the start of a turn when you resume, and in the probe before choosing strands.",
    input: schema.object({ topic: schema.str("Optional topic id; defaults to this session's topic.") }),
    async run(input, call, rt) {
      return statusText(rt, call.state, text(input, "topic", { optional: true }))
    },
  },
  {
    name: "phase_set",
    description:
      "Change this session's phase. Normally not needed: mathesis_probe_done moves probe → teach by itself. Use it to go back from teach to probe (re-probe a topic) or to set the first phase of a session.",
    input: schema.object({ phase: schema.enum(PHASES, "The new phase.") }, ["phase"]),
    async run(input, call, rt) {
      refuseWhileOpen(call.state)
      const phase = oneOf(input, "phase", PHASES)
      if ((phase === "probe" || phase === "teach") && !call.state?.topic) {
        throw new Refusal("the session has no topic yet. Call mathesis_topic_start first.")
      }
      try {
        const state = await setPhase(rt.store, call.sessionID, phase, {}, rt.now())
        return `Phase is now ${state.phase}.`
      } catch (error) {
        throw new Refusal((error as Error).message)
      }
    },
  },
]
