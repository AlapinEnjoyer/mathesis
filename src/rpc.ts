import { Rpc } from "@opencode/plugin/rpc"

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const str = { type: "string" } as const
const bool = { type: "boolean" } as const
const modelRef = obj({ providerID: str, id: str, variant: str }, ["providerID", "id"])

const formSpec = {
  type: "object",
  properties: {
    id: str,
    title: str,
    fields: { type: "array", items: { type: "object" } },
    metadata: { type: "object" },
  },
  required: ["id", "title", "fields"],
} as const

/**
 * The contract between the server part and the TUI part (and any other client). The server implements it; the TUI
 * calls it through `context.client.rpc(Mathesis)`.
 */
export const Mathesis = Rpc.define({
  id: "mathesis",
  methods: {
    /** Claims an open question. Only the first claim is accepted; it returns the form to create. */
    claim: {
      input: obj({ questionID: str }, ["questionID"]),
      output: obj({ accepted: bool, sessionID: str, form: formSpec }, ["accepted"]),
    },
    /** The claimer created the form and it is on screen; without this the question falls back after a while. */
    shown: {
      input: obj({ formID: str }, ["formID"]),
      output: obj({ accepted: bool }, ["accepted"]),
    },
    /** Relays a form outcome seen by the TUI (for example after a restart). The first outcome wins. */
    relay: {
      input: obj({ formID: str, answer: { type: "object" }, cancelled: bool, message: str }, ["formID"]),
      output: obj({ accepted: bool }, ["accepted"]),
    },
    /** Open questions, so a restarted TUI can show them again. */
    pending: {
      input: obj({ sessionID: str }),
      output: obj(
        {
          questions: {
            type: "array",
            items: obj({ questionID: str, sessionID: str, title: str, claimed: bool, form: formSpec }, [
              "questionID",
              "sessionID",
              "title",
              "claimed",
              "form",
            ]),
          },
        },
        ["questions"],
      ),
    },
    /** Starts a Mathesis session (learn, recall or practice) and returns its id; the TUI then opens it. */
    start: {
      input: obj(
        {
          kind: { type: "string", enum: ["learn", "recall", "practice"] },
          goal: str,
          topic: str,
          model: modelRef,
          directory: str,
        },
        ["kind"],
      ),
      output: obj({ sessionID: str, title: str, notice: str }, ["sessionID", "title"]),
      errors: { invalid: obj({ reason: str }, ["reason"]) },
    },
    /** Topics for the `/learn` picker and the status view. */
    topics: {
      input: obj({}),
      output: obj(
        {
          topics: {
            type: "array",
            items: obj({ id: str, goal: str, ideas: { type: "number" }, due: { type: "number" } }, [
              "id",
              "goal",
              "ideas",
              "due",
            ]),
          },
        },
        ["topics"],
      ),
    },
    /** Writes the agent file and the vault folders; stores the model choice. */
    setup: {
      input: obj({
        models: obj({ teach: modelRef, recall: modelRef, background: modelRef }),
        sameModel: bool,
      }),
      output: obj({ agentFile: str, vault: str, created: bool, models: { type: "object" } }, [
        "agentFile",
        "vault",
        "created",
        "models",
      ]),
    },
  },
  events: {
    questionAsked: { schema: obj({ questionID: str, sessionID: str, title: str }, ["questionID", "sessionID", "title"]) },
    questionClosed: {
      schema: obj(
        { questionID: str, sessionID: str, formID: str, reason: { type: "string", enum: ["answered", "cancelled", "aborted", "fallback"] } },
        ["questionID", "sessionID", "formID", "reason"],
      ),
    },
    planUpdated: { schema: obj({ sessionID: str, topic: str }, ["sessionID", "topic"]) },
    cardsChanged: {
      schema: obj({ sessionID: str, added: { type: "array", items: str }, updated: { type: "array", items: str } }, [
        "added",
        "updated",
      ]),
    },
  },
})

export type ModelRefInput = { providerID: string; id: string; variant?: string }
export type StartInput = {
  kind: "learn" | "recall" | "practice"
  goal?: string
  topic?: string
  model?: ModelRefInput
  directory?: string
}
export type SetupInput = {
  models?: { teach?: ModelRefInput; recall?: ModelRefInput; background?: ModelRefInput }
  sameModel?: boolean
}
