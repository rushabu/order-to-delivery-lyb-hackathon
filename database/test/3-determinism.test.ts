// Check 3: the generator is deterministic and the committed files are its output.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../scripts/generate-seed';
import { FIXTURE_FILES, SEED_DIR } from '../scripts/seed-lib';

describe('determinism', () => {
  const a = mkdtempSync(join(tmpdir(), 'seed-a-'));
  const b = mkdtempSync(join(tmpdir(), 'seed-b-'));
  generate(a);
  generate(b);

  it.each(FIXTURE_FILES)('%s: two runs are byte-identical', (name) => {
    expect(readFileSync(join(a, name)).equals(readFileSync(join(b, name)))).toBe(true);
  });

  it.each(FIXTURE_FILES)('%s: committed file equals a fresh run', (name) => {
    expect(readFileSync(join(SEED_DIR, name)).equals(readFileSync(join(a, name)))).toBe(true);
  });
});
