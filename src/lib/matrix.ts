import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Chapter, type Publication } from '@/db/schema';
import { listChapters } from './chapters';
import { badgeHint, deriveBadge } from './publish';
import type { Badge, PublishStatus } from './types';

export type Filter = 'all' | 'stale' | 'unpublished';
export const parseFilter = (v: string | undefined): Filter => (v === 'stale' || v === 'unpublished' ? v : 'all');

export interface MatrixCell {
  platformId: number;
  platformName: string;
  status: PublishStatus;
  badge: Badge;
  publishedAt: number | null;
  platformUrl: string | null;
  hint?: string;
}
export interface MatrixRow {
  chapter: Chapter;
  cells: MatrixCell[];
}
export interface Matrix {
  platforms: Array<{ id: number; name: string; bookUrl: string | null }>;
  rows: MatrixRow[];
  counts: { all: number; stale: number; unpublished: number };
  total: number;
  /** 实际生效的平台筛选；URL 里指向未绑定平台时归为 null。 */
  platformId: number | null;
}

function makeCell(ch: Chapter, pl: { id: number; name: string }, pub?: Publication): MatrixCell {
  const status = pub?.status ?? 'unpublished';
  const badge = deriveBadge(ch, pub);
  return {
    platformId: pl.id,
    platformName: pl.name,
    status,
    badge,
    publishedAt: pub?.publishedAt ?? null,
    platformUrl: pub?.platformUrl ?? null,
    hint: badgeHint({ badge, status, platformName: pl.name, mtimeMs: ch.mtimeMs }),
  };
}

function boundPlatforms(db: Db, novelId: number) {
  return db
    .select({ id: platform.id, name: platform.name, bookUrl: novelPlatform.bookUrl })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all();
}

export function getMatrix(db: Db, novelId: number, opts: { filter?: Filter; platformId?: number | null } = {}): Matrix {
  const platforms = boundPlatforms(db, novelId);
  const pubs = db
    .select({ p: publication })
    .from(publication)
    .innerJoin(chapter, eq(chapter.id, publication.chapterId))
    .where(eq(chapter.novelId, novelId))
    .all()
    .map((r) => r.p);
  const byKey = new Map(pubs.map((p) => [`${p.chapterId}:${p.platformId}`, p]));
  const all: MatrixRow[] = listChapters(db, novelId).map((ch) => ({
    chapter: ch,
    cells: platforms.map((pl) => makeCell(ch, pl, byKey.get(`${ch.id}:${pl.id}`))),
  }));

  const platformId = opts.platformId && platforms.some((p) => p.id === opts.platformId) ? opts.platformId : null;
  const scoped = (r: MatrixRow) => (platformId ? r.cells.filter((c) => c.platformId === platformId) : r.cells);
  const has = (r: MatrixRow, b: Badge) => scoped(r).some((c) => c.badge === b);
  const counts = {
    all: all.length,
    stale: all.filter((r) => has(r, 'stale')).length,
    unpublished: all.filter((r) => has(r, 'unpublished')).length,
  };
  const filter = opts.filter ?? 'all';
  const rows = filter === 'all' ? all : all.filter((r) => has(r, filter === 'stale' ? 'stale' : 'unpublished'));
  return { platforms, rows, counts, total: all.length, platformId };
}

export function getChapterCells(db: Db, chapterId: number): MatrixCell[] {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) return [];
  const pubs = new Map(db.select().from(publication).where(eq(publication.chapterId, chapterId)).all().map((p) => [p.platformId, p]));
  return boundPlatforms(db, ch.novelId).map((pl) => makeCell(ch, pl, pubs.get(pl.id)));
}
