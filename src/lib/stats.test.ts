import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { chapter, libraryRoot, novel, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { bindPlatform, listPlatforms } from './platforms';
import { getDashboard, parseSort } from './stats';
import { setArchived } from './library';

type Db = ReturnType<typeof makeDb>;
function base() {
  const db = makeDb();
  const [fanqie, qidian] = listPlatforms(db);
  const mkNovel = (name: string, over: Partial<typeof novel.$inferInsert> = {}) => insertNovel(db, `/x/${name}`, over);
  const mkCh = (novelId: number, seq: number, over: Partial<typeof chapter.$inferInsert> = {}) =>
    db.insert(chapter).values({ novelId, seq, title: `T${seq}`, filePath: `/x/${seq}.md`, wordCount: 100, contentHash: `H${seq}`, ...over }).returning().get();
  const pub = (chapterId: number, platformId: number, status: string) =>
    db.insert(publication).values({ chapterId, platformId, status: status as never }).run();
  return { db, fanqie, qidian, mkNovel, mkCh, pub };
}
const stat = (db: Db, name: string) => getDashboard(db, { showArchived: true }).novels.find((n) => n.novel.name === name)!;

describe('getDashboard 统计口径', () => {
  it('AC6.1/6.2 章数、字数（不含丢失）、已配置平台计数与恒等式', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    bindPlatform(s.db, n.id, s.qidian.id); // 未配置
    const c1 = s.mkCh(n.id, 1);
    const c2 = s.mkCh(n.id, 2);
    s.mkCh(n.id, 3);
    const c4 = s.mkCh(n.id, 4, { fileMissing: true, wordCount: 999 });
    s.pub(c1.id, s.fanqie.id, 'published');
    s.pub(c2.id, s.fanqie.id, 'stale');
    s.pub(c4.id, s.fanqie.id, 'published');
    s.pub(c1.id, s.qidian.id, 'published'); // 未配置：不计入

    const a = stat(s.db, 'A');
    expect([a.chapterCount, a.wordCount, a.missingCount]).toEqual([4, 300, 1]);
    expect(a.platforms[0]).toEqual({ platformId: s.fanqie.id, platformName: '番茄', configured: true, published: 2, stale: 1, unpublished: 1, lastSyncedAt: null, lastSyncError: null });
    expect(a.platforms[1]).toEqual({ platformId: s.qidian.id, platformName: '起点', configured: false, published: 0, stale: 0, unpublished: 0, lastSyncedAt: null, lastSyncError: null });
    expect(a.platforms[0].published + a.platforms[0].stale + a.platforms[0].unpublished).toBe(a.chapterCount);
    expect(a.staleChapters).toBe(1);
  });

  it('F7.19 未配置的番茄（无认证 / 无链接）不计入，staleChapters 为 0', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.fanqie.id, 'stale');
    expect(stat(s.db, 'A').staleChapters).toBe(1);
    s.db.update(platform).set({ cookie: null }).where(eq(platform.id, s.fanqie.id)).run();
    const a = stat(s.db, 'A');
    expect(a.platforms[0]).toMatchObject({ configured: false, stale: 0 });
    expect(a.staleChapters).toBe(0);
  });

  it('AC6.5 未绑定平台 → platforms 为空', () => {
    const s = base();
    s.mkNovel('A');
    expect(stat(s.db, 'A').platforms).toEqual([]);
  });

  it('绑定了平台但 0 章 → 计数为 0；未绑定平台的发布记录不计入', () => {
    const s = base();
    const n = s.mkNovel('A');
    configureFanqie(s.db, n.id);
    expect(stat(s.db, 'A').platforms[0]).toMatchObject({ published: 0, stale: 0, unpublished: 0 });
    expect(stat(s.db, 'A').platforms[0].configured).toBe(true);
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.qidian.id, 'published'); // 起点未绑定
    expect(stat(s.db, 'A').platforms.map((p) => p.platformName)).toEqual(['番茄']);
  });

  it('F6.8 归档默认隐藏，且排在末尾', () => {
    const s = base();
    s.mkNovel('A');
    const b = s.mkNovel('B');
    setArchived(s.db, b.id, true);
    s.mkNovel('C');
    expect(getDashboard(s.db, { sort: 'name' }).novels.map((x) => x.novel.name)).toEqual(['A', 'C']);
    expect(getDashboard(s.db, { showArchived: true, sort: 'name' }).novels.map((x) => x.novel.name)).toEqual(['A', 'C', 'B']);
  });

  it('F6.13 排序：recent / name / stale', () => {
    const s = base();
    const a = s.mkNovel('甲');
    const b = s.mkNovel('乙');
    for (const n of [a, b]) configureFanqie(s.db, n.id);
    const ca = s.mkCh(a.id, 1, { mtimeMs: 1000 });
    const cb = s.mkCh(b.id, 1, { mtimeMs: 2000 });
    s.pub(ca.id, s.fanqie.id, 'stale');
    s.pub(cb.id, s.fanqie.id, 'published');
    const names = (sort: 'recent' | 'name' | 'stale') => getDashboard(s.db, { sort }).novels.map((x) => x.novel.name);
    expect(names('recent')).toEqual(['乙', '甲']);
    expect(names('stale')).toEqual(['甲', '乙']);
    expect(names('name')).toEqual(['甲', '乙'].sort((x, y) => x.localeCompare(y, 'zh')));
  });

  it('rootCount', () => {
    const s = base();
    s.db.insert(libraryRoot).values({ path: '/x' }).run();
    expect(getDashboard(s.db).rootCount).toBe(1);
  });

  it('parseSort', () => {
    expect([parseSort('name'), parseSort('stale'), parseSort('zzz'), parseSort(undefined)]).toEqual(['name', 'stale', 'recent', 'recent']);
  });
});

describe('F6.12 规模', () => {
  it('20 本 × 500 章，聚合查询应在 1 秒内完成', () => {
    const s = base();
    s.db.$client.transaction(() => {
      for (let i = 0; i < 20; i++) {
        const n = s.mkNovel(`N${i}`);
        configureFanqie(s.db, n.id);
        for (let seq = 1; seq <= 500; seq++) {
          const c = s.mkCh(n.id, seq);
          if (seq % 2 === 0) s.pub(c.id, s.fanqie.id, seq % 10 === 0 ? 'stale' : 'published');
        }
      }
    })();
    const t0 = performance.now();
    const d = getDashboard(s.db);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(d.novels).toHaveLength(20);
  });
});
