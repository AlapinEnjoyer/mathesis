import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { composePrompt, promptCache } from "../src/compose.ts"

const root = fileURLToPath(new URL("./fixtures/prompts", import.meta.url))

describe("composePrompt", () => {
  test("base, then shared, then the phase fragments in file-name order, without comments", () => {
    expect(composePrompt("teach", root)).toBe("BASE\n\nSHARED-10\n\nSHARED-20\n\nTEACH-05\n\nTEACH-20")
    expect(composePrompt("probe", root)).toBe("BASE\n\nSHARED-10\n\nSHARED-20\n\nPROBE uses mathesis_probe_done")
  })

  test("a phase without its own folder still gets base and shared", () => {
    expect(composePrompt("review", root)).toBe("BASE\n\nSHARED-10\n\nSHARED-20")
  })

  test("the prompt for a phase is identical on every call (prompt cache)", () => {
    const get = promptCache(root)
    expect(get("probe")).toBe(get("probe"))
    expect(get("probe")).toBe(composePrompt("probe", root))
    expect(get("probe")).not.toBe(get("teach"))
  })
})

describe("the shipped prompts", () => {
  test("every phase gets base, shared and its own doctrine, without attribution comments", () => {
    for (const phase of ["probe", "teach", "review", "practice"] as const) {
      const prompt = composePrompt(phase)
      expect(prompt).toStartWith("# Mathesis")
      expect(prompt).toContain("## The question tools")
      expect(prompt).not.toContain("<!--")
    }
    expect(composePrompt("probe")).toContain("# Phase: probe")
    expect(composePrompt("probe")).not.toContain("# Phase: teach")
    expect(composePrompt("teach")).toContain("mathesis_idea_upsert")
    expect(composePrompt("teach")).not.toContain("mathesis_probe_done` once")
  })

  test("prompts refer to the learner as they, not he", () => {
    for (const phase of ["probe", "teach"] as const) expect(composePrompt(phase)).not.toMatch(/\b(he|him|his)\b/)
  })
})
