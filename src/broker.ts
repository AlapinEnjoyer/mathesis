import { buildForm, parseFormAnswer, type FormSpec, type LearnerAnswer } from "./questions.ts"
import type { OpenQuestion } from "./state.ts"

export type AskOutcome =
  | { kind: "answer"; answer: LearnerAnswer; elapsedMs: number }
  /** No TUI claimed the question in time: the agent asks another way and records the answer. */
  | { kind: "fallback" }
  /** `signal`: the tool call was aborted. `unload`: the plugin unloaded (a reload); the question can be asked again. */
  | { kind: "aborted"; cause: "signal" | "unload" }

export type CloseReason = "answered" | "cancelled" | "aborted" | "fallback"

export interface PendingQuestion {
  questionID: string
  sessionID: string
  title: string
  claimed: boolean
  form: FormSpec
}

export interface BrokerEvents {
  asked(data: { questionID: string; sessionID: string; title: string }): void
  closed(data: { questionID: string; sessionID: string; formID: string; reason: CloseReason }): void
}

interface Entry {
  question: OpenQuestion
  sessionID: string
  form: FormSpec
  claimed: boolean
  shown: boolean
  /** Dictated thinking (TUI speech-to-text), added to the typed thinking when the form is answered. */
  spoken: string[]
  startedAt: number
  /** Restarts the deadline: claim in time, then show the form in time, else the question falls back. */
  arm: (ms: number) => void
  /** The form is on screen: no deadline any more, the question waits for the learner. */
  disarm: () => void
  finish: (outcome: AskOutcome, reason: CloseReason) => void
}

/**
 * Connects a waiting question tool with the TUI that shows the question (docs/spike.md, "Design for phase 2"):
 * the first TUI to claim a question creates its form (fixed id, so never twice); the answer arrives from the form
 * events the server watches, or from a TUI relaying it. Without a claim in time, the tool falls back.
 */
export class QuestionBroker {
  private entries = new Map<string, Entry>()
  private byForm = new Map<string, string>()

  constructor(
    private readonly events: BrokerEvents,
    private readonly options: { claimTimeoutMs: number; showTimeoutMs?: number; clock?: () => number } = { claimTimeoutMs: 4000 },
  ) {}

  private now() {
    return (this.options.clock ?? Date.now)()
  }

  isOpen(questionID: string) {
    return this.entries.has(questionID)
  }

  ask(sessionID: string, question: OpenQuestion, signal: AbortSignal): Promise<AskOutcome> {
    if (signal.aborted) return Promise.resolve({ kind: "aborted", cause: "signal" })
    if (this.entries.has(question.questionID)) throw new Error(`Question ${question.questionID} is already open`)
    const form = buildForm(question)
    return new Promise<AskOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.finish({ kind: "aborted", cause: "signal" }, "aborted")
      const entry: Entry = {
        question,
        sessionID,
        form,
        claimed: false,
        shown: false,
        spoken: [],
        startedAt: this.now(),
        arm: (ms) => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            if (!entry.shown) entry.finish({ kind: "fallback" }, "fallback")
          }, ms)
        },
        disarm: () => {
          if (timer) clearTimeout(timer)
          timer = undefined
        },
        finish: (outcome, reason) => {
          if (this.entries.get(question.questionID) !== entry) return
          this.entries.delete(question.questionID)
          this.byForm.delete(form.id)
          if (timer) clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          this.events.closed({ questionID: question.questionID, sessionID, formID: form.id, reason })
          resolve(outcome)
        },
      }
      this.entries.set(question.questionID, entry)
      this.byForm.set(form.id, question.questionID)
      signal.addEventListener("abort", onAbort, { once: true })
      entry.arm(this.options.claimTimeoutMs)
      this.events.asked({ questionID: question.questionID, sessionID, title: question.prompt })
    })
  }

  /**
   * The first claim wins and receives the form to create. Later claims get `accepted: false`. The claimer must then
   * report `shown` in time; a TUI that dies or fails to create the form makes the question fall back, not hang.
   */
  claim(questionID: string): { accepted: boolean; form?: FormSpec; sessionID?: string } {
    const entry = this.entries.get(questionID)
    if (!entry || entry.claimed) return { accepted: false }
    entry.claimed = true
    entry.arm(this.options.showTimeoutMs ?? 15_000)
    return { accepted: true, form: entry.form, sessionID: entry.sessionID }
  }

  /** The form is on screen: from now on the question waits for the learner as long as it takes. */
  shown(formID: string): boolean {
    const entry = this.entryForForm(formID)
    if (!entry || !entry.claimed) return false
    entry.shown = true
    entry.disarm()
    return true
  }

  /** Ends every open question (plugin unload): the waiting tools tell the agent to ask again. */
  abortAll() {
    for (const entry of [...this.entries.values()]) entry.finish({ kind: "aborted", cause: "unload" }, "aborted")
  }

  /** Dictated thinking for an open question, kept until the form is answered; `undo` drops the last one. */
  dictation(formID: string, change: { text?: string; undo?: boolean }): { accepted: boolean; count: number } {
    const entry = this.entryForForm(formID)
    if (!entry) return { accepted: false, count: 0 }
    if (change.undo) {
      const accepted = entry.spoken.pop() !== undefined
      return { accepted, count: entry.spoken.length }
    }
    const text = change.text?.trim()
    if (!text) return { accepted: false, count: entry.spoken.length }
    entry.spoken.push(text)
    return { accepted: true, count: entry.spoken.length }
  }

  /** A form reply (from the server's event stream, or relayed by a TUI). Unknown or finished forms are ignored. */
  formReplied(formID: string, raw: Record<string, unknown>): boolean {
    const entry = this.entryForForm(formID)
    if (!entry) return false
    const answer = withSpoken(parseFormAnswer(entry.question, raw), entry.spoken)
    entry.finish({ kind: "answer", answer, elapsedMs: this.now() - entry.startedAt }, "answered")
    return true
  }

  formCancelled(formID: string, message?: string): boolean {
    const entry = this.entryForForm(formID)
    if (!entry) return false
    const answer: LearnerAnswer = { status: "cancelled", ...(message ? { message } : {}) }
    entry.finish({ kind: "answer", answer, elapsedMs: this.now() - entry.startedAt }, "cancelled")
    return true
  }

  pending(sessionID?: string): PendingQuestion[] {
    return [...this.entries.values()]
      .filter((entry) => !sessionID || entry.sessionID === sessionID)
      .map((entry) => ({
        questionID: entry.question.questionID,
        sessionID: entry.sessionID,
        title: entry.question.prompt,
        claimed: entry.claimed,
        form: entry.form,
      }))
  }

  private entryForForm(formID: string) {
    const questionID = this.byForm.get(formID)
    return questionID ? this.entries.get(questionID) : undefined
  }
}

function withSpoken(answer: LearnerAnswer, spoken: string[]): LearnerAnswer {
  if (answer.status === "cancelled" || spoken.length === 0) return answer
  const thinking = [answer.thinking, `Spoken: ${spoken.join(" ")}`].filter(Boolean).join("\n")
  return { ...answer, thinking }
}
