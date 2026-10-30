import type { Plugin } from "@opencode/plugin"
import { canTransition, isPhase, type Phase } from "./phases.ts"
import type { QuestionType } from "./store/log.ts"

/** The plugin's durable storage (`ctx.storage`), or a stand-in with the same shape. */
export type KeyValue = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">

export type OpenQuestion = {
  questionID: string
  kind: "quiz" | "explain"
  type: QuestionType
  prompt: string
  nodeId?: string
  ideaId?: string
  options?: string[]
  /** Committed before the learner sees the question: the correct option index (quiz) or answer (explain). */
  correctIndex?: number
  correctAnswer?: string
  explanation?: string
  askedAt: string
  /** No form could be shown; the agent asks another way and records the reply with mathesis_answer_record. */
  fallback?: boolean
  /** Set when the learner wrote a message or answered the built-in question tool after the fallback. */
  learnerReplied?: boolean
}

/** A question the learner answered in this session. Tools that grade or create cards check against these. */
export type AnswerRecord = {
  questionID: string
  kind: "quiz" | "explain"
  type: QuestionType
  prompt: string
  nodeId?: string
  ideaId?: string
  status: "answered" | "dont_know"
  /** Multiple choice: graded mechanically. Free recall: undefined until the agent grades it. */
  correct?: boolean
  choice?: number
  text?: string
  confidence?: number
  thinking?: string
  answeredAt: string
  elapsedMs?: number
  /** The tool call that already used this answer (a card, a review), so it cannot count twice. */
  usedBy?: string
  /** Misconception cards already recorded from this answer. */
  misconceptions?: string[]
  /** Recorded with mathesis_answer_record after a fallback, not through a form. */
  fallback?: boolean
}

export const ANSWERS_KEPT = 30

export type SessionState = {
  phase: Phase
  topic?: string
  currentNode?: string
  openQuestion?: OpenQuestion
  /** Recent answers, newest last (at most ANSWERS_KEPT). */
  answers?: AnswerRecord[]
  /** Ideas already reviewed or practised in this session. */
  done?: string[]
  updatedAt: string
}

const key = (sessionID: string) => `session/${sessionID}`

export async function getSession(store: KeyValue, sessionID: string): Promise<SessionState | undefined> {
  const value = (await store.get(key(sessionID))) as Partial<SessionState> | undefined
  if (!value || typeof value !== "object" || !isPhase(value.phase)) return undefined
  return value as SessionState
}

const locks = new Map<string, Promise<unknown>>()

/** Serializes read-modify-write cycles on one session's state (parallel tool calls in one turn). */
async function withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(sessionID) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  locks.set(sessionID, run)
  try {
    return await run
  } finally {
    if (locks.get(sessionID) === run) locks.delete(sessionID)
  }
}

type Patch = { [K in keyof SessionState]?: SessionState[K] | undefined }

/** Applies `patch` to the stored state. `undefined` values remove the key. Use `setPhase` to change the phase. */
export function updateSession(
  store: KeyValue,
  sessionID: string,
  patch: Omit<Patch, "phase" | "updatedAt">,
  now = new Date(),
): Promise<SessionState> {
  return withSessionLock(sessionID, async () => {
    const current = await getSession(store, sessionID)
    if (!current) throw new Error("This session has no Mathesis phase yet")
    return write(store, sessionID, { ...current, ...patch }, now)
  })
}

/**
 * Reads, checks and writes one session's state as a single step under the session lock, so parallel tool calls
 * cannot both pass a check (one open question, one use per answer). `fn` may throw to refuse; nothing is written then.
 */
export function mutateSession(
  store: KeyValue,
  sessionID: string,
  fn: (state: SessionState) => Omit<Patch, "phase" | "updatedAt">,
  now = new Date(),
): Promise<SessionState> {
  return withSessionLock(sessionID, async () => {
    const current = await getSession(store, sessionID)
    if (!current) throw new Error("This session has no Mathesis phase yet")
    return write(store, sessionID, { ...current, ...fn(current) }, now)
  })
}

/** Changes (or sets the first) phase, enforcing the allowed transitions. Other keys in `patch` are applied too. */
export function setPhase(
  store: KeyValue,
  sessionID: string,
  phase: Phase,
  patch: Omit<Patch, "phase" | "updatedAt"> = {},
  now = new Date(),
): Promise<SessionState> {
  return withSessionLock(sessionID, async () => {
    const current = await getSession(store, sessionID)
    if (!canTransition(current?.phase, phase)) {
      throw new Error(`A ${current!.phase} session cannot change to the ${phase} phase`)
    }
    return write(store, sessionID, { ...current, ...patch, phase }, now)
  })
}

async function write(store: KeyValue, sessionID: string, next: Patch & { phase: Phase }, now: Date) {
  const state = { ...next, updatedAt: now.toISOString() } as SessionState
  for (const [k, v] of Object.entries(state)) if (v === undefined) delete (state as Record<string, unknown>)[k]
  await store.set(key(sessionID), JSON.parse(JSON.stringify(state)))
  return state
}

/** In-memory store for tests and for running without plugin storage. */
export function memoryStore(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => structuredClone(data.get(k)) as never,
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
    scan: async ({ prefix, after, limit }) => {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix) && (!after || k > after)).sort()
      const page = keys.slice(0, limit ?? keys.length)
      return {
        entries: page.map((k) => ({ key: k, value: structuredClone(data.get(k)) as never })),
        ...(page.length < keys.length ? { next: page[page.length - 1] } : {}),
      }
    },
  }
}
