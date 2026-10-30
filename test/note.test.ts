import { describe, expect, test } from "bun:test"
import { getData, getSection, listItems, mergeField, parseNote, serializeNote, setField, setSection } from "../src/store/note.ts"

describe("note", () => {
  test("round trip keeps comments, key order and unknown keys", () => {
    const text = `---
# my own comment
id: a
custom: {keep: [1, 2]}
kind: proposition
---

## Claim
Text the learner wrote.
`
    const note = parseNote(text)
    expect(serializeNote(note)).toBe(text)
    setField(note, "kind", "chain")
    const out = serializeNote(note)
    expect(out).toContain("# my own comment")
    expect(out).toContain("custom: {keep: [1, 2]}")
    expect(out.indexOf("custom")).toBeLessThan(out.indexOf("kind: chain"))
  })

  test("other flow spacing is normalized but values stay", () => {
    const note = parseNote("---\nsrs: { due: 2026-11-04, reps: 3 }\n---\n")
    expect(getData(parseNote(serializeNote(note)))).toEqual({ srs: { due: "2026-11-04", reps: 3 } })
  })

  test("a byte-order mark is understood and kept", () => {
    const note = parseNote("﻿---\nid: bom\n---\n\nbody\n")
    expect(getData(note)).toEqual({ id: "bom" })
    expect(note.body).toBe("\nbody\n")
    expect(serializeNote(note)).toStartWith("﻿---\nid: bom\n---\n")
  })

  test("empty frontmatter is frontmatter, not body", () => {
    const note = parseNote("---\n---\nbody\n")
    expect(getData(note)).toEqual({})
    expect(note.body).toBe("body\n")
    setField(note, "id", "x")
    expect(serializeNote(note)).toBe("---\nid: x\n---\n\nbody\n")
  })

  test("CRLF files stay CRLF, without mixed line endings", () => {
    const note = parseNote("---\r\nid: a\r\n---\r\n\r\n## Claim\r\nold\r\n\r\n## Why\r\nw\r\n")
    expect(getSection(note.body, "Claim")).toBe("old")
    note.body = setSection(note.body, "Claim", "new")
    setField(note, "kind", "chain")
    const out = serializeNote(note)
    expect(out.replace(/\r\n/g, "")).not.toContain("\n")
    expect(out).toContain("## Claim\r\nnew\r\n")
  })

  test("note without frontmatter keeps its body", () => {
    const note = parseNote("just text\n")
    expect(note.body).toBe("just text\n")
    expect(getData(note)).toEqual({})
  })

  test("invalid frontmatter throws a clear error", () => {
    expect(() => parseNote("---\nid: [unclosed\n---\n")).toThrow(/Invalid frontmatter/)
    expect(() => parseNote("---\n- a list\n---\n")).toThrow(/mapping/)
  })

  test("setSection replaces one section and keeps the others and a preamble", () => {
    const body = "Intro line\n\n## Claim\nold\n\n## Notes\nmine\n"
    const next = setSection(body, "Claim", "new claim")
    expect(getSection(next, "Claim")).toBe("new claim")
    expect(getSection(next, "Notes")).toBe("mine")
    expect(next.startsWith("Intro line")).toBe(true)
    expect(getSection(setSection(next, "Extra", "x"), "Extra")).toBe("x")
  })

  test("headings inside fenced code do not split sections, and rewrites leave nothing behind", () => {
    const why = "Example:\n```md\n## Title\ntext\n```\nend of why"
    let body = setSection("## Claim\nc\n\n## Why\n\n## Notes\nn\n", "Why", why)
    expect(getSection(body, "Why")).toBe(why)
    body = setSection(body, "Why", "new why")
    expect(getSection(body, "Why")).toBe("new why")
    expect(body).not.toContain("## Title")
    expect(getSection(body, "Notes")).toBe("n")
  })

  test("level-2 headings in written content are demoted so they cannot split the note", () => {
    const body = setSection("## Assessment\n\n## Plan\np\n", "Assessment", "# Overall\nx\n## Strand A\ny")
    expect(getSection(body, "Assessment")).toBe("### Overall\nx\n### Strand A\ny")
    expect(getSection(body, "Plan")).toBe("p")
  })

  test("closing hashes on a heading are understood", () => {
    expect(getSection("## Claim ##\nc\n", "Claim")).toBe("c")
    expect(setSection("## Claim ##\nc\n", "Claim", "d")).toBe("## Claim\nd\n")
  })

  test("mergeField keeps unknown keys and comments inside a mapping", () => {
    const note = parseNote("---\nsrs: {due: 2026-11-01, suspended: true} # my note\n---\n")
    mergeField(note, "srs", { due: "2026-12-01", reps: 2 })
    const out = serializeNote(note)
    expect(out).toContain("suspended: true")
    expect(out).toContain("# my note")
    expect(getData(note).srs).toEqual({ due: "2026-12-01", suspended: true, reps: 2 })
  })

  test("listItems reads bullets", () => {
    expect(listItems("- a\n* b\nnot\n  - c")).toEqual(["a", "b", "c"])
  })
})
