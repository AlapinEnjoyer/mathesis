import { describe, expect, test } from "bun:test"
import { canTransition, phaseGuard, PHASES, TOOL_PHASES } from "../src/phases.ts"
import { getSession, memoryStore, setPhase, updateSession } from "../src/state.ts"

describe("session state", () => {
  test("create, patch and remove keys", async () => {
    const store = memoryStore()
    expect(await getSession(store, "s")).toBeUndefined()
    await expect(updateSession(store, "s", { topic: "x" })).rejects.toThrow(/no Mathesis phase/)
    await setPhase(store, "s", "probe", { topic: "binary-search" }, new Date("2026-10-30T10:00:00Z"))
    await setPhase(store, "s", "teach")
    const next = await updateSession(store, "s", { currentNode: "n1" })
    expect(next).toMatchObject({ phase: "teach", topic: "binary-search", currentNode: "n1" })
    const cleared = await updateSession(store, "s", { currentNode: undefined })
    expect("currentNode" in cleared).toBe(false)
  })

  test("setPhase enforces the transitions", async () => {
    const store = memoryStore()
    await setPhase(store, "r", "review")
    await expect(setPhase(store, "r", "teach")).rejects.toThrow(/cannot change/)
    expect((await getSession(store, "r"))?.phase).toBe("review")
  })

  test("parallel updates to one session are not lost", async () => {
    const store = memoryStore()
    await setPhase(store, "s", "teach")
    await Promise.all([
      updateSession(store, "s", { currentNode: "n1" }),
      updateSession(store, "s", { done: ["a"] }),
      updateSession(store, "s", { topic: "t" }),
    ])
    expect(await getSession(store, "s")).toMatchObject({ currentNode: "n1", done: ["a"], topic: "t" })
  })

  test("ignores stored garbage", async () => {
    const store = memoryStore()
    await store.set("session/s", { phase: "nope" })
    expect(await getSession(store, "s")).toBeUndefined()
  })

  test("memoryStore.scan pages by prefix", async () => {
    const store = memoryStore()
    for (const k of ["session/a", "session/b", "session/c", "config/models"]) await store.set(k, { k })
    const first = await store.scan({ prefix: "session/", limit: 2 })
    expect(first.entries.map((e) => e.key)).toEqual(["session/a", "session/b"])
    const second = await store.scan({ prefix: "session/", after: first.next })
    expect(second.entries.map((e) => e.key)).toEqual(["session/c"])
    expect(second.next).toBeUndefined()
  })
})

describe("phases", () => {
  test("every tool from the handoff tool list has a phase rule", () => {
    for (const tool of [
      "topic_start", "topic_list", "phase_set", "quiz", "explain", "probe_done", "plan_set", "idea_upsert",
      "misconception_record", "review_next", "review_grade", "practice_targets",
    ]) expect(TOOL_PHASES[tool]).not.toBeUndefined()
  })

  test("prober and teacher do not share phase-specific tools", () => {
    expect(phaseGuard("probe_done", "teach")).toContain("not available in the teach phase")
    expect(phaseGuard("plan_set", "probe")).toContain("not available in the probe phase")
    expect(phaseGuard("idea_upsert", "teach")).toBeUndefined()
    expect(phaseGuard("review_grade", "review")).toBeUndefined()
  })

  test("tools that need a topic refuse without a session phase", () => {
    expect(phaseGuard("quiz", undefined)).toContain("mathesis_topic_start")
    expect(phaseGuard("topic_start", undefined)).toBeUndefined()
    expect(phaseGuard("nope", "probe")).toContain("Unknown")
  })

  test("transitions", () => {
    expect(canTransition(undefined, "review")).toBe(true)
    expect(canTransition("probe", "teach")).toBe(true)
    expect(canTransition("teach", "probe")).toBe(true)
    expect(canTransition("review", "teach")).toBe(false)
    for (const p of PHASES) expect(canTransition(p, p)).toBe(true)
  })
})
