import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade as FsrsGrade } from "ts-fsrs"

export type Grade = "again" | "hard" | "good" | "easy"
export type SrsStateName = "new" | "learning" | "review" | "relearning"

/** FSRS state as stored in an idea note's `srs` frontmatter. Dates are ISO strings. */
export interface Srs {
  state: SrsStateName
  due: string
  stability: number
  difficulty: number
  reps: number
  lapses: number
  last?: string
  scheduledDays: number
  learningSteps: number
}

export interface AnswerOutcome {
  /** true, false, or "partial" for a partly right free-recall answer. */
  correct: boolean | "partial"
  /** 0–100. Missing means the learner gave none. */
  confidence?: number
  dontKnow?: boolean
  /** false when the learner's reasoning was confused even though the answer was right. */
  cleanReasoning?: boolean
}

export interface Rated {
  grade: Grade
  /** A confident wrong answer: create or bump a misconception card. */
  misconception: boolean
}

export const MISCONCEPTION_CONFIDENCE = 70

/** The rating table from docs/handoff.md §5.3. */
export function rate(outcome: AnswerOutcome): Rated {
  if (outcome.dontKnow) return { grade: "again", misconception: false }
  const confidence = outcome.confidence
  if (outcome.correct === false) {
    return { grade: "again", misconception: confidence !== undefined && confidence >= MISCONCEPTION_CONFIDENCE }
  }
  if (outcome.correct === "partial") return { grade: "hard", misconception: false }
  if (confidence === undefined) return { grade: "good", misconception: false }
  if (confidence < 50) return { grade: "hard", misconception: false }
  if (confidence >= 90 && outcome.cleanReasoning !== false) return { grade: "easy", misconception: false }
  return { grade: "good", misconception: false }
}

// FSRS-6 default weights (ts-fsrs 6.0.0), pinned so that a library upgrade cannot change how the log replays.
export const FSRS_WEIGHTS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483,
  0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]

// No fuzz, so rebuilding from the log gives exactly the stored state. No short-term steps: Mathesis schedules in days,
// and the learner meets the idea again in the same session anyway.
const scheduler = fsrs(
  generatorParameters({
    w: FSRS_WEIGHTS,
    request_retention: 0.9,
    maximum_interval: 36500,
    enable_fuzz: false,
    enable_short_term: false,
  }),
)

const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

const STATE_NAMES: Record<State, SrsStateName> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
}

const round = (value: number) => Math.round(value * 10_000) / 10_000

export function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== "string" || !value.trim()) return undefined
  const date = new Date(value.trim())
  return Number.isNaN(date.getTime()) ? undefined : date
}

const STATE_VALUES: Record<SrsStateName, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
}

const DAY = 24 * 60 * 60 * 1000

function toCard(srs: Srs, now: Date): Card {
  // Hand-written state may lack `last`; FSRS needs it for the elapsed time, so derive it from the interval.
  const due = parseDate(srs.due)
  const last =
    parseDate(srs.last) ??
    (due && srs.state !== "new" ? new Date(due.getTime() - Math.max(0, srs.scheduledDays) * DAY) : undefined)
  return {
    due: parseDate(srs.due) ?? now,
    stability: srs.stability,
    difficulty: srs.difficulty,
    scheduled_days: srs.scheduledDays,
    learning_steps: srs.learningSteps,
    reps: srs.reps,
    lapses: srs.lapses,
    state: STATE_VALUES[srs.state],
    ...(last ? { last_review: last } : {}),
  }
}

function fromCard(card: Card): Srs {
  return {
    state: STATE_NAMES[card.state],
    due: card.due.toISOString(),
    stability: round(card.stability),
    difficulty: round(card.difficulty),
    reps: card.reps,
    lapses: card.lapses,
    ...(card.last_review ? { last: card.last_review.toISOString() } : {}),
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
  }
}

export function newSrs(now: Date): Srs {
  return fromCard(createEmptyCard(now))
}

/** Applies one review. A missing state means a new card. */
export function review(srs: Srs | undefined, grade: Grade, now: Date): Srs {
  // Hand-written state without a memory model (stability or difficulty not positive) starts over as a new card.
  // The review counts and lapses written so far are kept.
  const usable = srs && (srs.state === "new" || (srs.stability > 0 && srs.difficulty > 0))
  const card = usable ? toCard(srs, now) : createEmptyCard(now)
  const next = fromCard(scheduler.next(card, now, GRADE_TO_RATING[grade]).card)
  if (srs && !usable) {
    next.reps += srs.reps
    next.lapses += srs.lapses
  }
  return next
}

/** A foundation of a lapsed idea becomes due now (never later than it already was). Memory state is unchanged. */
export function pullForward(srs: Srs, now: Date): Srs {
  const due = parseDate(srs.due)
  if (due && due.getTime() <= now.getTime()) return srs
  return { ...srs, due: now.toISOString() }
}

/** The end of the learner's local day. Cards due before it count as due today (a 20:00 card comes up in the morning). */
export function endOfDay(now: Date): Date {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return end
}

/** Due today: what /recall, the footer and the panel count. FSRS itself uses the exact time. */
export const isDueToday = (srs: Srs | undefined, now: Date) => isDue(srs, endOfDay(now))

/** Ideas whose card is due (at `now`), most overdue first. Pass `endOfDay(now)` for "due today". */
export function dueFirst<T extends { srs?: Srs }>(items: readonly T[], now: Date): T[] {
  return items
    .filter((item) => isDue(item.srs, now))
    .sort((a, b) => parseDate(a.srs!.due)!.getTime() - parseDate(b.srs!.due)!.getTime())
}

export function isDue(srs: Srs | undefined, now: Date): boolean {
  if (!srs) return false
  const due = parseDate(srs.due)
  return !!due && due.getTime() <= now.getTime()
}

/** Reads `srs` frontmatter that a person may have edited. Returns undefined when it is not usable. */
export function readSrs(value: unknown): Srs | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const due = parseDate(raw.due)
  if (!due) return undefined
  const num = (key: string, fallback = 0) => {
    const n = Number(raw[key])
    return Number.isFinite(n) ? n : fallback
  }
  const state = (["new", "learning", "review", "relearning"] as const).find((s) => s === raw.state) ?? "review"
  const last = parseDate(raw.last)
  return {
    state,
    due: due.toISOString(),
    stability: num("stability"),
    difficulty: num("difficulty"),
    reps: num("reps"),
    lapses: num("lapses"),
    ...(last ? { last: last.toISOString() } : {}),
    scheduledDays: num("scheduledDays"),
    learningSteps: num("learningSteps"),
  }
}
