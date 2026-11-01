import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, publication, type Chapter, type Publication } from '@/db/schema';
import { validateUrl } from './platforms';
import { UserError } from './result';
import { syncChapter } from './sync';
import type { PublishStatus } from './types';

export type PubAction = 'mark_pending' | 'mark_published' | 'approve' | 'resubmit' | 'cancel';

export interface PubSnapshot {
  status: PublishStatus;
  publishedAt: number | null;
  publishedHash: string | null;
  platformUrl: string | null;
}

const EMPTY: PubSnapshot = { status: 'unpublished', publishedAt: null, publishedHash: null, platformUrl: null };

export const snapshotOf = (row?: Publication | null): PubSnapshot =>
  row ? { status: row.status, publishedAt: row.publishedAt, publishedHash: row.publishedHash, platformUrl: row.platformUrl } : { ...EMPTY };

export function expectedStatus(action: PubAction): PublishStatus {
  return action === 'mark_pending' || action === 'resubmit' ? 'pending_review' : action === 'cancel' ? 'unpublished' : 'published';
}

const NEEDS_HASH: PubAction[] = ['mark_pending', 'mark_published', 'resubmit'];
const ALLOWED_FROM: Record<Exclude<PubAction, 'cancel'>, PublishStatus[]> = {
  mark_pending: ['unpublished'],
  mark_published: ['unpublished', 'published'],
  approve: ['pending_review'],
  resubmit: ['published'],
};
const ACTION_LABEL: Record<PubAction, string> = {
  mark_pending: '标记审核中', mark_published: '标记已发布', approve: '标记审核通过', resubmit: '重新提交', cancel: '取消',
};

export function nextPublication(
  prev: PubSnapshot,
  action: PubAction,
  ctx: { contentHash: string | null; fileMissing: boolean; now: number },
): PubSnapshot {
  if (action === 'cancel') {
    if (prev.status === 'unpublished') throw new UserError('当前未发布，不能取消');
    return { ...prev, status: 'unpublished', publishedAt: null, publishedHash: null };
  }
  if (ctx.fileMissing) throw new UserError('文件丢失的章节没有可对照的内容，不能标记已发。');
  if (!ALLOWED_FROM[action].includes(prev.status)) throw new UserError(`当前状态不能${ACTION_LABEL[action]}`);
  if (action === 'approve') return { ...prev, status: 'published' };
  if (NEEDS_HASH.includes(action) && !ctx.contentHash) throw new UserError('该章尚未同步成功，请先重新扫描');
  return { ...prev, status: expectedStatus(action), publishedAt: ctx.now, publishedHash: ctx.contentHash };
}

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

const ACTIONS: readonly string[] = ['mark_pending', 'mark_published', 'approve', 'resubmit', 'cancel'];
const STATUSES: readonly string[] = ['unpublished', 'pending_review', 'published'];

export function applyPublicationAction(db: Db, chapterId: number, platformId: number, action: PubAction, now = Date.now()) {
  if (!ACTIONS.includes(action)) throw new UserError('未知的发布操作');
  let ch = getChapter(db, chapterId);
  const bound = db
    .select()
    .from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, ch.novelId), eq(novelPlatform.platformId, platformId)))
    .get();
  if (!bound) throw new UserError('该小说未绑定此平台');
  if (NEEDS_HASH.includes(action)) {
    syncChapter(db, chapterId); // REQ-04 Q1：记录的必须是此刻磁盘上的版本
    ch = getChapter(db, chapterId);
  }
  const before = snapshotOf(rowOf(db, chapterId, platformId));
  const after = nextPublication(before, action, { contentHash: ch.contentHash, fileMissing: ch.fileMissing, now });
  write(db, chapterId, platformId, after);
  return { before, after };
}

export function restorePublication(db: Db, chapterId: number, platformId: number, snapshot: PubSnapshot): void {
  // 快照来自客户端，入库前重新校验
  const s = snapshot as Partial<PubSnapshot> | null;
  const intOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
  if (
    !s || !STATUSES.includes(s.status as string) || !intOrNull(s.publishedAt) ||
    !(s.publishedHash === null || typeof s.publishedHash === 'string')
  ) throw new UserError('撤销数据无效');
  snapshot = { ...snapshot, platformUrl: validateUrl(s.platformUrl, '章节链接') };
  write(db, chapterId, platformId, snapshot);
}

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
