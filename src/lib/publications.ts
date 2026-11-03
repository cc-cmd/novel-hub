import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, publication, type Chapter, type Publication } from '@/db/schema';
import { validateUrl } from './platforms';
import { UserError } from './result';
import type { PublishStatus } from './types';

export interface PubSnapshot {
  status: PublishStatus;
  publishedAt: number | null;
  publishedHash: string | null;
  platformUrl: string | null;
}

const EMPTY: PubSnapshot = { status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: null };

export const snapshotOf = (row?: Publication | null): PubSnapshot =>
  row ? { status: row.status, publishedAt: row.publishedAt, publishedHash: row.publishedHash, platformUrl: row.platformUrl } : { ...EMPTY };

function getChapter(db: Db, id: number): Chapter {
  const ch = db.select().from(chapter).where(eq(chapter.id, id)).get();
  if (!ch) throw new UserError('章节不存在');
  return ch;
}

const rowOf = (db: Db, chapterId: number, platformId: number) =>
  db.select().from(publication).where(and(eq(publication.chapterId, chapterId), eq(publication.platformId, platformId))).get();

function write(db: Db, chapterId: number, platformId: number, s: PubSnapshot) {
  db.insert(publication)
    .values({ chapterId, platformId, ...s })
    .onConflictDoUpdate({ target: [publication.chapterId, publication.platformId], set: s })
    .run();
}

/** 保存章节链接 / 发布时间（不改变状态）。 */
export function updatePublicationInfo(
  db: Db,
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
): PubSnapshot {
  getChapter(db, chapterId);
  const prev = snapshotOf(rowOf(db, chapterId, platformId));
  const next = { ...prev };
  if ('platformUrl' in patch) next.platformUrl = validateUrl(patch.platformUrl, '章节链接');
  if ('publishedAt' in patch) {
    if (prev.status === 'unpublished') throw new UserError('未发布的章节没有发布时间');
    next.publishedAt = patch.publishedAt ?? null;
  }
  write(db, chapterId, platformId, next);
  return next;
}
