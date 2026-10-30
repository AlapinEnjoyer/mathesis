import type { Plugin } from "@opencode/plugin"
import { phaseGuard } from "../phases.ts"
import { Refusal, type Runtime } from "../runtime.ts"
import { getSession, type SessionState } from "../state.ts"

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

export interface CallContext {
  sessionID: string
  signal: AbortSignal
  state: SessionState | undefined
  progress: (metadata: Record<string, unknown>) => Promise<void>
}

export interface ToolSpec {
  /** Name without the namespace; the model sees `mathesis_<name>`. */
  name: string
  description: string
  input: Record<string, unknown>
  run: (input: Record<string, unknown>, call: CallContext, rt: Runtime) => Promise<string>
}

export const NAMESPACE = "mathesis"

/**
 * Runs a tool with the phase rules: every Mathesis tool is registered for the whole session (prompt cache), and a
 * call outside its phases, or a Refusal thrown by the tool, returns a corrective message instead of failing.
 */
export async function runTool(spec: ToolSpec, rt: Runtime, input: unknown, call: Omit<CallContext, "state">): Promise<string> {
  const state = await getSession(rt.store, call.sessionID)
  const refusal = phaseGuard(spec.name, state?.phase)
  if (refusal) return `Refused: ${refusal}`
  try {
    return await spec.run((input ?? {}) as Record<string, unknown>, { ...call, state }, rt)
  } catch (error) {
    if (error instanceof Refusal) return `Refused: ${error.message}`
    throw error
  }
}

export function registerTools(editor: ToolEditor, rt: Runtime, specs: readonly ToolSpec[]) {
  editor.namespace({
    name: NAMESPACE,
    description: "Mathesis: probe, teach, spaced review and practice, with the learner's knowledge kept in a Markdown vault.",
  })
  for (const spec of specs) {
    editor.add({
      name: spec.name,
      description: spec.description,
      input: spec.input,
      options: { namespace: NAMESPACE, codemode: false },
      execute: async (input, context) => {
        try {
          return {
            content: await runTool(spec, rt, input, {
              sessionID: context.sessionID,
              signal: context.signal,
              progress: (metadata) => context.progress(metadata),
            }),
          }
        } finally {
          rt.events.sessionChanged?.({ sessionID: context.sessionID })
        }
      },
    })
  }
}

// Small input readers. The host validates against the JSON schema; these keep the tools safe either way.

export function text(input: Record<string, unknown>, key: string, options: { optional?: boolean; max?: number } = {}) {
  const value = input[key]
  if (value === undefined || value === null || value === "") {
    if (options.optional) return undefined
    throw new Refusal(`\`${key}\` is required.`)
  }
  if (typeof value !== "string") throw new Refusal(`\`${key}\` must be a string.`)
  const trimmed = value.trim()
  if (!trimmed && !options.optional) throw new Refusal(`\`${key}\` must not be empty.`)
  if (options.max && trimmed.length > options.max) throw new Refusal(`\`${key}\` is longer than ${options.max} characters.`)
  return trimmed || undefined
}

export function textList(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Refusal(`\`${key}\` must be a list of strings.`)
  }
  return (value as string[]).map((item) => item.trim()).filter(Boolean)
}

export function oneOf<T extends string>(input: Record<string, unknown>, key: string, values: readonly T[], fallback?: T): T {
  const value = input[key] ?? fallback
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Refusal(`\`${key}\` must be one of: ${values.join(", ")}.`)
  }
  return value as T
}

export const schema = {
  str: (description: string) => ({ type: "string", description }),
  list: (description: string) => ({ type: "array", items: { type: "string" }, description }),
  enum: (values: readonly string[], description: string) => ({ type: "string", enum: values, description }),
  object: (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }),
}
