import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { novel, novelPlatform, platform } from '@/db/schema';
import { isSyncConfigured } from './platforms';

/** 全局重新扫描要同步的小说：未归档、至少一个已配置平台、本地扫描未失败（F7.9 / F7.15）。 */
export function listSyncableNovels(db: Db, failedNovelIds: number[]): Array<{ id: number; name: string }> {
  const failed = new Set(failedNovelIds);
  const configured = new Set(
    db
      .select({ novelId: novelPlatform.novelId, name: platform.name, cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId })
      .from(novelPlatform)
      .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
      .all()
      .filter(isSyncConfigured)
      .map((r) => r.novelId),
  );
  return db
    .select({ id: novel.id, name: novel.name })
    .from(novel)
    .where(eq(novel.archived, false))
    .all()
    .filter((n) => configured.has(n.id) && !failed.has(n.id));
}
