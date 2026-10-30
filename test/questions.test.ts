import { describe, expect, test } from "bun:test"
import { buildForm, formID, parseFormAnswer } from "../src/questions.ts"
import type { OpenQuestion } from "../src/state.ts"

const quiz: OpenQuestion = {
  questionID: "6f1c-2a",
  kind: "quiz",
  type: "check",
  prompt: "Which?",
  options: ["A", "B", "C"],
  correctIndex: 1,
  explanation: "because",
  askedAt: "2026-10-30T10:00:00.000Z",
}
const explain: OpenQuestion = { ...quiz, kind: "explain", options: undefined, correctIndex: undefined, correctAnswer: "x" }

describe("forms", () => {
  test("fixed id, index values, I don't know, confidence hidden for I don't know", () => {
    const form = buildForm(quiz)
    expect(form.id).toBe("frm_mathesis_6f1c2a")
    expect(formID("6f1c-2a")).toBe(form.id)
    expect(form.metadata).toEqual({ questionID: "6f1c-2a", mathesis: true })
    const [answer, confidence, thinking] = form.fields
    expect(answer!.options!.map((o) => o.value)).toEqual(["0", "1", "2", "idk"])
    expect(confidence!.when).toEqual([{ key: "answer", op: "neq", value: "idk" }])
    expect(thinking!.required).toBe(false)
    expect(JSON.stringify(form)).not.toContain("because")
  })

  test("free recall: an empty answer means I don't know", () => {
    const form = buildForm(explain)
    expect(form.fields[0]!.options).toBeUndefined()
    expect(form.fields[1]!.when).toEqual([{ key: "answer", op: "neq", value: "" }])
  })
})

describe("parseFormAnswer", () => {
  test("quiz", () => {
    expect(parseFormAnswer(quiz, { answer: "1", confidence: "70", thinking: " t " })).toEqual({ status: "answered", choice: 1, confidence: 70, thinking: "t" })
    expect(parseFormAnswer(quiz, { answer: "idk" })).toEqual({ status: "dont_know" })
    expect(parseFormAnswer(quiz, { answer: "7" }).status).toBe("cancelled")
    expect(parseFormAnswer(quiz, { answer: "0", confidence: "999" })).toEqual({ status: "answered", choice: 0 })
    expect(parseFormAnswer(quiz, { answer: 2, confidence: 90 })).toEqual({ status: "answered", choice: 2, confidence: 90 })
  })

  test("explain", () => {
    expect(parseFormAnswer(explain, { answer: "my words", confidence: "50" })).toEqual({ status: "answered", text: "my words", confidence: 50 })
    expect(parseFormAnswer(explain, { answer: "" })).toEqual({ status: "dont_know" })
    expect(parseFormAnswer(explain, { answer: "I don't know" })).toEqual({ status: "dont_know" })
    expect(parseFormAnswer(explain, {})).toEqual({ status: "dont_know" })
  })
})
