import { describe, expect, it } from 'vitest';
import { createDb } from './index';
import { platform } from './schema';

describe('createDb', () => {
  it('migrates and seeds builtin platforms idempotently', () => {
    const db = createDb(':memory:');
    const rows = db.select().from(platform).all();
    expect(rows.map((r) => r.name)).toEqual(['番茄', '起点']);
    expect(rows.every((r) => r.builtin)).toBe(true);
  });
});
