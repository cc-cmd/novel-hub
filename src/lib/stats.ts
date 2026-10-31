// src/lib/stats.ts
import type { Db } from '@/db';
import { libraryRoot, novel, novelPlatform, platform, type Novel } from '@/db/schema';

export type Sort = 'recent' | 'name' | 'stale';
export const parseSort = (v: string | undefined): Sort => (v === 'name' || v === 'stale' ? v : 'recent');

export interface PlatformStat {
  platformId: number;
  platformName: string;
  published: number;
  pending: number;
  stale: number;
  unpublished: number;
  missing: number;
}
export interface NovelStat {
  novel: Novel;
  chapterCount: number;
  wordCount: number;
  missingCount: number;
  staleChapters: number;
  lastChangedAt: number | null;
  platforms: PlatformStat[];
}
export interface Dashboard {
  novels: NovelStat[];
  rootCount: number;
}

/**
 * 「需更新」的 SQL 形式，必须与 publish.ts 的 isStale 等价（c = chapter, p = publication）：
 *   !file_missing && status ∈ {pending_review, published} && content_hash 非空 && (published_hash 为空 || ≠ content_hash)
 * 由 stats.test.ts 的随机对拍保证一致，修改任一处必须同时修改另一处。
 */
const STALE = `(c.file_missing = 0
  AND p.status IN ('pending_review','published')
  AND c.content_hash IS NOT NULL AND c.content_hash <> ''
  AND (p.published_hash IS NULL OR p.published_hash = '' OR p.published_hash <> c.content_hash))`;

const Q_CHAPTERS = `
  SELECT n.id AS novel_id,
         COUNT(c.id) AS chapter_count,
         COALESCE(SUM(CASE WHEN c.file_missing = 0 THEN c.word_count END), 0) AS word_count,
         COALESCE(SUM(c.file_missing), 0) AS missing,
         MAX(c.mtime_ms) AS last_mtime
  FROM novel n LEFT JOIN chapter c ON c.novel_id = n.id
  GROUP BY n.id`;

const Q_PLATFORMS = `
  SELECT np.novel_id, np.platform_id,
         SUM(CASE WHEN c.file_missing = 1 THEN 1 ELSE 0 END) AS missing,
         SUM(CASE WHEN ${STALE} THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN c.file_missing = 0 AND p.status = 'published' AND NOT ${STALE} THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN c.file_missing = 0 AND p.status = 'pending_review' AND NOT ${STALE} THEN 1 ELSE 0 END) AS pending
  FROM novel_platform np
  JOIN chapter c ON c.novel_id = np.novel_id
  LEFT JOIN publication p ON p.chapter_id = c.id AND p.platform_id = np.platform_id
  GROUP BY np.novel_id, np.platform_id`;

const Q_STALE_CHAPTERS = `
  SELECT c.novel_id, COUNT(DISTINCT c.id) AS n
  FROM chapter c
  JOIN novel_platform np ON np.novel_id = c.novel_id
  JOIN publication p ON p.chapter_id = c.id AND p.platform_id = np.platform_id
  WHERE ${STALE}
  GROUP BY c.novel_id`;

export function getDashboard(db: Db, opts: { showArchived?: boolean; sort?: Sort } = {}): Dashboard {
  const raw = db.$client;
  const chapterRows = new Map(
    (raw.prepare(Q_CHAPTERS).all() as Array<{ novel_id: number; chapter_count: number; word_count: number; missing: number; last_mtime: number | null }>)
      .map((r) => [r.novel_id, r]),
  );
  const platRows = new Map(
    (raw.prepare(Q_PLATFORMS).all() as Array<{ novel_id: number; platform_id: number; missing: number; stale: number; published: number; pending: number }>)
      .map((r) => [`${r.novel_id}:${r.platform_id}`, r]),
  );
  const staleRows = new Map(
    (raw.prepare(Q_STALE_CHAPTERS).all() as Array<{ novel_id: number; n: number }>).map((r) => [r.novel_id, r.n]),
  );
  const platformNames = new Map(db.select().from(platform).all().map((p) => [p.id, p.name]));
  const bindings = db.select().from(novelPlatform).orderBy(novelPlatform.platformId).all();

  const stats: NovelStat[] = db
    .select()
    .from(novel)
    .all()
    .filter((n) => opts.showArchived || !n.archived)
    .map((n) => {
      const c = chapterRows.get(n.id);
      const chapterCount = c?.chapter_count ?? 0;
      const platforms: PlatformStat[] = bindings
        .filter((b) => b.novelId === n.id)
        .map((b) => {
          const r = platRows.get(`${n.id}:${b.platformId}`);
          const [published, pending, stale, missing] = [r?.published ?? 0, r?.pending ?? 0, r?.stale ?? 0, r?.missing ?? 0];
          return {
            platformId: b.platformId,
            platformName: platformNames.get(b.platformId) ?? '',
            published, pending, stale, missing,
            unpublished: chapterCount - published - pending - stale - missing,
          };
        });
      return {
        novel: n,
        chapterCount,
        wordCount: c?.word_count ?? 0,
        missingCount: c?.missing ?? 0,
        staleChapters: staleRows.get(n.id) ?? 0,
        lastChangedAt: c?.last_mtime ?? null,
        platforms,
      };
    });

  const sort = opts.sort ?? 'recent';
  const byName = (a: NovelStat, b: NovelStat) => a.novel.name.localeCompare(b.novel.name, 'zh');
  const cmp: Record<Sort, (a: NovelStat, b: NovelStat) => number> = {
    recent: (a, b) => (b.lastChangedAt ?? b.novel.createdAt) - (a.lastChangedAt ?? a.novel.createdAt),
    name: byName,
    stale: (a, b) => b.staleChapters - a.staleChapters || byName(a, b),
  };
  stats.sort((a, b) => Number(a.novel.archived) - Number(b.novel.archived) || cmp[sort](a, b));

  return { novels: stats, rootCount: db.select().from(libraryRoot).all().length };
}
