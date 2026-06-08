import { build } from "esbuild";

// Bundle lives at core/dist/index.cjs. The root composite action runs this
// bundle directly by its absolute path — `node
// "${{ github.action_path }}/core/dist/index.cjs"` — because a `uses: ./…`
// reference inside a composite resolves against the adopter's workspace,
// not flywheel's own checkout. core/action.yml documents the same entry
// point (`runs.main: dist/index.cjs`, relative to core/). See SPEC
// §spec:action-version-lockstep and §spec:composite-self-reference.
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "core/dist/index.cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
