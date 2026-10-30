import type { OpenQuestion } from "./state.ts"

export const DONT_KNOW = "idk"
export const CONFIDENCE_LEVELS = [10, 30, 50, 70, 90, 100] as const

/** Form fields as accepted by `client.session.form.create` (a subset of the opencode Form schema). */
export type FormField =
  | {
      key: string
      type: "string"
      title?: string
      description?: string
      required?: boolean
      placeholder?: string
      options?: { value: string; label: string }[]
      custom?: boolean
      when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[]
    }

export interface FormSpec {
  id: string
  title: string
  fields: FormField[]
  metadata: { questionID: string; mathesis: true }
}

/** Form ids must start with `frm_`; a fixed id per question keeps two TUIs from creating two forms. */
export const formID = (questionID: string) => `frm_mathesis_${questionID.replace(/[^A-Za-z0-9]/g, "")}`

export function buildForm(question: OpenQuestion): FormSpec {
  const title = question.prompt
  const answer: FormField =
    question.kind === "quiz"
      ? {
          key: "answer",
          type: "string",
          title: "Answer",
          required: true,
          custom: false,
          options: [
            ...(question.options ?? []).map((label, index) => ({ value: String(index), label })),
            { value: DONT_KNOW, label: "I don't know" },
          ],
        }
      : {
          key: "answer",
          type: "string",
          title: "Answer",
          description: "Leave empty for \"I don't know\".",
          required: false,
          placeholder: "Your answer",
        }
  const answered = [{ key: "answer", op: "neq" as const, value: question.kind === "quiz" ? DONT_KNOW : "" }]
  return {
    id: formID(question.questionID),
    title,
    metadata: { questionID: question.questionID, mathesis: true },
    fields: [
      answer,
      {
        key: "confidence",
        type: "string",
        title: "Confidence",
        description: "How likely is it that your answer is right?",
        // Inactive (hidden) fields are never required, so "I don't know" passes. Free recall cannot hide it for a
        // typed "I don't know", so there it stays optional.
        required: question.kind === "quiz",
        custom: false,
        options: CONFIDENCE_LEVELS.map((level) => ({ value: String(level), label: `${level}%` })),
        when: answered,
      },
      {
        key: "thinking",
        type: "string",
        title: "Thinking (optional)",
        description: "Think out loud: why this answer?",
        required: false,
        placeholder: "Why?",
      },
    ],
  }
}

export type LearnerAnswer =
  | { status: "answered"; choice?: number; text?: string; confidence?: number; thinking?: string }
  | { status: "dont_know"; thinking?: string }
  | { status: "cancelled"; message?: string }

const str = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "")

/** Reads a form answer back into a learner answer. Never trusts the client: values are re-checked here. */
export function parseFormAnswer(question: OpenQuestion, raw: Record<string, unknown>): LearnerAnswer {
  const thinking = str(raw.thinking) || undefined
  const answer = str(raw.answer)
  if (question.kind === "quiz") {
    if (answer === DONT_KNOW) return { status: "dont_know", ...(thinking ? { thinking } : {}) }
    const choice = Number(answer)
    if (!Number.isInteger(choice) || choice < 0 || choice >= (question.options?.length ?? 0)) {
      return { status: "cancelled", message: `invalid choice "${answer}"` }
    }
    return { status: "answered", choice, ...confidenceOf(raw), ...(thinking ? { thinking } : {}) }
  }
  if (!answer || /^i (do not|don'?t) know\.?$/i.test(answer)) {
    return { status: "dont_know", ...(thinking ? { thinking } : {}) }
  }
  return { status: "answered", text: answer, ...confidenceOf(raw), ...(thinking ? { thinking } : {}) }
}

function confidenceOf(raw: Record<string, unknown>): { confidence?: number } {
  const value = Number(str(raw.confidence))
  return Number.isFinite(value) && value >= 0 && value <= 100 ? { confidence: value } : {}
}
