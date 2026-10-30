import { dueLabel, Refusal, type Runtime } from "../runtime.ts"
import { dueFirst, parseDate, pullForward, rate, review, type Srs } from "../srs/fsrs.ts"
import { getSession, updateSession } from "../state.ts"
import { appendLog } from "../store/log.ts"
import type { Idea } from "../store/vault.ts"
import { oneOf, schema, text, type ToolSpec } from "./define.ts"
import { useAnswer } from "./teach.ts"
import { refuseWhileOpen } from "./topics.ts"

const firstLine = (value: string) => value.split("\n").find((line) => line.trim())?.trim() ?? ""

/** A lapse: a card that had been learned (reviewed before) is forgotten. */
const isLapse = (before: Srs | undefined, after: Srs) => !!before && before.reps > 0 && after.lapses > before.lapses

/**
 * The next card: the most overdue first, but never two in a row from the same topic while another topic has a due
 * card (interleaving), and never one already done in this session.
 */
export function pickNext(due: readonly Idea[], done: readonly string[], lastTopic?: string): Idea | undefined {
  const open = due.filter((idea) => !done.includes(idea.id))
  return open.find((idea) => !lastTopic || idea.topic !== lastTopic) ?? open[0]
}

/** The question mode to suggest for a card. */
export function suggestMode(idea: Idea): "recall" | "discrimination" | "reverse" {
  if (idea.kind === "misconception") return "discrimination"
  if ((idea.srs?.lapses ?? 0) > 0 || (idea.srs?.reps ?? 0) < 3) return "recall"
  return (idea.srs?.reps ?? 0) % 2 === 0 ? "reverse" : "discrimination"
}

export async function dueIdeas(rt: Runtime, topic?: string): Promise<Idea[]> {
  const { ideas } = await rt.vault.listIdeas()
  let pool = ideas
  if (topic) {
    const note = await rt.vault.readTopic(topic)
    const listed = new Set(note?.ideas ?? [])
    pool = ideas.filter((idea) => idea.topic === topic || listed.has(idea.id))
  }
  return dueFirst(pool, rt.now())
}

export const reviewTools: ToolSpec[] = [
  {
    name: "review_next",
    description:
      "Get the next due card for spaced review: its claim, why, foundations, known misconceptions, the question stems asked before (do not reuse their wording) and a suggested mode. Returns no card when nothing is due or the session cap is reached.",
    input: schema.object({}),
    async run(_input, call, rt) {
      await refuseWhileOpen(rt, call)
      const state = call.state!
      const done = state.done ?? []
      if (done.length >= rt.config.reviewCap) {
        return `Session cap reached (${rt.config.reviewCap} cards). Close the session with a short summary of what held and what lapsed.`
      }
      const due = await dueIdeas(rt, state.topic)
      const lastTopic = done.length ? (await rt.vault.readIdea(done[done.length - 1]!).catch(() => undefined))?.topic : undefined
      const idea = pickNext(due, done, lastTopic)
      if (!idea) {
        const { ideas } = await rt.vault.listIdeas()
        const next = ideas
          .map((i) => parseDate(i.srs?.due))
          .filter((d): d is Date => !!d)
          .sort((a, b) => a.getTime() - b.getTime())[0]
        return [
          done.length ? `All due cards are done (${done.length} reviewed in this session).` : "No cards are due.",
          next ? `The next card is due ${next.toISOString().slice(0, 10)}.` : "",
          "Close the session with a short summary.",
        ]
          .filter(Boolean)
          .join(" ")
      }
      await updateSession(rt.store, call.sessionID, { currentNode: idea.id }, rt.now())
      const foundations: string[] = []
      for (const id of idea.kind === "misconception" ? idea.about : idea.requires) {
        const other = await rt.vault.readIdea(id).catch(() => undefined)
        if (other) foundations.push(`- \`${id}\`: ${firstLine(other.claim)}`)
      }
      const remaining = due.filter((i) => !done.includes(i.id)).length
      return [
        `Card ${done.length + 1} (${remaining} due${state.topic ? ` in \`${state.topic}\`` : ""}, cap ${rt.config.reviewCap}).`,
        `ideaId: ${idea.id}`,
        `Kind: ${idea.kind}${idea.topic ? ` · topic: ${idea.topic}` : ""} · ${dueLabel(idea, rt.now())} · reviews: ${idea.srs?.reps ?? 0}, lapses: ${idea.srs?.lapses ?? 0}`,
        `Suggested mode: ${suggestMode(idea)}`,
        "",
        idea.kind === "misconception" ? "## The right model" : "## Claim",
        idea.claim || "(empty)",
        ...(idea.why ? ["", "## Why", idea.why] : []),
        ...(idea.misconceptions ? ["", idea.kind === "misconception" ? "## The wrong model" : "## Known misconceptions", idea.misconceptions] : []),
        ...(foundations.length ? ["", idea.kind === "misconception" ? "## Ideas it corrupts" : "## Builds on", ...foundations] : []),
        "",
        "## Asked before (write a NEW question; do not reuse this wording)",
        ...(idea.askedBefore.length ? idea.askedBefore.map((stem) => `- ${stem}`) : ["(nothing yet)"]),
      ].join("\n")
    },
  },
  {
    name: "review_grade",
    description:
      "Record the outcome of a review question (mathesis_quiz or mathesis_explain with the card's ideaId) and reschedule the card. Multiple choice is graded by the tool; for free recall pass your strict verdict. A lapse moves the card's foundations forward.",
    input: schema.object(
      {
        questionID: schema.str("The review question's questionID."),
        verdict: schema.enum(["correct", "partial", "wrong"], "Free recall: your strict grading. Ignored for multiple choice."),
        cleanReasoning: { type: "boolean", description: "false when the answer was right but the thinking showed a confused model (caps the rating at Good)." },
      },
      ["questionID"],
    ),
    async run(input, call, rt) {
      let correct: boolean | "partial" = false
      const { record, release } = await useAnswer(
        rt,
        call.sessionID,
        text(input, "questionID"),
        (record) => `review_grade:${record.ideaId}`,
        (record) => {
          if (!record.ideaId) throw new Refusal("that question had no ideaId; review questions must name their card.")
          if (record.status === "dont_know") correct = false
          else if (record.kind === "quiz") correct = record.correct === true
          else {
            const verdict = oneOf(input, "verdict", ["correct", "partial", "wrong"] as const)
            correct = verdict === "correct" ? true : verdict === "partial" ? "partial" : false
          }
        },
      )
      try {
        return await grade()
      } catch (error) {
        await release()
        throw error
      }

      async function grade() {
        const idea = await rt.vault.readIdea(record.ideaId!)
        if (!idea) throw new Refusal(`the card \`${record.ideaId}\` no longer exists.`)
        const now = rt.now()
        const rated = rate({
          correct,
          confidence: record.confidence,
          dontKnow: record.status === "dont_know",
          ...(input.cleanReasoning === false ? { cleanReasoning: false } : {}),
        })
        const before = idea.srs
        const after = review(before, rated.grade, now)
        await rt.vault.setSrs(idea.id, after)
        await rt.vault.addAskedBefore(idea.id, record.prompt)
        await appendLog(rt.vault.logPath, {
          ts: now.toISOString(),
          ideaId: idea.id,
          sessionID: call.sessionID,
          mode: "review",
          scheduled: true,
          type: record.type,
          questionStem: record.prompt,
          correct,
          ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
          ...(record.status === "dont_know" ? { dontKnow: true } : {}),
          rating: rated.grade,
          ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
        })

        // A lapse often means a weak foundation: its direct foundations become due now.
        const pulled: string[] = []
        if (isLapse(before, after)) {
          for (const id of idea.kind === "misconception" ? idea.about : idea.requires) {
            const foundation = await rt.vault.readIdea(id).catch(() => undefined)
            if (!foundation?.srs) continue
            const moved = pullForward(foundation.srs, now)
            if (moved.due === foundation.srs.due) continue
            await rt.vault.setSrs(id, moved)
            await appendLog(rt.vault.logPath, { ts: now.toISOString(), ideaId: id, sessionID: call.sessionID, mode: "pull", cause: idea.id })
            pulled.push(id)
          }
        }
        const state = await getSession(rt.store, call.sessionID)
        await updateSession(rt.store, call.sessionID, { done: [...new Set([...(state?.done ?? []), idea.id])], currentNode: undefined }, now)
        rt.events.cardsChanged({ sessionID: call.sessionID, added: [], updated: [idea.id, ...pulled] })

        const next = (await rt.vault.readIdea(idea.id))!
        return [
          `Rated ${rated.grade}${isLapse(before, after) ? " (a lapse)" : ""}; \`${idea.id}\` is ${dueLabel(next, now)}.`,
          ...(pulled.length ? [`Its foundations are due now: ${pulled.map((id) => `\`${id}\``).join(", ")}.`] : []),
          ...(rated.misconception && idea.kind !== "misconception"
            ? ["Wrong with high confidence: a committed misconception. Record it with mathesis_misconception_record (about: the card), then repair it in one or two sentences."]
            : []),
          correct === true ? "Confirm in one line, then call mathesis_review_next." : "Give the verdict plainly and a surgical correction (no re-teaching), then call mathesis_review_next.",
        ].join("\n")
      }
    },
  },
]
