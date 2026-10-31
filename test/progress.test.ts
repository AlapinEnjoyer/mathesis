import { describe, expect, test } from "bun:test"
import { calibration, calibrationLines } from "../src/calibration.ts"
import { sessionSummary } from "../src/panel.ts"
import { nextDue } from "../src/srs/fsrs.ts"
import type { LogEntry } from "../src/store/log.ts"

const entry = (extra: Partial<LogEntry> & Record<string, unknown>): LogEntry =>
  ({ ts: "2026-10-31T10:00:00.000Z", ideaId: "a", mode: "review", scheduled: true, correct: true, rating: "good", ...extra }) as LogEntry

describe("calibration", () => {
  test("right answers per confidence, partial as half; no confidence, I don't know and pulls are left out", () => {
    const rows = calibration([
      entry({ confidence: 90, correct: true }),
      entry({ confidence: 90, correct: false }),
      entry({ confidence: 90, correct: "partial" }),
      entry({ confidence: 90, correct: false }),
      entry({ confidence: 30, correct: true }),
      entry({ correct: true }),
      entry({ confidence: 50, dontKnow: true, correct: false }),
      { ts: "x", ideaId: "a", mode: "pull", cause: "b" },
    ])
    expect(rows).toEqual([
      { confidence: 90, answers: 4, right: 1.5 },
      { confidence: 30, answers: 1, right: 1 },
    ])
    expect(calibrationLines(rows)).toEqual([
      "Calibration (how often you were right when you said you were x% sure):",
      "   90% sure: right 38% of 4 · overconfident",
      "   30% sure: right 100% of 1 · too few answers to tell",
    ])
    expect(calibrationLines([])).toEqual([])
  })

  test("within 15 points is well calibrated; far below the stated confidence is underconfident", () => {
    const lines = calibrationLines([
      { confidence: 70, answers: 10, right: 6 },
      { confidence: 10, answers: 3, right: 3 },
    ])
    expect(lines[1]).toEndWith("well calibrated")
    expect(lines[2]).toEndWith("underconfident")
  })
})

test("sessionSummary counts cards from checks, reviews, practice and misconceptions", () => {
  expect(sessionSummary([])).toBe("")
  expect(
    sessionSummary([
      entry({ mode: "teach", ideaId: "a" }),
      entry({ mode: "teach", ideaId: "b" }),
      entry({ mode: "review", ideaId: "c" }),
      entry({ mode: "practice", ideaId: "a", scheduled: false }),
      entry({ mode: "teach", ideaId: "misconception-x", correct: false }),
      entry({ mode: "review", ideaId: "misconception-x", correct: false }),
    ]),
  ).toBe("2 cards from checks · 1 review · 1 practice problem · 1 misconception")
})

test("nextDue is the earliest due date after now", () => {
  const now = new Date("2026-10-31T10:00:00.000Z")
  const card = (due?: string) => ({ ...(due ? { srs: { due } as never } : {}) })
  expect(nextDue([card("2026-11-05T00:00:00.000Z"), card("2026-11-02T00:00:00.000Z"), card("2026-10-30T00:00:00.000Z"), card()], now)?.toISOString()).toBe(
    "2026-11-02T00:00:00.000Z",
  )
  expect(nextDue([card("2026-10-30T00:00:00.000Z")], now)).toBeUndefined()
})
