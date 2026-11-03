import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chapter, novelPlatform, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { PlatformApiError, PlatformAuthError, PlatformQuotaError, type FanqiePublisher, type PublishArticleInput, type RemoteChapter } from './fanqie-client';
import { planPublish, runPublish, setPublishSettings, setVolumeRules, startOfDay, usedToday } from './fanqie-publish';
import { toPublishHtml } from './publish';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const CH = (n: number, title: string, body: string) => `# 第${n}章 ${title}\n\n${body}\n`;
const NOW = new Date('2026-11-03T10:00:00').getTime();

function setup(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  const { platformId } = configureFanqie(db, n.id);
  return { db, n, platformId };
}
const chId = (db: ReturnType<typeof makeDb>, seq: number) => db.select().from(chapter).where(eq(chapter.seq, seq)).get()!.id;
const pubOf = (db: ReturnType<typeof makeDb>, platformId: number, seq: number) =>
  db.select().from(publication).where(and(eq(publication.chapterId, chId(db, seq)), eq(publication.platformId, platformId))).get();
const linkPub = (db: ReturnType<typeof makeDb>, platformId: number, seq: number, status: 'published' | 'stale', itemId: string) =>
  db.insert(publication).values({ chapterId: chId(db, seq), platformId, status, platformItemId: itemId }).run();

function fakePublisher(o: {
  remote?: RemoteChapter[];
  volumes?: Array<{ volumeId: string; volumeName: string }>;
  publishError?: (i: PublishArticleInput) => Error | null;
  addVolumeError?: Error;
} = {}) {
  const volumes = [...(o.volumes ?? [{ volumeId: 'v1', volumeName: '第一卷：崩塌' }])];
  const log: string[] = [];
  const published: PublishArticleInput[] = [];
  let draft = 0;
  const c: FanqiePublisher = {
    listBookIds: async () => [],
    listChapters: async () => o.remote ?? [],
    getChapterHtml: async () => null,
    listVolumes: async () => volumes.map((v) => ({ ...v })),
    addVolume: async (_b, name) => {
      log.push(`addVolume:${name}`);
      if (o.addVolumeError) throw o.addVolumeError;
      volumes.push({ volumeId: `v${volumes.length + 1}`, volumeName: name });
    },
    newDraft: async () => { log.push('newDraft'); return `draft${++draft}`; },
    publishArticle: async (i) => {
      const err = o.publishError?.(i);
      if (err) throw err;
      log.push(`publish:${i.itemId}`);
      published.push(i);
    },
  };
  return { c, log, published };
}
const opts = { now: () => NOW, sleep: async () => {}, intervalMs: 0 };

describe('toPublishHtml', () => {
  it('每个非空行一个 <p>，转义特殊字符', () => {
    expect(toPublishHtml('甲 & 乙\n\n<丙>\n  ')).toBe('<p>甲 &amp; 乙</p><p>&lt;丙&gt;</p>');
  });
});

describe('planPublish', () => {
  it('只列未发布 / 需更新；有 item_id 为覆盖、否则新发；审核中与平台缺失的章节标为阻塞', async () => {
    const s = setup({
      'Ch01-一.md': CH(1, '一', '甲乙'), 'Ch02-二.md': CH(2, '二', '丙丁'), 'Ch03-三.md': CH(3, '三', '戊'),
      'Ch04-四.md': CH(4, '四', '己'), 'Ch05-五.md': CH(5, '五', '庚'),
    });
    linkPub(s.db, s.platformId, 1, 'published', 'i1');
    linkPub(s.db, s.platformId, 2, 'stale', 'i2');
    linkPub(s.db, s.platformId, 3, 'stale', 'i3');
    linkPub(s.db, s.platformId, 4, 'stale', 'gone');
    const remote: RemoteChapter[] = [
      { itemId: 'i1', title: '第1章 一', wordNumber: 2, displayStatus: 1 },
      { itemId: 'i2', title: '第2章 二', wordNumber: 9, displayStatus: 1 },
      { itemId: 'i3', title: '第3章 三', wordNumber: 9, displayStatus: 5 },
    ];
    const plan = await planPublish(s.db, s.n.id, s.platformId, fakePublisher({ remote }).c, NOW);
    expect(plan.rows.map((r) => [r.seq, r.mode, r.blocked])).toEqual([
      [2, 'overwrite', null],
      [3, 'overwrite', '审核中，暂不支持修改'],
      [4, 'overwrite', '平台上找不到该章节，请先重新扫描'],
      [5, 'new', null],
    ]);
    expect(plan.rows[0]).toMatchObject({ title: '第2章 二', wordCount: 2, volumeName: '第一卷：崩塌' });
    expect(plan).toMatchObject({ usedToday: 0, dailyLimit: 20000, useAi: 2 });
  });

  it('分卷：未配置规则且平台多卷 → 阻塞；按规则匹配（容忍卷名后缀）；平台缺卷 → 标记待创建', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲'), 'Ch51-五十一.md': CH(51, '五十一', '乙'), 'Ch99-九十九.md': CH(99, '九十九', '丙') });
    const vols = [{ volumeId: 'v1', volumeName: '第一卷：崩塌' }, { volumeId: 'v0', volumeName: '作品相关' }];
    let plan = await planPublish(s.db, s.n.id, s.platformId, fakePublisher({ volumes: vols }).c, NOW);
    expect(plan.rows[0].blocked).toBe('平台有多个分卷，请先配置分卷规则');

    setVolumeRules(s.db, s.n.id, s.platformId, '51-98 第二卷：暗战\n1-50 第一卷');
    plan = await planPublish(s.db, s.n.id, s.platformId, fakePublisher({ volumes: vols }).c, NOW);
    expect(plan.rows.map((r) => [r.seq, r.volumeName, r.createVolume, r.blocked])).toEqual([
      [1, '第一卷：崩塌', false, null],
      [51, '第二卷：暗战', true, null],
      [99, null, false, '第 99 章不在任何分卷规则区间内'],
    ]);
  });

  it('H1 章号不一致、未绑定作品链接、缺认证 → 阻塞或报错', async () => {
    const s = setup({ 'Ch01-一.md': CH(2, '一', '甲') });
    const plan = await planPublish(s.db, s.n.id, s.platformId, fakePublisher().c, NOW);
    expect(plan.rows[0].blocked).toBe('H1 章号与文件序号不一致');
    s.db.update(platform).set({ cookie: null }).where(eq(platform.id, s.platformId)).run();
    await expect(planPublish(s.db, s.n.id, s.platformId, fakePublisher().c, NOW)).rejects.toBeInstanceOf(PlatformAuthError);
    s.db.update(novelPlatform).set({ bookId: null }).run();
    await expect(planPublish(s.db, s.n.id, s.platformId, fakePublisher().c, NOW)).rejects.toThrow('作品链接');
  });
});

describe('runPublish', () => {
  it('覆盖复用 item_id，新发先建草稿；正文转 HTML；落库为已发布并记录额度', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲乙\n\n**丙**'), 'Ch02-二.md': CH(2, '二', '丁戊己') });
    linkPub(s.db, s.platformId, 1, 'stale', 'i1');
    const f = fakePublisher({ remote: [{ itemId: 'i1', title: '第1章 旧', wordNumber: 1, displayStatus: 1 }] });
    const res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 1), chId(s.db, 2)], f.c, opts);
    expect(res.map((r) => [r.seq, r.mode, r.outcome])).toEqual([[1, 'overwrite', 'published'], [2, 'new', 'published']]);
    expect(f.log).toEqual(['publish:i1', 'newDraft', 'publish:draft1']);
    expect(f.published[0]).toMatchObject({ title: '第1章 一', html: '<p>甲乙</p><p>丙</p>', volumeId: 'v1', volumeName: '第一卷：崩塌', useAi: 2 });
    expect(pubOf(s.db, s.platformId, 1)).toMatchObject({ status: 'published', platformItemId: 'i1', quotaWords: 0, submittedAt: NOW });
    expect(pubOf(s.db, s.platformId, 2)).toMatchObject({ status: 'published', platformItemId: 'draft1', quotaWords: 3, platformWordCount: 3 });
    expect(usedToday(s.db, s.platformId, NOW)).toBe(3);
    expect(usedToday(s.db, s.platformId, startOfDay(NOW) + 86_400_000)).toBe(0);
  });

  it('只发选中的章节；未选或都不可发 → 报错；阻塞章节跳过不提交', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲'), 'Ch02-二.md': CH(2, '二', '乙') });
    linkPub(s.db, s.platformId, 1, 'stale', 'i1');
    const f = fakePublisher({ remote: [{ itemId: 'i1', title: '第1章 一', wordNumber: 9, displayStatus: 5 }] });
    await expect(runPublish(s.db, s.n.id, s.platformId, [], f.c, opts)).rejects.toThrow('请选择');
    const res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 1)], f.c, opts);
    expect(res).toMatchObject([{ seq: 1, outcome: 'skipped', message: '审核中，暂不支持修改' }]);
    expect(f.log).toEqual([]);
  });

  it('新发会超出每日上限 → 顺延并停止（覆盖不占额度）', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲'.repeat(800)), 'Ch02-二.md': CH(2, '二', '乙'.repeat(800)), 'Ch03-三.md': CH(3, '三', '丙') });
    setPublishSettings(s.db, s.platformId, { useAi: 1, dailyWordLimit: 1000 });
    linkPub(s.db, s.platformId, 3, 'stale', 'i3');
    const f = fakePublisher({ remote: [{ itemId: 'i3', title: '第3章 三', wordNumber: 9, displayStatus: 1 }] });
    const res = await runPublish(s.db, s.n.id, s.platformId, [1, 2, 3].map((n) => chId(s.db, n)), f.c, opts);
    expect(res.map((r) => r.outcome)).toEqual(['published', 'deferred', 'deferred']);
    expect(res[1].message).toContain('已用 800 / 1000');
    expect(f.published[0].useAi).toBe(1);
  });

  it('平台返回 -1019 → 本章与后续顺延；其他接口错误 → 本章失败、后续停止', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲'), 'Ch02-二.md': CH(2, '二', '乙') });
    const quota = fakePublisher({ publishError: () => new PlatformQuotaError() });
    let res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 1), chId(s.db, 2)], quota.c, opts);
    expect(res.map((r) => r.outcome)).toEqual(['deferred', 'deferred']);
    const broken = fakePublisher({ publishError: (i) => (i.title.startsWith('第1章') ? new PlatformApiError(-9) : null) });
    res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 1), chId(s.db, 2)], broken.c, opts);
    expect(res.map((r) => r.outcome)).toEqual(['failed', 'skipped']);
    expect(pubOf(s.db, s.platformId, 1)?.status ?? 'unpublished').toBe('unpublished');
  });

  it('缺卷时先建卷；-4054（已有空卷）→ 跳过该章', async () => {
    const s = setup({ 'Ch51-五十一.md': CH(51, '五十一', '乙') });
    setVolumeRules(s.db, s.n.id, s.platformId, '1-50 第一卷：崩塌\n51-150 第二卷：暗战');
    const ok = fakePublisher();
    let res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 51)], ok.c, opts);
    expect(res[0].outcome).toBe('published');
    expect(ok.log).toEqual(['addVolume:第二卷：暗战', 'newDraft', 'publish:draft1']);
    expect(ok.published[0]).toMatchObject({ volumeId: 'v2', volumeName: '第二卷：暗战' });

    s.db.delete(publication).run();
    const blocked = fakePublisher({ addVolumeError: new PlatformApiError(-4054) });
    res = await runPublish(s.db, s.n.id, s.platformId, [chId(s.db, 51)], blocked.c, opts);
    expect(res[0]).toMatchObject({ outcome: 'skipped' });
    expect(res[0].message).toContain('两个空卷');
  });

  it('每章之间按间隔等待', async () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲'), 'Ch02-二.md': CH(2, '二', '乙'), 'Ch03-三.md': CH(3, '三', '丙') });
    const waits: number[] = [];
    await runPublish(s.db, s.n.id, s.platformId, [1, 2, 3].map((n) => chId(s.db, n)), fakePublisher().c, { now: () => NOW, sleep: async (ms) => { waits.push(ms); }, intervalMs: 3000 });
    expect(waits).toEqual([3000, 3000]);
  });
});

describe('设置校验', () => {
  it('setPublishSettings / setVolumeRules 拒绝非法输入', () => {
    const s = setup({ 'Ch01-一.md': CH(1, '一', '甲') });
    expect(() => setPublishSettings(s.db, s.platformId, { useAi: 0, dailyWordLimit: 20000 })).toThrow('AI 标记');
    expect(() => setPublishSettings(s.db, s.platformId, { useAi: 2, dailyWordLimit: 10 })).toThrow('每日字数上限');
    expect(() => setVolumeRules(s.db, s.n.id, s.platformId, '1-50 甲\n40-60 乙')).toThrow('重叠');
    expect(() => setVolumeRules(s.db, s.n.id, s.platformId, '第一卷')).toThrow('第 1 行格式错误');
    setVolumeRules(s.db, s.n.id, s.platformId, '1-50 第一卷');
    expect(s.db.select().from(novelPlatform).get()!.volumes).toBe('[{"from":1,"to":50,"name":"第一卷"}]');
    setVolumeRules(s.db, s.n.id, s.platformId, '  ');
    expect(s.db.select().from(novelPlatform).get()!.volumes).toBeNull();
  });
});
