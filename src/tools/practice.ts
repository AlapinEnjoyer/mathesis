import { dueLabel, ideaState, Refusal, type Runtime } from "../runtime.ts"
import { getSession, updateSession } from "../state.ts"
import { appendLog, readLog } from "../store/log.ts"
import type { Idea } from "../store/vault.ts"
import { oneOf, schema, text, type ToolSpec } from "./define.ts"
import { useAnswer } from "./teach.ts"
import { refuseWhileOpen } from "./topics.ts"

const firstLine = (value: string) => value.split("\n").find((line) => line.trim())?.trim() ?? ""
const MISS_TYPES = ["cue", "discrimination", "execution", "careless", "structural"] as const

/**
 * Practice targets, weakest first: misconceptions and low-stability cards before stable ones, and among equals the
 * ideas that many others build on ("most served"), so one practice demand strengthens several chains.
 */
export function rankTargets(ideas: readonly Idea[]): Idea[] {
  const served = new Map<string, number>()
  for (const idea of ideas) for (const id of idea.requires) served.set(id, (served.get(id) ?? 0) + 1)
  const weight = (idea: Idea) => (idea.kind === "misconception" ? -1 : (idea.srs?.stability ?? 0))
  return ideas
    .filter((idea) => (idea.srs?.reps ?? 0) > 0)
    .sort((a, b) => weight(a) - weight(b) || (served.get(b.id) ?? 0) - (served.get(a.id) ?? 0) || a.id.localeCompare(b.id))
}

export const practiceTools: ToolSpec[] = [
  {
    name: "practice_targets",
    description:
      "The cards to build practice problems from: ideas the learner already holds, weakest first (misconceptions and low stability), with their claims, foundations and asked-before stems. Interleave them: never two problems in a row on the same card.",
    input: schema.object({
      count: { type: "integer", minimum: 1, maximum: 20, description: "How many targets (default 8)." },
    }),
    async run(input, call, rt) {
      const state = call.state!
      const { ideas } = await rt.vault.listIdeas()
      let pool = ideas
      if (state.topic) {
        const topic = await rt.vault.readTopic(state.topic)
        const listed = new Set(topic?.ideas ?? [])
        pool = ideas.filter((idea) => idea.topic === state.topic || listed.has(idea.id))
      }
      const count = Number.isInteger(input.count) ? Number(input.count) : 8
      const ranked = rankTargets(pool).slice(0, count)
      if (ranked.length === 0) {
        return "The learner holds no cards to practice yet. Say so, and suggest /learn to build some first."
      }
      const now = rt.now()
      const done = state.done ?? []
      return [
        `${ranked.length} targets${state.topic ? ` in \`${state.topic}\`` : ""}, weakest first. Practised in this session: ${done.length ? done.join(", ") : "none"}.`,
        "",
        ...ranked.flatMap((idea) => [
          `## \`${idea.id}\` (${idea.kind}, ${ideaState(idea, now)}, stability ${idea.srs?.stability ?? 0} d, ${dueLabel(idea, now)})`,
          firstLine(idea.claim),
          ...(idea.requires.length ? [`Builds on: ${idea.requires.join(", ")}`] : []),
          ...(idea.askedBefore.length ? [`Asked before: ${idea.askedBefore.slice(-3).join(" | ")}`] : []),
          "",
        ]),
      ].join("\n")
    },
  },
  {
    name: "practice_record",
    description:
      "Record the outcome of a practice problem (mathesis_quiz or mathesis_explain with type practice or a mode, and the target card's ideaId). Practice is logged but does not change the review schedule.",
    input: schema.object(
      {
        questionID: schema.str("The practice question's questionID."),
        verdict: schema.enum(["correct", "partial", "wrong"], "Free recall: your strict grading. Ignored for multiple choice."),
        hints: { type: "integer", minimum: 0, maximum: 5, description: "The highest hint rung the learner needed (0 = none, 5 = worked step)." },
        miss: schema.enum(MISS_TYPES, "For a miss: cue (nothing came), discrimination (wrong idea won), execution, careless, or structural (a misconception)."),
      },
      ["questionID"],
    ),
    async run(input, call, rt) {
      await refuseWhileOpen(rt, call)
      let correct = false as boolean | "partial"
      // Claimed atomically; the log write below is the only work, so a failure there releases it again.
      const { record, release } = await useAnswer(
        rt,
        call.sessionID,
        text(input, "questionID"),
        (record) => `practice_record:${record.ideaId}`,
        (record) => {
          if (!record.ideaId) throw new Refusal("that question had no ideaId; practice questions must name their target card.")
          if (record.status === "dont_know") correct = false
          else if (record.kind === "quiz") correct = record.correct === true
          else {
            const verdict = oneOf(input, "verdict", ["correct", "partial", "wrong"] as const)
            correct = verdict === "correct" ? true : verdict === "partial" ? "partial" : false
          }
        },
      )
      const ideaId = record.ideaId!
      const hints = Number.isInteger(input.hints) ? Number(input.hints) : 0
      const miss = correct === true ? undefined : input.miss === undefined ? undefined : oneOf(input, "miss", MISS_TYPES)
      const now = rt.now()
      await appendLog(rt.vault.logPath, {
        ts: now.toISOString(),
        ideaId: ideaId,
        sessionID: call.sessionID,
        mode: "practice",
        scheduled: false,
        type: record.type,
        questionStem: record.prompt,
        correct,
        ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
        ...(record.status === "dont_know" ? { dontKnow: true } : {}),
        rating: correct === true ? (hints >= 3 ? "hard" : "good") : correct === "partial" ? "hard" : "again",
        ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
      }).catch(async (error) => {
        await release()
        throw error
      })
      if (await rt.vault.hasIdea(ideaId)) await rt.vault.addAskedBefore(ideaId, record.prompt)
      const state = await getSession(rt.store, call.sessionID)
      const history = [...(state?.done ?? []), ideaId]
      await updateSession(rt.store, call.sessionID, { done: history }, now)
      const outcomes = (await readLog(rt.vault.logPath)).entries.filter(
        (e) => e.mode === "practice" && e.sessionID === call.sessionID && e.ideaId === ideaId,
      )
      const twoMisses = outcomes.length >= 2 && outcomes.slice(-2).every((e) => e.mode === "practice" && e.correct !== true)
      const advice =
        correct === true && hints <= 1
          ? "Clean: one notch harder on this target next time."
          : correct === true
            ? "Solved with hints: hold the difficulty on this target."
            : twoMisses
              ? "Second miss on this target: switch to another target next, and come back to this one later in a fresh situation."
              : "Missed: one notch easier on this target, or drop back a mode (composition → discrimination → recall)."
      return [
        `Recorded (${correct === true ? "solved" : correct === "partial" ? "partly solved" : "missed"}${hints ? `, hint rung ${hints}` : ""}${miss ? `, ${miss} miss` : ""}).`,
        advice,
        ...(miss === "structural" ? ["A structural miss is a misconception: record it with mathesis_misconception_record."] : []),
        "Retest every miss before the session ends, in a new situation.",
      ].join("\n")
    },
  },
]
