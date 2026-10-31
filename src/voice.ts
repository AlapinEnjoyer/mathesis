import { randomUUID } from "node:crypto"
import { rm, stat } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { expandHome } from "./config.ts"

/**
 * Dictation and read-aloud, run in the TUI process (where the microphone and the speakers are). A local command
 * (whisper.cpp, piper, `say`) or any OpenAI-compatible endpoint, local or cloud. Off unless the `voice` option sets it.
 */
export type Endpoint = { command: string[] } | { url: string; model: string; voice?: string; apiKeyEnv?: string }

export interface VoiceConfig {
  record: string[]
  play: string[]
  stt?: Endpoint
  tts?: Endpoint
  autoRead: boolean
  dictateKey: string
  readKey: string
}

const RECORD: Record<string, string[]> = {
  darwin: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000", "-y", "{file}"],
  linux: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-y", "{file}"],
}
const PLAY: Record<string, string[]> = {
  darwin: ["afplay", "{file}"],
  linux: ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", "{file}"],
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") ? value : undefined
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function endpoint(value: unknown): Endpoint | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const command = strings(raw.command)
  if (command) return { command }
  const url = text(raw.url)
  const model = text(raw.model)
  if (!url || !model) return undefined
  const voice = text(raw.voice)
  const apiKeyEnv = text(raw.apiKeyEnv)
  return { url, model, ...(voice ? { voice } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) }
}

/** The `voice` plugin option. Malformed parts are dropped, so a broken `stt` turns dictation off, nothing else. */
export function parseVoice(value: unknown, os: string = platform()): VoiceConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const stt = endpoint(raw.stt)
  const tts = endpoint(raw.tts)
  return {
    record: strings(raw.record) ?? RECORD[os] ?? RECORD.linux!,
    play: strings(raw.play) ?? PLAY[os] ?? PLAY.linux!,
    ...(stt ? { stt } : {}),
    ...(tts ? { tts } : {}),
    autoRead: raw.autoRead === true,
    dictateKey: text(raw.dictateKey) ?? "<leader>v",
    readKey: text(raw.readKey) ?? "<leader>o",
  }
}

/** `{file}` becomes the audio file, a leading `~` the home folder. Arguments go to the program as is, no shell. */
export const expand = (args: string[], file: string) => args.map((arg) => expandHome(arg.replaceAll("{file}", file)))

const tempFile = (ext: string) => join(tmpdir(), `mathesis-${randomUUID()}.${ext}`)

async function run(args: string[], stdin?: string) {
  const proc = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${err.trim().slice(0, 300)}`)
  return out
}

function authorization(endpoint: { apiKeyEnv?: string }): Record<string, string> {
  if (!endpoint.apiKeyEnv) return {}
  const key = process.env[endpoint.apiKeyEnv]
  if (!key) throw new Error(`${endpoint.apiKeyEnv} is not set`)
  return { Authorization: `Bearer ${key}` }
}

export interface Recording {
  /** Stops the recorder and returns the audio file (the caller deletes it). */
  stop(): Promise<string>
  cancel(): void
}

export function startRecording(config: VoiceConfig): Recording {
  const file = tempFile("wav")
  const proc = Bun.spawn(expand(config.record, file), { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  return {
    async stop() {
      // ffmpeg finishes the file on SIGINT and exits with 255, so judge by the file, not the exit code.
      proc.kill("SIGINT")
      const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      const size = await stat(file).then((info) => info.size, () => 0)
      if (size <= 44) {
        await rm(file, { force: true })
        throw new Error(`no audio was recorded${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`)
      }
      return file
    },
    cancel() {
      proc.kill()
      void proc.exited.then(() => rm(file, { force: true }))
    },
  }
}

/** Whisper puts each segment on its own line; the transcript is one paragraph. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export async function transcribe(endpoint: Endpoint, file: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if ("command" in endpoint) return oneLine(await run(expand(endpoint.command, file)))
  const body = new FormData()
  body.append("file", Bun.file(file), "speech.wav")
  body.append("model", endpoint.model)
  const response = await fetchImpl(endpoint.url, { method: "POST", headers: authorization(endpoint), body })
  if (!response.ok) throw new Error(`transcription failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
  const result = (await response.json()) as { text?: unknown }
  return typeof result.text === "string" ? oneLine(result.text) : ""
}

export interface Playback {
  done: Promise<void>
  stop(): void
}

/** Speaks the text: a command reads it on stdin; an endpoint returns audio that `play` plays. */
export function speak(config: VoiceConfig, endpoint: Endpoint, text: string, fetchImpl: typeof fetch = fetch): Playback {
  let proc: ReturnType<typeof Bun.spawn> | undefined
  let stopped = false
  const start = (args: string[], stdin?: string) => {
    proc = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "ignore", stderr: "ignore" })
    return proc.exited
  }
  const done = (async () => {
    if ("command" in endpoint) return void (await start(expand(endpoint.command, ""), text))
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorization(endpoint) },
      body: JSON.stringify({ model: endpoint.model, input: text, response_format: "wav", ...(endpoint.voice ? { voice: endpoint.voice } : {}) }),
    })
    if (!response.ok) throw new Error(`speech failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
    const file = tempFile("wav")
    await Bun.write(file, await response.arrayBuffer())
    try {
      if (!stopped) await start(expand(config.play, file))
    } finally {
      await rm(file, { force: true })
    }
  })()
  return {
    done,
    stop() {
      stopped = true
      proc?.kill()
    },
  }
}

/** What read-aloud says for a question form: the question, then the choices. */
export function spokenQuestion(form: { title: string; fields: unknown[] }): string {
  const answer = form.fields.find((field) => (field as { key?: string }).key === "answer") as
    | { options?: { value: string; label: string }[] }
    | undefined
  const choices = (answer?.options ?? []).filter((option) => /^\d+$/.test(option.value))
  return [form.title, ...choices.map((option, index) => `${String.fromCharCode(65 + index)}: ${option.label}.`)].join("\n")
}
