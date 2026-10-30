import type { QuestionBroker } from "./broker.ts"
import type { Config } from "./config.ts"
import type { Phase } from "./phases.ts"
import { readPlan, type Plan } from "./plan.ts"
import { isDue, parseDate } from "./srs/fsrs.ts"
import type { KeyValue } from "./state.ts"
import type { Idea, Topic, Vault } from "./store/vault.ts"

/** Everything the tools need. The plugin context stays outside, so the tools can be tested without opencode. */
export interface Runtime {
  config: Config
  vault: Vault
  store: KeyValue
  broker: QuestionBroker
  prompt: (phase: Phase) => string
  now: () => Date
  events: {
    planUpdated(data: { sessionID: string; topic: string }): void
    cardsChanged(data: { sessionID?: string; added: string[]; updated: string[] }): void
  }
  /** Renames a session (for sessions started by talking to the agent). Optional outside opencode. */
  renameSession?: (sessionID: string, title: string) => Promise<void>
}

/** Thrown by a tool to refuse with a corrective message; the model reads it and corrects course. */
export class Refusal extends Error {}

export const sessionKind = (phase: Phase) => (phase === "review" ? "recall" : phase === "practice" ? "practice" : "learn")

export type IdeaState = "new" | "due" | "shaky" | "held" | "stable"

/** A coarse reading of a card for the agent: what to skip, what to repair first. */
export function ideaState(idea: Idea, now: Date): IdeaState {
  const srs = idea.srs
  if (!srs || srs.reps === 0) return "new"
  if (isDue(srs, now)) return "due"
  if (srs.lapses > 0 && srs.stability < 7) return "shaky"
  if (srs.stability >= 21) return "stable"
  return "held"
}

export function topicPlan(topic: Topic | undefined): Plan | undefined {
  return topic ? readPlan(topic.data.plan) : undefined
}

export function dueLabel(idea: Idea, now: Date): string {
  const due = parseDate(idea.srs?.due)
  if (!due) return "not scheduled"
  const days = Math.round((due.getTime() - now.getTime()) / 86_400_000)
  if (days <= 0) return days === 0 ? "due today" : `overdue by ${-days} d`
  return `due in ${days} d`
}

/** Ideas that belong to a topic: listed in its note, or with `topic:` set to it. */
export function topicIdeas(topic: Topic, ideas: readonly Idea[]): Idea[] {
  const listed = new Set(topic.ideas)
  return ideas.filter((idea) => listed.has(idea.id) || idea.topic === topic.id)
}

/** "1 card", "3 cards". */
export const cardCount = (n: number) => `${n} card${n === 1 ? "" : "s"}`
