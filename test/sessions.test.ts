import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuestionBroker } from "../src/broker.ts"
import { resolveConfig } from "../src/config.ts"
import type { Runtime } from "../src/runtime.ts"
import { agentFilePath, chooseModel, permissions, setup } from "../src/sessions.ts"
import { memoryStore } from "../src/state.ts"
import { Vault } from "../src/store/vault.ts"

let root: string
let rt: Runtime
const previous = process.env.OPENCODE_CONFIG_DIR

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mathesis-sessions-"))
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  rt = {
    config: { ...resolveConfig({}), vault: join(root, "vault") },
    vault: new Vault(join(root, "vault")),
    store: memoryStore(),
    broker: new QuestionBroker({ asked: () => {}, closed: () => {} }),
    prompt: () => "",
    now: () => new Date("2026-10-30T10:00:00Z"),
    events: { planUpdated: () => {}, cardsChanged: () => {} },
  }
})
afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previous
  await rm(root, { recursive: true, force: true })
})

const fakeCtx = (models: { providerID: string; id: string }[]) => ({ model: { list: async () => ({ data: models }) } }) as never

describe("setup", () => {
  test("writes the agent file and the vault, and keeps a file the learner made their own", async () => {
    const first = await setup(rt, { sameModel: true })
    expect(first.created).toBe(true)
    const text = await readFile(agentFilePath(), "utf8")
    expect(text).toContain("mode: primary")
    expect(text).toContain("<!-- mathesis-agent v1 -->")
    expect(text).not.toContain("effect: allow")
    expect(first.models).toEqual({ sameModel: true })

    await writeFile(agentFilePath(), "---\ndescription: mine\n---\nMy own agent.\n")
    await setup(rt, {})
    expect(await readFile(agentFilePath(), "utf8")).toBe("---\ndescription: mine\n---\nMy own agent.\n")
  })

  test("an older Mathesis agent file is updated", async () => {
    await mkdir(join(root, "config", "agents"), { recursive: true })
    await writeFile(agentFilePath(), "<!-- mathesis-agent v0 -->\nold")
    await setup(rt, {})
    expect(await readFile(agentFilePath(), "utf8")).toContain("<!-- mathesis-agent v1 -->")
  })

  test("permissions deny edits and shell", () => {
    expect(permissions("/v")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ])
  })
})

describe("chooseModel", () => {
  const a = { providerID: "p", id: "a" }
  const b = { providerID: "p", id: "b" }
  const current = { providerID: "p", id: "current" }
  const ctx = fakeCtx([a, b, current])

  test("plugin options win over setup, setup over the TUI's model", async () => {
    expect((await chooseModel(ctx, rt, "teach", current)).model).toEqual(current)
    await setup(rt, { sameModel: false, models: { teach: b } })
    expect((await chooseModel(ctx, rt, "teach", current)).model).toEqual(b)
    expect((await chooseModel(ctx, rt, "recall", current)).model).toEqual(current)
    rt.config.models.teach = a
    expect((await chooseModel(ctx, rt, "teach", current)).model).toEqual(a)
  })

  test("unknown models are skipped with a notice; 'one model' ignores stored roles", async () => {
    rt.config.models.teach = { providerID: "p", id: "gone" }
    const result = await chooseModel(ctx, rt, "teach", current)
    expect(result.model).toEqual(current)
    expect(result.notice).toContain("p/gone is not available")
    delete rt.config.models.teach
    await setup(rt, { sameModel: true })
    expect((await chooseModel(ctx, rt, "teach", current)).model).toEqual(current)
  })
})
