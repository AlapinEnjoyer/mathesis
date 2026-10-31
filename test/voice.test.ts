import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { buildForm } from "../src/questions.ts"
import { expand, parseVoice, speak, spokenQuestion, transcribe } from "../src/voice.ts"

describe("parseVoice", () => {
  test("off by default, with recorder and player defaults per OS", () => {
    const mac = parseVoice(undefined, "darwin")
    expect(mac.stt).toBeUndefined()
    expect(mac.tts).toBeUndefined()
    expect(mac.autoRead).toBe(false)
    expect([mac.dictateKey, mac.readKey]).toEqual(["<leader>v", "<leader>o"])
    expect(mac.record).toContain("avfoundation")
    expect(mac.play[0]).toBe("afplay")
    expect(parseVoice({}, "linux").record).toContain("pulse")
  })

  test("commands and OpenAI-compatible endpoints; malformed parts are dropped", () => {
    const voice = parseVoice({
      stt: { command: ["whisper-cli", "-f", "{file}"] },
      tts: { url: "http://localhost:8000/v1/audio/speech", model: "kokoro", voice: "af", apiKeyEnv: "KEY" },
      record: ["rec", "{file}"],
      autoRead: true,
    })
    expect(voice.stt).toEqual({ command: ["whisper-cli", "-f", "{file}"] })
    expect(voice.tts).toEqual({ url: "http://localhost:8000/v1/audio/speech", model: "kokoro", voice: "af", apiKeyEnv: "KEY" })
    expect(voice.record).toEqual(["rec", "{file}"])
    expect(voice.autoRead).toBe(true)
    expect(parseVoice({ stt: { command: [] }, tts: { url: "http://x" } })).not.toHaveProperty("stt")
    expect(parseVoice({ tts: { url: "http://x" } })).not.toHaveProperty("tts")
  })

  test("expand fills in the file and the home folder, per argument", () => {
    expect(expand(["-m", "~/models/a.bin", "-f", "{file}", "x{file}"], "/tmp/a.wav")).toEqual([
      "-m",
      join(homedir(), "models/a.bin"),
      "-f",
      "/tmp/a.wav",
      "x/tmp/a.wav",
    ])
  })
})

describe("transcribe", () => {
  test("a command's stdout is the transcript", async () => {
    expect(await transcribe({ command: ["echo", "  I think {file}  "] }, "B")).toBe("I think B")
  })

  test("a failing command reports its error", async () => {
    await expect(transcribe({ command: ["false"] }, "x")).rejects.toThrow(/false failed/)
  })

  test("an OpenAI-compatible endpoint gets the file and model, with the key from the env", async () => {
    const file = join(import.meta.dir, "..", "package.json")
    process.env.MATHESIS_TEST_KEY = "secret"
    let seen: { url: string; init: RequestInit } | undefined
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return Response.json({ text: " because B\n and not A " })
    }) as unknown as typeof fetch
    const text = await transcribe({ url: "http://localhost:9/v1/audio/transcriptions", model: "whisper-1", apiKeyEnv: "MATHESIS_TEST_KEY" }, file, fake)
    expect(text).toBe("because B and not A")
    expect(seen?.url).toBe("http://localhost:9/v1/audio/transcriptions")
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer secret")
    const body = seen?.init.body as FormData
    expect(body.get("model")).toBe("whisper-1")
    expect(body.get("file")).toBeInstanceOf(Blob)
    delete process.env.MATHESIS_TEST_KEY
  })

  test("a missing key or an HTTP error is an error", async () => {
    const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    await expect(transcribe({ url: "http://x", model: "m", apiKeyEnv: "MATHESIS_UNSET_KEY" }, "f", fake)).rejects.toThrow(/not set/)
    await expect(transcribe({ url: "http://x", model: "m" }, join(import.meta.dir, "..", "package.json"), fake)).rejects.toThrow(/500/)
  })
})

describe("speak", () => {
  test("a command gets the text on stdin", async () => {
    const out = join(import.meta.dir, "..", "node_modules", ".mathesis-speak-test")
    const playback = speak(parseVoice({}), { command: ["tee", out] }, "Which is true?")
    await playback.done
    expect(await Bun.file(out).text()).toBe("Which is true?")
    await Bun.file(out).delete()
  })
})

test("spokenQuestion reads the question and the choices, not 'I don't know'", () => {
  const form = buildForm({
    questionID: "q1",
    kind: "quiz",
    type: "probe",
    prompt: "Which?",
    options: ["Paris", "Rome"],
    correctIndex: 0,
    explanation: "e",
    askedAt: "2026-10-31T10:00:00.000Z",
  })
  expect(spokenQuestion(form)).toBe("Which?\nA: Paris.\nB: Rome.")
})
