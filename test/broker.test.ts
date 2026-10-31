import { describe, expect, test } from "bun:test"
import { QuestionBroker, type CloseReason } from "../src/broker.ts"
import type { OpenQuestion } from "../src/state.ts"

const question = (id = "q1"): OpenQuestion => ({
  questionID: id,
  kind: "quiz",
  type: "probe",
  prompt: "Which?",
  options: ["A", "B"],
  correctIndex: 0,
  explanation: "e",
  askedAt: "2026-10-30T10:00:00.000Z",
})

function setup(timeout = 50) {
  const asked: string[] = []
  const closed: CloseReason[] = []
  const broker = new QuestionBroker(
    { asked: (d) => asked.push(d.questionID), closed: (d) => closed.push(d.reason) },
    { claimTimeoutMs: timeout },
  )
  return { broker, asked, closed }
}

describe("QuestionBroker", () => {
  test("the first claim gets the form, later claims do not; the reply resolves the question", async () => {
    const { broker, asked, closed } = setup()
    const outcome = broker.ask("ses", question(), new AbortController().signal)
    expect(asked).toEqual(["q1"])
    const first = broker.claim("q1")
    expect(first.accepted).toBe(true)
    expect(first.form?.id).toBe("frm_mathesis_q1")
    expect(broker.claim("q1").accepted).toBe(false)
    expect(broker.pending("ses")[0]?.claimed).toBe(true)
    expect(broker.formReplied("frm_mathesis_q1", { answer: "0", confidence: "90" })).toBe(true)
    expect(broker.formReplied("frm_mathesis_q1", { answer: "1" })).toBe(false) // the first outcome wins
    const result = await outcome
    expect(result).toMatchObject({ kind: "answer", answer: { status: "answered", choice: 0, confidence: 90 } })
    expect(closed).toEqual(["answered"])
    expect(broker.pending()).toEqual([])
  })

  test("without a claim in time the question falls back; a late claim is refused", async () => {
    const { broker, closed } = setup(10)
    const outcome = await broker.ask("ses", question(), new AbortController().signal)
    expect(outcome).toEqual({ kind: "fallback" })
    expect(closed).toEqual(["fallback"])
    expect(broker.claim("q1").accepted).toBe(false)
  })

  test("a claimed question waits past the claim timeout", async () => {
    const { broker } = setup(10)
    const outcome = broker.ask("ses", question(), new AbortController().signal)
    broker.claim("q1")
    await new Promise((r) => setTimeout(r, 30))
    expect(broker.isOpen("q1")).toBe(true)
    broker.formCancelled("frm_mathesis_q1")
    expect(await outcome).toMatchObject({ kind: "answer", answer: { status: "cancelled" } })
  })

  test("abort before and during the wait", async () => {
    const { broker, closed } = setup()
    const aborted = new AbortController()
    aborted.abort()
    expect(await broker.ask("ses", question("a"), aborted.signal)).toEqual({ kind: "aborted", cause: "signal" })
    const controller = new AbortController()
    const outcome = broker.ask("ses", question("b"), controller.signal)
    broker.claim("b")
    controller.abort()
    expect(await outcome).toEqual({ kind: "aborted", cause: "signal" })
    expect(closed).toEqual(["aborted"])
    expect(broker.formReplied("frm_mathesis_b", { answer: "0" })).toBe(false)
  })

  test("unknown forms are ignored and a question id cannot be opened twice", () => {
    const { broker } = setup()
    expect(broker.formReplied("frm_other", {})).toBe(false)
    void broker.ask("ses", question(), new AbortController().signal)
    expect(() => broker.ask("ses", question(), new AbortController().signal)).toThrow(/already open/)
    broker.formCancelled("frm_mathesis_q1")
  })
})

describe("QuestionBroker after a claim", () => {
  test("a claimer that never shows the form makes the question fall back", async () => {
    const closed: string[] = []
    const broker = new QuestionBroker({ asked: () => {}, closed: (d) => closed.push(d.reason) }, { claimTimeoutMs: 5, showTimeoutMs: 15 })
    const outcome = broker.ask("ses", question(), new AbortController().signal)
    broker.claim("q1")
    expect(await outcome).toEqual({ kind: "fallback" })
    expect(closed).toEqual(["fallback"])
  })

  test("a shown form waits for the learner; abortAll ends it", async () => {
    const broker = new QuestionBroker({ asked: () => {}, closed: () => {} }, { claimTimeoutMs: 5, showTimeoutMs: 10 })
    const outcome = broker.ask("ses", question(), new AbortController().signal)
    broker.claim("q1")
    expect(broker.shown("frm_mathesis_q1")).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(broker.isOpen("q1")).toBe(true)
    broker.abortAll()
    expect(await outcome).toEqual({ kind: "aborted", cause: "unload" })
    expect(broker.shown("frm_mathesis_q1")).toBe(false)
  })
})

test("showing the form clears the deadline instead of setting a long one", () => {
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0)
    return realSetTimeout(fn, ms)
  }) as typeof setTimeout
  try {
    const broker = new QuestionBroker({ asked: () => {}, closed: () => {} }, { claimTimeoutMs: 50, showTimeoutMs: 60 })
    void broker.ask("ses", question(), new AbortController().signal)
    broker.claim("q1")
    broker.shown("frm_mathesis_q1")
    expect(delays).toEqual([50, 60])
    broker.abortAll()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})
