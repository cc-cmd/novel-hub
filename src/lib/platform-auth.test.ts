import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { novelPlatform, platform } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { PlatformAuthError, type FanqieClient } from './fanqie-client';
import { authSummaryOf, bindPlatformChecked, clearAuth, saveFanqieAuth } from './platform-auth';
import { listPlatforms } from './platforms';

const SAMPLE = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';
const client = (ids: string[] | Error): FanqieClient => ({
  listBookIds: async () => { if (ids instanceof Error) throw ids; return ids; },
  listChapters: async () => [],
  getChapterHtml: async () => null,
});

function setup() {
  const db = makeDb();
  const [fanqie, qidian] = listPlatforms(db);
  const n = insertNovel(db, '/x/A');
  return { db, fanqie, qidian, n };
}
const row = (db: ReturnType<typeof makeDb>, id: number) => db.select().from(platform).where(eq(platform.id, id)).get()!;

describe('saveFanqieAuth', () => {
  it('AC7.3 校验失败不保存', async () => {
    const s = setup();
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'c', csrfToken: 't' }, () => client(new PlatformAuthError())))
      .rejects.toThrow('认证无效或已过期');
    expect(row(s.db, s.fanqie.id).cookie).toBeNull();
  });
  it('校验通过后保存（去首尾空白）', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: ' c ', csrfToken: ' t ' }, () => client(['1']));
    expect(row(s.db, s.fanqie.id)).toMatchObject({ cookie: 'c', csrfToken: 't' });
  });
  it('空值、含换行（头注入）、非番茄平台均拒绝', async () => {
    const s = setup();
    const ok = () => client(['1']);
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: ' ', csrfToken: 't' }, ok)).rejects.toThrow('请填写');
    await expect(saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'a\nb', csrfToken: 't' }, ok)).rejects.toThrow('不能包含换行');
    await expect(saveFanqieAuth(s.db, s.qidian.id, { cookie: 'c', csrfToken: 't' }, ok)).rejects.toThrow('暂不支持自动校验');
  });
  it('clearAuth 清除；authSummaryOf 只露末 4 位', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'sessionid=abcd1234', csrfToken: 't' }, () => client(['1']));
    expect(authSummaryOf(row(s.db, s.fanqie.id))).toBe('已配置 · 末4位 1234');
    s.db.insert(novelPlatform).values({ novelId: s.n.id, platformId: s.fanqie.id, lastSyncError: 'x' }).run();
    clearAuth(s.db, s.fanqie.id);
    expect(row(s.db, s.fanqie.id)).toMatchObject({ cookie: null, csrfToken: null });
    // 认证变化后旧的失败记录不再成立，否则「认证已失效」不会消失（saveFanqieAuth 同样清除）
    expect(s.db.select().from(novelPlatform).get()!.lastSyncError).toBeNull();
    expect(authSummaryOf(row(s.db, s.fanqie.id))).toBeNull();
  });
});

describe('bindPlatformChecked', () => {
  const link = (s: ReturnType<typeof setup>) =>
    s.db.select().from(novelPlatform).where(eq(novelPlatform.novelId, s.n.id)).get();

  it('AC7.2 格式错误阻止保存', async () => {
    const s = setup();
    await expect(bindPlatformChecked(s.db, s.n.id, s.fanqie.id, 'https://fanqienovel.com/page/1', () => client([]))).rejects.toThrow('链接不符合番茄章节管理页格式');
    expect(link(s)).toBeUndefined();
  });
  it('AC7.4 有认证时校验作品归属', async () => {
    const s = setup();
    await saveFanqieAuth(s.db, s.fanqie.id, { cookie: 'c', csrfToken: 't' }, () => client(['1']));
    await expect(bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => client(['999']))).rejects.toThrow('该作品不在当前认证账号下');
    expect(link(s)).toBeUndefined();
    await bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => client(['7670888040847395864']));
    expect(link(s)).toMatchObject({ bookId: '7670888040847395864', bookUrl: SAMPLE });
  });
  it('F7.5 无认证：只做格式校验，仍保存（未配置）', async () => {
    const s = setup();
    await bindPlatformChecked(s.db, s.n.id, s.fanqie.id, SAMPLE, () => { throw new Error('不应联网'); });
    expect(link(s)).toMatchObject({ bookId: '7670888040847395864' });
  });
  it('F7.6 非番茄平台沿用 http(s) 校验，不写 bookId', async () => {
    const s = setup();
    await bindPlatformChecked(s.db, s.n.id, s.qidian.id, 'https://book.qidian.com/x', () => { throw new Error('不应联网'); });
    expect(link(s)).toMatchObject({ bookUrl: 'https://book.qidian.com/x', bookId: null });
    await expect(bindPlatformChecked(s.db, s.n.id, s.qidian.id, 'nope', () => client([]))).rejects.toThrow('作品主页链接格式错误');
  });
});
