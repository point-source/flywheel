import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/index.js",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
