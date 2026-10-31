import type { Phase } from "../phases.ts"
import { parsePlan, planToMermaid, renderPlanTree, storePlan } from "../plan.ts"
import { Refusal, dueLabel, sessionKind, type Runtime } from "../runtime.ts"
import { rate, review, type Grade } from "../srs/fsrs.ts"
import { mutateSession, setPhase, updateSession, type AnswerRecord, type SessionState } from "../state.ts"
import { appendLog } from "../store/log.ts"
import { isSlug, slugify, today } from "../store/vault.ts"
import { oneOf, schema, text, textList, type ToolSpec } from "./define.ts"
import { refuseWhileOpen } from "./topics.ts"

function requireTopic(state: SessionState | undefined): string {
  if (!state?.topic) throw new Refusal("this session has no topic. Call mathesis_topic_start first.")
  return state.topic
}

function slugs(input: Record<string, unknown>, key: string, exclude?: string): string[] {
  const values = textList(input, key)
  const bad = values.filter((value) => !isSlug(value))
  if (bad.length) throw new Refusal(`\`${key}\` must hold card ids (lowercase slugs); not valid: ${bad.join(", ")}.`)
  return [...new Set(values)].filter((value) => value !== exclude)
}

/**
 * Claims an answer for one tool call in a single locked step: the answer must exist in this session, be unused and
 * pass `check`. Parallel calls with the same questionID cannot both succeed. Call `release` if the work then fails.
 */
export async function useAnswer(
  rt: Runtime,
  sessionID: string,
  questionID: string | undefined,
  usedBy: (record: AnswerRecord) => string,
  /** May refuse (throw), and may return fields to store on the answer, e.g. the agent's verdict on free recall. */
  check: (record: AnswerRecord, state: SessionState) => Partial<AnswerRecord> | void = () => {},
): Promise<{ record: AnswerRecord; release: () => Promise<void> }> {
  let claimed: AnswerRecord | undefined
  let tag = ""
  await mutateSession(
    rt.store,
    sessionID,
    (current) => {
      const found = findAnswer(current, questionID)
      const record = { ...found, ...(check(found, current) ?? {}) }
      tag = usedBy(record)
      claimed = record
      return { answers: current.answers!.map((a) => (a.questionID === record.questionID ? { ...record, usedBy: tag } : a)) }
    },
    rt.now(),
  )
  const release = async () => {
    await mutateSession(
      rt.store,
      sessionID,
      (current) => ({
        answers: (current.answers ?? []).map((a) => (a.questionID === claimed!.questionID && a.usedBy === tag ? { ...a, usedBy: undefined } : a)),
      }),
      rt.now(),
    ).catch(() => {})
  }
  return { record: claimed!, release }
}

export function findAnswer(state: SessionState | undefined, questionID: string | undefined): AnswerRecord {
  const record = questionID ? state?.answers?.find((a) => a.questionID === questionID) : undefined
  if (!record) throw new Refusal(`no answered question \`${questionID}\` in this session. Pass the questionID from the question's result.`)
  if (record.usedBy) throw new Refusal(`question \`${questionID}\` was already used (${record.usedBy}).`)
  return record
}

export const teachTools: ToolSpec[] = [
  {
    name: "probe_done",
    description:
      "End the probe: record the learner assessment (one entry per dependency strand) in the topic note and move this session to the teach phase. Call exactly once, when every strand is bracketed and the goal is concrete. Refused while a question is open.",
    input: schema.object(
      {
        summary: schema.str("Overall synthesis: the concrete goal and where the teaching should enter."),
        strands: {
          type: "array",
          minItems: 1,
          description: "Every strand the lesson will depend on.",
          items: schema.object(
            {
              strand: schema.str("The dependency strand, e.g. 'the derivative as a limit'."),
              floor: schema.str("What the learner reliably gets right."),
              ceiling: schema.str("Where it runs out: wrong or unknown."),
              misconceptions: schema.list("Misconceptions found, in the learner's terms."),
              buildFrom: schema.str("What the lesson should build from."),
            },
            ["strand", "floor", "ceiling", "buildFrom"],
          ),
        },
      },
      ["summary", "strands"],
    ),
    async run(input, call, rt) {
      await refuseWhileOpen(rt, call)
      const topic = requireTopic(call.state)
      const summary = text(input, "summary", { max: 4000 })!
      if (!Array.isArray(input.strands) || input.strands.length === 0) throw new Refusal("give at least one strand.")
      const now = rt.now()
      const blocks = (input.strands as Record<string, unknown>[]).map((strand) => {
        const misconceptions = textList(strand, "misconceptions")
        return [
          `### ${text(strand, "strand", { max: 200 })}`,
          `- Floor: ${text(strand, "floor", { max: 2000 })}`,
          `- Ceiling: ${text(strand, "ceiling", { max: 2000 })}`,
          `- Misconceptions: ${misconceptions.length ? misconceptions.join("; ") : "none found"}`,
          `- Build from: ${text(strand, "buildFrom", { max: 2000 })}`,
        ].join("\n")
      })
      await rt.vault.updateTopic(topic, { sections: { Assessment: [`Probed ${today(now)}.`, summary, ...blocks].join("\n\n") } }, now)
      await setPhase(rt.store, call.sessionID, "teach", {}, now)
      return [
        "Assessment saved in the topic note. The session is now in the teach phase.",
        "Next, without waiting: plan (see the planning doctrine), present the approach in prose and the map with mathesis_plan_set, and ask the learner to confirm. Teach nothing before they confirm.",
      ].join("\n")
    },
  },
  {
    name: "plan_set",
    description:
      "Write or rewrite the topic's plan map: a mermaid `graph TD` block. Node ids are permanent lowercase slugs (a-z, 0-9, single hyphens) that questions reference as nodeId and that become card ids; `a --> b` means a is required before b; labels as `a[\"Short title\"]`. Returns the map as an indented tree.",
    input: schema.object({ mermaid: schema.str("The plan as a mermaid graph TD block.") }, ["mermaid"]),
    async run(input, call, rt) {
      const topic = requireTopic(call.state)
      const parsed = parsePlan(text(input, "mermaid", { max: 20_000 })!)
      if (!parsed.ok) throw new Refusal(`the plan could not be read:\n${parsed.problems.map((p) => `- ${p}`).join("\n")}`)
      const plan = parsed.plan
      const tree = renderPlanTree(plan)
      await rt.vault.updateTopic(
        topic,
        {
          fields: { plan: storePlan(plan) },
          sections: { Plan: ["```mermaid", planToMermaid(plan), "```", "", "Foundations first:", "", renderPlanTree(plan, undefined, { list: true })].join("\n") },
        },
        rt.now(),
      )
      if (call.state?.currentNode && !plan.nodes.some((n) => n.id === call.state!.currentNode)) {
        await updateSession(rt.store, call.sessionID, { currentNode: undefined }, rt.now())
      }
      rt.events.planUpdated({ sessionID: call.sessionID, topic })
      return `Plan saved (${plan.nodes.length} nodes, ${plan.edges.length} edges). The learner sees it as:\n\n${tree}`
    },
  },
  {
    name: "idea_upsert",
    description:
      "Create the card for an idea the learner just demonstrated with a passed check (or record another review of the node's existing card). Only call it after a `check` question whose answer was correct (multiple choice) or that you graded correct or partial (free recall). The check counts as a review; the tool schedules the next one. An existing card keeps its text (the learner may have edited it).",
    input: schema.object(
      {
        questionID: schema.str("The passed check's questionID."),
        id: schema.str("Card id; defaults to the check's nodeId. A new slug only when the step taught a finer idea."),
        claim: schema.str("The idea in one or two sentences that stand on their own."),
        why: schema.str("The reasoning chain that makes it follow."),
        requires: schema.list("Ids of the cards this idea builds on."),
        kind: schema.enum(["proposition", "chain"], "proposition (one fact) or chain (a reasoning chain). Default proposition."),
        verdict: schema.enum(["correct", "partial"], "Free-recall checks: your strict grading of the answer. Required for them."),
        cleanReasoning: { type: "boolean", description: "false when the answer was right but the thinking showed a confused model (caps the rating at Good)." },
      },
      ["questionID", "claim", "why"],
    ),
    async run(input, call, rt) {
      const topic = requireTopic(call.state)
      const claim = text(input, "claim", { max: 2000 })!
      const why = text(input, "why", { max: 6000 })!
      const kind = oneOf(input, "kind", ["proposition", "chain"] as const, "proposition")
      const requested = text(input, "id", { optional: true })
      if (requested && !isSlug(requested)) throw new Refusal("`id` must be a lowercase slug (a-z, 0-9, single hyphens).")
      let correct: true | "partial" = true
      let id = ""
      const { record, release } = await useAnswer(
        rt,
        call.sessionID,
        text(input, "questionID"),
        (record) => `idea_upsert:${requested ?? record.nodeId}`,
        (record) => {
          if (record.type !== "check") throw new Refusal(`only a passed \`check\` creates a card; \`${record.questionID}\` was a ${record.type}.`)
          if (record.status !== "answered") throw new Refusal("the learner did not know the answer; repair the step and check again.")
          if (record.kind === "quiz") {
            if (record.correct !== true) throw new Refusal("that check was answered wrong; repair the step and check again.")
          } else correct = oneOf(input, "verdict", ["correct", "partial"] as const) === "partial" ? "partial" : true
          id = requested ?? record.nodeId ?? ""
          if (!id) throw new Refusal("give a card `id` (lowercase slug), or ask checks with a nodeId.")
          // Keep the agent's verdict on the answer, so later tools see it (e.g. misconception evidence).
          return record.kind === "explain" ? { correct: correct === true } : undefined
        },
      )
      try {
        return await createCard()
      } catch (error) {
        await release()
        throw error
      }

      async function createCard() {
        const existing = await rt.vault.readIdea(id)
        // A check proves its own node, or a new finer idea; it cannot review an unrelated existing card.
        if (existing && id !== record.nodeId) {
          throw new Refusal(`\`${id}\` is an existing card that this check (about \`${record.nodeId}\`) does not test. Use the node's id or a new id.`)
        }
        if (existing?.kind === "misconception") throw new Refusal(`\`${id}\` is a misconception card; choose another id.`)
        if (existing?.topic && existing.topic !== topic) {
          throw new Refusal(`\`${id}\` belongs to the topic \`${existing.topic}\`; use a new id for this topic's idea.`)
        }
        const now = rt.now()
        const { grade } = rate({ correct, confidence: record.confidence, ...(input.cleanReasoning === false ? { cleanReasoning: false } : {}) })
        const srs = review(existing?.srs, grade, now)
        const source = `sessions/${today(now)}-${topic}-${sessionKind("teach")}.md`
        const { created } = await rt.vault.upsertIdea(
          {
            id,
            topic,
            kind,
            requires: slugs(input, "requires", id),
            claim,
            why,
            source,
            srs,
          },
          now,
        )
        await rt.vault.addAskedBefore(id, record.prompt)
        await appendLog(rt.vault.logPath, {
          ts: now.toISOString(),
          ideaId: id,
          sessionID: call.sessionID,
          mode: "teach",
          scheduled: true,
          type: "check",
          questionStem: record.prompt,
          correct,
          ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
          rating: grade,
          ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
        })
        await rt.vault.updateTopic(topic, { addIdeas: [id] }, now)
        // A card that builds on another topic's card connects the two topics.
        for (const required of slugs(input, "requires", id)) {
          const other = (await rt.vault.readIdea(required).catch(() => undefined))?.topic
          if (!other || other === topic || !(await rt.vault.readTopic(other).catch(() => undefined))) continue
          await rt.vault.updateTopic(topic, { addRelated: [other] }, now)
          await rt.vault.updateTopic(other, { addRelated: [topic] }, now)
        }
        await linkCard(rt, call.sessionID, topic, call.state!.phase, id, created ? "Card created" : "Card reviewed again", now)
        rt.events.cardsChanged({ sessionID: call.sessionID, added: created ? [id] : [], updated: created ? [] : [id] })
        const idea = (await rt.vault.readIdea(id))!
        return `${created ? "Card created" : "Card reviewed again"}: \`${id}\` (rated ${grade}; ${dueLabel(idea, now)}). Continue with the next step.`
      }
    },
  },
  {
    name: "misconception_record",
    description:
      "Record a committed misconception (a wrong model the learner holds, typically a wrong answer with confidence ≥ 70). It becomes its own card, reviewed with discrimination questions that set the wrong model against the right one; recording it again bumps it.",
    input: schema.object(
      {
        wrongModel: schema.str("The wrong model, in the learner's terms."),
        rightModel: schema.str("The right model it should be replaced by."),
        about: schema.list("Ids of the cards (or plan nodes) the misconception corrupts."),
        id: schema.str("Optional card id; defaults to one derived from the wrong model."),
        questionID: schema.str("Optional: the question whose answer revealed it."),
      },
      ["wrongModel", "rightModel"],
    ),
    async run(input, call, rt) {
      const state = call.state!
      const wrong = text(input, "wrongModel", { max: 2000 })!
      const right = text(input, "rightModel", { max: 2000 })!
      const id = text(input, "id", { optional: true }) ?? `misconception-${slugify(wrong, 40)}`
      if (!isSlug(id)) throw new Refusal("`id` must be a lowercase slug.")
      const about = slugs(input, "about", id)
      const questionID = text(input, "questionID", { optional: true })
      let record: AnswerRecord | undefined
      if (questionID) {
        // Evidence, when named, must be real: an answer of this session that was not right, used once per card.
        await mutateSession(
          rt.store,
          call.sessionID,
          (current) => {
            const found = current.answers?.find((a) => a.questionID === questionID)
            if (!found) throw new Refusal(`no answered question \`${questionID}\` in this session.`)
            if (found.correct === true) throw new Refusal("that answer was correct; a misconception needs a wrong answer or wrong thinking as evidence.")
            if (found.misconceptions?.includes(id)) throw new Refusal(`\`${id}\` was already recorded from this answer.`)
            record = found
            return { answers: current.answers!.map((a) => (a.questionID === questionID ? { ...a, misconceptions: [...(a.misconceptions ?? []), id] } : a)) }
          },
          rt.now(),
        )
      }
      const now = rt.now()
      const grade: Grade = "again"
      const existing = await rt.vault.readIdea(id)
      if (existing && existing.kind !== "misconception") throw new Refusal(`\`${id}\` is an idea card, not a misconception; choose another id.`)
      // Without a session topic (an all-topics review or practice), the card takes the topic of the idea it corrupts.
      let topic = state.topic
      for (const target of about) topic ??= (await rt.vault.readIdea(target).catch(() => undefined))?.topic
      const { created } = await rt.vault.upsertIdea(
        {
          id,
          ...(topic ? { topic } : {}),
          kind: "misconception",
          about,
          claim: right,
          misconceptions: `- ${wrong}`,
          srs: review(existing?.srs, grade, now),
        },
        now,
      )
      for (const target of about) {
        if (await rt.vault.hasIdea(target)) {
          await rt.vault.upsertIdea({ id: target, misconceptions: `- [${wrong}](./${id}.md)` }, now)
        }
      }
      await appendLog(rt.vault.logPath, {
        ts: now.toISOString(),
        ideaId: id,
        sessionID: call.sessionID,
        mode: state.phase === "probe" || state.phase === "teach" ? "teach" : "review",
        scheduled: true,
        ...(record ? { type: record.type, questionStem: record.prompt } : {}),
        correct: false,
        ...(record?.confidence !== undefined ? { confidence: record.confidence } : {}),
        rating: grade,
      })
      if (topic && (await rt.vault.readTopic(topic).catch(() => undefined))) await rt.vault.updateTopic(topic, { addIdeas: [id] }, now)
      if (state.topic) {
        await linkCard(rt, call.sessionID, state.topic, state.phase, id, created ? "Misconception card created" : "Misconception card bumped", now)
      }
      rt.events.cardsChanged({ sessionID: call.sessionID, added: created ? [id] : [], updated: created ? [] : [id] })
      const next =
        state.phase === "probe"
          ? "Continue the probe; dig into its extent."
          : state.phase === "teach"
            ? "Now repair it in the teaching."
            : "Correct it surgically in one or two sentences; it comes back as a discrimination question."
      return `${created ? "Misconception card created" : "Misconception card bumped"}: \`${id}\`. ${next}`
    },
  },
]

/** Links a card from the session note, so the note shows which cards the session made or touched. */
async function linkCard(rt: Runtime, sessionID: string, topic: string, phase: Phase, id: string, label: string, now: Date) {
  await rt.vault
    .appendSession({ sessionID, topic, kind: sessionKind(phase), date: today(now) }, `**${label}:** [${id.replace(/-/g, " ")}](../ideas/${id}.md)`)
    .catch(() => {})
}
