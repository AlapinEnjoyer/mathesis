import { Refusal, type Runtime } from "../runtime.ts"
import { dueFirst, endOfDay, parseDate, pullForward, rate, review, type Grade, type Srs } from "../srs/fsrs.ts"
import { mutateSession } from "../state.ts"
import { appendLog } from "../store/log.ts"
import { today, type Idea } from "../store/vault.ts"
import { cardDetail, dueText, localDay } from "./cards.ts"
import { oneOf, schema, text, type ToolSpec } from "./define.ts"
import { useAnswer } from "./teach.ts"
import { refuseWhileOpen } from "./topics.ts"

/** A lapse: a card that had been learned (reviewed at least once) is forgotten. */
export const isLapse = (before: Srs | undefined, grade: Grade) => !!before && before.reps > 0 && grade === "again"

/**
 * The next card: the most overdue first, but never two in a row from the same topic while another topic has a due
 * card (interleaving), and never one already done in this session.
 */
export function pickNext(due: readonly Idea[], done: readonly string[], lastTopic?: string): Idea | undefined {
  const open = due.filter((idea) => !done.includes(idea.id))
  return open.find((idea) => !lastTopic || idea.topic !== lastTopic) ?? open[0]
}

/** The question mode to suggest: recall while a card is new or shaky, then alternate discrimination and reverse. */
export function suggestMode(idea: Idea): "recall" | "discrimination" | "reverse" {
  if (idea.kind === "misconception") return "discrimination"
  const srs = idea.srs
  if (!srs || srs.reps < 3 || (srs.lapses > 0 && srs.stability < 7)) return "recall"
  return srs.reps % 2 === 0 ? "reverse" : "discrimination"
}

/** Cards due today (before the end of the learner's local day), most overdue first; optionally one topic only. */
export async function dueIdeas(rt: Runtime, topic?: string): Promise<Idea[]> {
  const { ideas } = await rt.vault.listIdeas()
  let pool = ideas
  if (topic) {
    const note = await rt.vault.readTopic(topic)
    const listed = new Set(note?.ideas ?? [])
    pool = ideas.filter((idea) => idea.topic === topic || listed.has(idea.id))
  }
  return dueFirst(pool, endOfDay(rt.now()))
}

export const reviewTools: ToolSpec[] = [
  {
    name: "review_next",
    description:
      "Serve the next card for spaced review: its claim, why, foundations, known misconceptions, the question stems asked before (do not reuse their wording) and a suggested mode. Ask about exactly this card. Returns no card when nothing is due or the session cap is reached.",
    input: schema.object({}),
    async run(_input, call, rt) {
      await refuseWhileOpen(rt, call)
      const state = call.state!
      const done = state.done ?? []
      if (done.length >= rt.config.reviewCap) {
        await mutateSession(rt.store, call.sessionID, () => ({ currentNode: undefined }), rt.now())
        return `Session cap reached (${rt.config.reviewCap} cards). Close the session with a short summary of what held and what lapsed.`
      }
      const due = await dueIdeas(rt, state.topic)
      const lastTopic = done.length ? (await rt.vault.readIdea(done[done.length - 1]!).catch(() => undefined))?.topic : undefined
      const idea = pickNext(due, done, lastTopic)
      if (!idea) {
        await mutateSession(rt.store, call.sessionID, () => ({ currentNode: undefined }), rt.now())
        const { ideas } = await rt.vault.listIdeas()
        const next = ideas
          .map((i) => parseDate(i.srs?.due))
          .filter((d): d is Date => !!d)
          .sort((a, b) => a.getTime() - b.getTime())[0]
        return [
          done.length ? `All due cards are done (${done.length} reviewed in this session).` : "No cards are due today.",
          next ? `The next card is due ${localDay(next)}.` : "",
          "Close the session with a short summary.",
        ]
          .filter(Boolean)
          .join(" ")
      }
      // The served card: review questions and the grade must be about it.
      await mutateSession(rt.store, call.sessionID, () => ({ currentNode: idea.id }), rt.now())
      const remaining = due.filter((i) => !done.includes(i.id)).length
      return [
        `Card ${done.length + 1} (${remaining} due${state.topic ? ` in \`${state.topic}\`` : ""}, cap ${rt.config.reviewCap}).`,
        `ideaId: ${idea.id}`,
        `Kind: ${idea.kind}${idea.topic ? ` · topic: ${idea.topic}` : ""} · ${dueText(idea, rt.now())} · reviews: ${idea.srs?.reps ?? 0}, lapses: ${idea.srs?.lapses ?? 0}`,
        `Suggested mode: ${suggestMode(idea)}`,
        "",
        ...(await cardDetail(rt, idea)),
      ].join("\n")
    },
  },
  {
    name: "review_grade",
    description:
      "Record the outcome of the review question about the served card and reschedule it. Multiple choice is graded by the tool; for free recall pass your strict verdict. A lapse makes the card's foundations due now.",
    input: schema.object(
      {
        questionID: schema.str("The review question's questionID."),
        verdict: schema.enum(["correct", "partial", "wrong"], "Free recall: your strict grading. Ignored for multiple choice."),
        cleanReasoning: { type: "boolean", description: "false when the answer was right but the thinking showed a confused model (caps the rating at Good)." },
      },
      ["questionID"],
    ),
    async run(input, call, rt) {
      let correct = false as boolean | "partial"
      const { record, release } = await useAnswer(
        rt,
        call.sessionID,
        text(input, "questionID"),
        (record) => `review_grade:${record.ideaId}`,
        (record, state) => {
          if (!record.ideaId) throw new Refusal("that question had no ideaId; review questions must name their card.")
          if (record.ideaId !== state.currentNode) {
            throw new Refusal(`that question is about \`${record.ideaId}\`, but the card being reviewed is ${state.currentNode ? `\`${state.currentNode}\`` : "none (call mathesis_review_next)"}.`)
          }
          if (record.status === "dont_know") correct = false
          else if (record.kind === "quiz") correct = record.correct === true
          else {
            const verdict = oneOf(input, "verdict", ["correct", "partial", "wrong"] as const)
            correct = verdict === "correct" ? true : verdict === "partial" ? "partial" : false
            return { correct: verdict === "correct" }
          }
        },
      )
      const now = rt.now()
      const ideaId = record.ideaId!
      const rated = rate({
        correct,
        confidence: record.confidence,
        dontKnow: record.status === "dont_know",
        ...(input.cleanReasoning === false ? { cleanReasoning: false } : {}),
      })
      let result: { before?: Srs; after?: Srs }
      try {
        result = await rt.vault.updateSrs(ideaId, (srs) => review(srs, rated.grade, now))
      } catch (error) {
        // Nothing was written: the answer can be graded again.
        await release()
        throw (error as Error).message.startsWith("Unknown idea") ? new Refusal(`the card \`${ideaId}\` no longer exists.`) : error
      }
      // From here the review counts; later failures do not release the answer, so it cannot be applied twice.
      const lapse = isLapse(result.before, rated.grade)
      await appendLog(rt.vault.logPath, {
        ts: now.toISOString(),
        ideaId,
        sessionID: call.sessionID,
        mode: "review",
        scheduled: true,
        type: record.type,
        questionStem: record.prompt,
        correct,
        ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
        ...(record.status === "dont_know" ? { dontKnow: true } : {}),
        rating: rated.grade,
        ...(lapse ? { lapse: true } : {}),
        ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
      })
      await rt.vault.addAskedBefore(ideaId, record.prompt).catch(() => {})

      const state = await mutateSession(
        rt.store,
        call.sessionID,
        (current) => ({ done: [...(current.done ?? []).filter((id) => id !== ideaId), ideaId], currentNode: undefined }),
        now,
      )
      // A lapse often means a weak foundation: its direct foundations (for a misconception card: the ideas it
      // corrupts) become due now, unless they were already reviewed today.
      const pulled: string[] = []
      if (lapse) {
        const idea = await rt.vault.readIdea(ideaId)
        for (const id of idea?.kind === "misconception" ? idea.about : (idea?.requires ?? [])) {
          if (state.done?.includes(id)) continue
          const moved = await rt.vault
            .updateSrs(id, (srs) => {
              if (!srs || (srs.last && localDay(srs.last) === today(now))) return undefined
              const next = pullForward(srs, now)
              return next.due === srs.due ? undefined : next
            })
            .catch(() => ({}) as { after?: Srs })
          if (!moved.after) continue
          await appendLog(rt.vault.logPath, { ts: now.toISOString(), ideaId: id, sessionID: call.sessionID, mode: "pull", cause: ideaId })
          pulled.push(id)
        }
      }
      rt.events.cardsChanged({ sessionID: call.sessionID, added: [], updated: [ideaId, ...pulled] })

      const next = (await rt.vault.readIdea(ideaId))!
      const misconception = next.kind === "misconception"
      return [
        `Rated ${rated.grade}${lapse ? " (a lapse)" : ""}; \`${ideaId}\` is ${dueText(next, now)}.`,
        ...(pulled.length ? [`Its foundations are due now: ${pulled.map((id) => `\`${id}\``).join(", ")}.`] : []),
        ...(rated.misconception && !misconception
          ? [`Wrong with high confidence: a committed misconception. Record it with mathesis_misconception_record (about: ["${ideaId}"], questionID: "${record.questionID}"), then correct it in one or two sentences.`]
          : []),
        correct === true
          ? "Confirm in one line, then call mathesis_review_next."
          : "Give the verdict plainly and a surgical correction (no re-teaching), then call mathesis_review_next.",
      ].join("\n")
    },
  },
]
