import { appendFile, mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pullForward, review, type Grade, type Srs } from "../srs/fsrs.ts"

/** Where an entry came from. */
export type LogMode = "teach" | "review" | "practice" | "pull"

export const QUESTION_TYPES = [
  "probe",
  "predict",
  "check",
  "recall",
  "discrimination",
  "reverse",
  "composition",
  "practice",
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export interface ReviewEntry {
  ts: string
  ideaId: string
  sessionID?: string
  mode: Exclude<LogMode, "pull">
  /** true when this entry changed the idea's FSRS schedule; the rebuild replays only these. */
  scheduled: boolean
  type?: QuestionType
  questionStem?: string
  correct: boolean | "partial"
  confidence?: number
  dontKnow?: boolean
  rating: Grade
  elapsedMs?: number
  /** A review that forgot a card that had been learned. */
  lapse?: boolean
  /** Practice: the highest hint rung used ("R0"–"R5"), and the kind of miss. */
  hints?: string
  miss?: string
}

/** A lapse of `cause` moved this foundation's due date forward. Always scheduled. */
export interface PullEntry {
  ts: string
  ideaId: string
  sessionID?: string
  mode: "pull"
  cause: string
}

export type LogEntry = ReviewEntry | PullEntry

const GRADES: ReadonlySet<string> = new Set(["again", "hard", "good", "easy"])
const MODES: ReadonlySet<string> = new Set(["teach", "review", "practice", "pull"])

export async function appendLog(path: string, entry: LogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // A last line without its newline (a crash, or an edit by hand) would swallow this entry; start a new line first.
  let prefix = ""
  try {
    const handle = await open(path, "r")
    try {
      const { size } = await handle.stat()
      if (size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) prefix = "\n"
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  // One short line per append: O_APPEND keeps concurrent writers from interleaving inside a line.
  await appendFile(path, prefix + JSON.stringify(entry) + "\n", "utf8")
}

/** Checks one parsed line. Returns the reason it is not a usable entry, or undefined. */
function invalid(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "not an object"
  const entry = value as Record<string, unknown>
  if (typeof entry.ideaId !== "string" || !entry.ideaId) return "missing ideaId"
  if (typeof entry.ts !== "string" || !Number.isFinite(Date.parse(entry.ts))) return "invalid ts"
  if (typeof entry.mode !== "string" || !MODES.has(entry.mode)) return "unknown mode"
  if (entry.mode === "pull") return typeof entry.cause === "string" ? undefined : "pull without cause"
  if (typeof entry.rating !== "string" || !GRADES.has(entry.rating)) return "invalid rating"
  return undefined
}

/**
 * Reads the log. The learner may edit it by hand, so lines that are not valid entries are skipped and reported
 * in `errors` (1-based line numbers) instead of failing the whole read.
 */
export async function readLog(path: string): Promise<{ entries: LogEntry[]; errors: { line: number; message: string }[] }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], errors: [] }
    throw error
  }
  const entries: LogEntry[] = []
  const errors: { line: number; message: string }[] = []
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      errors.push({ line: index + 1, message: "not valid JSON" })
      return
    }
    const reason = invalid(parsed)
    if (reason) errors.push({ line: index + 1, message: reason })
    else entries.push(parsed as LogEntry)
  })
  return { entries, errors }
}

const affectsSchedule = (entry: LogEntry) => entry.mode === "pull" || entry.scheduled === true

/** Replays the log into FSRS state per idea. Must match what the tools wrote into the notes. */
export function rebuild(entries: readonly LogEntry[]): Map<string, Srs> {
  const states = new Map<string, Srs>()
  const ordered = entries
    .map((entry, index) => ({ entry, index, time: Date.parse(entry.ts) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
  for (const { entry, time } of ordered) {
    if (!affectsSchedule(entry)) continue
    const now = new Date(time)
    if (entry.mode === "pull") {
      const current = states.get(entry.ideaId)
      if (current) states.set(entry.ideaId, pullForward(current, now))
      continue
    }
    states.set(entry.ideaId, review(states.get(entry.ideaId), entry.rating, now))
  }
  return states
}
