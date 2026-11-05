import { describe, expect, test } from "bun:test"
import { encodeWav, toBase64 } from "../src/wav.ts"

describe("encodeWav", () => {
  test("writes a 16-bit mono header and clamps samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000)
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF")
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE")
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(8)
    expect([44, 46, 48, 50].map((at) => view.getInt16(at, true))).toEqual([0, 32767, -32768, 32767])
  })

  test("base64 survives a long buffer", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251)
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
  })
})
