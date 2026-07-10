// Evaluate the text of a generated `.releaserc.cjs` module (the output of
// serializeReleaseRc) in memory and return its exported config object. The
// module is self-contained — it defines `finalizeContext` and assigns
// `module.exports` with no `require`/import — so `new Function` resolves the
// spliced-in function into a genuine callable without touching the filesystem.
// Shared by push-flow.test.ts and release-rc.test.ts so both exercise the same
// load path (§spec:release-notes-dedup).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadReleaseConfig(contents: string): any {
  const mod = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", contents)(mod, mod.exports);
  return mod.exports;
}
