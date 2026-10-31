import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { review } from "../src/srs/fsrs.ts"
import { slugify, topicSlug, Vault } from "../src/store/vault.ts"

const now = new Date("2026-10-30T10:00:00.000Z")
let root: string
let vault: Vault

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mathesis-"))
  vault = new Vault(root)
  await vault.ensure()
})
afterEach(async () => rm(root, { recursive: true, force: true }))

describe("slugify", () => {
  test("makes safe slugs", () => {
    expect(slugify("How TCP Congestion Control works!")).toBe("how-tcp-congestion-control-works")
    expect(slugify("Ünïcödé — à la carte")).toBe("unicode-a-la-carte")
    expect(slugify("???")).toBe("untitled")
  })

  test("cuts at a word end", () => {
    expect(slugify("Airflow triggers one 15-minute refresh for everything", 40)).toBe("airflow-triggers-one-15-minute-refresh")
    expect(slugify("a-veryveryveryveryverylongwordwithoutbreaks", 20)).toBe("a-veryveryveryveryve")
  })
})

describe("topicSlug", () => {
  test("keeps the content words of a goal", () => {
    expect(topicSlug("See the current notes I have for task force 3. I would like to learn according to the plan.")).toBe("current-notes-task-force-3-plan")
    expect(topicSlug("how binary search finds its bounds")).toBe("binary-search-finds-its-bounds")
    expect(topicSlug("Why is the sky blue?")).toBe("sky-blue")
    expect(topicSlug("How to")).toBe("how-to")
  })
})

describe("ideas", () => {
  test("create writes the documented format with relative links", async () => {
    await vault.upsertIdea({ id: "derivative-as-local-slope", claim: "slope" }, now)
    const { created } = await vault.upsertIdea(
      { id: "chain-rule-intuition", topic: "calculus", requires: ["derivative-as-local-slope"], claim: "C", why: "W" },
      now,
    )
    expect(created).toBe(true)
    const text = await readFile(join(root, "ideas/chain-rule-intuition.md"), "utf8")
    expect(text).toStartWith("---\nid: chain-rule-intuition\ntopic: calculus\nkind: proposition\nrequires: [derivative-as-local-slope]\ncreated: 2026-10-30\n---\n")
    expect(text).toContain("## Claim\nC\n")
    expect(text).toContain("Builds on: [derivative as local slope](./derivative-as-local-slope.md)")
    expect(text).toContain("## Asked before")
  })

  test("Builds on links only ideas that have a note, so every link resolves", async () => {
    await vault.upsertIdea({ id: "slope", claim: "s" }, now)
    await vault.upsertIdea({ id: "chain", requires: ["slope", "prior-knowledge"], claim: "c", why: "w" }, now)
    const idea = await vault.readIdea("chain")
    expect(idea?.requires).toEqual(["slope", "prior-knowledge"])
    expect(idea?.why).toBe("w\n\nBuilds on: [slope](./slope.md)")
  })

  test("update keeps user edits, unknown keys and extra sections", async () => {
    await vault.upsertIdea({ id: "a", topic: "t", claim: "first", why: "because" }, now)
    const path = join(root, "ideas/a.md")
    const edited = (await readFile(path, "utf8"))
      .replace("kind: proposition", "kind: proposition\nmine: keep me # note")
      .concat("\n## My notes\nwritten by hand\n")
    await writeFile(path, edited)

    await vault.upsertIdea({ id: "a", claim: "second" }, now)
    await vault.setSrs("a", review(undefined, "good", now))
    await vault.addAskedBefore("a", "What is a?")

    const text = await readFile(path, "utf8")
    expect(text).toContain("mine: keep me # note")
    expect(text).toContain("## My notes\nwritten by hand")
    expect(text).toContain("## Claim\nfirst") // existing text is not overwritten without `replace`
    expect(text).toContain("## Why\nbecause")
    await vault.upsertIdea({ id: "a", claim: "second", replace: true }, now)
    expect((await vault.readIdea("a"))?.claim).toBe("second")
    const idea = await vault.readIdea("a")
    expect(idea?.srs?.reps).toBe(1)
    expect(idea?.askedBefore).toEqual(["What is a?"])
  })

  test("requires are merged, never dropped; a scalar written by hand is understood", async () => {
    await vault.upsertIdea({ id: "x", claim: "x" }, now)
    await vault.upsertIdea({ id: "y", claim: "y" }, now)
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    const path = join(root, "ideas/a.md")
    await writeFile(path, (await readFile(path, "utf8")).replace("requires: []", "requires: x"))
    await vault.upsertIdea({ id: "a", requires: ["y"], why: "w" }, now)
    expect((await vault.readIdea("a"))?.requires).toEqual(["x", "y"])
  })

  test("a Builds on line the learner changed is left alone", async () => {
    await vault.upsertIdea({ id: "x", claim: "x" }, now)
    await vault.upsertIdea({ id: "a", requires: ["x"], claim: "c", why: "w" }, now)
    const path = join(root, "ideas/a.md")
    const mine = "Builds on: [x](./x.md), and also my own link [y](./y.md)"
    await writeFile(path, (await readFile(path, "utf8")).replace(/^Builds on: .*$/m, mine))
    await vault.upsertIdea({ id: "a", requires: ["x"] }, now)
    expect((await vault.readIdea("a"))?.why).toContain(mine)
  })

  test("setSrs keeps unknown keys and comments inside srs", async () => {
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    await vault.setSrs("a", review(undefined, "good", now))
    const path = join(root, "ideas/a.md")
    await writeFile(path, (await readFile(path, "utf8")).replace(/^(srs: \{.*\})$/m, "$1 # my note").replace("srs: {", "srs: {suspended: true, "))
    await vault.setSrs("a", review((await vault.readIdea("a"))!.srs, "good", new Date("2026-11-05T10:00:00Z")))
    const text = await readFile(path, "utf8")
    expect(text).toContain("suspended: true")
    expect(text).toContain("# my note")
    expect((await vault.readIdea("a"))?.srs?.reps).toBe(2)
  })

  test("a new card can get its first srs in the same write", async () => {
    const srs = review(undefined, "good", now)
    await vault.upsertIdea({ id: "a", claim: "c", srs }, now)
    expect((await vault.readIdea("a"))?.srs).toEqual(srs)
  })

  test("a note without frontmatter gets frontmatter and keeps its text", async () => {
    await writeFile(join(root, "ideas/plain.md"), "## Claim\nmine\n\nfree text\n")
    await vault.setSrs("plain", review(undefined, "good", now))
    const idea = await vault.readIdea("plain")
    expect(idea?.claim).toBe("mine\n\nfree text")
    expect(idea?.srs?.reps).toBe(1)
  })

  test("asked-before keeps text the learner wrote in that section", async () => {
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    const path = join(root, "ideas/a.md")
    await writeFile(path, (await readFile(path, "utf8")).replace("## Asked before\n", "## Asked before\nMy note: ask about edge cases.\n"))
    await vault.addAskedBefore("a", "q1")
    const text = await readFile(path, "utf8")
    expect(text).toContain("My note: ask about edge cases.\n- q1")
  })

  test("asked-before keeps the newest stems without duplicates", async () => {
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    for (const stem of ["q1", "q2", "q1", "q3"]) await vault.addAskedBefore("a", stem, 2)
    expect((await vault.readIdea("a"))?.askedBefore).toEqual(["q1", "q3"])
  })

  test("re-reads files on every use (hand edits show up immediately)", async () => {
    await vault.upsertIdea({ id: "a", claim: "old" }, now)
    const path = join(root, "ideas/a.md")
    await writeFile(path, (await readFile(path, "utf8")).replace("old", "edited"))
    expect((await vault.readIdea("a"))?.claim).toBe("edited")
  })

  test("a hand-edited due date in the past is read as due", async () => {
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    await vault.setSrs("a", review(undefined, "good", now))
    const path = join(root, "ideas/a.md")
    await writeFile(path, (await readFile(path, "utf8")).replace(/due: [^,]+,/, "due: 2026-10-01,"))
    expect((await vault.readIdea("a"))?.srs?.due).toBe("2026-10-01T00:00:00.000Z")
  })

  test("rejects ids that could escape the vault", async () => {
    expect(vault.upsertIdea({ id: "../x", claim: "c" }, now)).rejects.toThrow(/Invalid idea id/)
    expect(vault.upsertIdea({ id: "a", requires: ["../../etc"] }, now)).rejects.toThrow(/Invalid/)
  })

  test("concurrent updates to one note do not lose writes", async () => {
    await vault.upsertIdea({ id: "a", claim: "c" }, now)
    await Promise.all(["s1", "s2", "s3", "s4", "s5"].map((s) => vault.addAskedBefore("a", s)))
    expect((await vault.readIdea("a"))?.askedBefore.sort()).toEqual(["s1", "s2", "s3", "s4", "s5"])
    expect((await readdir(join(root, "ideas"))).filter((f) => f.endsWith(".tmp"))).toEqual([])
  })

  test("listIdeas reports broken notes instead of failing", async () => {
    await vault.upsertIdea({ id: "good", claim: "c" }, now)
    await writeFile(join(root, "ideas/broken.md"), "---\nid: [\n---\n")
    const { ideas, errors } = await vault.listIdeas()
    expect(ideas.map((i) => i.id)).toEqual(["good"])
    expect(errors[0]?.file).toBe("ideas/broken.md")
  })
})

describe("links", () => {
  test("a card links its topic once, before its sections; a learner's Topic line is kept", async () => {
    await vault.upsertIdea({ id: "a", topic: "calculus", claim: "C" }, now)
    await vault.upsertIdea({ id: "a", claim: "C2", why: "W" }, now)
    const text = await readFile(join(root, "ideas/a.md"), "utf8")
    expect(text).toContain("---\n\nTopic: [calculus](../topics/calculus.md)\n\n## Claim\nC\n")
    expect(text.match(/Topic:/g)?.length).toBe(1)

    await vault.upsertIdea({ id: "no-topic", claim: "C" }, now)
    expect(await readFile(join(root, "ideas/no-topic.md"), "utf8")).not.toContain("Topic:")

    await writeFile(join(root, "ideas/mine.md"), "---\nid: mine\ntopic: calculus\n---\nTopic: my own words\n\n## Claim\nX\n")
    await vault.upsertIdea({ id: "mine", why: "W" }, now)
    expect(await readFile(join(root, "ideas/mine.md"), "utf8")).toStartWith("---\nid: mine\ntopic: calculus\n---\n\nTopic: my own words\n\n## Claim")

    await writeFile(join(root, "ideas/old.md"), "---\nid: old\ntopic: calculus\n---\n## Claim\nX\n")
    await vault.upsertIdea({ id: "old", why: "W" }, now)
    const old = await readFile(join(root, "ideas/old.md"), "utf8")
    expect(old).toContain("Topic: [calculus](../topics/calculus.md)\n\n## Claim\nX")
    expect((await vault.readIdea("old"))?.claim).toBe("X")
  })

  test("related topics are listed once each, never the topic itself", async () => {
    await vault.updateTopic("calculus", { goal: "g", addRelated: ["algebra", "calculus"] }, now)
    await vault.updateTopic("calculus", { addRelated: ["algebra", "limits"] }, now)
    const text = await readFile(join(root, "topics/calculus.md"), "utf8")
    expect(text).toContain("## Related topics\n- [algebra](./algebra.md)\n- [limits](./limits.md)\n")
  })

  test("a session note links its topic", async () => {
    const path = await vault.appendSession({ sessionID: "s", topic: "binary-search", kind: "learn", date: "2026-10-30" }, "x")
    expect(await readFile(path, "utf8")).toContain("Topic: [binary search](../topics/binary-search.md)")
  })
})

describe("paths", () => {
  test("session note paths cannot escape the vault", () => {
    expect(() => vault.sessionNotePath("../../x", "t", "teach")).toThrow(/Invalid session date/)
    expect(() => vault.sessionNotePath("2026-10-30", "../t", "teach")).toThrow(/Invalid topic id/)
  })

  test("a symlinked note is written through to its target", async () => {
    const { symlink, lstat } = await import("node:fs/promises")
    await vault.upsertIdea({ id: "real", claim: "c" }, now)
    await symlink(join(root, "ideas/real.md"), join(root, "ideas/link.md"))
    await vault.setSrs("link", review(undefined, "good", now))
    expect((await lstat(join(root, "ideas/link.md"))).isSymbolicLink()).toBe(true)
    expect((await vault.readIdea("real"))?.srs?.reps).toBe(1)
  })
})

describe("topics and sessions", () => {
  test("topic note links ideas and keeps sections", async () => {
    await vault.updateTopic("binary-search", { goal: "How binary search finds its bounds" }, now)
    await vault.updateTopic(
      "binary-search",
      { fields: { assessment: { floor: "arrays" } }, sections: { Plan: "```mermaid\ngraph TD\n```" }, addIdeas: ["a", "a", "b"] },
      now,
    )
    const topic = await vault.readTopic("binary-search")
    expect(topic?.goal).toBe("How binary search finds its bounds")
    expect(topic?.ideas).toEqual(["a", "b"])
    expect(topic?.data.assessment).toEqual({ floor: "arrays" })
    expect(topic?.plan).toContain("graph TD")
    expect((await vault.listTopics()).topics.map((t) => t.id)).toEqual(["binary-search"])
  })

  test("the learner's edit of the Goal section wins, and broken topic notes are reported", async () => {
    await vault.updateTopic("t", { goal: "old goal" }, now)
    const path = join(root, "topics/t.md")
    await writeFile(path, (await readFile(path, "utf8")).replace("## Goal\nold goal", "## Goal\nmy goal"))
    await vault.updateTopic("t", { addIdeas: ["a"] }, now)
    expect((await vault.readTopic("t"))?.goal).toBe("my goal")
    await writeFile(join(root, "topics/broken.md"), "---\nid: [\n---\n")
    await writeFile(join(root, "topics/My Topic.md"), "x")
    const { topics, errors } = await vault.listTopics()
    expect(topics.map((t) => t.id)).toEqual(["t"])
    expect(errors.map((e) => e.file).sort()).toEqual(["topics/My Topic.md", "topics/broken.md"])
  })

  test("session note appends blocks and records each session id once", async () => {
    const header = { sessionID: "ses_1", topic: "binary-search", kind: "teach", date: "2026-10-30" }
    const path = await vault.appendSession(header, "### Q1\nfirst")
    await vault.appendSession(header, "### Q2\nsecond")
    await vault.appendSession({ ...header, sessionID: "ses_2" }, "### Q3\nthird")
    const text = await readFile(path, "utf8")
    expect(text).toContain("sessions: [ses_1, ses_2]")
    expect(text.indexOf("Q1")).toBeLessThan(text.indexOf("Q2"))
    expect(text).toContain("### Q3\nthird\n")
  })
})
