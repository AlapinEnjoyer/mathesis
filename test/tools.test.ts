import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuestionBroker } from "../src/broker.ts"
import { resolveConfig } from "../src/config.ts"
import type { Runtime } from "../src/runtime.ts"
import { getSession, memoryStore } from "../src/state.ts"
import { readLog } from "../src/store/log.ts"
import { Vault } from "../src/store/vault.ts"
import { runTool, type ToolSpec } from "../src/tools/define.ts"
import { noteLearnerReply, questionTools } from "../src/tools/questions.ts"
import { teachTools } from "../src/tools/teach.ts"
import { topicTools } from "../src/tools/topics.ts"

const tools = new Map([...topicTools, ...questionTools, ...teachTools].map((t) => [t.name, t] as [string, ToolSpec]))
const SESSION = "ses_test"
let root: string
let rt: Runtime
let clock: Date
let asked: { questionID: string }[]
let events: string[]
/** What the fake TUI does with the next question: claim it and reply, or ignore it (no TUI). */
let reply: ((questionID: string) => Record<string, unknown>) | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mathesis-tools-"))
  clock = new Date("2026-10-30T10:00:00.000Z")
  asked = []
  events = []
  reply = undefined
  const broker: QuestionBroker = new QuestionBroker(
    {
      asked: (data) => {
        asked.push(data)
        if (!reply) return
        const answer = reply(data.questionID)
        queueMicrotask(() => {
          const claim = broker.claim(data.questionID)
          if (claim.accepted) broker.formReplied(claim.form!.id, answer)
        })
      },
      closed: () => {},
    },
    { claimTimeoutMs: 20 },
  )
  rt = {
    config: { ...resolveConfig({}), vault: root },
    vault: new Vault(root),
    store: memoryStore(),
    broker,
    prompt: (phase) => `prompt for ${phase}`,
    now: () => clock,
    events: {
      planUpdated: (d) => events.push(`plan:${d.topic}`),
      cardsChanged: (d) => events.push(`cards:+${d.added.join(",")}~${d.updated.join(",")}`),
    },
  }
  await rt.vault.ensure()
})
afterEach(async () => rm(root, { recursive: true, force: true }))

const call = (name: string, input: Record<string, unknown> = {}) =>
  runTool(tools.get(name)!, rt, input, { sessionID: SESSION, signal: new AbortController().signal, progress: async () => {} })
const lastQuestionID = (result: string) => /questionID: (\S+)/.exec(result)![1]!

const PLAN = 'graph TD\n  sorted["Sorted array"] --> interval["Half-open interval"]\n  interval --> bounds["Lower bound"]'
const quiz = (extra: Record<string, unknown> = {}) => ({
  question: "Which interval keeps the target?",
  options: ["[5, 8)", "[4, 8)", "[0, 4)"],
  answerKey: { explanation: "mid is excluded", correctIndex: 0 },
  type: "check",
  nodeId: "interval",
  ...extra,
})

async function toTeach() {
  await call("topic_start", { goal: "how binary search finds its bounds" })
  await call("probe_done", { summary: "s", strands: [{ strand: "arrays", floor: "f", ceiling: "c", buildFrom: "b" }] })
  await call("plan_set", { mermaid: PLAN })
}

describe("probe → teach → card", () => {
  test("the whole flow", async () => {
    const started = await call("topic_start", { goal: "how binary search finds its bounds" })
    expect(started).toContain("Created topic `how-binary-search-finds-its-bounds`")
    expect((await getSession(rt.store, SESSION))?.phase).toBe("probe")

    // A reworded goal does not create a second topic.
    expect(await call("topic_start", { goal: "Understand binary search bounds" })).toContain("already works on the topic")
    expect((await rt.vault.listTopics()).topics.length).toBe(1)

    // Probe question, answered through the fake TUI.
    reply = () => ({ answer: "0", confidence: "90", thinking: "mid was checked" })
    const probe = await call("quiz", quiz({ type: "probe", nodeId: undefined }))
    expect(probe).toContain("Verdict: CORRECT")
    expect(probe).toContain("Confidence: 90%")
    expect(probe).toContain("Thinking: mid was checked")

    // Phase rules: no plan or cards in the probe.
    expect(await call("plan_set", { mermaid: PLAN })).toStartWith("Refused:")
    await call("probe_done", { summary: "Ready for intervals", strands: [{ strand: "arrays", floor: "indexing", ceiling: "invariants", misconceptions: ["mid stays in"], buildFrom: "indexing" }] })
    expect((await getSession(rt.store, SESSION))?.phase).toBe("teach")
    expect((await rt.vault.readTopic("how-binary-search-finds-its-bounds"))?.assessment).toContain("### arrays")
    expect(await call("probe_done", { summary: "x", strands: [{ strand: "a", floor: "f", ceiling: "c", buildFrom: "b" }] })).toContain("not available in the teach phase")

    // Teaching needs a plan and plan nodes.
    expect(await call("quiz", quiz())).toContain("no plan yet")
    expect(await call("plan_set", { mermaid: "graph TD\n  Bad_Node" })).toContain("must be a lowercase slug")
    expect(await call("plan_set", { mermaid: PLAN })).toContain("Plan saved (3 nodes, 2 edges)")
    expect(await call("quiz", quiz({ nodeId: "nope" }))).toContain("not a node of the plan")

    // A passed check creates a card with its first review.
    const check = await call("quiz", quiz())
    expect(check).toContain("mathesis_idea_upsert")
    const id = lastQuestionID(check)
    expect((await getSession(rt.store, SESSION))?.currentNode).toBe("interval")
    const card = await call("idea_upsert", { questionID: id, claim: "The interval [lo, hi) holds every candidate.", why: "mid is excluded", requires: ["sorted"] })
    expect(card).toContain("Card created: `interval` (rated easy")
    const idea = await rt.vault.readIdea("interval")
    expect(idea?.srs?.reps).toBe(1)
    expect(idea?.askedBefore).toEqual(["Which interval keeps the target?"])
    expect((await rt.vault.readTopic("how-binary-search-finds-its-bounds"))?.ideas).toEqual(["interval"])
    const log = (await readLog(rt.vault.logPath)).entries
    expect(log).toMatchObject([{ ideaId: "interval", mode: "teach", scheduled: true, rating: "easy", confidence: 90 }])
    expect(events).toContain("cards:+interval~")
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w" })).toContain("already used")

    // The session note has the question, the answer and the committed answer.
    const note = await readFile(join(root, "sessions", `${new Date(clock).toISOString().slice(0, 10)}-how-binary-search-finds-its-bounds-learn.md`), "utf8")
    expect(note).toContain("**Answer:** A. [5, 8) · confidence 90% · correct")
    expect(note).toContain("**Committed answer:** A. [5, 8). mid is excluded")
  })
})

describe("cards only from passed checks", () => {
  test("a wrong check, a prediction and I don't know create no card", async () => {
    await toTeach()
    reply = () => ({ answer: "1", confidence: "80" })
    const wrong = await call("quiz", quiz())
    expect(wrong).toContain("Verdict: WRONG")
    expect(wrong).toContain("misconception")
    expect(await call("idea_upsert", { questionID: lastQuestionID(wrong), claim: "c", why: "w" })).toContain("answered wrong")

    reply = () => ({ answer: "0", confidence: "50" })
    const predict = await call("quiz", quiz({ type: "predict" }))
    expect(await call("idea_upsert", { questionID: lastQuestionID(predict), claim: "c", why: "w" })).toContain("only a passed `check`")

    reply = () => ({ answer: "idk" })
    const idk = await call("quiz", quiz())
    expect(idk).toContain("I don't know")
    expect(await call("idea_upsert", { questionID: lastQuestionID(idk), claim: "c", why: "w" })).toContain("did not know")
    expect((await rt.vault.listIdeas()).ideas).toEqual([])
  })

  test("free recall: the agent's verdict decides the rating", async () => {
    await toTeach()
    reply = () => ({ answer: "lo moves past mid", confidence: "95" })
    const result = await call("explain", { question: "What happens to lo?", answerKey: { correctAnswer: "lo = mid + 1" }, type: "check", nodeId: "interval" })
    expect(result).toContain("Learner's answer: lo moves past mid")
    expect(result).toContain("Your committed answer: lo = mid + 1")
    const id = lastQuestionID(result)
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w" })).toContain("`verdict` must be one of")
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w", verdict: "partial" })).toContain("rated hard")
  })

  test("one question at a time", async () => {
    await toTeach()
    reply = undefined
    const pending = call("quiz", quiz())
    await new Promise((r) => setTimeout(r, 5))
    expect(await call("quiz", quiz())).toContain("a question is still open")
    await pending
  })
})

describe("fallback without a TUI", () => {
  test("the question falls back and the reply is recorded with answer_record", async () => {
    await toTeach()
    const result = await call("quiz", quiz())
    expect(result).toContain("fallback: true")
    const id = lastQuestionID(result)
    expect((await getSession(rt.store, SESSION))?.openQuestion?.fallback).toBe(true)
    expect(await call("answer_record", { questionID: "other", choiceIndex: 0 })).toStartWith("Refused:")
    // The model cannot answer for the learner: a reply must have arrived first.
    expect(await call("answer_record", { questionID: id, choiceIndex: 0 })).toContain("has not replied yet")
    await noteLearnerReply(rt, SESSION)
    expect(await call("answer_record", { questionID: id, choiceIndex: 9 })).toContain("choiceIndex must be 0–2")
    const recorded = await call("answer_record", { questionID: id, choiceIndex: 0, confidence: 60 })
    expect(recorded).toContain("Verdict: CORRECT")
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w" })).toContain("rated good")
    // After a fallback, new questions are allowed again.
    expect((await getSession(rt.store, SESSION))?.openQuestion).toBeUndefined()
  })
})

describe("misconceptions", () => {
  test("a misconception becomes its own card, linked from the idea, and is bumped when recorded again", async () => {
    await toTeach()
    reply = () => ({ answer: "0", confidence: "90" })
    await call("idea_upsert", { questionID: lastQuestionID(await call("quiz", quiz())), claim: "c", why: "w" })
    const input = { wrongModel: "mid stays in the interval", rightModel: "mid is excluded after the comparison", about: ["interval"] }
    expect(await call("misconception_record", input)).toContain("Misconception card created: `misconception-mid-stays-in-the-interval`")
    const card = await rt.vault.readIdea("misconception-mid-stays-in-the-interval")
    expect(card).toMatchObject({ kind: "misconception", about: ["interval"], claim: "mid is excluded after the comparison" })
    expect(card?.srs?.reps).toBe(1)
    expect((await rt.vault.readIdea("interval"))?.misconceptions).toContain("(./misconception-mid-stays-in-the-interval.md)")
    clock = new Date("2026-11-02T10:00:00.000Z")
    expect(await call("misconception_record", input)).toContain("bumped")
    expect((await rt.vault.readIdea("misconception-mid-stays-in-the-interval"))?.srs?.reps).toBe(2)
    expect(await call("misconception_record", { ...input, id: "interval" })).toContain("is an idea card")
  })
})

describe("status and lists", () => {
  test("topic_status marks the plan and lists cards; topic_list counts them", async () => {
    await toTeach()
    reply = () => ({ answer: "0", confidence: "70" })
    await call("idea_upsert", { questionID: lastQuestionID(await call("quiz", quiz())), claim: "The interval holds every candidate.", why: "w" })
    const status = await call("topic_status")
    expect(status).toContain("Session phase: teach · current node: `interval`")
    expect(status).toContain("▶ Half-open interval `interval`")
    expect(status).toContain("- `interval` (proposition, held, due in")
    expect(await call("topic_list")).toContain("(1 cards, 0 due)")
  })

  test("tools that need a topic refuse in a session without one", async () => {
    expect(await call("quiz", quiz())).toContain("needs an active Mathesis topic")
    expect(await call("topic_status")).toBe("The vault is empty: no topics and no cards yet.")
  })
})

describe("phase 2 review fixes", () => {
  test("a question the broker forgot (server restart) does not lock the session", async () => {
    await toTeach()
    const state = (await getSession(rt.store, SESSION))!
    await rt.store.set(`session/${SESSION}`, { ...state, openQuestion: { questionID: "lost", kind: "quiz", type: "check", prompt: "p", options: ["a", "b"], correctIndex: 0, explanation: "e", nodeId: "interval", askedAt: clock.toISOString() } })
    reply = () => ({ answer: "0", confidence: "70" })
    expect(await call("quiz", quiz())).toContain("Verdict: CORRECT")
  })

  test("one answer cannot create two cards, even in parallel", async () => {
    await toTeach()
    reply = () => ({ answer: "0", confidence: "90" })
    const id = lastQuestionID(await call("quiz", quiz()))
    const results = await Promise.all([
      call("idea_upsert", { questionID: id, claim: "c", why: "w" }),
      call("idea_upsert", { questionID: id, id: "other-card", claim: "c", why: "w" }),
    ])
    expect(results.filter((r) => r.startsWith("Card created")).length).toBe(1)
    expect(results.some((r) => r.includes("already used"))).toBe(true)
    expect((await readLog(rt.vault.logPath)).entries.length).toBe(1)
  })

  test("a failed card write releases the answer for a retry", async () => {
    await toTeach()
    reply = () => ({ answer: "0", confidence: "90" })
    const id = lastQuestionID(await call("quiz", quiz()))
    await rt.vault.upsertIdea({ id: "foreign", topic: "other-topic", claim: "x" }, clock)
    expect(await call("idea_upsert", { questionID: id, id: "foreign", claim: "c", why: "w" })).toContain("does not test")
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w" })).toContain("Card created")
  })

  test("a check cannot review a misconception card or a card of another topic", async () => {
    await toTeach()
    await rt.vault.upsertIdea({ id: "interval", topic: "other-topic", claim: "x" }, clock)
    reply = () => ({ answer: "0", confidence: "90" })
    expect(await call("idea_upsert", { questionID: lastQuestionID(await call("quiz", quiz())), claim: "c", why: "w" })).toContain("belongs to the topic `other-topic`")
  })

  test("misconception evidence must be real, wrong and used once", async () => {
    await toTeach()
    const input = { wrongModel: "w", rightModel: "r" }
    expect(await call("misconception_record", { ...input, questionID: "nope" })).toContain("no answered question")
    reply = () => ({ answer: "0", confidence: "90" })
    expect(await call("misconception_record", { ...input, questionID: lastQuestionID(await call("quiz", quiz())) })).toContain("was correct")
    reply = () => ({ answer: "1", confidence: "90" })
    const wrong = lastQuestionID(await call("quiz", quiz()))
    expect(await call("misconception_record", { ...input, questionID: wrong })).toContain("created")
    expect(await call("misconception_record", { ...input, questionID: wrong })).toContain("already recorded from this answer")
  })

  test("two parallel questions: the second is refused", async () => {
    await toTeach()
    reply = undefined
    const results = await Promise.all([call("quiz", quiz()), call("quiz", quiz())])
    expect(results.filter((r) => r.includes("a question is still open")).length).toBe(1)
  })

  test("blank options are refused, not dropped", async () => {
    await toTeach()
    expect(await call("quiz", quiz({ options: ["A", " ", "B"], answerKey: { explanation: "e", correctIndex: 2 } }))).toContain("non-empty strings")
  })

  test("phase_set only moves between probe and teach; topic_status refuses a non-id", async () => {
    await toTeach()
    expect(await call("phase_set", { phase: "review" })).toContain("must be one of: probe, teach")
    expect(await call("phase_set", { phase: "probe" })).toBe("Phase is now probe.")
    expect(await call("topic_status", { topic: "Binary Search" })).toContain("is not a topic id")
  })

  test("answer_record clamps the confidence and the note marks a fallback answer", async () => {
    await toTeach()
    const id = lastQuestionID(await call("quiz", quiz({ question: "## Not a heading" })))
    await noteLearnerReply(rt, SESSION)
    expect(await call("answer_record", { questionID: id, choiceIndex: 0, confidence: 250 })).toContain("Confidence: 100%")
    const note = await readFile(join(root, "sessions", `${clock.toISOString().slice(0, 10)}-how-binary-search-finds-its-bounds-learn.md`), "utf8")
    expect(note).toContain("**Question:** \\## Not a heading")
    expect(note).toContain("Recorded by the agent from the learner's reply")
  })
})
