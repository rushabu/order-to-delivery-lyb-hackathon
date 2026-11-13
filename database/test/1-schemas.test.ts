// Check 1: every seed file validates against its JSON Schema.
import { describe, expect, it } from 'vitest';
import { FIXTURE_FILES } from '../scripts/seed-lib';
import { schemaErrors } from '../scripts/validate-seed';
import { data } from './helpers';

describe('schemas', () => {
  const errors = schemaErrors(data);
  it.each(FIXTURE_FILES)('%s validates', (name) => {
    expect(errors.filter((e) => e.startsWith(`${name}:`))).toEqual([]);
  });

  it('rejects an email on a real domain', () => {
    const broken = structuredClone(data);
    broken['users.json'].users[0].email = 'someone@gmail.com';
    expect(schemaErrors(broken).some((e) => e.startsWith('users.json'))).toBe(true);
  });
});
