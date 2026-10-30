import { parsePlan, planToMermaid, renderPlanTree, storePlan } from "../plan.ts"
import { Refusal, dueLabel, sessionKind, type Runtime } from "../runtime.ts"
import { rate, review, type Grade } from "../srs/fsrs.ts"
import { getSession, setPhase, updateSession, type AnswerRecord, type SessionState } from "../state.ts"
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

/** Marks an answer as used by a tool call, so one answer cannot create two cards or two reviews. */
export async function markUsed(rt: Runtime, sessionID: string, questionID: string, usedBy: string) {
  const state = await getSession(rt.store, sessionID)
  if (!state?.answers) return
  const answers = state.answers.map((a) => (a.questionID === questionID ? { ...a, usedBy } : a))
  await updateSession(rt.store, sessionID, { answers }, rt.now())
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
      refuseWhileOpen(call.state)
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
      await rt.vault.updateTopic(topic, { sections: { Assessment: [`Probed ${today(now)}.`, "", summary, "", ...blocks].join("\n\n") } }, now)
      await setPhase(rt.store, call.sessionID, "teach", {}, now)
      return [
        "Assessment saved in the topic note. The session is now in the teach phase.",
        "Next: plan (see the planning doctrine), then present the approach in prose and the map with mathesis_plan_set, and ask the learner to confirm. Do not teach in that turn.",
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
          sections: { Plan: ["```mermaid", planToMermaid(plan), "```", "", "Foundations first:", "", tree].join("\n") },
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
      "Create (or update) the card for an idea the learner just demonstrated with a passed check. Only call it after a `check` question whose answer was correct (multiple choice) or that you graded correct or partial (free recall). The check counts as the card's first review; the tool schedules the next one.",
    input: schema.object(
      {
        questionID: schema.str("The passed check's questionID."),
        id: schema.str("Card id; defaults to the check's nodeId. A new slug only when the step taught a finer idea."),
        claim: schema.str("The idea in one or two sentences that stand on their own."),
        why: schema.str("The reasoning chain that makes it follow."),
        requires: schema.list("Ids of the cards this idea builds on."),
        kind: schema.enum(["proposition", "chain"], "proposition (one fact) or chain (a reasoning chain). Default proposition."),
        verdict: schema.enum(["correct", "partial"], "Free-recall checks: your strict grading of the answer. Required for them."),
      },
      ["questionID", "claim", "why"],
    ),
    async run(input, call, rt) {
      const topic = requireTopic(call.state)
      const record = findAnswer(call.state, text(input, "questionID"))
      if (record.type !== "check") throw new Refusal(`only a passed \`check\` creates a card; \`${record.questionID}\` was a ${record.type}.`)
      if (record.status !== "answered") throw new Refusal("the learner did not know the answer; repair the step and check again.")
      let correct: true | "partial" = true
      if (record.kind === "quiz") {
        if (record.correct !== true) throw new Refusal("that check was answered wrong; repair the step and check again.")
      } else {
        const verdict = oneOf(input, "verdict", ["correct", "partial"] as const)
        correct = verdict === "partial" ? "partial" : true
      }
      const id = text(input, "id", { optional: true }) ?? record.nodeId
      if (!id || !isSlug(id)) throw new Refusal("give a card `id` (lowercase slug), or ask checks with a nodeId.")
      const now = rt.now()
      const { grade } = rate({ correct, confidence: record.confidence })
      const existing = await rt.vault.readIdea(id)
      const srs = review(existing?.srs, grade, now)
      const source = `sessions/${today(now)}-${topic}-${sessionKind("teach")}.md`
      const { created } = await rt.vault.upsertIdea(
        {
          id,
          topic,
          kind: oneOf(input, "kind", ["proposition", "chain"] as const, "proposition"),
          requires: slugs(input, "requires", id),
          claim: text(input, "claim", { max: 2000 })!,
          why: text(input, "why", { max: 6000 })!,
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
      await markUsed(rt, call.sessionID, record.questionID, `idea_upsert:${id}`)
      rt.events.cardsChanged({ sessionID: call.sessionID, added: created ? [id] : [], updated: created ? [] : [id] })
      const idea = (await rt.vault.readIdea(id))!
      return `${created ? "Card created" : "Card updated"}: \`${id}\` (rated ${grade}; ${dueLabel(idea, now)}). Continue with the next step.`
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
      const record = questionID ? state.answers?.find((a) => a.questionID === questionID) : undefined
      const now = rt.now()
      const grade: Grade = "again"
      const existing = await rt.vault.readIdea(id)
      if (existing && existing.kind !== "misconception") throw new Refusal(`\`${id}\` is an idea card, not a misconception; choose another id.`)
      const { created } = await rt.vault.upsertIdea(
        {
          id,
          ...(state.topic ? { topic: state.topic } : {}),
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
      if (state.topic) await rt.vault.updateTopic(state.topic, { addIdeas: [id] }, now)
      rt.events.cardsChanged({ sessionID: call.sessionID, added: created ? [id] : [], updated: created ? [] : [id] })
      return `${created ? "Misconception card created" : "Misconception card bumped"}: \`${id}\`. Now repair it in the teaching.`
    },
  },
]
