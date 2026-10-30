export const PHASES = ["probe", "teach", "review", "practice"] as const
export type Phase = (typeof PHASES)[number]

export const isPhase = (value: unknown): value is Phase => PHASES.includes(value as Phase)

/**
 * Which phases may use each Mathesis tool. All tools stay registered for the whole session (prompt cache, see
 * docs/handoff.md §2c); an executor called outside its phases refuses with a corrective message.
 * `null` means the tool works in any session, including one that has no phase yet.
 */
export const TOOL_PHASES: Readonly<Record<string, readonly Phase[] | null>> = {
  topic_start: null,
  topic_list: null,
  topic_status: null,
  phase_set: null,
  quiz: ["probe", "teach", "review", "practice"],
  explain: ["probe", "teach", "review", "practice"],
  answer_record: ["probe", "teach", "review", "practice"],
  probe_done: ["probe"],
  plan_set: ["teach"],
  idea_upsert: ["teach"],
  misconception_record: ["probe", "teach", "review", "practice"],
  review_next: ["review"],
  review_grade: ["review"],
  practice_targets: ["practice"],
  practice_record: ["practice"],
}

/** Allowed phase changes. A learn session goes probe → teach once; review and practice sessions keep their phase. */
const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  probe: ["teach"],
  teach: ["probe"],
  review: [],
  practice: [],
}

export function canTransition(from: Phase | undefined, to: Phase): boolean {
  if (from === undefined) return true
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/** Returns an error message when `tool` may not run in `phase`, otherwise undefined. */
export function phaseGuard(tool: string, phase: Phase | undefined): string | undefined {
  const allowed = TOOL_PHASES[tool]
  if (allowed === undefined) return `Unknown Mathesis tool "${tool}".`
  if (allowed === null) return undefined
  if (phase === undefined) {
    return `mathesis_${tool} needs an active Mathesis topic. Call mathesis_topic_start (or ask the learner to run /learn) first.`
  }
  if (allowed.includes(phase)) return undefined
  return `mathesis_${tool} is not available in the ${phase} phase (allowed: ${allowed.join(", ")}). Use the tools described for the ${phase} phase.`
}
