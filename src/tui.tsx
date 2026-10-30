import { Plugin } from "@opencode/plugin/tui"
import { setupSpikeTui } from "./spike/tui.tsx"

export default Plugin.define({
  id: "mathesis.tui",
  setup(context) {
    if (process.env.MATHESIS_SPIKE === "1") return setupSpikeTui(context)
  },
})
