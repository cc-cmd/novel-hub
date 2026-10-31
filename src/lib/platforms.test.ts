import { describe, expect, it } from 'vitest';
import { chapter, platform, publication } from '@/db/schema';
import { insertNovel, makeDb } from '@/test/helpers';
import { UserError } from './result';
import { addPlatform, bindPlatform, deletePlatform, listBindings, listPlatforms, renamePlatform, unbindPlatform } from './platforms';

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
    bindPlatform(db, n.id, fanqie.id, ' https://fanqie.example/book/1 ');
    expect(listBindings(db, n.id).find((b) => b.platform.id === fanqie.id)).toMatchObject({ bound: true, bookUrl: 'https://fanqie.example/book/1' });
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
