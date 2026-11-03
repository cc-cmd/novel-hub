import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novel, novelPlatform, platform, publication, type Chapter } from '@/db/schema';
import { listChapters } from './chapters';
import { PlatformAuthError, type ClientFactory, type FanqieClient, type RemoteChapter } from './fanqie-client';
import { readChapterFile } from './file-io';
import { isSyncConfigured } from './platforms';
import { parseChineseNumber, toPublishBody } from './publish';
import { UserError } from './result';

export type SyncedStatus = 'unpublished' | 'published' | 'stale';
export interface PlatformSyncCounts {
  published: number;
  stale: number;
  unpublished: number;
  skipped: number;
  unreadable: number;
  remoteExtra: number;
}
interface OutcomeBase { novelId: number; novelName: string; platformId: number; platformName: string }
export type PlatformSyncOutcome =
  | (OutcomeBase & { ok: true } & PlatformSyncCounts)
  | (OutcomeBase & { ok: false; error: string; authFailed: boolean });

const REVIEWING = 5; // chapter_list.display_status：审核中
const REMOTE_TITLE_RE = /^\s*第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*章\s*(.*?)\s*$/;

export function parseRemoteTitle(title: string): { seq: number; title: string } | null {
  const m = REMOTE_TITLE_RE.exec(title);
  if (!m) return null;
  const seq = parseChineseNumber(m[1]);
  return seq === null ? null : { seq, title: m[2] };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 线上 HTML 正文 → 纯文本（每个 <p> 一行）。先去标签再反转义，故 &lt;p&gt; 不会被当成标签。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const normTitle = (seq: number, title: string) => `第${seq}章 ${title.replace(/\s+/g, ' ').trim()}`;
const squash = (s: string) => s.replace(/\s/g, '');

export async function decideStatus(i: {
  local: { seq: number; title: string; wordCount: number };
  remote: RemoteChapter | undefined;
  localBody: () => string | null;
  remoteHtml: () => Promise<string | null>;
}): Promise<SyncedStatus | null> {
  const { local, remote } = i;
  if (!remote) return 'unpublished';
  const remoteTitle = parseRemoteTitle(remote.title)?.title ?? remote.title;
  const titleSame = normTitle(local.seq, remoteTitle) === normTitle(local.seq, local.title);
  const wordSame = remote.wordNumber === local.wordCount;
  if (titleSame && wordSame) return 'published';
  if (remote.displayStatus === REVIEWING) return 'stale'; // 审核中读不到正文，标题或字数已不一致
  if (!titleSame) return 'stale';
  const body = i.localBody();
  if (body === null) return null;
  const html = await i.remoteHtml();
  if (html === null) return null;
  return squash(htmlToText(html)) === squash(body) ? 'published' : 'stale';
}

function localBodyOf(ch: Chapter): string | null {
  try {
    const r = readChapterFile(ch.filePath);
    return r.ok ? toPublishBody(r.text) : null;
  } catch {
    return null;
  }
}

export async function syncNovelPlatform(
  db: Db,
  novelId: number,
  platformId: number,
  client: FanqieClient,
  now = Date.now(),
): Promise<PlatformSyncCounts> {
  const link = db
    .select()
    .from(novelPlatform)
    .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId)))
    .get();
  const bookId = link?.bookId;
  if (!bookId) throw new UserError('未填写有效的作品链接');

  const bySeq = new Map<number, RemoteChapter>();
  for (const r of await client.listChapters(bookId)) {
    const t = parseRemoteTitle(r.title);
    if (t) bySeq.set(t.seq, r); // 同章号重复：后出现的覆盖前面的
  }
  const locals = listChapters(db, novelId);
  const localSeqs = new Set(locals.map((c) => c.seq));
  const counts: PlatformSyncCounts = {
    published: 0, stale: 0, unpublished: 0, skipped: 0, unreadable: 0,
    remoteExtra: [...bySeq.keys()].filter((s) => !localSeqs.has(s)).length,
  };

  // 所有网络读取先于任何写库：认证中途失效时不会留下半截结果
  const decided: Array<{ ch: Chapter; status: SyncedStatus; remote: RemoteChapter | undefined }> = [];
  for (const ch of locals) {
    if (ch.fileMissing) {
      counts.skipped++;
      continue;
    }
    const remote = bySeq.get(ch.seq);
    try {
      const status = await decideStatus({
        local: ch,
        remote,
        localBody: () => localBodyOf(ch),
        remoteHtml: () => client.getChapterHtml(bookId, remote!.itemId),
      });
      if (status === null) {
        counts.unreadable++;
        continue;
      }
      decided.push({ ch, status, remote });
    } catch (e) {
      if (e instanceof PlatformAuthError) throw e;
      if (e instanceof UserError) {
        counts.unreadable++;
        continue;
      }
      throw e;
    }
  }

  db.$client.transaction(() => {
    for (const d of decided) {
      const set = {
        status: d.status,
        platformItemId: d.remote?.itemId ?? null,
        platformWordCount: d.remote?.wordNumber ?? null,
        syncedAt: now,
      };
      db.insert(publication)
        .values({ chapterId: d.ch.id, platformId, ...set })
        .onConflictDoUpdate({ target: [publication.chapterId, publication.platformId], set })
        .run();
      counts[d.status]++;
    }
    db.update(novelPlatform)
      .set({ lastSyncedAt: now, lastSyncError: null })
      .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId)))
      .run();
  })();
  return counts;
}

/** 对一本小说所有「已配置」平台同步。UserError 级失败记录到 lastSyncError 并作为失败结果返回，不抛出。 */
export async function syncNovelPlatforms(
  db: Db,
  novelId: number,
  makeClient: ClientFactory,
  now = Date.now(),
): Promise<PlatformSyncOutcome[]> {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  const rows = db
    .select({ platformId: platform.id, name: platform.name, cookie: platform.cookie, csrfToken: platform.csrfToken, bookId: novelPlatform.bookId })
    .from(novelPlatform)
    .innerJoin(platform, eq(platform.id, novelPlatform.platformId))
    .where(eq(novelPlatform.novelId, novelId))
    .orderBy(platform.id)
    .all()
    .filter(isSyncConfigured);
  const out: PlatformSyncOutcome[] = [];
  for (const r of rows) {
    const base = { novelId, novelName: n.name, platformId: r.platformId, platformName: r.name };
    try {
      out.push({ ok: true, ...base, ...(await syncNovelPlatform(db, novelId, r.platformId, makeClient(db, r.platformId), now)) });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      db.update(novelPlatform)
        .set({ lastSyncError: e.message })
        .where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, r.platformId)))
        .run();
      out.push({ ok: false, ...base, error: e.message, authFailed: e instanceof PlatformAuthError });
    }
  }
  return out;
}
