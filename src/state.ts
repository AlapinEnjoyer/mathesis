import { isPhase, type Phase } from "./phases.ts"

/** Durable key-value storage; matches the shape of the plugin's `ctx.storage`. */
export interface KeyValue {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
  remove(key: string): Promise<void>
}

export interface OpenQuestion {
  questionID: string
  kind: "quiz" | "explain"
  type: "predict" | "check" | "recall" | "discrimination" | "reverse" | "composition" | "practice"
  prompt: string
  nodeId?: string
  ideaId?: string
  options?: string[]
  /** Committed before the learner sees the question. */
  answer: string
  explanation?: string
  askedAt: string
  formID?: string
}

export interface SessionState {
  phase: Phase
  topic?: string
  currentNode?: string
  openQuestion?: OpenQuestion
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

export async function setSession(store: KeyValue, sessionID: string, state: SessionState): Promise<void> {
  await store.set(key(sessionID), JSON.parse(JSON.stringify(state)) as never)
}

/** Applies `patch` to the stored state. `undefined` values remove the key. */
export async function updateSession(
  store: KeyValue,
  sessionID: string,
  patch: Partial<SessionState> & { phase?: Phase },
  now = new Date(),
): Promise<SessionState> {
  const current = await getSession(store, sessionID)
  const phase = patch.phase ?? current?.phase
  if (!phase) throw new Error("A new Mathesis session needs a phase")
  const next = { ...current, ...patch, phase, updatedAt: now.toISOString() } as SessionState
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k]
  await setSession(store, sessionID, next)
  return next
}

/** In-memory store for tests and for running without plugin storage. */
export function memoryStore(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  }
}
