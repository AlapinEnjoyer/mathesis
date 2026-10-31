import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuestionBroker } from "../src/broker.ts"
import { resolveConfig } from "../src/config.ts"
import type { Runtime } from "../src/runtime.ts"
import { review as fsrsReview } from "../src/srs/fsrs.ts"
import { getSession, memoryStore, setPhase } from "../src/state.ts"
import { panel } from "../src/panel.ts"
import { status } from "../src/status.ts"
import { readLog } from "../src/store/log.ts"
import { Vault } from "../src/store/vault.ts"
import { runTool, type ToolSpec } from "../src/tools/define.ts"
import { practiceTools, rankTargets } from "../src/tools/practice.ts"
import { noteLearnerReply, questionTools } from "../src/tools/questions.ts"
import { pickNext, reviewTools, suggestMode } from "../src/tools/review.ts"
import { teachTools } from "../src/tools/teach.ts"
import { topicTools } from "../src/tools/topics.ts"

const tools = new Map([...topicTools, ...questionTools, ...teachTools, ...reviewTools, ...practiceTools].map((t) => [t.name, t] as [string, ToolSpec]))
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

describe("links between notes", () => {
  test("a card that builds on another topic's card links the topics; the session note links the card", async () => {
    await rt.vault.updateTopic("arrays", { goal: "arrays" }, new Date(clock))
    await rt.vault.upsertIdea({ id: "sorted", topic: "arrays", claim: "Sorted" }, new Date(clock))
    await toTeach()
    reply = () => ({ answer: "0", confidence: "90" })
    const id = lastQuestionID(await call("quiz", quiz()))
    await call("idea_upsert", { questionID: id, claim: "c", why: "w", requires: ["sorted"] })
    const topic = "binary-search-finds-its-bounds"
    expect(await readFile(join(root, "topics", `${topic}.md`), "utf8")).toContain("## Related topics\n- [arrays](./arrays.md)")
    expect(await readFile(join(root, "topics/arrays.md"), "utf8")).toContain(`## Related topics\n- [${topic.replace(/-/g, " ")}](./${topic}.md)`)
    const note = await readFile(join(root, "sessions", `${new Date(clock).toISOString().slice(0, 10)}-${topic}-learn.md`), "utf8")
    expect(note).toContain("**Card created:** [interval](../ideas/interval.md)")
    expect(await readFile(join(root, "ideas/interval.md"), "utf8")).toContain(`Topic: [${topic.replace(/-/g, " ")}](../topics/${topic}.md)`)
  })
})

describe("card diagrams", () => {
  test("idea_upsert stores a mermaid diagram (fence stripped) and refuses text that is not one", async () => {
    await toTeach()
    reply = () => ({ answer: "0", confidence: "90" })
    const bad = await call("idea_upsert", { questionID: lastQuestionID(await call("quiz", quiz())), claim: "c", why: "w", diagram: "a box with arrows" })
    expect(bad).toContain("must be a mermaid diagram")
    const id = lastQuestionID(await call("quiz", quiz()))
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w", diagram: "```mermaid\ngraph LR\n  lo --> hi\n```" })).toContain("Card created")
    expect((await rt.vault.readIdea("interval"))?.picture).toBe("```mermaid\ngraph LR\n  lo --> hi\n```")
  })
})

describe("probe → teach → card", () => {
  test("the whole flow", async () => {
    const started = await call("topic_start", { goal: "how binary search finds its bounds" })
    expect(started).toContain("Created topic `binary-search-finds-its-bounds`")
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
    expect((await rt.vault.readTopic("binary-search-finds-its-bounds"))?.assessment).toContain("### arrays")
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
    expect((await rt.vault.readTopic("binary-search-finds-its-bounds"))?.ideas).toEqual(["interval"])
    const log = (await readLog(rt.vault.logPath)).entries
    expect(log).toMatchObject([{ ideaId: "interval", mode: "teach", scheduled: true, rating: "easy", confidence: 90 }])
    expect(events).toContain("cards:+interval~")
    expect(await call("idea_upsert", { questionID: id, claim: "c", why: "w" })).toContain("already used")

    // The session note has the question, the answer and the committed answer.
    const note = await readFile(join(root, "sessions", `${new Date(clock).toISOString().slice(0, 10)}-binary-search-finds-its-bounds-learn.md`), "utf8")
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
    expect(await call("topic_list")).toContain("(1 card, 0 due)")
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

  test("a `type` inside answerKey is accepted; no type at all is refused", async () => {
    await toTeach()
    expect(await call("quiz", quiz({ type: undefined }))).toContain("`type` must be one of")
    const result = await call("quiz", quiz({ type: undefined, answerKey: { explanation: "e", correctIndex: 0, type: "check" } }))
    expect(result).toContain("fallback: true")
    expect((await getSession(rt.store, SESSION))?.openQuestion?.type).toBe("check")
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
    const note = await readFile(join(root, "sessions", `${clock.toISOString().slice(0, 10)}-binary-search-finds-its-bounds-learn.md`), "utf8")
    expect(note).toContain("**Question:** \\## Not a heading")
    expect(note).toContain("Recorded by the agent from the learner's reply")
  })
})


describe("spaced review", () => {
  const day = 86_400_000
  async function card(id: string, topic: string, daysAgoDue: number, extra: Record<string, unknown> = {}) {
    const learned = new Date(clock.getTime() - 30 * day)
    const srs = { ...fsrsReview(undefined, "good", learned), due: new Date(clock.getTime() - daysAgoDue * day).toISOString() }
    await rt.vault.upsertIdea({ id, topic, claim: `claim of ${id}`, why: `why ${id}`, srs, ...extra }, clock)
    await rt.vault.updateTopic(topic, { goal: topic, addIdeas: [id] }, clock)
  }

  beforeEach(async () => {
    await card("slope", "calculus", 1)
    await card("chain-rule", "calculus", 5, { requires: ["slope"] })
    await card("tcp-window", "networking", 3)
    await card("future", "networking", -10)
    await rt.vault.addAskedBefore("chain-rule", "What does the chain rule say?")
    await setPhase(rt.store, SESSION, "review", {}, clock)
  })

  test("review_next: most overdue first, with foundations and asked-before stems", async () => {
    const next = await call("review_next")
    expect(next).toContain("ideaId: chain-rule")
    expect(next).toContain("Card 1 (3 due")
    expect(next).toContain("- `slope`: claim of slope")
    expect(next).toContain("- What does the chain rule say?")
    expect((await getSession(rt.store, SESSION))?.currentNode).toBe("chain-rule")
  })

  test("a review answer is graded, rescheduled and logged; a lapse pulls the foundation forward", async () => {
    // slope is due 1 day ago; move it to the future so the pull is visible.
    await rt.vault.setSrs("slope", { ...(await rt.vault.readIdea("slope"))!.srs!, due: new Date(clock.getTime() + 20 * day).toISOString() })
    reply = () => ({ answer: "1", confidence: "90" })
    expect(await call("review_next")).toContain("ideaId: chain-rule")
    const asked = await call("quiz", { question: "New wording?", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "chain-rule" })
    expect(asked).toContain("mathesis_review_grade")
    const graded = await call("review_grade", { questionID: lastQuestionID(asked) })
    expect(graded).toContain("Rated again (a lapse)")
    expect(graded).toContain("Its foundations are due now: `slope`")
    expect(graded).toContain("mathesis_misconception_record")
    const chain = (await rt.vault.readIdea("chain-rule"))!
    expect(chain.srs?.lapses).toBe(1)
    expect(chain.askedBefore).toContain("New wording?")
    expect((await rt.vault.readIdea("slope"))?.srs?.due).toBe(clock.toISOString())
    const log = (await readLog(rt.vault.logPath)).entries
    expect(log.map((e) => `${e.ideaId}:${e.mode}`)).toEqual(["chain-rule:review", "slope:pull"])
    expect((await getSession(rt.store, SESSION))?.done).toEqual(["chain-rule"])
    expect(await call("review_grade", { questionID: lastQuestionID(asked) })).toContain("already used")
  })

  test("free recall needs the agent's verdict; the next card switches topic", async () => {
    reply = () => ({ answer: "it composes derivatives", confidence: "60" })
    await call("review_next")
    const asked = await call("explain", { question: "Why?", answerKey: { correctAnswer: "x" }, type: "reverse", ideaId: "chain-rule" })
    expect(await call("review_grade", { questionID: lastQuestionID(asked) })).toContain("`verdict` must be one of")
    expect(await call("review_grade", { questionID: lastQuestionID(asked), verdict: "correct" })).toContain("Rated good")
    // tcp-window (other topic) comes before slope (same topic as the last card), although slope is due too.
    expect(await call("review_next")).toContain("ideaId: tcp-window")
  })

  test("review questions and grades are bound to the served card", async () => {
    const q = (ideaId: string) => ({ question: `About ${ideaId}?`, options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId })
    expect(await call("quiz", q("slope"))).toContain("call mathesis_review_next first")
    await call("review_next") // serves chain-rule
    expect(await call("quiz", q("future"))).toContain("the card being reviewed is `chain-rule`")
    reply = () => ({ answer: "0", confidence: "70" })
    const id = lastQuestionID(await call("quiz", q("chain-rule")))
    // Pretend the model moves on to another card before grading: the grade must still be about the served card.
    await rt.store.set(`session/${SESSION}`, { ...(await getSession(rt.store, SESSION))!, currentNode: "slope" })
    expect(await call("review_grade", { questionID: id })).toContain("the card being reviewed is `slope`")
  })

  test("a card due later today counts as due; the date for people is local", async () => {
    const later = new Date(clock.getTime() + 2 * 3_600_000)
    if (later.getDate() === clock.getDate()) {
      await rt.vault.setSrs("future", { ...(await rt.vault.readIdea("future"))!.srs!, due: later.toISOString() })
      expect((await status(rt)).due).toBe(4)
    }
  })

  test("a dismissed review question skips the card for the session", async () => {
    await call("review_next")
    reply = () => ({}) // an empty form reply counts as dismissed
    const q = { question: "Dismiss me", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "chain-rule" }
    expect(await call("quiz", q)).toContain("skipped for this session")
    expect((await getSession(rt.store, SESSION))?.done).toEqual(["chain-rule"])
    expect((await rt.vault.readIdea("chain-rule"))?.askedBefore).toContain("Dismiss me")
    expect(await call("review_next")).not.toContain("ideaId: chain-rule")
  })

  test("only real lapses count as lapses; foundations reviewed today are not pulled; the log rebuilds the notes", async () => {
    reply = () => ({ answer: "0", confidence: "80" })
    // slope first (Good), then chain-rule lapses: slope was reviewed today, so it is not pulled.
    await setPhase(rt.store, SESSION, "review", { topic: "calculus" }, clock)
    await rt.vault.setSrs("slope", { ...(await rt.vault.readIdea("slope"))!.srs!, due: new Date(clock.getTime() - 9 * 86_400_000).toISOString() })
    expect(await call("review_next")).toContain("ideaId: slope")
    await call("review_grade", { questionID: lastQuestionID(await call("quiz", { question: "s?", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "slope" })) })
    const slopeAfter = (await rt.vault.readIdea("slope"))!.srs
    reply = () => ({ answer: "1", confidence: "80" })
    expect(await call("review_next")).toContain("ideaId: chain-rule")
    const graded = await call("review_grade", { questionID: lastQuestionID(await call("quiz", { question: "c?", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "chain-rule" })) })
    expect(graded).toContain("(a lapse)")
    expect(graded).not.toContain("foundations are due now")
    expect((await rt.vault.readIdea("slope"))!.srs).toEqual(slopeAfter)
    await call("misconception_record", { wrongModel: "w", rightModel: "r" })
    expect((await status(rt)).text).toContain("Lapsed in the last 7 days: chain-rule\n")
    // The review entries replay onto the state the cards had before this session.
  })

  test("questions need an existing card; the cap and an empty queue close the session", async () => {
    expect(await call("quiz", { question: "q", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "nope" })).toContain("no card `nope`")
    expect(await call("quiz", { question: "q", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "check", ideaId: "slope" })).toContain("not used in the review phase")
    rt.config.reviewCap = 1
    await setPhase(rt.store, SESSION, "review", { done: ["slope"] }, clock)
    expect(await call("review_next")).toContain("Session cap reached")
    rt.config.reviewCap = 20
    await setPhase(rt.store, SESSION, "review", { done: ["slope", "chain-rule", "tcp-window"] }, clock)
    expect(await call("review_next")).toContain("All due cards are done (3 reviewed")
  })

  test("a topic filter limits the queue", async () => {
    await setPhase(rt.store, SESSION, "review", { topic: "networking" }, clock)
    expect(await call("review_next")).toContain("ideaId: tcp-window")
  })

  test("pickNext and suggestMode", () => {
    const idea = (id: string, topic: string, extra = {}) => ({ id, topic, kind: "proposition" as const, requires: [], about: [], claim: "", why: "", picture: "", misconceptions: "", askedBefore: [], ...extra })
    const due = [idea("a", "t1"), idea("b", "t1"), idea("c", "t2")]
    expect(pickNext(due, [], "t1")?.id).toBe("c")
    expect(pickNext(due, ["c"], "t2")?.id).toBe("a")
    expect(pickNext(due, ["a", "b", "c"])).toBeUndefined()
    expect(suggestMode(idea("m", "t", { kind: "misconception" }))).toBe("discrimination")
    expect(suggestMode(idea("n", "t", { srs: { reps: 1, lapses: 0 } }))).toBe("recall")
  })

  test("status lists due cards per topic and recent lapses", async () => {
    const result = await status(rt)
    expect(result.due).toBe(3)
    expect(result.cards).toBe(4)
    expect(result.text).toContain("calculus: calculus · 2 cards, 2 due")
    expect(result.text).toContain("networking: networking · 2 cards, 1 due")
  })
})

describe("practice", () => {
  beforeEach(async () => {
    const day = 86_400_000
    const at = (d: number) => new Date(clock.getTime() - d * day)
    let slope = fsrsReview(undefined, "good", at(60))
    slope = fsrsReview(slope, "good", new Date(slope.due))
    await rt.vault.upsertIdea({ id: "slope", topic: "calculus", claim: "slope", srs: slope }, clock)
    await rt.vault.upsertIdea({ id: "chain-rule", topic: "calculus", claim: "chain", requires: ["slope"], srs: fsrsReview(undefined, "hard", at(2)) }, clock)
    await rt.vault.upsertIdea({ id: "product-rule", topic: "calculus", claim: "product", requires: ["slope"], srs: fsrsReview(undefined, "good", at(2)) }, clock)
    await rt.vault.upsertIdea({ id: "never-reviewed", topic: "calculus", claim: "new" }, clock)
    await setPhase(rt.store, SESSION, "practice", {}, clock)
  })

  test("targets: held cards only, weakest now first (overdue beats low stability), recent ones last", async () => {
    const { ideas } = await rt.vault.listIdeas()
    expect(rankTargets(ideas, clock).map((i) => i.id)).toEqual(["slope", "chain-rule", "product-rule"])
    expect(rankTargets(ideas, clock, new Set(["slope"])).map((i) => i.id)).toEqual(["chain-rule", "product-rule", "slope"])
    const result = await call("practice_targets", { count: -5 })
    expect(result).toContain("0 of 20 problems done")
    expect(result).toContain("## `slope`")
    expect(result).not.toContain("## `chain-rule`") // count clamped to 1
    expect(await call("practice_targets")).not.toContain("never-reviewed")
  })

  test("a problem is a series of attempts: only the concluded problem is recorded", async () => {
    const before = (await rt.vault.readIdea("chain-rule"))!.srs
    const ask = () => call("quiz", { question: `Problem ${Math.random()}`, options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "composition", ideaId: "chain-rule" })
    reply = () => ({ answer: "idk" })
    expect(await ask()).toContain("request for help: give the next hint rung")
    reply = () => ({ answer: "0", confidence: "60" })
    const solved = lastQuestionID(await ask())
    expect(await call("practice_record", { questionID: solved, hints: "R7" })).toContain("must be one of")
    const recorded = await call("practice_record", { questionID: solved, hints: "R2" })
    expect(recorded).toContain("solved, hint R2")
    expect(recorded).toContain("hold the difficulty")
    expect((await rt.vault.readIdea("chain-rule"))!.srs).toEqual(before)
    const log = (await readLog(rt.vault.logPath)).entries
    expect(log).toMatchObject([{ mode: "practice", scheduled: false, hints: "R2", ideaId: "chain-rule" }])
    expect(await call("practice_targets")).toContain("This session: composition solved (hint R2)")
  })

  test("two concluded misses on a target advise a switch; misses are listed for retest", async () => {
    reply = () => ({ answer: "1", confidence: "60" })
    const ask = () => call("quiz", { question: `Problem ${Math.random()}`, options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "product-rule" })
    const first = await call("practice_record", { questionID: lastQuestionID(await ask()), miss: "discrimination" })
    expect(first).toContain("missed, discrimination miss")
    expect(first).toContain("one notch easier")
    expect(await call("practice_record", { questionID: lastQuestionID(await ask()) })).toContain("Two concluded problems")
    expect(await call("practice_targets")).toContain("To retest before closing (fresh situation): product-rule")
    expect((await getSession(rt.store, SESSION))?.done).toEqual(["product-rule", "product-rule"])
  })

  test("a deleted card is refused before its answer is used", async () => {
    reply = () => ({ answer: "0", confidence: "60" })
    const id = lastQuestionID(await call("quiz", { question: "q", options: ["a", "b"], answerKey: { explanation: "e", correctIndex: 0 }, type: "recall", ideaId: "slope" }))
    await rm(join(root, "ideas", "slope.md"))
    expect(await call("practice_record", { questionID: id })).toContain("no longer exists")
  })

  test("review tools are refused in practice, practice tools outside it", async () => {
    expect(await call("review_next")).toContain("not available in the practice phase")
    await setPhase(rt.store, "other", "review", {}, clock)
    const result = await runTool(tools.get("practice_targets")!, rt, {}, { sessionID: "other", signal: new AbortController().signal, progress: async () => {} })
    expect(result).toContain("not available in the review phase")
  })
})

describe("panel", () => {
  const text = (view: Awaited<ReturnType<typeof panel>>) => view.rows.map((r) => `${"  ".repeat(r.depth)}${r.text}`).join("\n")

  test("shows the phase, the plan with titles and marks, and the cards due now", async () => {
    await toTeach()
    await call("plan_set", { mermaid: 'graph TD\n  sorted["Sorted `a`"] --> interval["Half-open interval"]\n  interval --> bounds["Lower bound"]\n  extra["Extra root"] --> bounds' })
    reply = () => ({ answer: "0", confidence: "90" })
    await call("idea_upsert", { questionID: lastQuestionID(await call("quiz", quiz())), claim: "c", why: "w" })
    const view = await panel(rt, SESSION)
    expect(view.title).toBe("Mathesis: how binary search finds its bounds")
    expect(text(view)).toContain("Phase: teach")
    expect(text(view)).toContain("· Sorted `a`\n· Extra root\n  ▶ Half-open interval  ← Sorted `a`\n    · Lower bound  ← Half-open interval, Extra root")
    expect(view.rows.find((r) => r.text.startsWith("▶"))?.tone).toBe("current")
    expect(text(view)).toContain("No cards due today.")
    clock = new Date("2027-01-01T10:00:00.000Z")
    await rt.store.set(`session/${SESSION}`, { ...(await getSession(rt.store, SESSION))!, currentNode: "bounds" })
    const later = text(await panel(rt, SESSION))
    expect(later).toContain("↻ Half-open interval")
    expect(later).toContain("Due today: 1 card\n  ↻ interval (overdue by")
    expect(text(await panel(rt, "unknown"))).toContain("Not a Mathesis session")
  })

  test("more than ten due cards are summarized", async () => {
    for (let i = 0; i < 12; i++) await rt.vault.upsertIdea({ id: `card-${i}`, claim: "c", srs: fsrsReview(undefined, "good", new Date("2026-01-01T00:00:00Z")) }, clock)
    const view = text(await panel(rt, "unknown"))
    expect(view).toContain("Due today: 12 cards")
    expect(view).toContain("… and 2 more")
  })
})
