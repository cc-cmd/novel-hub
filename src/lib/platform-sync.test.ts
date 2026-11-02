import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chapter, novelPlatform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { PlatformAuthError, PlatformUnavailableError, type FanqieClient, type RemoteChapter } from './fanqie-client';
import { decideStatus, htmlToText, parseRemoteTitle, syncNovelPlatform, syncNovelPlatforms } from './platform-sync';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe('parseRemoteTitle / htmlToText', () => {
  it('解析章号（阿拉伯与中文数字），其余为标题', () => {
    expect(parseRemoteTitle('第12章 开端')).toEqual({ seq: 12, title: '开端' });
    expect(parseRemoteTitle('第十二章  开端 ')).toEqual({ seq: 12, title: '开端' });
    expect(parseRemoteTitle('序章')).toBeNull();
  });
  it('htmlToText：段落换行、去标签、反转义', () => {
    expect(htmlToText('<p>a &amp; b</p><p>&lt;c&gt;&#20320;</p>')).toBe('a & b\n<c>你\n');
    expect(htmlToText('x<br/>y')).toBe('x\ny');
  });
});

describe('decideStatus（三态判定表）', () => {
  const local = { seq: 1, title: '开端', wordCount: 6 };
  const remote = (over: Partial<RemoteChapter> = {}): RemoteChapter =>
    ({ itemId: 'i', title: '第1章 开端', wordNumber: 6, displayStatus: 1, ...over });
  const run = (r: RemoteChapter | undefined, body: string | null = '你好，世界。', html: string | null = '<p>你好，世界。</p>') => {
    let htmlCalls = 0;
    const p = decideStatus({ local, remote: r, localBody: () => body, remoteHtml: async () => { htmlCalls++; return html; } });
    return p.then((status) => ({ status, htmlCalls }));
  };

  it('线上没有该章 → 未发布', async () => expect((await run(undefined)).status).toBe('unpublished'));
  it('标题与字数一致 → 已发布，且不拉正文', async () => expect(await run(remote())).toEqual({ status: 'published', htmlCalls: 0 }));
  it('AC7.6 标题不一致 → 需更新，且不拉正文', async () =>
    expect(await run(remote({ title: '第1章 别的', wordNumber: 9 }))).toEqual({ status: 'stale', htmlCalls: 0 }));
  it('AC7.6 标题不一致但字数一致 → 也是需更新', async () =>
    expect((await run(remote({ title: '第1章 别的' }))).status).toBe('stale'));
  it('AC7.7 字数不同、标题一致、正文有差异 → 需更新', async () =>
    expect(await run(remote({ wordNumber: 7 }), '你好，世界。', '<p>你好，世界！</p>')).toEqual({ status: 'stale', htmlCalls: 1 }));
  it('AC7.8 字数不同但正文去空白后一致 → 已发布', async () =>
    expect((await run(remote({ wordNumber: 7 }), '你好，\n世界。', '<p>你好， 世界。</p>')).status).toBe('published'));
  it('AC7.9 审核中：只比标题与字数，不拉正文', async () => {
    expect(await run(remote({ displayStatus: 5 }))).toEqual({ status: 'published', htmlCalls: 0 });
    expect(await run(remote({ displayStatus: 5, wordNumber: 0 }))).toEqual({ status: 'stale', htmlCalls: 0 });
  });
  it('无法比对（本地正文读不到 / 线上正文读不到）→ null', async () => {
    expect((await run(remote({ wordNumber: 7 }), null)).status).toBeNull();
    expect((await run(remote({ wordNumber: 7 }), '你好，世界。', null)).status).toBeNull();
  });
});

// ---------- 带库集成 ----------
const CH = (n: number, title: string, body: string) => `# 第${n}章 ${title}\n\n${body}\n`;

function setup(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  const { platformId } = configureFanqie(db, n.id);
  return { db, n, platformId, dir: t.dir };
}
const rc = (seq: number, title: string, w: number, displayStatus = 1): RemoteChapter =>
  ({ itemId: `item${seq}`, title: `第${seq}章 ${title}`, wordNumber: w, displayStatus });
const wc = (db: ReturnType<typeof makeDb>, seq: number) => db.select().from(chapter).where(eq(chapter.seq, seq)).get()!.wordCount;
const statusOf = (db: ReturnType<typeof makeDb>, platformId: number, seq: number) => {
  const ch = db.select().from(chapter).where(eq(chapter.seq, seq)).get()!;
  return db.select().from(publication).where(and(eq(publication.chapterId, ch.id), eq(publication.platformId, platformId))).get();
};
function fakeClient(remote: RemoteChapter[] | Error, html: Record<string, string | null | Error> = {}) {
  const htmlCalls: string[] = [];
  const c: FanqieClient = {
    listBookIds: async () => [],
    listChapters: async () => { if (remote instanceof Error) throw remote; return remote; },
    getChapterHtml: async (_b, itemId) => {
      htmlCalls.push(itemId);
      const v = html[itemId];
      if (v instanceof Error) throw v;
      return v === undefined ? null : v;
    },
  };
  return { c, htmlCalls };
}

describe('syncNovelPlatform', () => {
  const files = {
    'Ch01-甲.md': CH(1, '甲', '第一章正文。'),
    'Ch02-乙.md': CH(2, '乙', '第二章正文。'),
    'Ch03-丙.md': CH(3, '丙', '第三章正文。'),
    'Ch04-丁.md': CH(4, '丁', '第四章正文。'),
  };

  it('AC7.5 综合：已发布 / 未发布 / 需更新，并记录线上 ID 与字数', async () => {
    const s = setup(files);
    const { c, htmlCalls } = fakeClient(
      [
        rc(1, '甲', wc(s.db, 1)),          // 一致 → 已发布
        rc(3, '改了标题', wc(s.db, 3)),     // 标题不同 → 需更新
        rc(4, '丁', 999),                  // 字数不同 + 正文有差异 → 需更新
        rc(99, '本地没有', 5),              // 线上多出
      ],
      { item4: '<p>完全不一样的正文</p>' },
    );
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, c, 1234);
    expect(counts).toEqual({ published: 1, stale: 2, unpublished: 1, skipped: 0, unreadable: 0, remoteExtra: 1 });
    expect(htmlCalls).toEqual(['item4']);
    expect(statusOf(s.db, s.platformId, 1)).toMatchObject({ status: 'published', platformItemId: 'item1', platformWordCount: wc(s.db, 1), syncedAt: 1234 });
    expect(statusOf(s.db, s.platformId, 2)).toMatchObject({ status: 'unpublished', platformItemId: null });
    expect(statusOf(s.db, s.platformId, 3)?.status).toBe('stale');
    expect(statusOf(s.db, s.platformId, 4)?.status).toBe('stale');
    expect(s.db.select().from(novelPlatform).get()).toMatchObject({ lastSyncedAt: 1234, lastSyncError: null });
  });

  it('再次同步可从需更新回到已发布 / 从已发布变回未发布', async () => {
    const s = setup(files);
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', 1)], { item1: '<p>不同</p>' }).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('stale');
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', wc(s.db, 1))]).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([]).c);
    expect(statusOf(s.db, s.platformId, 1)).toMatchObject({ status: 'unpublished', platformItemId: null, platformWordCount: null });
  });

  it('线上同章号重复 → 取列表中最后一条', async () => {
    const s = setup(files);
    await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([rc(1, '甲', 1), rc(1, '甲', wc(s.db, 1))]).c);
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
  });

  it('文件丢失的章节不参与，保持原状态', async () => {
    const s = setup(files);
    s.db.insert(publication).values({ chapterId: s.db.select().from(chapter).where(eq(chapter.seq, 2)).get()!.id, platformId: s.platformId, status: 'published' }).run();
    s.db.update(chapter).set({ fileMissing: true }).where(eq(chapter.seq, 2)).run();
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, fakeClient([]).c);
    expect(counts.skipped).toBe(1);
    expect(statusOf(s.db, s.platformId, 2)?.status).toBe('published');
  });

  it('单章读正文失败（非认证）→ 该章状态不变、计入无法比对，其他章继续', async () => {
    const s = setup(files);
    const { c } = fakeClient([rc(1, '甲', 1), rc(2, '乙', wc(s.db, 2))], { item1: new PlatformUnavailableError() });
    const counts = await syncNovelPlatform(s.db, s.n.id, s.platformId, c);
    expect(counts.unreadable).toBe(1);
    expect(statusOf(s.db, s.platformId, 1)).toBeUndefined();
    expect(statusOf(s.db, s.platformId, 2)?.status).toBe('published');
  });

  it('读正文时认证失效 → 整个同步中止，不写任何状态', async () => {
    const s = setup(files);
    const { c } = fakeClient([rc(1, '甲', wc(s.db, 1)), rc(2, '乙', 1)], { item2: new PlatformAuthError() });
    await expect(syncNovelPlatform(s.db, s.n.id, s.platformId, c)).rejects.toBeInstanceOf(PlatformAuthError);
    expect(s.db.select().from(publication).all()).toHaveLength(0);
  });
});

describe('syncNovelPlatforms（容错与记录）', () => {
  const files = { 'Ch01-甲.md': CH(1, '甲', '第一章正文。') };

  it('AC7.10 认证失效：状态不变，记录 lastSyncError，authFailed=true', async () => {
    const s = setup(files);
    s.db.insert(publication).values({ chapterId: s.db.select().from(chapter).get()!.id, platformId: s.platformId, status: 'published' }).run();
    const out = await syncNovelPlatforms(s.db, s.n.id, () => fakeClient(new PlatformAuthError()).c);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ok: false, authFailed: true, platformName: '番茄', novelName: s.n.name });
    expect(statusOf(s.db, s.platformId, 1)?.status).toBe('published');
    expect(s.db.select().from(novelPlatform).get()!.lastSyncError).toContain('认证无效或已过期');
  });

  it('未配置的绑定不参与同步', async () => {
    const s = setup(files);
    s.db.update(novelPlatform).set({ bookId: null }).run();
    expect(await syncNovelPlatforms(s.db, s.n.id, () => { throw new Error('不应创建客户端'); })).toEqual([]);
  });

  it('成功：返回 ok 结果', async () => {
    const s = setup(files);
    const out = await syncNovelPlatforms(s.db, s.n.id, () => fakeClient([rc(1, '甲', wc(s.db, 1))]).c);
    expect(out[0]).toMatchObject({ ok: true, published: 1, stale: 0, unpublished: 0 });
  });
});
