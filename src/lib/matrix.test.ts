import { describe, expect, it } from 'vitest';
import { chapter, publication } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { getChapterCells, getMatrix, parseFilter } from './matrix';
import { bindPlatform, listPlatforms, unbindPlatform } from './platforms';

function setup() {
  const db = makeDb();
  const n = insertNovel(db, '/x/A');
  const [fanqie, qidian] = listPlatforms(db);
  bindPlatform(db, n.id, fanqie.id);
  bindPlatform(db, n.id, qidian.id);
  const mk = (seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId: n.id, seq, title: `T${seq}`, filePath: `/x/A/Ch${seq}.md`, contentHash: `H${seq}`, ...over }).returning().get();
  return { db, n, fanqie, qidian, mk };
}

describe('getMatrix', () => {
  it('AC3.3 只显示已绑定平台的列', () => {
    const s = setup();
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    s.mk(1);
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms.map((p) => p.name)).toEqual(['番茄']);
    expect(m.rows[0].cells).toHaveLength(1);
  });

  it('无记录等同未发布；徽标与计数', () => {
    const s = setup();
    const c1 = s.mk(1); // 番茄已发且一致
    const c2 = s.mk(2); // 番茄已发但过期
    s.mk(3); // 全未发
    const c4 = s.mk(4, { fileMissing: true });
    s.db.insert(publication).values([
      { chapterId: c1.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H1' },
      { chapterId: c2.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'OLD' },
      { chapterId: c4.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H4' },
    ]).run();
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].badge)).toEqual(['published', 'stale', 'unpublished', 'missing']);
    // 第 1、2 章在起点未发，第 3 章两个平台都未发 → 3；文件丢失的第 4 章不计入
    expect(m.counts).toEqual({ all: 4, stale: 1, unpublished: 3 });
    expect(m.total).toBe(4);
    expect(m.rows[1].cells[0].hint).toContain('与 番茄 已发版本不一致');
  });

  it('AC3.7 / 筛选语义：任一平台命中；平台下拉限定范围；missing 不算未发布', () => {
    const s = setup();
    const c1 = s.mk(1);
    s.mk(2);
    s.mk(3, { fileMissing: true });
    s.db.insert(publication).values([
      { chapterId: c1.id, platformId: s.fanqie.id, status: 'published', publishedHash: 'H1' },
      { chapterId: c1.id, platformId: s.qidian.id, status: 'published', publishedHash: 'H1' },
    ]).run();
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished' }).rows.map((r) => r.chapter.seq)).toEqual([2]);
    // 限定到番茄：第 1 章已发 → 不出现；第 2 章未发 → 出现
    const m = getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.fanqie.id });
    expect(m.rows.map((r) => r.chapter.seq)).toEqual([2]);
    expect(m.counts.unpublished).toBe(1);
  });

  it('filter=all 返回全部', () => {
    const s = setup();
    s.mk(1);
    s.mk(2);
    expect(getMatrix(s.db, s.n.id, { filter: 'all' }).rows).toHaveLength(2);
  });
});

it('parseFilter', () => {
  expect(parseFilter('stale')).toBe('stale');
  expect(parseFilter('xx')).toBe('all');
  expect(parseFilter(undefined)).toBe('all');
});

describe('getChapterCells', () => {
  it('返回该章在每个已绑定平台的单元格', () => {
    const s = setup();
    const c = s.mk(1);
    expect(getChapterCells(s.db, c.id).map((x) => [x.platformName, x.badge])).toEqual([['番茄', 'unpublished'], ['起点', 'unpublished']]);
  });
});
