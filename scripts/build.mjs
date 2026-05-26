import { build } from "esbuild";

// Bundle lives at core/dist/index.cjs to match the nested core/action.yml
// (`runs.main: dist/index.cjs` relative to that action's directory). The
// root composite action invokes the dispatcher via `uses: ./core`, so the
// bundle must sit alongside core/action.yml — not at the repo root. See
// SPEC §spec:action-version-lockstep.
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
