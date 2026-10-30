import { describe, expect, test } from "bun:test"
import { getData, getSection, listItems, parseNote, serializeNote, setField, setSection } from "../src/store/note.ts"

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

  test("listItems reads bullets", () => {
    expect(listItems("- a\n* b\nnot\n  - c")).toEqual(["a", "b", "c"])
  })
})
