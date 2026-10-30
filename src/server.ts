import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "mathesis",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "mathesis", description: "Mathesis learning tools" })
      editor.add({
        name: "hello",
        description: "Check that the Mathesis plugin is loaded.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "mathesis", codemode: false },
        execute: async () => ({ content: `Mathesis is loaded (opencode ${ctx.app.version}).` }),
      })
    })
  },
})
