import { describe, it, expect } from 'vitest';
import { isCommand, COMMANDS } from './index.js';

describe('isCommand', () => {
  it('accepts every name in COMMANDS', () => {
    for (const cmd of COMMANDS) {
      expect(isCommand(cmd)).toBe(true);
    }
  });

  it('rejects unknown command names', () => {
    expect(isCommand('unknown')).toBe(false);
    expect(isCommand('')).toBe(false);
    expect(isCommand('PR-LIFECYCLE')).toBe(false);
  });
});
