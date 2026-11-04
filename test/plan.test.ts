import { describe, expect, test } from "bun:test"
import { depths, parsePlan, planLayers, planToMermaid, progressBar, readPlan, renderPlanText, renderPlanTree, storePlan } from "../src/plan.ts"

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

describe("numbered layers", () => {
  const plan = ok('graph TD\n a["A"] --> c["C"]\n b["B"] --> c\n c --> d["D"]\n a --> d')

  test("steps are numbered foundations first, layered, and name prerequisites by number", () => {
    const rows = planLayers(plan, (id) => (id === "a" ? "held" : id === "c" ? "current" : "none"))
    expect(rows.map((r) => [r.n, r.id, r.layer, r.first, r.needs])).toEqual([
      [1, "a", "Start", true, []],
      [2, "b", "Start", false, []],
      [3, "c", "Then", true, [1, 2]],
      [4, "d", "Goal", true, [1, 3]],
    ])
    expect(renderPlanText(plan, (id) => (id === "a" ? "held" : "none"))).toBe(
      ["Start", " 1 ✓ A", " 2 · B", "Then", " 3 · C  (needs 1, 2)", "Goal", " 4 · D  (needs 1, 3)"].join("\n"),
    )
  })

  test("a plan with one layer has only Start; middle layers beyond the first are Later", () => {
    expect(planLayers(ok('graph TD\n a["A"]\n b["B"]')).map((r) => r.layer)).toEqual(["Start", "Start"])
    const deep = ok('graph TD\n a["A"] --> b["B"]\n b --> c["C"]\n c --> d["D"]')
    expect(planLayers(deep).map((r) => r.layer)).toEqual(["Start", "Then", "Later", "Goal"])
    const long = ok('graph TD\n a["A"] --> b["B"]\n b --> c["C"]\n c --> d["D"]\n d --> e["E"]\n e --> f["F"]')
    expect(planLayers(long).map((r) => (r.first ? r.layer : "-"))).toEqual(["Start", "Then", "Later", "-", "-", "Goal"])
  })

  test("progress bar", () => {
    expect(progressBar(2, 9)).toBe("██░░░░░░░ 2/9")
    expect(progressBar(0, 0)).toBe("░░░░░░░░░ 0/0")
    expect(progressBar(9, 9)).toBe("█████████ 9/9")
  })
})
