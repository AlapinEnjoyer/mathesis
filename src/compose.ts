import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Phase } from "./phases.ts"

export const PROMPTS_DIR = fileURLToPath(new URL("./prompts", import.meta.url))

/** Leading HTML comments hold attribution and notes for maintainers; the model does not need them. */
function stripComments(text: string): string {
  return text.replace(/^(?:\s*<!--[\s\S]*?-->)+/, "").trim()
}

function fragments(dir: string): string[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return files
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => stripComments(readFileSync(join(dir, file), "utf8")))
    .filter(Boolean)
}

/**
 * Builds the system prompt for a phase: `base.md`, then `shared/*.md`, then `<phase>/*.md`, each in file-name order
 * (numbered fragments such as `10-doctrine.md`). The result depends only on the phase, so it stays byte-identical
 * for the whole phase and keeps the provider's prompt cache warm.
 */
export function composePrompt(phase: Phase, root = PROMPTS_DIR): string {
  let base: string[] = []
  try {
    base = [stripComments(readFileSync(join(root, "base.md"), "utf8"))]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return [...base, ...fragments(join(root, "shared")), ...fragments(join(root, phase))].filter(Boolean).join("\n\n")
}

/** Cached per phase: prompt files ship with the package and do not change while opencode runs. */
export function promptCache(root = PROMPTS_DIR) {
  const cache = new Map<Phase, string>()
  return (phase: Phase) => {
    let text = cache.get(phase)
    if (text === undefined) {
      text = composePrompt(phase, root)
      cache.set(phase, text)
    }
    return text
  }
}
