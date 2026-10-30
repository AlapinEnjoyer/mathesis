import { Refusal, type Runtime } from "../runtime.ts"
import { rate } from "../srs/fsrs.ts"
import { mutateSession, type SessionState } from "../state.ts"
import { appendLog, readLog, type ReviewEntry } from "../store/log.ts"
import type { Idea } from "../store/vault.ts"
import { cardDetail, dueText } from "./cards.ts"
import { findAnswer, useAnswer } from "./teach.ts"
import { oneOf, schema, text, type ToolSpec } from "./define.ts"
import { refuseWhileOpen } from "./topics.ts"

const MISS_TYPES = ["cue", "discrimination", "execution", "careless", "structural"] as const
const HINTS = ["none", "R0", "R1", "R2", "R3", "R4", "R5"] as const
const DAY = 86_400_000

/**
 * How weak a card is now: elapsed time over stability (a retrievability proxy), so a long-overdue card ranks above a
 * fresh low-stability one. Misconceptions that are not yet stable come first.
 */
function weakness(idea: Idea, now: Date): number {
  const srs = idea.srs!
  const last = srs.last ? Date.parse(srs.last) : now.getTime()
  const elapsed = Math.max(0, now.getTime() - last) / DAY
  const score = (elapsed + 1) / Math.max(srs.stability, 0.1)
  return idea.kind === "misconception" && srs.stability < 21 ? score + 1000 : score
}

/**
 * Practice targets, weakest first; among equals the ideas many others build on ("most served"). Cards practised
 * recently (`recent`, e.g. in this session or in the last day) move to the back, so each session gets fresh targets.
 */
export function rankTargets(ideas: readonly Idea[], now: Date, recent: ReadonlySet<string> = new Set()): Idea[] {
  const served = new Map<string, number>()
  for (const idea of ideas) for (const id of idea.requires) served.set(id, (served.get(id) ?? 0) + 1)
  return ideas
    .filter((idea) => (idea.srs?.reps ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(recent.has(a.id)) - Number(recent.has(b.id)) ||
        weakness(b, now) - weakness(a, now) ||
        (served.get(b.id) ?? 0) - (served.get(a.id) ?? 0) ||
        a.id.localeCompare(b.id),
    )
}

/** This session's concluded practice problems, oldest first. */
async function sessionPractice(rt: Runtime, sessionID: string): Promise<ReviewEntry[]> {
  return (await readLog(rt.vault.logPath)).entries.filter(
    (e): e is ReviewEntry => e.mode === "practice" && e.sessionID === sessionID,
  )
}

const outcome = (e: ReviewEntry) =>
  `${e.type ?? "?"} ${e.correct === true ? "solved" : e.correct === "partial" ? "partly" : "missed"}${e.hints && e.hints !== "none" ? ` (hint ${e.hints})` : ""}`

const needsRetest = (e: ReviewEntry) => e.correct !== true || ["R3", "R4", "R5"].includes(e.hints ?? "")

export const practiceTools: ToolSpec[] = [
  {
    name: "practice_targets",
    description:
      "The cards to build practice problems from: ideas the learner holds, weakest first, with their full content, this session's outcomes per target and the list of problems to retest. Call it at the start, after every few problems, when resuming, and before closing.",
    input: schema.object({
      count: { type: "integer", minimum: 1, maximum: 20, description: "How many targets (default 6)." },
    }),
    async run(input, call, rt) {
      const state = call.state!
      const now = rt.now()
      const { ideas } = await rt.vault.listIdeas()
      let pool = ideas
      if (state.topic) {
        const topic = await rt.vault.readTopic(state.topic)
        const listed = new Set(topic?.ideas ?? [])
        pool = ideas.filter((idea) => idea.topic === state.topic || listed.has(idea.id))
      }
      const history = await sessionPractice(rt, call.sessionID)
      const recentAll = (await readLog(rt.vault.logPath)).entries.filter((e) => e.mode === "practice" && Date.parse(e.ts) > now.getTime() - DAY)
      const count = Math.min(20, Math.max(1, Number.isInteger(input.count) ? Number(input.count) : 6))
      const ranked = rankTargets(pool, now, new Set(recentAll.map((e) => e.ideaId))).slice(0, count)
      if (ranked.length === 0) {
        return state.topic
          ? `The learner holds no reviewed cards in \`${state.topic}\` yet. Say so; suggest /learn for this topic, or /practice without a topic.`
          : "The learner holds no reviewed cards yet. Say so, and suggest /learn to build some first."
      }
      const cap = rt.config.reviewCap
      const byTarget = new Map<string, ReviewEntry[]>()
      for (const e of history) byTarget.set(e.ideaId, [...(byTarget.get(e.ideaId) ?? []), e])
      const lastOutcome = new Map(history.map((e) => [e.ideaId, e]))
      const retest = [...lastOutcome.values()].filter(needsRetest).map((e) => e.ideaId)
      const lines = [
        `${history.length} of ${cap} problems done in this session${history.length >= cap ? ": the cap is reached; retest what is left, then close." : "."}`,
        `Last target: ${history.at(-1)?.ideaId ?? "none"} (never the same target twice in a row; retries of the active problem do not count).`,
        `To retest before closing (fresh situation): ${retest.length ? retest.join(", ") : "nothing"}.`,
        "",
      ]
      for (const idea of ranked) {
        const past = byTarget.get(idea.id) ?? []
        lines.push(
          `## \`${idea.id}\` (${idea.kind}${idea.kind === "misconception" ? ", use discrimination" : ""}, stability ${idea.srs?.stability ?? 0} d, ${dueText(idea, now)})`,
          `This session: ${past.length ? past.map(outcome).join("; ") : "not practised yet"}`,
          "",
          ...(await cardDetail(rt, idea, { askedBefore: 3 })),
          "",
        )
      }
      return lines.join("\n")
    },
  },
  {
    name: "practice_record",
    description:
      "Record a concluded practice problem once: solved, or given up. Pass the questionID of its last attempt, the highest hint rung the learner needed over all attempts, and for a miss its kind. Practice is logged but does not change the review schedule.",
    input: schema.object(
      {
        questionID: schema.str("The questionID of the problem's last attempt."),
        verdict: schema.enum(["correct", "partial", "wrong"], "Free recall: your strict grading of the last attempt. Ignored for multiple choice."),
        hints: schema.enum(HINTS, "The highest hint rung used over all attempts: none, or R0 (attention) … R5 (worked step)."),
        miss: schema.enum(MISS_TYPES, "If the problem was not solved: cue (nothing came), discrimination (wrong idea won), execution, careless, or structural (a misconception)."),
      },
      ["questionID"],
    ),
    async run(input, call, rt) {
      await refuseWhileOpen(rt, call)
      // Validate everything before the answer is claimed, so a bad input does not use it up.
      const hints = oneOf(input, "hints", HINTS, "none")
      const miss = input.miss === undefined ? undefined : oneOf(input, "miss", MISS_TYPES)
      const questionID = text(input, "questionID")
      const preview = findAnswer(call.state, questionID)
      if (!preview.ideaId) throw new Refusal("that question had no ideaId; practice questions must name their target card.")
      if (!(await rt.vault.hasIdea(preview.ideaId))) throw new Refusal(`the card \`${preview.ideaId}\` no longer exists.`)

      let correct = false as boolean | "partial"
      const { record, release } = await useAnswer(
        rt,
        call.sessionID,
        questionID,
        (record) => `practice_record:${record.ideaId}`,
        (record) => {
          if (record.status === "dont_know") correct = false
          else if (record.kind === "quiz") correct = record.correct === true
          else {
            const verdict = oneOf(input, "verdict", ["correct", "partial", "wrong"] as const)
            correct = verdict === "correct" ? true : verdict === "partial" ? "partial" : false
            return { correct: verdict === "correct" }
          }
        },
      )
      const ideaId = record.ideaId!
      const now = rt.now()
      const { grade } = rate({ correct, confidence: record.confidence, dontKnow: record.status === "dont_know" })
      try {
        await appendLog(rt.vault.logPath, {
          ts: now.toISOString(),
          ideaId,
          sessionID: call.sessionID,
          mode: "practice",
          scheduled: false,
          type: record.type,
          questionStem: record.prompt,
          correct,
          ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
          ...(record.status === "dont_know" ? { dontKnow: true } : {}),
          rating: grade,
          hints,
          ...(correct !== true && miss ? { miss } : {}),
          ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
        })
      } catch (error) {
        await release()
        throw error
      }
      await rt.vault.addAskedBefore(ideaId, record.prompt).catch(() => {})
      const state: SessionState = await mutateSession(rt.store, call.sessionID, (current) => ({ done: [...(current.done ?? []), ideaId] }), now)

      const problems = (await sessionPractice(rt, call.sessionID)).filter((e) => e.ideaId === ideaId)
      const twoMisses = problems.length >= 2 && problems.slice(-2).every((e) => e.correct !== true)
      const advice =
        correct === true && hints === "none"
          ? "Clean: one notch harder on this target next time."
          : correct === true
            ? "Solved with hints: hold the difficulty on this target."
            : twoMisses
              ? "Two concluded problems on this target missed in a row: switch targets, and come back to it later in a fresh situation."
              : "Missed: one notch easier on this target next time, or drop back a mode (composition → discrimination → recall)."
      const done = state.done?.length ?? 0
      return [
        `Recorded (${correct === true ? "solved" : correct === "partial" ? "partly solved" : "missed"}${hints !== "none" ? `, hint ${hints}` : ""}${correct !== true && miss ? `, ${miss} miss` : ""}).`,
        advice,
        ...(correct !== true && miss === "structural" ? ["A structural miss is a misconception: record it with mathesis_misconception_record."] : []),
        done >= rt.config.reviewCap
          ? "The session cap is reached: retest what is left (mathesis_practice_targets lists it), then close with a short summary."
          : "Give your closing words on this problem, then pose the next one (another target).",
      ].join("\n")
    },
  },
]
