import { describe, expect, test } from "bun:test"
import { depths, parsePlan, planToMermaid, readPlan, renderPlanTree, storePlan } from "../src/plan.ts"

const ok = (text: string) => {
  const result = parsePlan(text)
  if (!result.ok) throw new Error(result.problems.join("\n"))
  return result.plan
}

describe("parsePlan", () => {
  test("nodes, labels, chains and fenced input", () => {
    const plan = ok('```mermaid\ngraph TD\n  sorted-array["Sorted array"]\n  %% comment\n  sorted-array --> interval("Search interval") --> bounds["Bounds"]\n  sorted-array --> bounds\n  sorted-array --> bounds\n```')
    expect(plan.nodes).toEqual([
      { id: "sorted-array", title: "Sorted array" },
      { id: "interval", title: "Search interval" },
      { id: "bounds", title: "Bounds" },
    ])
    expect(plan.edges).toEqual([
      { from: "sorted-array", to: "interval" },
      { from: "interval", to: "bounds" },
      { from: "sorted-array", to: "bounds" },
    ])
  })

  test("reports every problem with its line", () => {
    const result = parsePlan("graph TD\n  Bad_Id --> ok\n  a --> a\n  subgraph x")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.startsWith("line 2:") && p.includes("Bad_Id"))).toBe(true)
    expect(result.problems.some((p) => p.startsWith("line 3:") && p.includes("self-loop"))).toBe(true)
    expect(result.problems.some((p) => p.startsWith("line 4:"))).toBe(true)
  })

  test("header, empty plans and cycles", () => {
    expect(parsePlan("").ok).toBe(false)
    expect(parsePlan("flowchart LR\n a").ok).toBe(true)
    const noHeader = parsePlan("a --> b")
    expect(!noHeader.ok && noHeader.problems[0]).toContain("graph TD")
    const cycle = parsePlan("graph TD\n a --> b\n b --> c\n c --> a")
    expect(!cycle.ok && cycle.problems[0]).toContain("cycle")
  })
})

describe("rendering and storage", () => {
  const plan = ok('graph TD\n a["A"] --> c["C"]\n b["B"] --> c\n c --> d["D"]\n a --> d')

  test("depth is the longest prerequisite chain", () => {
    expect(Object.fromEntries(depths(plan))).toEqual({ a: 0, b: 0, c: 1, d: 2 })
  })

  test("the tree lists foundations first, indented, with marks", () => {
    const tree = renderPlanTree(plan, (id) => (id === "a" ? "held" : id === "c" ? "current" : "none"))
    expect(tree).toBe(["✓ A `a`", "· B `b`", "  ▶ C `c`  (needs a, b)", "    · D `d`  (needs c, a)"].join("\n"))
  })

  test("store, read back and print as mermaid", () => {
    expect(readPlan(JSON.parse(JSON.stringify(storePlan(plan))))).toEqual(plan)
    expect(ok(planToMermaid(plan))).toEqual(plan)
    expect(readPlan({ nodes: [{ id: "x" }, { id: "Bad" }], edges: [["x", "missing"]] })).toEqual({ nodes: [{ id: "x", title: "x" }], edges: [] })
    expect(readPlan("nope")).toBeUndefined()
  })
})
