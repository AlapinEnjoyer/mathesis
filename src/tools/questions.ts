import { randomUUID } from "node:crypto"
import type { Phase } from "../phases.ts"
import type { LearnerAnswer } from "../questions.ts"
import { CONFIDENCE_LEVELS } from "../questions.ts"
import { Refusal, sessionKind, topicPlan, type Runtime } from "../runtime.ts"
import { ANSWERS_KEPT, mutateSession, type AnswerRecord, type OpenQuestion, type SessionState } from "../state.ts"
import type { QuestionType } from "../store/log.ts"
import { isSlug, today } from "../store/vault.ts"
import { oneOf, schema, text, textList, type CallContext, type ToolSpec } from "./define.ts"
import { refuseWhileOpen } from "./topics.ts"

/** Which question types each phase asks. */
export const PHASE_TYPES: Record<Phase, readonly QuestionType[]> = {
  probe: ["probe"],
  teach: ["predict", "check"],
  review: ["recall", "discrimination", "reverse"],
  practice: ["recall", "discrimination", "reverse", "composition"],
}
const ALL_TYPES = [...new Set(Object.values(PHASE_TYPES).flat())]

const letter = (index: number) => String.fromCharCode(65 + index)
const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`

async function validateTarget(rt: Runtime, state: SessionState, type: QuestionType, input: Record<string, unknown>) {
  const nodeId = text(input, "nodeId", { optional: true })
  const ideaId = text(input, "ideaId", { optional: true })
  if (!PHASE_TYPES[state.phase].includes(type)) {
    throw new Refusal(`type "${type}" is not used in the ${state.phase} phase (use: ${PHASE_TYPES[state.phase].join(", ")}).`)
  }
  if (state.phase === "teach") {
    if (!nodeId) throw new Refusal("teaching questions need the `nodeId` of the plan node they are about.")
    const topic = state.topic ? await rt.vault.readTopic(state.topic) : undefined
    const plan = topicPlan(topic)
    if (!plan) throw new Refusal("there is no plan yet. Present the plan with mathesis_plan_set before teaching.")
    if (!plan.nodes.some((node) => node.id === nodeId)) {
      throw new Refusal(`\`${nodeId}\` is not a node of the plan (${plan.nodes.map((n) => n.id).join(", ")}). Use a plan node, or add it with mathesis_plan_set.`)
    }
  }
  if (state.phase === "review" || state.phase === "practice") {
    if (!ideaId) throw new Refusal("review and practice questions need the `ideaId` of the card they exercise.")
    if (!isSlug(ideaId) || !(await rt.vault.hasIdea(ideaId))) throw new Refusal(`there is no card \`${ideaId}\`.`)
    if (state.phase === "review" && ideaId !== state.currentNode) {
      throw new Refusal(
        state.currentNode
          ? `the card being reviewed is \`${state.currentNode}\`; ask about that card (other cards come when mathesis_review_next serves them).`
          : "call mathesis_review_next first; review questions are about the card it serves.",
      )
    }
  }
  return { ...(nodeId ? { nodeId } : {}), ...(ideaId ? { ideaId } : {}) }
}

async function ask(rt: Runtime, call: CallContext, question: OpenQuestion): Promise<string> {
  const state = call.state!
  const nodeChanged = state.phase === "teach" && question.nodeId && question.nodeId !== state.currentNode
  // Commit before the learner sees anything. Checked and set in one step, so two parallel calls cannot both ask.
  await mutateSession(
    rt.store,
    call.sessionID,
    (current) => {
      const open = current.openQuestion
      if (open && !open.fallback && rt.broker.isOpen(open.questionID)) {
        throw new Refusal(`a question is still open (${open.questionID}). Wait for the learner's answer first.`)
      }
      return { openQuestion: question, ...(nodeChanged ? { currentNode: question.nodeId } : {}) }
    },
    rt.now(),
  )
  if (nodeChanged && state.topic) rt.events.planUpdated({ sessionID: call.sessionID, topic: state.topic })
  await call.progress({ status: "waiting for the learner's answer" }).catch(() => {})

  const outcome = await rt.broker.ask(call.sessionID, question, call.signal)
  if (outcome.kind === "fallback") {
    await mutateSession(rt.store, call.sessionID, (current) => (current.openQuestion?.questionID === question.questionID ? { openQuestion: { ...question, fallback: true } } : {}), rt.now())
    return fallbackText(question)
  }
  if (outcome.kind === "aborted") {
    await clearOpen(rt, call.sessionID, question.questionID)
    return "The question was interrupted before the learner answered."
  }
  return recordAnswer(rt, call.sessionID, question, outcome.answer, outcome.elapsedMs)
}

function fallbackText(question: OpenQuestion): string {
  const lines = [
    "fallback: true",
    `questionID: ${question.questionID}`,
    "No Mathesis form could be shown to the learner (no Mathesis TUI attached). Ask the same question another way:",
    "",
    "- If the built-in `question` tool is available, ask ONE form with two questions:",
    `  1. header "Answer", prompt: the question text${question.kind === "quiz" ? `, choices: ${question.options!.map((o, i) => `"${letter(i)}. ${o}"`).join(", ")}, "I don't know"` : ", free-form answer"}`,
    `  2. header "Confidence", choices: ${CONFIDENCE_LEVELS.map((c) => `"${c}%"`).join(", ")}`,
    "  The learner can add their thinking in the free-form field.",
    "- Otherwise write the question in the chat (with the options and a request for a confidence in %) and end your turn.",
    "",
    "Then record the reply with mathesis_answer_record (same questionID). Do not reveal the answer before that.",
  ]
  return lines.join("\n")
}

/**
 * The learner replied after a fallback (a chat message, or an answer in the built-in question form). Only then may
 * mathesis_answer_record record a reply, so the model cannot answer for the learner.
 */
export async function noteLearnerReply(rt: Runtime, sessionID: string) {
  await mutateSession(
    rt.store,
    sessionID,
    (current) => {
      const open = current.openQuestion
      return open?.fallback && !open.learnerReplied ? { openQuestion: { ...open, learnerReplied: true } } : {}
    },
    rt.now(),
  ).catch(() => {})
}

/** Clears the open question, but only if it is still this one. */
async function clearOpen(rt: Runtime, sessionID: string, questionID: string) {
  await mutateSession(rt.store, sessionID, (current) => (current.openQuestion?.questionID === questionID ? { openQuestion: undefined } : {}), rt.now())
}

/** A learner's text in a session note must not become a heading of the note. */
const inline = (text: string) => text.replace(/^(\s*)(#{1,6}\s)/gm, "$1\\$2")

export async function recordAnswer(
  rt: Runtime,
  sessionID: string,
  question: OpenQuestion,
  answer: LearnerAnswer,
  elapsedMs?: number,
): Promise<string> {
  const now = rt.now()
  if (answer.status === "cancelled") {
    await clearOpen(rt, sessionID, question.questionID)
    // The learner saw the wording, so it counts as asked. In review, a dismissed card is skipped for this session.
    if (question.ideaId && (question.type !== "check" && question.type !== "predict")) {
      await rt.vault.addAskedBefore(question.ideaId, question.prompt).catch(() => {})
    }
    const after = await mutateSession(
      rt.store,
      sessionID,
      (current) =>
        current.phase === "review" && question.ideaId && current.currentNode === question.ideaId
          ? { done: [...(current.done ?? []), question.ideaId], currentNode: undefined }
          : {},
      now,
    )
    return after.phase === "review"
      ? "The learner dismissed the question. The card is skipped for this session (its schedule is unchanged). Ask in one line whether they want to go on, or call mathesis_review_next."
      : "The learner dismissed the question without answering. Do not grade it. Continue from where the learner is: ask what they want, or come back to it later in a fresh situation."
  }
  const record: AnswerRecord = {
    questionID: question.questionID,
    kind: question.kind,
    type: question.type,
    prompt: question.prompt,
    ...(question.nodeId ? { nodeId: question.nodeId } : {}),
    ...(question.ideaId ? { ideaId: question.ideaId } : {}),
    status: answer.status,
    ...(answer.status === "dont_know" && question.kind === "quiz" ? { correct: false } : {}),
    ...(answer.status === "answered" && answer.choice !== undefined
      ? { choice: answer.choice, correct: answer.choice === question.correctIndex }
      : {}),
    ...(answer.status === "answered" && answer.text ? { text: answer.text } : {}),
    ...(answer.status === "answered" && answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
    ...(answer.thinking ? { thinking: answer.thinking } : {}),
    answeredAt: now.toISOString(),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(question.fallback ? { fallback: true } : {}),
  }
  const state = await mutateSession(
    rt.store,
    sessionID,
    (current) => ({
      answers: [...(current.answers ?? []), record].slice(-ANSWERS_KEPT),
      ...(current.openQuestion?.questionID === question.questionID ? { openQuestion: undefined } : {}),
    }),
    now,
  )
  if (state?.topic) {
    await rt.vault
      .appendSession({ sessionID, topic: state.topic, kind: sessionKind(state.phase), date: today(now) }, noteBlock(question, record, now))
      .catch(() => {})
  }
  return resultText(question, record, state?.phase)
}

function choiceText(question: OpenQuestion, index: number | undefined) {
  return index === undefined ? "" : `${letter(index)}. ${question.options?.[index] ?? "?"}`
}

function noteBlock(question: OpenQuestion, record: AnswerRecord, now: Date) {
  const target = question.nodeId ? ` · \`${question.nodeId}\`` : question.ideaId ? ` · [${question.ideaId}](../ideas/${question.ideaId}.md)` : ""
  const lines = [`### ${clock(now)} · ${question.type}${target}`, "", `**Question:** ${inline(question.prompt)}`]
  if (question.options) lines.push("", ...question.options.map((option, i) => `${letter(i)}. ${inline(option)}`))
  const verdict = record.correct === true ? " · correct" : record.correct === false && record.status === "answered" ? " · wrong" : ""
  const given = record.status === "dont_know" ? "I don't know" : question.kind === "quiz" ? choiceText(question, record.choice) : record.text
  lines.push("", `**Answer:** ${inline(given ?? "")}${record.confidence !== undefined ? ` · confidence ${record.confidence}%` : ""}${verdict}`)
  if (record.thinking) lines.push("", `**Thinking:** ${inline(record.thinking)}`)
  const committed = question.kind === "quiz" ? `${choiceText(question, question.correctIndex)}. ${question.explanation ?? ""}` : question.correctAnswer
  lines.push("", `**Committed answer:** ${inline(committed ?? "")}`)
  if (record.fallback) lines.push("", "_Recorded by the agent from the learner's reply (no form)._")
  return lines.join("\n")
}

function resultText(question: OpenQuestion, record: AnswerRecord, phase: Phase | undefined): string {
  const lines = [`questionID: ${question.questionID}`]
  if (record.status === "dont_know") {
    lines.push('The learner answered "I don\'t know" (a genuine gap, not a wrong answer).')
  } else if (question.kind === "quiz") {
    lines.push(`Verdict: ${record.correct ? "CORRECT" : "WRONG"}`, `Learner chose: ${choiceText(question, record.choice)}`)
  } else {
    lines.push(`Learner's answer: ${record.text}`)
  }
  if (record.confidence !== undefined) lines.push(`Confidence: ${record.confidence}%`)
  lines.push(`Thinking: ${record.thinking ?? "(none)"}`)
  if (question.kind === "quiz") {
    lines.push(`Correct answer: ${choiceText(question, question.correctIndex)}`, `Your committed explanation: ${question.explanation}`)
  } else {
    lines.push(`Your committed answer: ${question.correctAnswer}`, "Grade the learner's answer strictly against it: correct, partial or wrong.")
  }
  lines.push("", nextStep(question, record, phase))
  return lines.join("\n")
}

function nextStep(question: OpenQuestion, record: AnswerRecord, phase: Phase | undefined): string {
  const passed = record.correct === true || (question.kind === "explain" && record.status === "answered")
  const misconception =
    record.status === "answered" && record.confidence !== undefined && record.confidence >= 70 && record.correct !== true
      ? " If it is wrong with this confidence, it is a committed misconception: record it with mathesis_misconception_record."
      : ""
  switch (question.type) {
    case "predict":
      return "Next: open your teaching by resolving the prediction (what they predicted, what is true, why). Predictions create no card."
    case "check":
      return passed
        ? `Next: if the check passed${question.kind === "explain" ? " (correct or partial by your grading)" : ""}, create the card with mathesis_idea_upsert (questionID ${question.questionID}${question.kind === "explain" ? ", with your verdict" : ""}), then continue.${misconception}`
        : `Next: the step did not land. Diagnose from the thinking, repair, and check again before building on it.${misconception}`
    case "probe":
      return `Next: choose the next probe question from this evidence.${misconception}`
    default:
      return phase === "review"
        ? `Next: record the outcome with mathesis_review_grade (questionID ${question.questionID}).${misconception}`
        : passed
          ? `Next: if the problem is solved, record it once with mathesis_practice_record (questionID ${question.questionID}, the highest hint rung used).${misconception}`
          : `Next: the problem is not finished. "I don't know" or a wrong attempt is a request for help: give the next hint rung only, then pose the next attempt on the same target (a new question). Record the problem with mathesis_practice_record when it is solved or the learner gives up.${misconception}`
  }
}

const common = {
  type: schema.enum(ALL_TYPES, "The question's role: probe (probe phase); predict or check (teach); recall, discrimination or reverse (review); recall, discrimination, reverse or composition (practice)."),
  nodeId: schema.str("Teach phase: the plan node this question is about (required there)."),
  ideaId: schema.str("Review and practice: the card this question exercises (required there)."),
}

export const questionTools: ToolSpec[] = [
  {
    name: "quiz",
    description:
      "Ask the learner ONE multiple-choice question and wait for the answer. The learner answers in a form with their choice (or \"I don't know\"), a confidence and optional thinking. Commit the answer key before asking: reason out the explanation first, then the correct index. The result gives the verdict, the confidence and the thinking.",
    input: schema.object(
      {
        question: schema.str("The question text (Markdown; no LaTeX)."),
        options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6, description: "2–6 bare options, no reasoning in them." },
        answerKey: schema.object(
          {
            explanation: schema.str("Why the correct option is correct, reasoned out BEFORE choosing the index. Shown to you after the answer."),
            correctIndex: { type: "integer", minimum: 0, description: "0-based index of the correct option." },
          },
          ["explanation", "correctIndex"],
        ),
        ...common,
      },
      ["question", "options", "answerKey", "type"],
    ),
    async run(input, call, rt) {
      await refuseWhileOpen(rt, call)
      const state = call.state!
      const prompt = text(input, "question", { max: 4000 })!
      const raw = input.options
      if (!Array.isArray(raw) || raw.some((option) => typeof option !== "string" || !option.trim())) {
        throw new Refusal("`options` must be a list of non-empty strings.")
      }
      const options = (raw as string[]).map((option) => option.trim())
      if (options.length < 2 || options.length > 6) throw new Refusal("give 2–6 options.")
      if (new Set(options).size !== options.length) throw new Refusal("options must be different from each other.")
      const key = (input.answerKey ?? {}) as Record<string, unknown>
      const correctIndex = Number(key.correctIndex)
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
        throw new Refusal(`answerKey.correctIndex must be 0–${options.length - 1}.`)
      }
      const explanation = text(key, "explanation", { max: 4000 })!
      const type = oneOf(input, "type", ALL_TYPES)
      const target = await validateTarget(rt, state, type, input)
      return ask(rt, call, {
        questionID: randomUUID(),
        kind: "quiz",
        type,
        prompt,
        options,
        correctIndex,
        explanation,
        ...target,
        askedAt: rt.now().toISOString(),
      })
    },
  },
  {
    name: "explain",
    description:
      "Ask the learner ONE free-recall question and wait for the answer. The learner writes the answer (or leaves it empty for \"I don't know\"), with a confidence and optional thinking. Commit the answer key first: your worked answer with its reasoning. The result gives the learner's words next to your committed answer; grade strictly.",
    input: schema.object(
      {
        question: schema.str("The question text (Markdown; no LaTeX)."),
        answerKey: schema.object({ correctAnswer: schema.str("Your committed answer with its reasoning, written BEFORE asking.") }, ["correctAnswer"]),
        ...common,
      },
      ["question", "answerKey", "type"],
    ),
    async run(input, call, rt) {
      await refuseWhileOpen(rt, call)
      const state = call.state!
      const prompt = text(input, "question", { max: 4000 })!
      const correctAnswer = text((input.answerKey ?? {}) as Record<string, unknown>, "correctAnswer", { max: 4000 })!
      const type = oneOf(input, "type", ALL_TYPES)
      const target = await validateTarget(rt, state, type, input)
      return ask(rt, call, {
        questionID: randomUUID(),
        kind: "explain",
        type,
        prompt,
        correctAnswer,
        ...target,
        askedAt: rt.now().toISOString(),
      })
    },
  },
  {
    name: "answer_record",
    description:
      "Record the learner's reply to a question that fell back (a mathesis_quiz or mathesis_explain result said `fallback: true`) after you asked it with the built-in question tool or in the chat. Only for that open question.",
    input: schema.object(
      {
        questionID: schema.str("The questionID from the fallback result."),
        choiceIndex: { type: "integer", minimum: 0, description: "Multiple choice: 0-based index of the option the learner picked." },
        text: schema.str("Free recall: the learner's answer, verbatim."),
        dontKnow: { type: "boolean", description: "The learner said they don't know." },
        confidence: { type: "number", minimum: 0, maximum: 100, description: "The learner's confidence in %, if given." },
        thinking: schema.str("The learner's reasoning, verbatim, if given."),
      },
      ["questionID"],
    ),
    async run(input, call, rt) {
      const question = call.state?.openQuestion
      const questionID = text(input, "questionID")
      if (!question || question.questionID !== questionID || !question.fallback) {
        throw new Refusal("there is no fallback question with this questionID. Use it only after a `fallback: true` result.")
      }
      if (!question.learnerReplied) {
        throw new Refusal("the learner has not replied yet. Ask the question (built-in question tool or chat), end your turn, and record their actual reply.")
      }
      const thinking = text(input, "thinking", { optional: true, max: 8000 })
      const given = input.confidence === undefined ? undefined : Number(input.confidence)
      const confidence = given === undefined || !Number.isFinite(given) ? undefined : Math.min(100, Math.max(0, given))
      let answer: LearnerAnswer
      if (input.dontKnow === true) answer = { status: "dont_know", ...(thinking ? { thinking } : {}) }
      else if (question.kind === "quiz") {
        const choice = Number(input.choiceIndex)
        if (!Number.isInteger(choice) || choice < 0 || choice >= question.options!.length) {
          throw new Refusal(`choiceIndex must be 0–${question.options!.length - 1} (or set dontKnow).`)
        }
        answer = { status: "answered", choice, ...(Number.isFinite(confidence) ? { confidence } : {}), ...(thinking ? { thinking } : {}) }
      } else {
        const reply = text(input, "text", { max: 8000 })!
        answer = { status: "answered", text: reply, ...(Number.isFinite(confidence) ? { confidence } : {}), ...(thinking ? { thinking } : {}) }
      }
      return recordAnswer(rt, call.sessionID, question, answer)
    },
  },
]
