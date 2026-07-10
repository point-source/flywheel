// Minimal ambient declaration for the untyped @semantic-release/release-notes-generator
// dev dependency, used only by tests/release-rc.test.ts to render notes through
// the generated config (§spec:release-notes-dedup). The upstream package ships
// no type declarations and publishes no @types package.
declare module "@semantic-release/release-notes-generator" {
  export function generateNotes(
    pluginConfig: unknown,
    context: unknown,
  ): Promise<string>;
}
