import { describe, expect, test } from "bun:test"
import { dueFirst, isDue, newSrs, pullForward, rate, readSrs, review, type AnswerOutcome, type Grade, type Srs } from "../src/srs/fsrs.ts"

const day = 24 * 60 * 60 * 1000
const t0 = new Date("2026-10-30T10:00:00.000Z")
const at = (days: number) => new Date(t0.getTime() + days * day)

describe("rating table (handoff §5.3)", () => {
  const cases: [string, AnswerOutcome, Grade, boolean][] = [
    ["I don't know", { correct: false, dontKnow: true, confidence: 90 }, "again", false],
    ["wrong, unsure", { correct: false, confidence: 30 }, "again", false],
    ["wrong, no confidence", { correct: false }, "again", false],
    ["wrong, confidence 69", { correct: false, confidence: 69 }, "again", false],
    ["wrong, confidence 70", { correct: false, confidence: 70 }, "again", true],
    ["wrong, confidence 100", { correct: false, confidence: 100 }, "again", true],
    ["partial free recall", { correct: "partial", confidence: 95 }, "hard", false],
    ["correct, confidence 10", { correct: true, confidence: 10 }, "hard", false],
    ["correct, confidence 49", { correct: true, confidence: 49 }, "hard", false],
    ["correct, confidence 50", { correct: true, confidence: 50 }, "good", false],
    ["correct, confidence 89", { correct: true, confidence: 89 }, "good", false],
    ["correct, confidence 90", { correct: true, confidence: 90 }, "easy", false],
    ["correct, confidence 100", { correct: true, confidence: 100 }, "easy", false],
    ["correct, 90 but muddled reasoning", { correct: true, confidence: 90, cleanReasoning: false }, "good", false],
    ["correct, no confidence", { correct: true }, "good", false],
  ]
  for (const [name, outcome, grade, misconception] of cases) {
    test(name, () => expect(rate(outcome)).toEqual({ grade, misconception }))
  }
})

describe("scheduling with a fake clock", () => {
  test("a new card reviewed Good is due in whole days, never minutes", () => {
    const s = review(undefined, "good", t0)
    expect(s.state).toBe("review")
    expect(s.reps).toBe(1)
    expect(new Date(s.due).getTime() - t0.getTime()).toBeGreaterThanOrEqual(day)
    expect(s.last).toBe(t0.toISOString())
  })

  test("intervals grow with successful reviews and Easy beats Good beats Hard", () => {
    const first = review(undefined, "good", t0)
    const due1 = new Date(first.due)
    const interval = (g: Grade) => new Date(review(first, g, due1).due).getTime() - due1.getTime()
    expect(interval("easy")).toBeGreaterThan(interval("good"))
    expect(interval("good")).toBeGreaterThan(interval("hard"))
    expect(interval("good")).toBeGreaterThan(new Date(first.due).getTime() - t0.getTime())
  })

  test("Again on a review card is a lapse", () => {
    const first = review(undefined, "good", t0)
    const lapsed = review(first, "again", new Date(first.due))
    expect(lapsed.lapses).toBe(1)
    expect(lapsed.stability).toBeLessThan(first.stability)
    const gap = new Date(lapsed.due).getTime() - new Date(first.due).getTime()
    expect(gap).toBeLessThanOrEqual(2 * day)
  })

  test("same inputs give the same state (no fuzz)", () => {
    expect(review(review(undefined, "good", t0), "hard", at(3))).toEqual(
      review(review(undefined, "good", t0), "hard", at(3)),
    )
  })

  test("isDue follows the clock", () => {
    const s = review(undefined, "good", t0)
    expect(isDue(s, t0)).toBe(false)
    expect(isDue(s, new Date(s.due))).toBe(true)
    expect(isDue(undefined, at(100))).toBe(false)
  })

  test("pullForward makes a foundation due now but never later, and keeps memory state", () => {
    const s = review(undefined, "easy", t0)
    const pulled = pullForward(s, at(1))
    expect(pulled.due).toBe(at(1).toISOString())
    expect(pulled.stability).toBe(s.stability)
    const overdue = { ...s, due: t0.toISOString() }
    expect(pullForward(overdue, at(1)).due).toBe(t0.toISOString())
  })

  test("newSrs is a due new card", () => {
    expect(newSrs(t0)).toMatchObject({ state: "new", reps: 0, due: t0.toISOString() })
  })
})

describe("readSrs (hand-edited frontmatter)", () => {
  test("accepts a date-only due and missing fields", () => {
    expect(readSrs({ due: "2026-11-04", state: "review", stability: 6.2 })).toMatchObject({
      due: "2026-11-04T00:00:00.000Z",
      state: "review",
      stability: 6.2,
      reps: 0,
    })
  })
  test("rejects unusable values", () => {
    expect(readSrs(undefined)).toBeUndefined()
    expect(readSrs({ due: "soon" })).toBeUndefined()
    expect(readSrs("2026-11-04")).toBeUndefined()
  })
  test("a hand-written review state without stability starts over instead of producing NaN", () => {
    const s = review(readSrs({ due: "2026-11-04", state: "review" }), "good", at(5))
    expect(Number.isFinite(s.stability)).toBe(true)
    expect(s.reps).toBe(1)
  })
})

describe("hand-edited state", () => {
  test("a missing last review date is derived from the interval, so elapsed time counts", () => {
    const due = "2026-11-29T10:00:00.000Z"
    const withLast = review(
      { state: "review", due, stability: 30, difficulty: 5, reps: 3, lapses: 0, last: "2026-10-30T10:00:00.000Z", scheduledDays: 30, learningSteps: 0 },
      "good",
      new Date(due),
    )
    const withoutLast = review(
      { state: "review", due, stability: 30, difficulty: 5, reps: 3, lapses: 0, scheduledDays: 30, learningSteps: 0 },
      "good",
      new Date(due),
    )
    expect(withoutLast).toEqual(withLast)
  })

  test("starting over keeps the review count and lapses", () => {
    const s = review({ state: "review", due: "2026-11-01T00:00:00.000Z", stability: 0, difficulty: 0, reps: 4, lapses: 2, scheduledDays: 0, learningSteps: 0 }, "good", at(3))
    expect(s.reps).toBe(5)
    expect(s.lapses).toBe(2)
  })
})

test("dueFirst lists due cards, most overdue first", () => {
  const a = { id: "a", srs: review(undefined, "good", t0) }
  const b = { id: "b", srs: review(undefined, "easy", t0) }
  const c: { id: string; srs?: Srs } = { id: "c" }
  expect(dueFirst([b, c, a], at(100)).map((x) => x.id)).toEqual(["a", "b"])
  expect(dueFirst([a, b, c], t0)).toEqual([])
})
