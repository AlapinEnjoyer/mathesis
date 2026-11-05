import { describe, expect, test } from "bun:test"
import { layoutPlan, NODE_HEIGHT, NODE_WIDTH } from "../src/plan-layout.ts"

const at = (layout: ReturnType<typeof layoutPlan>, n: number) => layout.nodes.find((node) => node.n === n)!

describe("layoutPlan", () => {
  test("a step sits below everything it needs, and every prerequisite gets a line", () => {
    const layout = layoutPlan([
      { n: 1, needs: [] },
      { n: 2, needs: [] },
      { n: 3, needs: [] },
      { n: 4, needs: [2] },
      { n: 5, needs: [1, 3, 4] },
    ])
    expect(at(layout, 4).y).toBeGreaterThan(at(layout, 2).y)
    expect(at(layout, 5).y).toBeGreaterThan(at(layout, 4).y)
    expect(layout.edges.map((edge) => [edge.from, edge.to])).toEqual([[2, 4], [1, 5], [3, 5], [4, 5]])
    expect(layout.height).toBe(at(layout, 5).y + NODE_HEIGHT)
  })

  test("a line that skips a row goes around the cards in it", () => {
    const layout = layoutPlan([
      { n: 1, needs: [] },
      { n: 2, needs: [] },
      { n: 3, needs: [] },
      { n: 4, needs: [2] },
      { n: 5, needs: [1, 2, 3, 4] },
    ])
    const middle = at(layout, 4)
    for (const edge of layout.edges.filter((e) => e.to === 5 && e.from !== 4)) {
      const inRow = edge.points.filter((point) => point.y >= middle.y - 6 && point.y <= middle.y + NODE_HEIGHT + 6)
      expect(inRow.length).toBe(2)
      for (const point of inRow) expect(point.x < middle.x || point.x > middle.x + NODE_WIDTH).toBe(true)
    }
  })

  test("a wide layer breaks into rows, and nothing overlaps", () => {
    const layout = layoutPlan([1, 2, 3, 4, 5].map((n) => ({ n, needs: [] })))
    const rows = new Set(layout.nodes.map((node) => node.y))
    expect(rows.size).toBe(2)
    expect(layout.width).toBe(3 * NODE_WIDTH + 2 * 24)
    for (const a of layout.nodes) for (const b of layout.nodes) {
      if (a.n !== b.n) expect(Math.abs(a.x - b.x) >= NODE_WIDTH || Math.abs(a.y - b.y) >= NODE_HEIGHT).toBe(true)
    }
  })

  test("a prerequisite outside the plan and a cycle do not break it", () => {
    const layout = layoutPlan([{ n: 1, needs: [2, 9] }, { n: 2, needs: [1] }])
    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges.some((edge) => edge.from === 9)).toBe(false)
  })

  test("an empty plan draws nothing", () => {
    expect(layoutPlan([])).toEqual({ width: NODE_WIDTH, height: 0, nodes: [], edges: [] })
  })
})
