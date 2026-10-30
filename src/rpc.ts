import { Rpc } from "@opencode/plugin/rpc"

const answerInput = {
  type: "object",
  properties: {
    questionID: { type: "string" },
    choice: { type: "string" },
    text: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    thinking: { type: "string" },
    dontKnow: { type: "boolean" },
    cancelled: { type: "boolean" },
  },
  required: ["questionID"],
  additionalProperties: false,
} as const

const questionAsked = {
  type: "object",
  properties: {
    questionID: { type: "string" },
    sessionID: { type: "string" },
    kind: { type: "string", enum: ["quiz", "explain"] },
    prompt: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    mode: { type: "string" },
  },
  required: ["questionID", "sessionID", "kind", "prompt"],
  additionalProperties: false,
} as const

export const Mathesis = Rpc.define({
  id: "mathesis",
  methods: {
    answer: {
      input: answerInput,
      output: {
        type: "object",
        properties: { accepted: { type: "boolean" } },
        required: ["accepted"],
        additionalProperties: false,
      },
    },
    pending: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { questions: { type: "array", items: questionAsked } },
        required: ["questions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    questionAsked: { schema: questionAsked },
    questionClosed: {
      schema: {
        type: "object",
        properties: { questionID: { type: "string" } },
        required: ["questionID"],
        additionalProperties: false,
      },
    },
  },
})

export type AnswerInput = {
  questionID: string
  choice?: string
  text?: string
  confidence?: number
  thinking?: string
  dontKnow?: boolean
  cancelled?: boolean
}

export type QuestionAsked = {
  questionID: string
  sessionID: string
  kind: "quiz" | "explain"
  prompt: string
  options?: string[]
  mode?: string
}
