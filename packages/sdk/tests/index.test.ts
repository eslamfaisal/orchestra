import { describe, expect, it } from 'vitest';

import metadata from '../package.json' with { type: 'json' };
import { version } from '../src/index.js';

describe('package entry point', () => {
  it('exports the package manifest version', () => {
    expect(version).toBe(metadata.version);
  });
});
