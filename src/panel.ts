import { MARK_SYMBOL, planRows, type NodeMark } from "./plan.ts"
import { cardCount, dueLabel, topicPlan, type Runtime } from "./runtime.ts"
import { dueFirst, endOfDay, isDue } from "./srs/fsrs.ts"
import { getSession } from "./state.ts"
import { readLog, type LogEntry, type ReviewEntry } from "./store/log.ts"

const DUE_SHOWN = 10

export interface PanelRow {
  /** Indentation level; the TUI indents wrapped lines too. */
  depth: number
  text: string
  tone?: "heading" | "muted" | "current"
}

/** The Mathesis side panel for one session: phase, the plan as an indented dependency list, and the cards due today. */
export async function panel(rt: Runtime, sessionID: string): Promise<{ title: string; rows: PanelRow[] }> {
  const now = rt.now()
  const state = await getSession(rt.store, sessionID)
  const [{ ideas }, { entries }] = await Promise.all([rt.vault.listIdeas(), readLog(rt.vault.logPath)])
  const byId = new Map(ideas.map((idea) => [idea.id, idea]))
  const rows: PanelRow[] = []
  const topic = state?.topic ? await rt.vault.readTopic(state.topic).catch(() => undefined) : undefined
  const title = topic ? `Mathesis: ${topic.goal}` : state ? `Mathesis: ${state.phase}` : "Mathesis"
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
    rows.push(
      { depth: 0, text: "" },
      { depth: 0, text: `Plan: ${learned} of ${plan.nodes.length} steps have a card`, tone: "heading" },
      { depth: 0, text: "Foundations first:", tone: "muted" },
    )
    for (const row of planRows(plan, mark)) {
      const needs = row.needs.length ? `  ← ${row.needs.join(", ")}` : ""
      rows.push({ depth: row.depth, text: `${MARK_SYMBOL[row.mark]} ${row.title}${needs}`, ...(row.mark === "current" ? { tone: "current" as const } : {}) })
    }
    rows.push({ depth: 0, text: "✓ card · ↻ due · ▶ now · · to learn", tone: "muted" })
  } else if (state?.currentNode && byId.has(state.currentNode)) {
    rows.push({ depth: 0, text: "" }, { depth: 0, text: `Now: ${state.currentNode}`, tone: "current" })
  }
  const due = dueFirst(ideas, endOfDay(now))
  rows.push({ depth: 0, text: "" }, { depth: 0, text: due.length ? `Due today: ${cardCount(due.length)}` : "No cards due today.", tone: "heading" })
  for (const idea of due.slice(0, DUE_SHOWN)) rows.push({ depth: 1, text: `↻ ${idea.id} (${dueLabel(idea, now)})` })
  if (due.length > DUE_SHOWN) rows.push({ depth: 1, text: `… and ${due.length - DUE_SHOWN} more`, tone: "muted" })
  return { title, rows }
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
