// Adapted from LearnHarness (AGPL-3.0), src/agent/tools/mermaid-plan.ts, 2026-10-30; modified:
// node ids must be Mathesis slugs (hyphens only, so they can become idea ids), cycles are rejected,
// and the plan renders as an indented text tree for the terminal.
import { isSlug } from "./store/vault.ts"

export interface PlanNode {
  id: string
  title: string
}

/** `from` must be understood before `to`. */
export interface PlanEdge {
  from: string
  to: string
}

export interface Plan {
  nodes: PlanNode[]
  edges: PlanEdge[]
}

export type PlanParseResult = { ok: true; plan: Plan } | { ok: false; problems: string[] }

const HEADER = /^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*;?\s*$/i
const ARROW = /-->|==>|-\.->/
// Broad on purpose: every bad id reaches the specific slug message instead of a generic parse error.
const ENDPOINT = /^([^\s()[\]]+)\s*(?:\[([^[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/

interface Endpoint {
  id: string
  label?: string
}

function parseEndpoint(text: string): Endpoint | null {
  const match = ENDPOINT.exec(text.trim().replace(/;$/, ""))
  if (!match?.[1]) return null
  let label = (match[2] ?? match[3] ?? match[4] ?? "").trim()
  if (label.length >= 2 && /^(["']).*\1$/.test(label)) label = label.slice(1, -1).trim()
  return { id: match[1], label }
}

/** Parses the mermaid subset used for plans. Collects all problems, each with its line number. */
export function parsePlan(mermaid: string): PlanParseResult {
  const problems: string[] = []
  const lines = mermaid
    .replace(/^\s*```(?:mermaid)?\s*$/gim, "")
    .split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() && !line.trim().startsWith("%%"))
  if (first === -1) return { ok: false, problems: ["The plan is empty: expected `graph TD` with nodes and `-->` edges."] }
  const header = lines[first]!.trim()
  if (!HEADER.test(header)) problems.push(`line ${first + 1}: expected the header \`graph TD\` first, got \`${header}\`.`)

  const nodes = new Map<string, string>()
  const edges: PlanEdge[] = []
  const seen = new Set<string>()
  const register = ({ id, label }: Endpoint, no: number): boolean => {
    if (!isSlug(id)) {
      problems.push(
        `line ${no}: node id \`${id}\` must be a lowercase slug: a-z and 0-9 joined by single hyphens (e.g. \`chain-rule-intuition\`). Ids are permanent and become card ids.`,
      )
      return false
    }
    if (!nodes.has(id) || (label && nodes.get(id) === id)) nodes.set(id, label || nodes.get(id) || id)
    return true
  }

  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const no = i + 1
    if (!line || line.startsWith("%%")) continue
    const segments = line.split(ARROW)
    if (segments.length >= 2) {
      const endpoints = segments.map(parseEndpoint)
      if (endpoints.some((e) => !e)) {
        problems.push(`line ${no}: can't read the edge \`${line}\`; expected \`a["title"] --> b["title"]\`.`)
        continue
      }
      const valid = (endpoints as Endpoint[]).map((e) => register(e, no))
      for (let k = 0; k + 1 < endpoints.length; k++) {
        if (!valid[k] || !valid[k + 1]) continue
        const from = endpoints[k]!.id
        const to = endpoints[k + 1]!.id
        if (from === to) {
          problems.push(`line ${no}: \`${from} --> ${to}\` is a self-loop; a node can't require itself.`)
          continue
        }
        if (!seen.has(`${from}>${to}`)) {
          seen.add(`${from}>${to}`)
          edges.push({ from, to })
        }
      }
      continue
    }
    const node = parseEndpoint(line)
    if (!node) {
      problems.push(
        `line ${no}: can't parse \`${line}\`. Accepted: node lines (\`slug["title"]\`) and edges (\`a --> b\`); subgraphs, styles and classes are not supported.`,
      )
      continue
    }
    register(node, no)
  }

  if (problems.length) return { ok: false, problems }
  if (nodes.size === 0) return { ok: false, problems: ["No nodes found: the plan needs at least one."] }
  const plan: Plan = { nodes: [...nodes].map(([id, title]) => ({ id, title })), edges }
  const cycle = findCycle(plan)
  if (cycle) return { ok: false, problems: [`The plan has a cycle: ${cycle.join(" --> ")}. Requires-edges must not loop.`] }
  return { ok: true, plan }
}

function findCycle(plan: Plan): string[] | undefined {
  const next = new Map<string, string[]>()
  for (const { from, to } of plan.edges) next.set(from, [...(next.get(from) ?? []), to])
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 1)
    stack.push(id)
    for (const to of next.get(id) ?? []) {
      const cycle = visit(to)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 2)
    return undefined
  }
  for (const node of plan.nodes) {
    const cycle = visit(node.id)
    if (cycle) return cycle
  }
  return undefined
}

/** Depth = length of the longest chain of prerequisites below a node (foundations have depth 0). */
export function depths(plan: Plan): Map<string, number> {
  const requires = new Map<string, string[]>()
  for (const { from, to } of plan.edges) requires.set(to, [...(requires.get(to) ?? []), from])
  const depth = new Map<string, number>()
  const visit = (id: string, guard: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (guard.has(id)) return 0
    guard.add(id)
    const value = Math.max(-1, ...(requires.get(id) ?? []).map((r) => visit(r, guard))) + 1
    guard.delete(id)
    depth.set(id, value)
    return value
  }
  for (const node of plan.nodes) visit(node.id, new Set())
  return depth
}

export type NodeMark = "held" | "due" | "current" | "none"

export interface PlanRow {
  id: string
  title: string
  depth: number
  mark: NodeMark
  /** Titles of the nodes this one needs. */
  needs: string[]
}

/** The plan as rows, foundations first, each with its depth (longest chain of prerequisites below it). */
export function planRows(plan: Plan, marks: (id: string) => NodeMark = () => "none"): PlanRow[] {
  const depth = depths(plan)
  const title = new Map(plan.nodes.map((node) => [node.id, node.title]))
  const requires = new Map<string, string[]>()
  for (const { from, to } of plan.edges) requires.set(to, [...(requires.get(to) ?? []), from])
  return plan.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => depth.get(a.node.id)! - depth.get(b.node.id)! || a.index - b.index)
    .map(({ node }) => ({
      id: node.id,
      title: node.title,
      depth: depth.get(node.id)!,
      mark: marks(node.id),
      needs: (requires.get(node.id) ?? []).map((id) => title.get(id) ?? id),
    }))
}

export const MARK_SYMBOL: Record<NodeMark, string> = { held: "✓", due: "↻", current: "▶", none: "·" }

/**
 * The plan as an indented list, foundations first: each node is indented by its depth and lists what it needs.
 * Used in the topic note, in tool results and in the TUI panel (mermaid does not render in a terminal).
 */
export function renderPlanTree(
  plan: Plan,
  marks: (id: string) => NodeMark = () => "none",
  options: { list?: boolean; link?: (id: string) => string | undefined } = {},
): string {
  const depth = depths(plan)
  const requires = new Map<string, string[]>()
  for (const { from, to } of plan.edges) requires.set(to, [...(requires.get(to) ?? []), from])
  const order = plan.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => depth.get(a.node.id)! - depth.get(b.node.id)! || a.index - b.index)
  const symbol: Record<NodeMark, string> = { held: "✓", due: "↻", current: "▶", none: "·" }
  const title = new Map(plan.nodes.map((node) => [node.id, node.title]))
  return order
    .map(({ node }) => {
      const needs = requires.get(node.id)
      const indent = "  ".repeat(depth.get(node.id)!)
      if (!options.list) {
        const suffix = needs?.length ? `  (needs ${needs.join(", ")})` : ""
        return `${indent}${symbol[marks(node.id)]} ${node.title} \`${node.id}\`${suffix}`
      }
      // As a Markdown list (topic note): deep indentation stays a nested list instead of becoming a code block, the
      // list bullet is the only marker, and a step with a card links to it.
      const target = options.link?.(node.id)
      const mark = marks(node.id) === "none" ? "" : `${symbol[marks(node.id)]} `
      const label = target ? `[${node.title}](${target})` : node.title
      const suffix = needs?.length ? ` (needs ${needs.map((id) => title.get(id) ?? id).join(", ")})` : ""
      return `${indent}- ${mark}${label}${suffix}`
    })
    .join("\n")
}

export interface LayerRow {
  /** 1-based position in the foundations-first order; prerequisites are named by this number. */
  n: number
  id: string
  title: string
  layer: string
  /** True where the heading changes (consecutive "Later" layers share one heading). */
  first: boolean
  mark: NodeMark
  needs: number[]
}

/**
 * The plan as numbered steps in layers: each row names its prerequisites by number instead of repeating titles, and
 * layers are headed Start / Then / Later / Goal. The one layout for the chat, tool results and the panel.
 */
export function planLayers(plan: Plan, marks: (id: string) => NodeMark = () => "none"): LayerRow[] {
  const rows = planRows(plan, marks)
  const number = new Map(rows.map((row, index) => [row.id, index + 1]))
  const requires = new Map<string, number[]>()
  for (const { from, to } of plan.edges) requires.set(to, [...(requires.get(to) ?? []), number.get(from)!])
  const top = Math.max(...rows.map((row) => row.depth))
  const label = (depth: number) => (depth === 0 ? "Start" : depth === top ? "Goal" : depth === 1 ? "Then" : "Later")
  return rows.map((row, index) => ({
    n: index + 1,
    id: row.id,
    title: row.title,
    layer: label(row.depth),
    first: index === 0 || label(rows[index - 1]!.depth) !== label(row.depth),
    mark: row.mark,
    needs: (requires.get(row.id) ?? []).sort((a, b) => a - b),
  }))
}

/** `██░░░░░░░ 2/9` */
export function progressBar(done: number, total: number, width = 9): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${done}/${total}`
}

export const needsText = (needs: number[]) => (needs.length ? `needs ${needs.join(", ")}` : "")

/** Greedy word wrap; a word longer than the width stays whole. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

/**
 * The plan as a box diagram for the chat: one box per step in foundations-first order, numbered like the panel. An
 * arrow joins a box to the one below it only when the lower step needs it; other prerequisites are named inside the
 * box (`needs 1, 3`), so the picture never shows a dependency the plan does not have.
 */
export function renderPlanDiagram(plan: Plan, maxWidth = 44): string {
  const rows = planLayers(plan)
  const boxes = rows.map((row) => {
    const prefix = `${row.n}. `
    const lines = wrapText(row.title, maxWidth - prefix.length).map((line, index) => (index === 0 ? prefix : " ".repeat(prefix.length)) + line)
    const extra = row.needs.filter((n) => n !== row.n - 1)
    if (extra.length) lines.push(`${" ".repeat(prefix.length)}needs ${extra.join(", ")}`)
    return { lines, linked: row.needs.includes(row.n - 1) }
  })
  const inner = Math.max(...boxes.flatMap((box) => box.lines.map((line) => line.length)))
  const mid = Math.floor((inner + 2) / 2)
  const out: string[] = []
  boxes.forEach((box, index) => {
    const next = boxes[index + 1]
    out.push(`┌${"─".repeat(inner + 2)}┐`)
    for (const line of box.lines) out.push(`│ ${line.padEnd(inner)} │`)
    const bottom = `└${"─".repeat(inner + 2)}┘`.split("")
    if (next?.linked) bottom[mid] = "┬"
    out.push(bottom.join(""))
    if (next?.linked) out.push(`${" ".repeat(mid)}▼`)
  })
  return out.join("\n")
}

/** Explains the marks a plan shows. Empty when every step is still to learn: the plain list needs no key then. */
export function planLegend(marks: Iterable<NodeMark>): string {
  const used = new Set(marks)
  if (![...used].some((mark) => mark !== "none")) return ""
  const entries: Array<[NodeMark, string]> = [
    ["held", "✓ card"],
    ["due", "↻ due"],
    ["current", "▶ now"],
    ["none", "· to learn"],
  ]
  return entries
    .filter(([mark]) => used.has(mark))
    .map(([, label]) => label)
    .join("   ")
}

export function planToMermaid(plan: Plan): string {
  const lines = ["graph TD"]
  for (const node of plan.nodes) lines.push(`  ${node.id}["${node.title.replace(/"/g, "'")}"]`)
  for (const edge of plan.edges) lines.push(`  ${edge.from} --> ${edge.to}`)
  return lines.join("\n")
}

/** Reads a plan stored in topic frontmatter, dropping anything malformed. */
export function readPlan(value: unknown): Plan | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(raw.nodes)) return undefined
  const nodes = raw.nodes
    .filter((n): n is { id: string; title?: unknown } => !!n && typeof n === "object" && isSlug((n as { id?: unknown }).id))
    .map((n) => ({ id: n.id, title: typeof n.title === "string" ? n.title : n.id }))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((e) => (Array.isArray(e) ? { from: e[0], to: e[1] } : (e as PlanEdge)))
    .filter((e): e is PlanEdge => !!e && ids.has(e.from) && ids.has(e.to))
  return nodes.length ? { nodes, edges } : undefined
}

/** Compact form for frontmatter: edges as `[from, to]` pairs. */
export function storePlan(plan: Plan) {
  return { nodes: plan.nodes, edges: plan.edges.map((e) => [e.from, e.to]) }
}
