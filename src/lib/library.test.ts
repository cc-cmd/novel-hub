// src/lib/library.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { novel } from '@/db/schema';
import { makeDb, makeTmpDir } from '@/test/helpers';
import { UserError } from '@/lib/result';
import { addRoot, chapterDirOf, listRoots, removeRoot, scanLibrary, setArchived, setChapterSubdir } from './library';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function lib(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('addRoot', () => {
  it('AC1.5 不存在的路径被拒绝且不写库', () => {
    const db = makeDb();
    expect(() => addRoot(db, '/no/such/xyz')).toThrow(UserError);
    expect(listRoots(db)).toHaveLength(0);
  });
  it('AC1.6 规范化后重复被拒绝', () => {
    const db = makeDb();
    const d = lib({});
    addRoot(db, d);
    expect(() => addRoot(db, d + '/')).toThrow('该目录已添加，无需重复添加');
  });
});

describe('scanLibrary', () => {
  it('AC1.1/1.2/1.7 发现小说、新增、幂等', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '', 'B/x': '', 'C/x': '' });
    addRoot(db, d);
    expect(scanLibrary(db).newNovels).toBe(3);
    expect(db.select().from(novel).all().map((n) => n.name).sort()).toEqual(['A', 'B', 'C']);
    fs.mkdirSync(path.join(d, 'D'));
    expect(scanLibrary(db).newNovels).toBe(1);
    expect(scanLibrary(db).newNovels).toBe(0);
    expect(db.select().from(novel).all()).toHaveLength(4);
  });
  it('已有小说保留 archived 设置', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    setArchived(db, n.id, true);
    scanLibrary(db);
    expect(db.select().from(novel).get()!.archived).toBe(true);
  });
  it('AC1.4 目录消失 → 记录保留并标记 dirMissing', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    fs.rmSync(path.join(d, 'A'), { recursive: true });
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(n.dirMissing).toBe(true);
    // 目录恢复后清除标记
    fs.mkdirSync(path.join(d, 'A'));
    scanLibrary(db);
    expect(db.select().from(novel).get()!.dirMissing).toBe(false);
  });
  it('根目录不可访问 → 其他根目录照常扫描，已有记录不动', () => {
    const db = makeDb();
    const a = lib({ 'A/x': '' });
    const b = lib({ 'B/x': '' });
    addRoot(db, a);
    addRoot(db, b);
    scanLibrary(db);
    fs.rmSync(a, { recursive: true });
    fs.mkdirSync(path.join(b, 'C'));
    const s = scanLibrary(db);
    expect(s.roots.find((r) => r.path === a)!.state).toBe('missing');
    expect(s.newNovels).toBe(1);
    expect(db.select().from(novel).all()).toHaveLength(3);
  });
});

describe('removeRoot', () => {
  it('F1.3 移除后小说保留并标记 rootRemoved', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    const { id } = addRoot(db, d);
    scanLibrary(db);
    removeRoot(db, id);
    const n = db.select().from(novel).get()!;
    expect(n.rootRemoved).toBe(true);
    expect(listRoots(db)).toHaveLength(0);
    expect(fs.existsSync(path.join(d, 'A'))).toBe(true);
  });
});

describe('setChapterSubdir', () => {
  it('规范化并保存；空串表示小说目录本身', () => {
    const db = makeDb();
    const d = lib({ 'A/改稿/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(setChapterSubdir(db, n.id, ' 改稿/ ').chapterSubdir).toBe('改稿');
    expect(chapterDirOf(db.select().from(novel).get()!)).toBe(path.join(d, 'A', '改稿'));
    expect(setChapterSubdir(db, n.id, '').chapterSubdir).toBe('');
  });
  it('拒绝绝对路径、越界、不存在的目录', () => {
    const db = makeDb();
    const d = lib({ 'A/x': '' });
    addRoot(db, d);
    scanLibrary(db);
    const n = db.select().from(novel).get()!;
    expect(() => setChapterSubdir(db, n.id, '/etc')).toThrow(UserError);
    expect(() => setChapterSubdir(db, n.id, '../B')).toThrow(UserError);
    expect(() => setChapterSubdir(db, n.id, '不存在')).toThrow('目录不存在');
  });
});
