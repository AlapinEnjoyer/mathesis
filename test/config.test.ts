import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseModel, resolveConfig } from "../src/config.ts"

describe("config", () => {
  test("defaults", () => {
    expect(resolveConfig({})).toEqual({ vault: join(homedir(), "mathesis"), models: {}, notify: true, reviewCap: 20 })
  })

  test("options from opencode.jsonc", () => {
    const config = resolveConfig(
      {
        vault: "notes/learn",
        notify: false,
        reviewCap: 5,
        models: { teach: "anthropic/claude-opus-5-5", recall: "openrouter/a/b", background: "bad" },
      },
      "/base",
    )
    expect(config.vault).toBe("/base/notes/learn")
    expect(config.notify).toBe(false)
    expect(config.reviewCap).toBe(5)
    expect(config.models).toEqual({
      teach: { providerID: "anthropic", id: "claude-opus-5-5" },
      recall: { providerID: "openrouter", id: "a/b" },
    })
  })

  test("parseModel", () => {
    expect(parseModel("a/b")).toEqual({ providerID: "a", id: "b" })
    for (const bad of ["", "a", "/b", "a/", 3, undefined]) expect(parseModel(bad)).toBeUndefined()
  })
})
