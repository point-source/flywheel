/** Strip ANSI SGR escape sequences (color codes, glyph styling) so text
 * assertions match the plain content of a script's stdout. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
