import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { pullForward, review, type Grade, type Srs } from "../srs/fsrs.ts"

/** How an entry came about. Only `teach` and `review` entries change the FSRS schedule (see docs/decisions.md). */
export type LogMode = "teach" | "review" | "practice" | "pull"

export interface ReviewEntry {
  ts: string
  ideaId: string
  sessionID?: string
  mode: Exclude<LogMode, "pull">
  type?: "predict" | "check" | "recall" | "discrimination" | "reverse" | "composition" | "practice"
  questionStem?: string
  correct: boolean | "partial"
  confidence?: number
  dontKnow?: boolean
  rating: Grade
  elapsedMs?: number
}

/** A lapse of `cause` moved this foundation's due date forward. */
export interface PullEntry {
  ts: string
  ideaId: string
  sessionID?: string
  mode: "pull"
  cause: string
}

export type LogEntry = ReviewEntry | PullEntry

export const SCHEDULING_MODES: ReadonlySet<LogMode> = new Set(["teach", "review", "pull"])

export async function appendLog(path: string, entry: LogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // One short line per append: O_APPEND keeps concurrent writers from interleaving inside a line.
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8")
}

/** Reads the log. Lines that are not valid entries (for example a torn last line) are skipped. */
export async function readLog(path: string): Promise<LogEntry[]> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const entries: LogEntry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as LogEntry
      if (entry && typeof entry.ideaId === "string" && typeof entry.ts === "string" && entry.mode) entries.push(entry)
    } catch {
      // skip malformed line
    }
  }
  return entries
}

/** Replays the log into FSRS state per idea. Must match what the tools wrote into the notes. */
export function rebuild(entries: readonly LogEntry[]): Map<string, Srs> {
  const states = new Map<string, Srs>()
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts.localeCompare(b.entry.ts) || a.index - b.index)
  for (const { entry } of ordered) {
    if (!SCHEDULING_MODES.has(entry.mode)) continue
    const now = new Date(entry.ts)
    if (entry.mode === "pull") {
      const current = states.get(entry.ideaId)
      if (current) states.set(entry.ideaId, pullForward(current, now))
      continue
    }
    states.set(entry.ideaId, review(states.get(entry.ideaId), entry.rating, now))
  }
  return states
}
