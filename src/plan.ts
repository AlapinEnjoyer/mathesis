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
export function renderPlanTree(plan: Plan, marks: (id: string) => NodeMark = () => "none", options: { list?: boolean } = {}): string {
  const depth = depths(plan)
  const requires = new Map<string, string[]>()
  for (const { from, to } of plan.edges) requires.set(to, [...(requires.get(to) ?? []), from])
  const order = plan.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => depth.get(a.node.id)! - depth.get(b.node.id)! || a.index - b.index)
  const symbol: Record<NodeMark, string> = { held: "✓", due: "↻", current: "▶", none: "·" }
  return order
    .map(({ node }) => {
      const needs = requires.get(node.id)
      const suffix = needs?.length ? `  (needs ${needs.join(", ")})` : ""
      // As a Markdown list (topic note), deep indentation stays a nested list instead of becoming a code block.
      const lead = options.list ? `${"  ".repeat(depth.get(node.id)!)}- ` : "  ".repeat(depth.get(node.id)!)
      return `${lead}${symbol[marks(node.id)]} ${node.title} \`${node.id}\`${suffix}`
    })
    .join("\n")
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
