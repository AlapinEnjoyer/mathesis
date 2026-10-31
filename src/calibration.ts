import type { LogEntry } from "./store/log.ts"

export interface CalibrationRow {
  /** The confidence the learner stated, in percent. */
  confidence: number
  answers: number
  /** Right answers; a partial answer counts as half. */
  right: number
}

/** How often the learner was right at each stated confidence, from the checks, reviews and practice in the log. */
export function calibration(entries: readonly LogEntry[]): CalibrationRow[] {
  const rows = new Map<number, CalibrationRow>()
  for (const entry of entries) {
    if (entry.mode === "pull" || entry.confidence === undefined || entry.dontKnow) continue
    const row = rows.get(entry.confidence) ?? { confidence: entry.confidence, answers: 0, right: 0 }
    row.answers += 1
    row.right += entry.correct === true ? 1 : entry.correct === "partial" ? 0.5 : 0
    rows.set(entry.confidence, row)
  }
  return [...rows.values()].sort((a, b) => b.confidence - a.confidence)
}

const FEW = 3
const MARGIN = 15

/** Lines for the status view: one per confidence level, with a verdict once there are a few answers. */
export function calibrationLines(rows: readonly CalibrationRow[]): string[] {
  if (!rows.length) return []
  const lines = ["Calibration (how often you were right when you said you were x% sure):"]
  for (const row of rows) {
    const rate = Math.round((row.right / row.answers) * 100)
    const verdict =
      row.answers < FEW
        ? "too few answers to tell"
        : rate < row.confidence - MARGIN
          ? "overconfident"
          : rate > row.confidence + MARGIN
            ? "underconfident"
            : "well calibrated"
    lines.push(`  ${String(row.confidence).padStart(3)}% sure: right ${rate}% of ${row.answers} · ${verdict}`)
  }
  return lines
}
