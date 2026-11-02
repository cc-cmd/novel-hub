import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Chapter, type Publication } from '@/db/schema';
import { listChapters } from './chapters';
import { isSyncConfigured, SYNC_PLATFORM } from './platforms';
import { syncedStatus, syncHint } from './publish';
import type { Badge, PublishStatus } from './types';

export type Filter = 'all' | 'stale' | 'unpublished';
export const parseFilter = (v: string | undefined): Filter => (v === 'stale' || v === 'unpublished' ? v : 'all');

export interface MatrixCell {
  platformId: number;
  platformName: string;
  /** 未配置的平台没有状态：badge 为 null */
  configured: boolean;
  status: PublishStatus;
  badge: Badge | null;
  publishedAt: number | null;
  platformUrl: string | null;
  hint?: string;
  platformWordCount: number | null;
  syncedAt: number | null;
  /** 该平台是否支持同步（决定未配置时显示"去配置"还是"暂不支持自动校验"） */
  syncSupported: boolean;
  /** 该（小说，平台）最近一次成功同步时间 */
  lastSyncedAt: number | null;
  /** 文件修改时间晚于该章同步时间：状态可能已落后，要等重新扫描（F7.22） */
  changedSinceSync: boolean;
}
export interface MatrixRow {
  chapter: Chapter;
  cells: MatrixCell[];
}
export interface Matrix {
  platforms: Array<{ id: number; name: string; bookUrl: string | null; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null }>;
  rows: MatrixRow[];
  counts: { all: number; stale: number; unpublished: number };
  /** 不受筛选影响 */
  changedCount: number;
  total: number;
  /** 实际生效的平台筛选；URL 里指向未绑定平台时归为 null。 */
  platformId: number | null;
}

type Bound = Matrix['platforms'][number];

function makeCell(pl: Bound, ch: Chapter, pub?: Publication): MatrixCell {
  if (!pl.configured) {
    return {
      platformId: pl.id, platformName: pl.name, configured: false, status: 'unpublished', badge: null, publishedAt: null, platformUrl: null, hint: '未配置，无状态',
      syncSupported: pl.name === SYNC_PLATFORM, platformWordCount: null, syncedAt: null, lastSyncedAt: null, changedSinceSync: false,
    };
  }
  const status = syncedStatus(pub?.status);
  return {
    platformId: pl.id,
    platformName: pl.name,
    configured: true,
    status,
    badge: status,
    publishedAt: pub?.publishedAt ?? null,
    platformUrl: pub?.platformUrl ?? null,
    hint: syncHint(pl.name),
    syncSupported: true,
    platformWordCount: pub?.platformWordCount ?? null,
    syncedAt: pub?.syncedAt ?? null,
    lastSyncedAt: pl.lastSyncedAt,
    changedSinceSync: !ch.fileMissing && !!pub?.syncedAt && (ch.mtimeMs ?? 0) > pub.syncedAt,
  };
}

function boundPlatforms(db: Db, novelId: number): Bound[] {
  return db
    .select({
      id: platform.id, name: platform.name, bookUrl: novelPlatform.bookUrl,
      cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId,
      lastSyncedAt: novelPlatform.lastSyncedAt, lastSyncError: novelPlatform.lastSyncError,
    })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all()
    .map((r) => ({ id: r.id, name: r.name, bookUrl: r.bookUrl, configured: isSyncConfigured(r), lastSyncedAt: r.lastSyncedAt, lastSyncError: r.lastSyncError }));
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
    cells: platforms.map((pl) => makeCell(pl, ch, byKey.get(`${ch.id}:${pl.id}`))),
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
  const changedCount = all.filter((r) => r.cells.some((c) => c.changedSinceSync)).length;
  return { platforms, rows, counts, changedCount, total: all.length, platformId };
}

export function getChapterCells(db: Db, chapterId: number): MatrixCell[] {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) return [];
  const pubs = new Map(db.select().from(publication).where(eq(publication.chapterId, chapterId)).all().map((p) => [p.platformId, p]));
  return boundPlatforms(db, ch.novelId).map((pl) => makeCell(pl, ch, pubs.get(pl.id)));
}
