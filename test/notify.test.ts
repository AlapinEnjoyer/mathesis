import { describe, expect, test } from "bun:test"
import { countsAsNotified, localDate, shouldNotify } from "../src/notify.ts"

describe("daily notification", () => {
  const base = { due: 3, last: "2026-10-30", today: "2026-10-31", enabled: true, reviewing: false }
  test("once a day, only with due cards, never while reviewing or when disabled", () => {
    expect(shouldNotify(base)).toBe(true)
    expect(shouldNotify({ ...base, last: "2026-10-31" })).toBe(false)
    expect(shouldNotify({ ...base, due: 0 })).toBe(false)
    expect(shouldNotify({ ...base, enabled: false })).toBe(false)
    expect(shouldNotify({ ...base, reviewing: true })).toBe(false)
  })
  test("a skipped notification (terminal focused) does not use up the day", () => {
    expect(countsAsNotified({ notification: false, skipped: "focused" })).toBe(false)
    expect(countsAsNotified({ notification: true })).toBe(true)
  })
  test("local date format", () => {
    expect(localDate(new Date(2026, 9, 31, 23, 59))).toBe("2026-10-31")
  })
})
