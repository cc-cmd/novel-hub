// src/lib/stats.test.ts
import { describe, expect, it } from 'vitest';
import { chapter, libraryRoot, novel, publication } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { getMatrix } from './matrix';
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
  const pub = (chapterId: number, platformId: number, status: 'unpublished' | 'pending_review' | 'published', publishedHash: string | null) =>
    db.insert(publication).values({ chapterId, platformId, status, publishedHash }).run();
  return { db, fanqie, qidian, mkNovel, mkCh, pub };
}
const stat = (db: Db, name: string) => getDashboard(db, { showArchived: true }).novels.find((n) => n.novel.name === name)!;

describe('getDashboard 统计口径', () => {
  it('AC6.1/6.2/6.8 章数、字数（不含丢失）、平台计数与恒等式', () => {
    const s = base();
    const n = s.mkNovel('A');
    bindPlatform(s.db, n.id, s.fanqie.id);
    bindPlatform(s.db, n.id, s.qidian.id);
    const c1 = s.mkCh(n.id, 1); // 番茄已发（一致）
    const c2 = s.mkCh(n.id, 2); // 番茄已发但过期
    const c3 = s.mkCh(n.id, 3); // 番茄审核中（一致）
    s.mkCh(n.id, 4); // 全未发
    const c5 = s.mkCh(n.id, 5, { fileMissing: true, wordCount: 999 }); // 丢失
    s.pub(c1.id, s.fanqie.id, 'published', 'H1');
    s.pub(c2.id, s.fanqie.id, 'published', 'OLD');
    s.pub(c3.id, s.fanqie.id, 'pending_review', 'H3');
    s.pub(c5.id, s.fanqie.id, 'published', 'H5');

    const a = stat(s.db, 'A');
    expect([a.chapterCount, a.wordCount, a.missingCount]).toEqual([5, 400, 1]);
    expect(a.platforms[0]).toEqual({ platformId: s.fanqie.id, platformName: '番茄', published: 1, pending: 1, stale: 1, unpublished: 1, missing: 1 });
    expect(a.platforms[1]).toMatchObject({ platformName: '起点', published: 0, pending: 0, stale: 0, unpublished: 4, missing: 1 });
    for (const p of a.platforms) {
      expect(p.published + p.pending + p.stale + p.unpublished + p.missing).toBe(a.chapterCount);
    }
    expect(a.staleChapters).toBe(1);
  });

  it('AC6.3 过期 → 已发 −1、需更新 +1', () => {
    const s = base();
    const n = s.mkNovel('A');
    bindPlatform(s.db, n.id, s.fanqie.id);
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.fanqie.id, 'published', 'H1');
    expect(stat(s.db, 'A').platforms[0]).toMatchObject({ published: 1, stale: 0 });
    s.db.update(chapter).set({ contentHash: 'CHANGED' }).run();
    expect(stat(s.db, 'A').platforms[0]).toMatchObject({ published: 0, stale: 1 });
  });

  it('AC6.5 未绑定平台 → platforms 为空', () => {
    const s = base();
    s.mkNovel('A');
    expect(stat(s.db, 'A').platforms).toEqual([]);
  });

  it('绑定了平台但 0 章 → 各计数为 0；未绑定平台的发布记录不计入', () => {
    const s = base();
    const n = s.mkNovel('A');
    bindPlatform(s.db, n.id, s.fanqie.id);
    expect(stat(s.db, 'A').platforms[0]).toMatchObject({ published: 0, pending: 0, stale: 0, unpublished: 0, missing: 0 });
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.qidian.id, 'published', 'H1'); // 起点未绑定
    expect(stat(s.db, 'A').platforms.map((p) => p.platformName)).toEqual(['番茄']);
  });

  it('卡片需更新数按「章」去重：两个平台都过期的同一章只算 1', () => {
    const s = base();
    const n = s.mkNovel('A');
    bindPlatform(s.db, n.id, s.fanqie.id);
    bindPlatform(s.db, n.id, s.qidian.id);
    const c = s.mkCh(n.id, 1);
    s.pub(c.id, s.fanqie.id, 'published', 'OLD');
    s.pub(c.id, s.qidian.id, 'published', 'OLD');
    const a = stat(s.db, 'A');
    expect(a.staleChapters).toBe(1);
    expect(a.platforms.map((p) => p.stale)).toEqual([1, 1]);
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
    for (const n of [a, b]) bindPlatform(s.db, n.id, s.fanqie.id);
    const ca = s.mkCh(a.id, 1, { mtimeMs: 1000 });
    const cb = s.mkCh(b.id, 1, { mtimeMs: 2000 });
    s.pub(ca.id, s.fanqie.id, 'published', 'OLD'); // 甲有 1 章需更新
    s.pub(cb.id, s.fanqie.id, 'published', 'H1');
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

describe('与详情页口径一致（AC4.8，随机对拍）', () => {
  it('SQL 聚合 = deriveBadge 逐格统计', () => {
    const s = base();
    const n = s.mkNovel('R');
    bindPlatform(s.db, n.id, s.fanqie.id);
    bindPlatform(s.db, n.id, s.qidian.id);
    let seed = 42;
    const rnd = (k: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % k);
    const hashes = ['H', 'OTHER', null, ''];
    for (let seq = 1; seq <= 300; seq++) {
      const ch = s.mkCh(n.id, seq, { fileMissing: rnd(8) === 0, contentHash: seq % 17 === 0 ? null : `H${seq}` });
      for (const p of [s.fanqie, s.qidian]) {
        const kind = rnd(5);
        if (kind === 0) continue; // 无记录
        const status = (['unpublished', 'pending_review', 'published'] as const)[rnd(3)];
        const h = rnd(3);
        const publishedHash = h === 0 ? `H${seq}` : h === 1 ? 'OTHER' : hashes[2 + rnd(2)];
        s.pub(ch.id, p.id, status, publishedHash);
      }
    }
    const dash = stat(s.db, 'R');
    const matrix = getMatrix(s.db, n.id);
    matrix.platforms.forEach((pl, i) => {
      const count = (b: string) => matrix.rows.filter((r) => r.cells[i].badge === b).length;
      expect(dash.platforms[i]).toMatchObject({
        platformId: pl.id,
        published: count('published'),
        pending: count('pending_review'),
        stale: count('stale'),
        unpublished: count('unpublished'),
        missing: count('missing'),
      });
    });
    expect(dash.staleChapters).toBe(matrix.counts.stale);
  });
});

describe('F6.12 规模', () => {
  it('20 本 × 500 章，3 条聚合查询应在 1 秒内完成', () => {
    const s = base();
    s.db.$client.transaction(() => {
      for (let i = 0; i < 20; i++) {
        const n = s.mkNovel(`N${i}`);
        bindPlatform(s.db, n.id, s.fanqie.id);
        bindPlatform(s.db, n.id, s.qidian.id);
        for (let seq = 1; seq <= 500; seq++) {
          const c = s.mkCh(n.id, seq);
          if (seq % 2 === 0) s.pub(c.id, s.fanqie.id, 'published', seq % 10 === 0 ? 'OLD' : `H${seq}`);
        }
      }
    })();
    const t0 = performance.now();
    const d = getDashboard(s.db);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(d.novels).toHaveLength(20);
  });
});
