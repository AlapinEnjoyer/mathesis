import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export interface ModelRef {
  providerID: string
  id: string
}

export type ModelRole = "teach" | "recall" | "background"

export interface Config {
  vault: string
  models: Partial<Record<ModelRole, ModelRef>>
  notify: boolean
  reviewCap: number
}

export const DEFAULT_VAULT = "~/mathesis"
export const DEFAULT_REVIEW_CAP = 20

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return join(home, path.slice(2))
  return path
}

/** Parses "provider/model" (the model part may contain more slashes). */
export function parseModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

/** Plugin options from opencode.jsonc. Unknown or malformed values fall back to defaults. */
export function resolveConfig(options: Readonly<Record<string, unknown>>, base = process.cwd()): Config {
  const vaultOption = typeof options.vault === "string" && options.vault.trim() ? options.vault.trim() : DEFAULT_VAULT
  const expanded = expandHome(vaultOption)
  const vault = isAbsolute(expanded) ? expanded : resolve(base, expanded)

  const models: Config["models"] = {}
  const rawModels = options.models
  if (rawModels && typeof rawModels === "object") {
    for (const role of ["teach", "recall", "background"] as const) {
      const model = parseModel((rawModels as Record<string, unknown>)[role])
      if (model) models[role] = model
    }
  }

  const cap = Number(options.reviewCap)
  return {
    vault,
    models,
    notify: options.notify !== false,
    reviewCap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_REVIEW_CAP,
  }
}
