// Compiles the TUI part to plain JavaScript for the npm package. opencode compiles a local plugin's .tsx itself, but
// not a package's, so the package ships dist/tui.js. OpenTUI, Solid and @opencode/plugin stay imports: the host
// provides them.
import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  plugins: [solid],
  external: ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(output.path)
