import { describe, expect, it } from 'vitest';
import { chapter, novelPlatform, platform, publication } from '@/db/schema';
import { configureFanqie, insertNovel, makeDb } from '@/test/helpers';
import { UserError } from './result';
import { addPlatform, bindPlatform, deletePlatform, isSyncConfigured, listBindings, listPlatforms, renamePlatform, unbindPlatform } from './platforms';

describe('平台管理', () => {
  it('AC3.1 预置平台存在且不可删/改名', () => {
    const db = makeDb();
    const [fanqie] = listPlatforms(db);
    expect(listPlatforms(db).map((p) => [p.name, p.builtin])).toEqual([['番茄', true], ['起点', true]]);
    expect(() => deletePlatform(db, fanqie.id)).toThrow('预置平台不可删除');
    expect(() => renamePlatform(db, fanqie.id, '别名')).toThrow('预置平台不可改名');
  });

  it('AC3.2 新增、去空白、重名（忽略大小写）被拒', () => {
    const db = makeDb();
    expect(addPlatform(db, '  晋江 ').name).toBe('晋江');
    expect(() => addPlatform(db, '晋江')).toThrow('平台已存在');
    addPlatform(db, 'Wattpad');
    expect(() => addPlatform(db, 'wattpad ')).toThrow('平台已存在');
  });

  it('长度校验', () => {
    const db = makeDb();
    expect(() => addPlatform(db, '   ')).toThrow('平台名称长度应为 1–20 个字');
    expect(() => addPlatform(db, 'a'.repeat(21))).toThrow('平台名称长度应为 1–20 个字');
  });

  it('自定义平台可改名（不与自己冲突）', () => {
    const db = makeDb();
    const p = addPlatform(db, '晋江');
    expect(renamePlatform(db, p.id, '晋江文学城').name).toBe('晋江文学城');
    expect(renamePlatform(db, p.id, '晋江文学城').name).toBe('晋江文学城');
    expect(() => renamePlatform(db, p.id, '番茄')).toThrow('平台已存在');
  });

  it('删除：被引用时拒绝并说明数量；无引用可删', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const p = addPlatform(db, '晋江');
    bindPlatform(db, n.id, p.id);
    const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 't', filePath: '/x/A/Ch01-t.md' }).returning().get();
    db.insert(publication).values({ chapterId: ch.id, platformId: p.id, status: 'published' }).run();
    expect(() => deletePlatform(db, p.id)).toThrow('无法删除：晋江被 1 本小说绑定，并有 1 条发布记录。请保留该平台。');
    const q = addPlatform(db, '七猫');
    deletePlatform(db, q.id);
    expect(listPlatforms(db).map((x) => x.name)).not.toContain('七猫');
  });
});

describe('绑定', () => {
  it('book_url 校验', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    expect(() => bindPlatform(db, n.id, fanqie.id, 'ftp://x')).toThrow(UserError);
    bindPlatform(db, n.id, fanqie.id, ' https://fanqienovel.com/main/writer/chapter-manage/1 ');
    expect(listBindings(db, n.id).find((b) => b.platform.id === fanqie.id)).toMatchObject({ bound: true, bookUrl: 'https://fanqienovel.com/main/writer/chapter-manage/1' });
    bindPlatform(db, n.id, fanqie.id, ''); // 再次绑定 = 更新链接
    expect(listBindings(db, n.id)[0].bookUrl).toBeNull();
  });

  it('AC3.6 解绑保留发布记录，重新绑定后仍在', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    bindPlatform(db, n.id, fanqie.id);
    const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 't', filePath: '/x/A/Ch01-t.md' }).returning().get();
    db.insert(publication).values({ chapterId: ch.id, platformId: fanqie.id, status: 'published', publishedHash: 'h' }).run();
    expect(listBindings(db, n.id)[0].publicationCount).toBe(1);
    unbindPlatform(db, n.id, fanqie.id);
    expect(listBindings(db, n.id)[0]).toMatchObject({ bound: false, publicationCount: 1 });
    expect(db.select().from(publication).all()).toHaveLength(1);
    bindPlatform(db, n.id, fanqie.id);
    expect(db.select().from(publication).get()).toMatchObject({ status: 'published', publishedHash: 'h' });
  });
});

it('platform 表由迁移预置，且 seed 幂等', () => {
  const db = makeDb();
  expect(db.select().from(platform).all()).toHaveLength(2);
});

describe('REQ-07 已配置判定与绑定', () => {
  it('isSyncConfigured：番茄 + cookie + csrf + bookId 缺一不可', () => {
    const ok = { name: '番茄', cookie: 'c', csrfToken: 't', bookId: '1' };
    expect(isSyncConfigured(ok)).toBe(true);
    expect(isSyncConfigured({ ...ok, name: '起点' })).toBe(false);
    expect(isSyncConfigured({ ...ok, cookie: null })).toBe(false);
    expect(isSyncConfigured({ ...ok, csrfToken: '' })).toBe(false);
    expect(isSyncConfigured({ ...ok, bookId: null })).toBe(false);
  });
  it('bindPlatform 番茄：解析 bookId；换链接时清空同步记录；listBindings 反映 configured', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const { platformId } = configureFanqie(db, n.id);
    db.update(novelPlatform).set({ lastSyncedAt: 5, lastSyncError: 'x' }).run();
    expect(listBindings(db, n.id).find((b) => b.platform.id === platformId)).toMatchObject({
      bound: true, syncSupported: true, hasAuth: true, configured: true, lastSyncedAt: 5, lastSyncError: 'x',
    });
    bindPlatform(db, n.id, platformId, 'https://fanqienovel.com/main/writer/chapter-manage/42');
    expect(db.select().from(novelPlatform).get()).toMatchObject({ bookId: '42', lastSyncedAt: null, lastSyncError: null });
  });
  it('bindPlatform 番茄：重复保存同一作品不清空同步记录', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const { platformId } = configureFanqie(db, n.id);
    db.update(novelPlatform).set({ lastSyncedAt: 5, lastSyncError: 'x' }).run();
    bindPlatform(db, n.id, platformId, 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864');
    expect(db.select().from(novelPlatform).get()).toMatchObject({ lastSyncedAt: 5, lastSyncError: 'x' });
  });
  it('bindPlatform 番茄：不填链接 → bookId 为空（未配置）', () => {
    const db = makeDb();
    const n = insertNovel(db, '/x/A');
    const [fanqie] = listPlatforms(db);
    bindPlatform(db, n.id, fanqie.id, '');
    expect(db.select().from(novelPlatform).get()).toMatchObject({ bookUrl: null, bookId: null });
  });
});

describe('bindPlatform 换绑作品', () => {
  const urlOf = (id: string) => `https://fanqienovel.com/main/writer/chapter-manage/${id}&x?type=1`;

  function seed() {
    const db = makeDb();
    const [fanqie] = listPlatforms(db);
    const n = insertNovel(db, '/x/A');
    bindPlatform(db, n.id, fanqie.id, urlOf('111'));
    const c = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 'T', filePath: '/x/1.md', wordCount: 1, contentHash: 'H' }).returning().get();
    db.insert(publication).values({
      chapterId: c.id, platformId: fanqie.id, status: 'published', publishedAt: 5, platformUrl: 'http://u',
      publishedHash: 'H', platformItemId: 'i1', platformWordCount: 9, syncedAt: 7,
    }).run();
    const pub = () => db.select().from(publication).get()!;
    return { db, fanqie, n, pub };
  }

  it('换绑到另一本书：旧书同步状态重置为未发布，记录保留', () => {
    const s = seed();
    bindPlatform(s.db, s.n.id, s.fanqie.id, urlOf('222'));
    expect(s.pub()).toMatchObject({
      status: 'unpublished', platformItemId: null, platformWordCount: null, syncedAt: null,
      publishedAt: 5, platformUrl: 'http://u', publishedHash: 'H',
    });
  });

  it('重复保存同一链接：记录不动', () => {
    const s = seed();
    const before = s.pub();
    bindPlatform(s.db, s.n.id, s.fanqie.id, urlOf('111'));
    expect(s.pub()).toEqual(before);
  });
});
