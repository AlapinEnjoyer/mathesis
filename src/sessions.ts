import type { Plugin } from "@opencode/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ModelRef, ModelRole } from "./config.ts"
import type { ModelRefInput, SetupInput, StartInput } from "./rpc.ts"
import { topicPlan, type Runtime } from "./runtime.ts"
import { setPhase } from "./state.ts"
import { isSlug, slugify, topicSlug } from "./store/vault.ts"

type Ctx = Plugin.Context

export const AGENT_NAME = "mathesis"
const AGENT_MARKER = "<!-- mathesis-agent v1 -->"
const MODELS_KEY = "config/models"

export function configDir() {
  return process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

export const agentFilePath = () => join(configDir(), "agents", `${AGENT_NAME}.md`)

/**
 * Mathesis edits no files with file tools (its own tools write the vault) and runs no shell commands. Applied to the
 * agent and to every session it starts. Reading the learner's files stays allowed.
 */
export function permissions(_vault: string) {
  return [
    { action: "edit", resource: "*", effect: "deny" as const },
    { action: "shell", resource: "*", effect: "deny" as const },
  ]
}

export function agentFile(vault: string): string {
  const rules = permissions(vault)
    .map((rule) => `  - action: ${rule.action}\n    resource: ${JSON.stringify(rule.resource)}\n    effect: ${rule.effect}`)
    .join("\n")
  return `---
description: Mathesis. Learn a subject at the edge of what you know, and keep it with spaced review.
mode: primary
permissions:
${rules}
---
${AGENT_MARKER}
You are Mathesis, a learning harness. You teach at the edge of the learner's understanding, one reasoning step at a
time, and every idea the learner demonstrates becomes a card for spaced review in their Markdown vault (${vault}).

When this session has no Mathesis topic yet:
- If the learner wants to learn or understand something, call \`mathesis_topic_start\` with their goal. The
  instructions for the phase arrive with your system prompt from then on.
- If they want to continue earlier work, call \`mathesis_topic_list\` and let them pick.
- For spaced review or practice, tell them to run \`/recall\` or \`/practice\` (they start their own session).

Graded questions always go through \`mathesis_quiz\` or \`mathesis_explain\`, one at a time. Never edit vault files
with file tools; the Mathesis tools keep them consistent.
`
}

interface StoredModels {
  sameModel?: boolean
  teach?: ModelRef
  recall?: ModelRef
  background?: ModelRef
}

async function listModels(ctx: Ctx): Promise<{ providerID: string; id: string }[]> {
  const result = (await ctx.model.list()) as unknown
  const data = Array.isArray(result) ? result : ((result as { data?: unknown }).data ?? [])
  return (data as { providerID?: string; id?: string }[]).filter(
    (m): m is { providerID: string; id: string } => typeof m.providerID === "string" && typeof m.id === "string",
  )
}

/**
 * The model for a new session: plugin options > what /mathesis-setup stored > the model the TUI has selected.
 * Models are only ever chosen here, when a session is created (prompt cache, handoff §2c). Unknown models are
 * skipped, because opencode would store them without checking.
 */
export async function chooseModel(ctx: Ctx, rt: Runtime, role: ModelRole, current?: ModelRefInput) {
  const stored = ((await rt.store.get(MODELS_KEY)) ?? {}) as StoredModels
  const candidates = [rt.config.models[role], stored.sameModel ? undefined : stored[role], current].filter(Boolean) as ModelRefInput[]
  if (candidates.length === 0) return { model: undefined, notice: undefined }
  const available = await listModels(ctx).catch(() => undefined)
  const exists = (m: ModelRefInput) => !available || available.some((a) => a.providerID === m.providerID && a.id === m.id)
  const model = candidates.find(exists)
  const skipped = candidates.filter((m) => m !== model && !exists(m)).map((m) => `${m.providerID}/${m.id}`)
  return {
    model,
    notice: skipped.length ? `Model ${skipped.join(", ")} is not available; using ${model ? `${model.providerID}/${model.id}` : "the default model"}.` : undefined,
  }
}

async function agentExists(ctx: Ctx): Promise<boolean> {
  try {
    const result = (await ctx.agent.list()) as unknown
    const data = Array.isArray(result) ? result : ((result as { data?: unknown }).data ?? [])
    return (data as { id?: string; name?: string }[]).some((a) => a.id === AGENT_NAME || a.name === AGENT_NAME)
  } catch {
    return false
  }
}

export async function startSession(ctx: Ctx, rt: Runtime, input: StartInput): Promise<{ sessionID: string; title: string; notice?: string }> {
  const now = rt.now()
  const notices: string[] = []
  let topicId: string | undefined
  let goal: string | undefined
  if (input.kind === "learn") {
    if (input.topic) {
      topicId = isSlug(input.topic) ? input.topic : slugify(input.topic, 40)
      const topic = await rt.vault.readTopic(topicId)
      if (!topic && !input.goal) throw new Error(`There is no topic "${topicId}".`)
      goal = topic?.goal ?? input.goal
    } else {
      goal = input.goal?.trim()
      if (!goal) throw new Error("Say what you want to learn, e.g. /learn how binary search finds its bounds")
      topicId = topicSlug(goal)
    }
  } else if (input.topic) {
    topicId = isSlug(input.topic) ? input.topic : slugify(input.topic, 40)
    if (!(await rt.vault.readTopic(topicId))) throw new Error(`There is no topic "${topicId}".`)
  }

  const role: ModelRole = input.kind === "recall" ? "recall" : "teach"
  const { model, notice } = await chooseModel(ctx, rt, role, input.model)
  if (notice) notices.push(notice)
  const hasAgent = await agentExists(ctx)
  if (!hasAgent) notices.push("The mathesis agent is not set up yet; run /mathesis-setup. This session uses the default agent.")

  const title =
    input.kind === "learn" ? `Mathesis: ${goal}` : `Mathesis: ${input.kind === "recall" ? "review" : "practice"}${topicId ? ` (${topicId})` : ""}`
  await rt.vault.ensure()
  const session = await ctx.session.create({
    title,
    ...(hasAgent ? { agent: AGENT_NAME } : {}),
    ...(model ? { model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
    location: { directory: input.directory ?? ctx.location.directory },
    metadata: { mathesis: input.kind, ...(topicId ? { topic: topicId } : {}) },
    permissions: permissions(rt.config.vault),
  })

  let opening: string
  if (input.kind === "learn") {
    const existing = await rt.vault.readTopic(topicId!)
    const topic = existing ?? (await rt.vault.updateTopic(topicId!, { goal: goal! }, now))
    const phase = topicPlan(topic) ? "teach" : "probe"
    await setPhase(rt.store, session.id, phase, { topic: topicId }, now)
    opening = existing
      ? `Continue my Mathesis topic "${topic.goal}" (\`${topicId}\`). Start with mathesis_topic_status, recap in one or two sentences, and go on.`
      : `I want to learn: ${goal}`
  } else {
    await setPhase(rt.store, session.id, input.kind === "recall" ? "review" : "practice", topicId ? { topic: topicId } : {}, now)
    opening =
      input.kind === "recall"
        ? `Start my spaced review${topicId ? ` for the topic \`${topicId}\`` : ""}.`
        : `Start a practice session${topicId ? ` on the topic \`${topicId}\`` : ""}.`
  }
  await ctx.session.prompt({ sessionID: session.id, text: opening })
  return { sessionID: session.id, title, ...(notices.length ? { notice: notices.join(" ") } : {}) }
}

/** Writes the agent file (unless the learner wrote their own), creates the vault folders, stores the model choice. */
export async function setup(rt: Runtime, input: SetupInput) {
  await rt.vault.ensure()
  const path = agentFilePath()
  let created = false
  let existing: string | undefined
  try {
    existing = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (existing === undefined || existing.includes(AGENT_MARKER.replace(/v\d+ -->$/, ""))) {
    const next = agentFile(rt.config.vault)
    if (existing !== next) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, next, "utf8")
      created = existing === undefined
    }
  }
  if (input.sameModel !== undefined || input.models) {
    const stored: StoredModels = input.sameModel ? { sameModel: true } : { sameModel: false, ...input.models }
    await rt.store.set(MODELS_KEY, JSON.parse(JSON.stringify(stored)))
  }
  return { agentFile: path, vault: rt.config.vault, created, models: ((await rt.store.get(MODELS_KEY)) ?? {}) as Record<string, unknown> }
}
