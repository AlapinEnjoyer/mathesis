import { renderPlanTree, type NodeMark } from "./plan.ts"
import { dueLabel, topicPlan, type Runtime } from "./runtime.ts"
import { dueFirst, isDue } from "./srs/fsrs.ts"
import { getSession } from "./state.ts"

const DUE_SHOWN = 10

/** The text of the Mathesis side panel for one session: phase, the plan as a tree, and the due cards. */
export async function panel(rt: Runtime, sessionID: string): Promise<{ title: string; text: string }> {
  const now = rt.now()
  const state = await getSession(rt.store, sessionID)
  const { ideas } = await rt.vault.listIdeas()
  const byId = new Map(ideas.map((idea) => [idea.id, idea]))
  const lines: string[] = []
  let title = "Mathesis"
  const topic = state?.topic ? await rt.vault.readTopic(state.topic).catch(() => undefined) : undefined
  if (state) {
    title = topic ? `Mathesis: ${topic.goal}` : `Mathesis: ${state.phase === "review" ? "review" : state.phase}`
    lines.push(`Phase: ${state.phase}${state.done?.length ? ` · done this session: ${state.done.length}` : ""}`)
  } else lines.push("This session is not a Mathesis session. Start one with /learn, /recall or /practice.")
  const plan = topicPlan(topic)
  if (plan) {
    const mark = (id: string): NodeMark => {
      if (state?.currentNode === id) return "current"
      const idea = byId.get(id)
      if (!idea?.srs) return "none"
      return isDue(idea.srs, now) ? "due" : "held"
    }
    lines.push("", "Plan (foundations first)", renderPlanTree(plan, mark).replace(/ `[a-z0-9-]+`/g, ""), "", "✓ card · ↻ due · ▶ now · · to learn")
  } else if (state?.phase === "review" && state.currentNode) {
    const idea = byId.get(state.currentNode)
    if (idea) lines.push("", `Now: ${idea.id}`)
  }
  const due = dueFirst(ideas, now)
  lines.push("", due.length ? `Due (${due.length})` : "No cards due.")
  for (const idea of due.slice(0, DUE_SHOWN)) lines.push(`  ↻ ${idea.id} (${dueLabel(idea, now)})`)
  if (due.length > DUE_SHOWN) lines.push(`  … and ${due.length - DUE_SHOWN} more`)
  return { title, text: lines.join("\n") }
}
