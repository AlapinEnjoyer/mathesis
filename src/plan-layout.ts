/** Where each plan step goes in a drawn map: pure geometry, so it can be tested without a browser. */
export interface MapStep {
  n: number
  needs: number[]
}

export interface MapLayout {
  width: number
  height: number
  nodes: { n: number; x: number; y: number }[]
  edges: { from: number; to: number; path: string; points: { x: number; y: number }[] }[]
}

export const NODE_WIDTH = 190
export const NODE_HEIGHT = 58
const GAP_X = 24
const GAP_Y = 44
const MAX_PER_ROW = 3
const MARGIN = 4
/** How far a routed line may leave the cards' area; a drawing adds this around the map. */
export const MAP_PADDING = GAP_X / 2 + 2

/** Foundations on top, each step below everything it needs; a wide layer breaks into rows so labels stay readable. */
export function layoutPlan(steps: MapStep[]): MapLayout {
  const byN = new Map(steps.map((step) => [step.n, step]))
  const depth = new Map<number, number>()
  const depthOf = (n: number, seen = new Set<number>()): number => {
    if (depth.has(n)) return depth.get(n)!
    if (seen.has(n)) return 0
    seen.add(n)
    const needs = (byN.get(n)?.needs ?? []).filter((need) => byN.has(need))
    const value = needs.length ? 1 + Math.max(...needs.map((need) => depthOf(need, seen))) : 0
    depth.set(n, value)
    return value
  }
  steps.forEach((step) => depthOf(step.n))

  const layers: number[][] = []
  for (const step of steps) (layers[depth.get(step.n)!] ??= []).push(step.n)

  const rows: number[][] = []
  const column = new Map<number, number>()
  for (const layer of layers) {
    if (!layer) continue
    // Under the average of its parents, which keeps most lines from crossing.
    const score = (n: number) => {
      const parents = (byN.get(n)?.needs ?? []).map((need) => column.get(need)).filter((c): c is number => c !== undefined)
      return parents.length ? parents.reduce((sum, c) => sum + c, 0) / parents.length : n
    }
    const ordered = [...layer].sort((a, b) => score(a) - score(b) || a - b)
    for (let i = 0; i < ordered.length; i += MAX_PER_ROW) {
      const row = ordered.slice(i, i + MAX_PER_ROW)
      row.forEach((n, index) => column.set(n, index - (row.length - 1) / 2))
      rows.push(row)
    }
  }

  const widest = Math.max(1, ...rows.map((row) => row.length))
  const width = widest * NODE_WIDTH + (widest - 1) * GAP_X
  const place = new Map<number, { x: number; y: number }>()
  rows.forEach((row, r) => {
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * GAP_X
    row.forEach((n, i) => place.set(n, { x: (width - rowWidth) / 2 + i * (NODE_WIDTH + GAP_X), y: r * (NODE_HEIGHT + GAP_Y) }))
  })

  const nodes = steps.map((step) => ({ n: step.n, ...place.get(step.n)! }))
  const rowIndex = new Map(rows.flatMap((row, r) => row.map((n) => [n, r] as const)))
  const rowTop = (r: number) => r * (NODE_HEIGHT + GAP_Y)
  /** Keeps a line that skips a row out of that row's cards: it goes through the nearest gap instead. */
  const clearOfCards = (x: number, r: number) => {
    const card = rows[r]!.map((n) => place.get(n)!).find((node) => x > node.x - MARGIN && x < node.x + NODE_WIDTH + MARGIN)
    if (!card) return x
    const left = card.x - GAP_X / 2
    const right = card.x + NODE_WIDTH + GAP_X / 2
    return x - left <= right - x ? left : right
  }
  const edges = steps.flatMap((step) =>
    step.needs
      .filter((need) => place.has(need))
      .map((need) => {
        const from = place.get(need)!
        const to = place.get(step.n)!
        const x1 = from.x + NODE_WIDTH / 2
        const x2 = to.x + NODE_WIDTH / 2
        const first = rowIndex.get(need)!
        const last = rowIndex.get(step.n)!
        const points = [{ x: x1, y: from.y + NODE_HEIGHT }]
        for (let r = first + 1; r < last; r++) {
          const x = clearOfCards(x1 + ((x2 - x1) * (r - first)) / (last - first), r)
          points.push({ x, y: rowTop(r) - 6 }, { x, y: rowTop(r) + NODE_HEIGHT + 6 })
        }
        points.push({ x: x2, y: to.y })
        const path = points.slice(1).reduce((d, point, index) => {
          const previous = points[index]!
          if (point.x === previous.x) return `${d} L ${point.x} ${point.y}`
          const bend = (point.y - previous.y) / 2
          return `${d} C ${previous.x} ${previous.y + bend}, ${point.x} ${point.y - bend}, ${point.x} ${point.y}`
        }, `M ${x1} ${points[0]!.y}`)
        return { from: need, to: step.n, path, points }
      }),
  )
  return { width, height: rows.length * NODE_HEIGHT + Math.max(0, rows.length - 1) * GAP_Y, nodes, edges }
}
