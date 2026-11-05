import { needsText, planLayers, planLegend, progressBar, renderPlanDiagram, type NodeMark } from "./plan.ts"
import { cardCount, dueLabel, topicPlan, type Runtime } from "./runtime.ts"
import { dueFirst, endOfDay, isDue } from "./srs/fsrs.ts"
import { getSession } from "./state.ts"
import { shortGoal } from "./store/vault.ts"
import { readLog, type LogEntry, type ReviewEntry } from "./store/log.ts"

const DUE_SHOWN = 10

export interface PanelRow {
  /** Indentation level; the TUI indents wrapped lines too. */
  depth: number
  text: string
  tone?: "heading" | "muted" | "current"
  /** A plan step: its number, state and prerequisites ("needs 2, 3"); `text` is the title. */
  step?: { n: number; mark: NodeMark; needs: string }
  /** Text that only stands in for a drawn plan; a client that draws the steps itself skips these rows. */
  plan?: boolean
}

/** The Mathesis side panel for one session: phase, the plan as an indented dependency list, and the cards due today. */
export async function panel(rt: Runtime, sessionID: string): Promise<{ title: string; rows: PanelRow[]; progress?: { learned: number; total: number } }> {
  const now = rt.now()
  const state = await getSession(rt.store, sessionID)
  const [{ ideas }, { entries }] = await Promise.all([rt.vault.listIdeas(), readLog(rt.vault.logPath)])
  const byId = new Map(ideas.map((idea) => [idea.id, idea]))
  const rows: PanelRow[] = []
  const topic = state?.topic ? await rt.vault.readTopic(state.topic).catch(() => undefined) : undefined
  const title = topic ? `Mathesis: ${shortGoal(topic.goal)}` : state ? `Mathesis: ${state.phase}` : "Mathesis"
  if (state) {
    rows.push({ depth: 0, text: `Phase: ${state.phase}${state.done?.length ? ` · done this session: ${state.done.length}` : ""}`, tone: "muted" })
    const summary = sessionSummary(entries.filter((entry) => entry.sessionID === sessionID))
    if (summary) rows.push({ depth: 0, text: `This session: ${summary}`, tone: "muted" })
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
    const learned = plan.nodes.filter((node) => byId.get(node.id)?.srs).length
    rows.push({ depth: 0, text: "" }, { depth: 0, text: `Plan  ${progressBar(learned, plan.nodes.length)}`, tone: "heading", plan: true })
    const layers = planLayers(plan, mark)
    for (const row of layers) {
      if (row.first) rows.push({ depth: 0, text: row.layer, tone: "muted", plan: true })
      rows.push({ depth: 0, text: row.title, step: { n: row.n, mark: row.mark, needs: needsText(row.needs) }, ...(row.mark === "current" ? { tone: "current" as const } : {}) })
    }
    const legend = planLegend(layers.map((row) => row.mark))
    if (legend) rows.push({ depth: 0, text: legend, tone: "muted", plan: true })
    // The same boxes the topic note's plan describes, drawn by code so the panel shows the map without the model's help.
    rows.push({ depth: 0, text: "", plan: true }, { depth: 0, text: "Map", tone: "heading", plan: true })
    for (const line of renderPlanDiagram(plan).split("\n")) rows.push({ depth: 0, text: line, tone: "muted", plan: true })
  } else if (state?.currentNode && byId.has(state.currentNode)) {
    rows.push({ depth: 0, text: "" }, { depth: 0, text: `Now: ${state.currentNode}`, tone: "current" })
  }
  const due = dueFirst(ideas, endOfDay(now))
  rows.push({ depth: 0, text: "" }, { depth: 0, text: due.length ? `Due today: ${cardCount(due.length)}` : "No cards due today.", tone: "heading" })
  for (const idea of due.slice(0, DUE_SHOWN)) rows.push({ depth: 1, text: `↻ ${idea.id} (${dueLabel(idea, now)})` })
  if (due.length > DUE_SHOWN) rows.push({ depth: 1, text: `… and ${due.length - DUE_SHOWN} more`, tone: "muted" })
  return { title, rows, ...(plan ? { progress: { learned: plan.nodes.filter((node) => byId.get(node.id)?.srs).length, total: plan.nodes.length } } : {}) }
}

/** What this session did, from its log entries: cards from passed checks, reviews, practice problems, misconceptions. */
export function sessionSummary(entries: readonly LogEntry[]): string {
  const reviews = entries.filter((e): e is ReviewEntry => e.mode !== "pull")
  const isMisconception = (e: ReviewEntry) => e.ideaId.startsWith("misconception-")
  const own = reviews.filter((e) => !isMisconception(e))
  const parts: [number, string, string][] = [
    [own.filter((e) => e.mode === "teach").length, "card from a check", "cards from checks"],
    [own.filter((e) => e.mode === "review").length, "review", "reviews"],
    [own.filter((e) => e.mode === "practice").length, "practice problem", "practice problems"],
    [new Set(reviews.filter(isMisconception).map((e) => e.ideaId)).size, "misconception", "misconceptions"],
  ]
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(" · ")
}
