import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pullForward, review } from "../src/srs/fsrs.ts"
import { appendLog, readLog, rebuild, type LogEntry } from "../src/store/log.ts"
import { Vault } from "../src/store/vault.ts"

let root: string
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "mathesis-log-"))))
afterEach(async () => rm(root, { recursive: true, force: true }))

const day = 24 * 60 * 60 * 1000
const t = (days: number) => new Date(Date.UTC(2026, 9, 30, 10) + days * day)

describe("review log", () => {
  test("missing log reads as empty; torn lines are skipped", async () => {
    const path = join(root, "log/reviews.jsonl")
    expect(await readLog(path)).toEqual([])
    await appendLog(path, { ts: t(0).toISOString(), ideaId: "a", mode: "teach", correct: true, rating: "good" })
    await appendFile(path, '{"ts": "2026-1')
    expect((await readLog(path)).length).toBe(1)
  })

  test("rebuilding state from reviews.jsonl matches what was written to the notes", async () => {
    const vault = new Vault(root)
    await vault.ensure()
    for (const id of ["slope", "chain", "product"]) await vault.upsertIdea({ id, claim: id }, t(0))

    // Simulate what the tools do: update the note and append to the log, with a fake clock.
    const script: [number, string, LogEntry["mode"], "again" | "hard" | "good" | "easy", string?][] = [
      [0, "slope", "teach", "good"],
      [0, "chain", "teach", "good"],
      [1, "product", "teach", "hard"],
      [3, "slope", "review", "easy"],
      [4, "chain", "review", "again"], // lapse pulls in "slope"
      [4, "slope", "pull", "again", "chain"],
      [5, "chain", "practice", "good"], // practice is logged only
      [6, "chain", "review", "good"],
      [9, "product", "review", "good"],
    ]
    for (const [d, ideaId, mode, rating, cause] of script) {
      const now = t(d)
      const current = (await vault.readIdea(ideaId))?.srs
      if (mode === "pull") {
        await vault.setSrs(ideaId, pullForward(current!, now))
        await appendLog(vault.logPath, { ts: now.toISOString(), ideaId, mode, cause: cause! })
      } else {
        if (mode !== "practice") await vault.setSrs(ideaId, review(current, rating, now))
        await appendLog(vault.logPath, { ts: now.toISOString(), ideaId, mode, correct: rating !== "again", rating })
      }
    }

    const rebuilt = rebuild(await readLog(vault.logPath))
    for (const idea of (await vault.listIdeas()).ideas) expect(rebuilt.get(idea.id)).toEqual(idea.srs!)
    expect(rebuilt.get("slope")?.due).toBe(t(4).toISOString())
  })

  test("rebuild orders by timestamp, stable for equal timestamps", () => {
    const entries: LogEntry[] = [
      { ts: t(2).toISOString(), ideaId: "a", mode: "review", correct: true, rating: "good" },
      { ts: t(0).toISOString(), ideaId: "a", mode: "teach", correct: true, rating: "good" },
    ]
    const expected = review(review(undefined, "good", t(0)), "good", t(2))
    expect(rebuild(entries).get("a")).toEqual(expected)
  })
})
