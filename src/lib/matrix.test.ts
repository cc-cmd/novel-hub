import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chapter, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { getChapterCells, getMatrix, parseFilter } from './matrix';
import { bindPlatform, listPlatforms, unbindPlatform } from './platforms';

function setup() {
  const db = makeDb();
  const n = insertNovel(db, '/x/A');
  const [fanqie, qidian] = listPlatforms(db);
  configureFanqie(db, n.id); // 番茄：已配置
  bindPlatform(db, n.id, qidian.id); // 起点：未配置
  const mk = (seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId: n.id, seq, title: `T${seq}`, filePath: `/x/A/Ch${seq}.md`, contentHash: `H${seq}`, ...over }).returning().get();
  const pub = (chapterId: number, platformId: number, status: string) =>
    db.insert(publication).values({ chapterId, platformId, status: status as never }).run();
  return { db, n, fanqie, qidian, mk, pub };
}

describe('getMatrix', () => {
  it('platform 参数指向未绑定平台时归为全部平台', () => {
    const s = setup();
    s.mk(1);
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    const m = getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.qidian.id });
    expect(m.platformId).toBeNull();
    expect(m.counts.unpublished).toBe(1);
    expect(getMatrix(s.db, s.n.id, { platformId: s.fanqie.id }).platformId).toBe(s.fanqie.id);
  });

  it('AC3.3 只显示已绑定平台的列，并标注是否已配置', () => {
    const s = setup();
    unbindPlatform(s.db, s.n.id, s.qidian.id);
    s.mk(1);
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms).toMatchObject([{ name: '番茄', configured: true }]);
  });

  it('AC7.11/7.12 已配置列三态徽标；未配置列无徽标', () => {
    const s = setup();
    const c1 = s.mk(1);
    const c2 = s.mk(2);
    s.mk(3);
    const c4 = s.mk(4, { fileMissing: true });
    s.pub(c1.id, s.fanqie.id, 'published');
    s.pub(c2.id, s.fanqie.id, 'stale');
    s.pub(c4.id, s.fanqie.id, 'published');
    s.pub(c1.id, s.qidian.id, 'published'); // 未配置平台的遗留记录：不展示
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].badge)).toEqual(['published', 'stale', 'unpublished', 'published']);
    expect(m.rows.map((r) => r.cells[1].badge)).toEqual([null, null, null, null]);
    expect(m.rows[0].cells[0].hint).toBe('状态由番茄同步，点击重新扫描刷新');
    expect(m.rows[0].cells[1]).toMatchObject({ configured: false, hint: '未配置，无状态' });
    expect(m.counts).toEqual({ all: 4, stale: 1, unpublished: 1 });
  });

  it('F7.22 同步后有改动：文件修改时间晚于该章同步时间；从未同步或文件丢失不算', () => {
    const s = setup();
    const c1 = s.mk(1, { mtimeMs: 2000 });
    const c2 = s.mk(2, { mtimeMs: 500 });
    const c3 = s.mk(3, { mtimeMs: 2000 });
    const c4 = s.mk(4, { mtimeMs: 2000, fileMissing: true });
    for (const c of [c1, c2, c4]) {
      s.db.insert(publication).values({ chapterId: c.id, platformId: s.fanqie.id, status: 'published', syncedAt: 1000, platformWordCount: 77 }).run();
    }
    const m = getMatrix(s.db, s.n.id);
    expect(m.rows.map((r) => r.cells[0].changedSinceSync)).toEqual([true, false, false, false]);
    expect(m.changedCount).toBe(1);
    expect(m.rows[0].cells[0].platformWordCount).toBe(77);
    expect(c3.id).toBeGreaterThan(0);
  });

  it('清除认证 → 番茄变为未配置，整列无徽标', () => {
    const s = setup();
    const c = s.mk(1);
    s.pub(c.id, s.fanqie.id, 'published');
    s.db.update(platform).set({ cookie: null }).where(eq(platform.id, s.fanqie.id)).run();
    const m = getMatrix(s.db, s.n.id);
    expect(m.platforms.find((p) => p.name === '番茄')!.configured).toBe(false);
    expect(m.rows[0].cells.map((x) => x.badge)).toEqual([null, null]);
  });

  it('MVP 遗留的 pending_review 按未发布展示', () => {
    const s = setup();
    const c = s.mk(1);
    s.pub(c.id, s.fanqie.id, 'pending_review');
    expect(getMatrix(s.db, s.n.id).rows[0].cells[0].badge).toBe('unpublished');
  });

  it('筛选：任一已配置平台命中；平台下拉限定范围；filter=all 返回全部', () => {
    const s = setup();
    const c1 = s.mk(1);
    s.mk(2);
    s.pub(c1.id, s.fanqie.id, 'stale');
    expect(getMatrix(s.db, s.n.id, { filter: 'stale' }).rows.map((r) => r.chapter.seq)).toEqual([1]);
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished' }).rows.map((r) => r.chapter.seq)).toEqual([2]);
    expect(getMatrix(s.db, s.n.id, { filter: 'unpublished', platformId: s.qidian.id }).rows).toHaveLength(0); // 起点未配置，无状态
    expect(getMatrix(s.db, s.n.id, { filter: 'all' }).rows).toHaveLength(2);
  });
});

it('parseFilter', () => {
  expect(parseFilter('stale')).toBe('stale');
  expect(parseFilter('unpublished')).toBe('unpublished');
  expect(parseFilter('xx')).toBe('all');
  expect(parseFilter(undefined)).toBe('all');
});

describe('getChapterCells', () => {
  it('返回该章在每个已绑定平台的单元格', () => {
    const s = setup();
    const c = s.mk(1);
    expect(getChapterCells(s.db, c.id).map((x) => [x.platformName, x.configured, x.badge])).toEqual([['番茄', true, 'unpublished'], ['起点', false, null]]);
  });
});
