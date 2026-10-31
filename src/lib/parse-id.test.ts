import { describe, expect, it } from 'vitest';
import { parsePositiveInt } from './parse-id';

describe('parsePositiveInt', () => {
  it('accepts positive integers', () => {
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt('42')).toBe(42);
  });
  it('rejects everything else', () => {
    for (const v of ['abc', '0', '-3', '1.5', '', ' ', undefined, null, 'Infinity']) {
      expect(parsePositiveInt(v)).toBeNull();
    }
  });
});
