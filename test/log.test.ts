import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pullForward, review, type Grade } from "../src/srs/fsrs.ts"
import { appendLog, readLog, rebuild, type LogEntry, type ReviewEntry } from "../src/store/log.ts"
import { Vault } from "../src/store/vault.ts"

let root: string
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "mathesis-log-"))))
afterEach(async () => rm(root, { recursive: true, force: true }))

const day = 24 * 60 * 60 * 1000
const t = (days: number) => new Date(Date.UTC(2026, 9, 30, 10) + days * day)
const entry = (days: number, ideaId: string, rating: Grade, extra: Partial<ReviewEntry> = {}): ReviewEntry => ({
  ts: t(days).toISOString(),
  ideaId,
  mode: "review",
  scheduled: true,
  correct: rating !== "again",
  rating,
  ...extra,
})

describe("reading the log", () => {
  test("missing log reads as empty", async () => {
    expect(await readLog(join(root, "log/reviews.jsonl"))).toEqual({ entries: [], errors: [] })
  })

  test("a torn last line does not swallow the next entry", async () => {
    const path = join(root, "log/reviews.jsonl")
    await appendLog(path, entry(0, "a", "good"))
    await appendFile(path, '{"ts": "2026-1')
    await appendLog(path, entry(1, "a", "good"))
    const { entries, errors } = await readLog(path)
    expect(entries.length).toBe(2)
    expect(errors).toEqual([{ line: 2, message: "not valid JSON" }])
  })

  test("hand-edited garbage is skipped and reported, never thrown", async () => {
    const path = join(root, "reviews.jsonl")
    const lines = [
      JSON.stringify(entry(0, "a", "good")),
      JSON.stringify({ ...entry(1, "a", "good"), ts: "garbage" }),
      JSON.stringify({ ...entry(1, "a", "good"), rating: undefined }),
      JSON.stringify({ ...entry(1, "a", "good"), mode: "dream" }),
      JSON.stringify({ ts: t(1).toISOString(), ideaId: "a", mode: "pull" }),
      "[1,2]",
    ]
    await writeFile(path, lines.join("\n") + "\n")
    const { entries, errors } = await readLog(path)
    expect(entries.length).toBe(1)
    expect(errors.map((e) => e.message)).toEqual([
      "invalid ts",
      "invalid rating",
      "unknown mode",
      "pull without cause",
      "missing ideaId",
    ])
    expect(() => rebuild(entries)).not.toThrow()
  })
})

describe("rebuild", () => {
  test("state rebuilt from reviews.jsonl matches what was written to the notes", async () => {
    const vault = new Vault(root)
    await vault.ensure()
    for (const id of ["slope", "chain", "product"]) await vault.upsertIdea({ id, claim: id }, t(0))

    // What the tools do: update the note and append to the log, with a fake clock.
    const script: [number, string, LogEntry["mode"], Grade, boolean][] = [
      [0, "slope", "teach", "good", true],
      [0, "chain", "teach", "good", true],
      [0, "chain", "teach", "again", false], // a failed teach check on an existing card: logged, not scheduled
      [1, "product", "teach", "hard", true],
      [3, "slope", "review", "easy", true],
      [4, "chain", "review", "again", true], // lapse pulls in "slope"
      [4, "slope", "pull", "again", true],
      [5, "chain", "practice", "good", false], // practice is logged only
      [6, "chain", "review", "good", true],
      [9, "product", "review", "good", true],
    ]
    for (const [d, ideaId, mode, rating, scheduled] of script) {
      const now = t(d)
      const current = (await vault.readIdea(ideaId))?.srs
      if (mode === "pull") {
        await vault.setSrs(ideaId, pullForward(current!, now))
        await appendLog(vault.logPath, { ts: now.toISOString(), ideaId, mode, cause: "chain" })
      } else {
        if (scheduled) await vault.setSrs(ideaId, review(current, rating, now))
        await appendLog(vault.logPath, entry(d, ideaId, rating, { mode, scheduled }))
      }
    }

    const rebuilt = rebuild((await readLog(vault.logPath)).entries)
    for (const idea of (await vault.listIdeas()).ideas) expect(rebuilt.get(idea.id)).toEqual(idea.srs!)
    expect(rebuilt.get("slope")?.due).toBe(t(4).toISOString())
  })

  test("orders by real time, also across time-zone offsets", () => {
    const later = { ...entry(0, "a", "again"), ts: "2026-10-30T10:30:00+00:00" }
    const earlier = { ...entry(0, "a", "good"), ts: "2026-10-30T10:15:00+01:00" } // 09:15Z
    const expected = review(review(undefined, "good", new Date("2026-10-30T09:15:00Z")), "again", new Date("2026-10-30T10:30:00Z"))
    expect(rebuild([later, earlier]).get("a")).toEqual(expected)
  })

  test("a pull for an idea without state is ignored", () => {
    expect(rebuild([{ ts: t(0).toISOString(), ideaId: "x", mode: "pull", cause: "y" }]).size).toBe(0)
  })
})
