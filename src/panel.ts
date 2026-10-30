import { MARK_SYMBOL, planRows, type NodeMark } from "./plan.ts"
import { cardCount, dueLabel, topicPlan, type Runtime } from "./runtime.ts"
import { dueFirst, isDue } from "./srs/fsrs.ts"
import { getSession } from "./state.ts"

const DUE_SHOWN = 10

export interface PanelRow {
  /** Indentation level; the TUI indents wrapped lines too. */
  depth: number
  text: string
  tone?: "heading" | "muted" | "current"
}

/** The Mathesis side panel for one session: phase, the plan as an indented dependency list, and the cards due now. */
export async function panel(rt: Runtime, sessionID: string): Promise<{ title: string; rows: PanelRow[] }> {
  const now = rt.now()
  const state = await getSession(rt.store, sessionID)
  const { ideas } = await rt.vault.listIdeas()
  const byId = new Map(ideas.map((idea) => [idea.id, idea]))
  const rows: PanelRow[] = []
  const topic = state?.topic ? await rt.vault.readTopic(state.topic).catch(() => undefined) : undefined
  const title = topic ? `Mathesis: ${topic.goal}` : state ? `Mathesis: ${state.phase}` : "Mathesis"
  if (state) {
    rows.push({ depth: 0, text: `Phase: ${state.phase}${state.done?.length ? ` · done this session: ${state.done.length}` : ""}`, tone: "muted" })
  } else {
    rows.push({ depth: 0, text: "Not a Mathesis session. Start one with /learn, /recall or /practice.", tone: "muted" })
  }
  const plan = topicPlan(topic)
  if (plan) {
    const mark = (id: string): NodeMark => {
      if (state?.currentNode === id) return "current"
      const idea = byId.get(id)
      if (!idea?.srs) return "none"
      return isDue(idea.srs, now) ? "due" : "held"
    }
    rows.push({ depth: 0, text: "" }, { depth: 0, text: "Plan (foundations first)", tone: "heading" })
    for (const row of planRows(plan, mark)) {
      const needs = row.needs.length ? `  ← ${row.needs.join(", ")}` : ""
      rows.push({ depth: row.depth, text: `${MARK_SYMBOL[row.mark]} ${row.title}${needs}`, ...(row.mark === "current" ? { tone: "current" as const } : {}) })
    }
    rows.push({ depth: 0, text: "✓ card · ↻ due · ▶ now · · to learn", tone: "muted" })
  } else if (state?.currentNode && byId.has(state.currentNode)) {
    rows.push({ depth: 0, text: "" }, { depth: 0, text: `Now: ${state.currentNode}`, tone: "current" })
  }
  const due = dueFirst(ideas, now)
  rows.push({ depth: 0, text: "" }, { depth: 0, text: due.length ? `Due now: ${cardCount(due.length)}` : "No cards due now.", tone: "heading" })
  for (const idea of due.slice(0, DUE_SHOWN)) rows.push({ depth: 1, text: `↻ ${idea.id} (${dueLabel(idea, now)})` })
  if (due.length > DUE_SHOWN) rows.push({ depth: 1, text: `… and ${due.length - DUE_SHOWN} more`, tone: "muted" })
  return { title, rows }
}
