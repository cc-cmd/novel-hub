import { describe, expect, it } from 'vitest';
import { buildInfoPatch } from './publication-patch';

describe('buildInfoPatch', () => {
  it('untouched time sends no publishedAt', () => {
    const p = buildInfoPatch({ status: 'published', url: 'https://a.b', at: '', atDirty: false });
    expect('publishedAt' in p).toBe(false);
    expect(p.platformUrl).toBe('https://a.b');
  });
  it('edited time sends ms value', () => {
    const p = buildInfoPatch({ status: 'published', url: '', at: '2026-01-02T03:04', atDirty: true });
    expect(p.publishedAt).toBe(new Date('2026-01-02T03:04').getTime());
  });
  it('edited then cleared sends null', () => {
    expect(buildInfoPatch({ status: 'pending_review', url: '', at: '', atDirty: true }).publishedAt).toBeNull();
  });
  it('unpublished never sends publishedAt', () => {
    expect('publishedAt' in buildInfoPatch({ status: 'unpublished', url: '', at: 'x', atDirty: true })).toBe(false);
  });
  it('empty url becomes null', () => {
    expect(buildInfoPatch({ status: 'unpublished', url: '', at: '', atDirty: false }).platformUrl).toBeNull();
  });
});
