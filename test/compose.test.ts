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
