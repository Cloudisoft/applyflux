import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTENSION_VERSION } from '@applyflux/shared';

describe('extension version', () => {
  it('matches the version the server announces, so the web app can tell people to update', () => {
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBe(EXTENSION_VERSION);
  });
});
