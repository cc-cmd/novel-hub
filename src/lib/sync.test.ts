// src/lib/sync.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapter, publication, scanIssue } from '@/db/schema';
import { makeDb, insertNovel, makeTmpDir } from '@/test/helpers';
import { eq } from 'drizzle-orm';
import { contentHash } from './hash';
import { scanAndSync, syncChapter, syncNovel } from './sync';
import { addRoot } from './library';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(files: Record<string, string>, subdir = '') {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir, { chapterSubdir: subdir });
  return { db, n, dir: t.dir };
}
let tick = 0;
/** 写文件并推进 mtime，避免同毫秒写入导致短路。 */
function put(file: string, content: string | Buffer) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + ++tick * 5000);
  fs.utimesSync(file, t, t);
}
const chapters = (db: ReturnType<typeof makeDb>) => db.select().from(chapter).orderBy(chapter.seq).all();

const CH1 = '# 第1章 开端\n\n你好，世界。\n';
const CH2 = '# 第2章 发展\n\n第二章正文。\n';

describe('syncNovel 基本路径', () => {
  it('AC2.1 入库 2 章，notes.md 进入未识别提示', () => {
    const { db, n } = setup({ 'Ch01-开端.md': CH1, 'Ch02-发展.md': CH2, 'notes.md': 'x' });
    const r = syncNovel(db, n.id);
    expect(r).toMatchObject({ added: 2, issues: 1 });
    const rows = chapters(db);
    expect(rows.map((c) => [c.seq, c.title])).toEqual([[1, '开端'], [2, '发展']]);
    expect(rows[0].wordCount).toBe(6); // "你好，世界。" 共 6 个字符
    expect(rows[0].contentHash).toBe(contentHash(CH1, 1, '开端'));
    expect(db.select().from(scanIssue).all()).toMatchObject([{ fileName: 'notes.md', kind: 'unrecognized' }]);
  });

  it('章节目录：只读 chapter_subdir，且不递归', () => {
    const { db, n } = setup({ 'Ch09-根目录.md': CH1, '改稿/Ch01-开端.md': CH1, '改稿/_v1/Ch02-旧.md': CH2 }, '改稿');
    syncNovel(db, n.id);
    expect(chapters(db).map((c) => c.seq)).toEqual([1]);
  });

  it('AC2.2 外部修改后字数与 hash 更新', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0];
    put(path.join(dir, 'Ch01-开端.md'), CH1 + '新增一段话。\n');
    expect(syncNovel(db, n.id)).toMatchObject({ updated: 1 });
    const after = chapters(db)[0];
    expect(after.id).toBe(before.id);
    expect(after.wordCount).toBeGreaterThan(before.wordCount);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('AC2.3 仅 LF→CRLF，hash 不变', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0].contentHash;
    put(path.join(dir, 'Ch01-开端.md'), CH1.replace(/\n/g, '\r\n'));
    syncNovel(db, n.id);
    expect(chapters(db)[0].contentHash).toBe(before);
  });

  it('F2.6 H1 标题变化视为同一章并更新标题与 hash', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const before = chapters(db)[0];
    put(path.join(dir, 'Ch01-开端.md'), CH1.replace('开端', '序幕'));
    syncNovel(db, n.id);
    const after = chapters(db)[0];
    expect([after.id, after.title]).toEqual([before.id, '序幕']);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('文件改名（同 seq）→ 同一章，更新 file_path', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    const id = chapters(db)[0].id;
    fs.renameSync(path.join(dir, 'Ch01-开端.md'), path.join(dir, 'Ch1-新名.md'));
    syncNovel(db, n.id);
    expect(chapters(db)).toHaveLength(1);
    expect(chapters(db)[0]).toMatchObject({ id, filePath: path.join(dir, 'Ch1-新名.md') });
  });
});

describe('缺失与恢复（发布记录受保护）', () => {
  it('AC2.4 / AC2.5', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1, 'Ch02-发展.md': CH2 });
    syncNovel(db, n.id);
    const ch2 = chapters(db)[1];
    db.insert(publication).values({ chapterId: ch2.id, platformId: 1, status: 'published', publishedHash: ch2.contentHash }).run();
    fs.rmSync(path.join(dir, 'Ch02-发展.md'));
    expect(syncNovel(db, n.id)).toMatchObject({ markedMissing: 1 });
    expect(chapters(db)[1].fileMissing).toBe(true);
    expect(db.select().from(publication).where(eq(publication.chapterId, ch2.id)).all()).toHaveLength(1);
    put(path.join(dir, 'Ch02-发展.md'), CH2);
    expect(syncNovel(db, n.id)).toMatchObject({ restored: 1 });
    expect(chapters(db)[1].fileMissing).toBe(false);
    expect(db.select().from(publication).all()).toHaveLength(1);
  });

  it('章节目录不可读 → 全部章节标记丢失并返回 error', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    fs.rmSync(dir, { recursive: true });
    const r = syncNovel(db, n.id);
    expect(r.error).toContain('章节目录不可读');
    expect(chapters(db)[0].fileMissing).toBe(true);
  });
});

describe('冲突、警告与编码', () => {
  it('AC2.8 重复序号只入库一个', () => {
    const { db, n } = setup({ 'Ch01-a.md': CH1, 'Ch1-b.md': CH1 });
    syncNovel(db, n.id);
    expect(chapters(db)).toHaveLength(1);
    expect(db.select().from(scanIssue).all()).toMatchObject([{ fileName: 'Ch1-b.md', kind: 'duplicate' }]);
  });

  it('H1 章号与文件名不符 / 缺少 H1 → 入库并带 warning', () => {
    const { db, n } = setup({ 'Ch01-甲.md': '# 第9章 错号\n正文', 'Ch02-乙.md': '正文无标题' });
    syncNovel(db, n.id);
    const [a, b] = chapters(db);
    expect([a.seq, a.warning, a.title]).toEqual([1, 'h1_mismatch', '错号']);
    expect([b.seq, b.warning, b.title]).toEqual([2, 'no_h1', '乙']);
  });

  it('非 UTF-8：新章 hash 为 NULL 且 warning=encoding；旧章保留原字数/hash', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    put(path.join(dir, 'Ch02-坏.md'), Buffer.from([0xff, 0xfe, 0x41]));
    syncNovel(db, n.id);
    const [c1, c2] = chapters(db);
    expect([c2.warning, c2.contentHash, c2.wordCount]).toEqual(['encoding', null, 0]);
    put(path.join(dir, 'Ch01-开端.md'), Buffer.from([0xff, 0xfe, 0x41]));
    syncNovel(db, n.id);
    const c1b = chapters(db)[0];
    expect([c1b.warning, c1b.contentHash, c1b.wordCount]).toEqual(['encoding', c1.contentHash, c1.wordCount]);
  });

  it('空文件合法：字数 0', () => {
    const { db, n } = setup({ 'Ch01-空.md': '' });
    syncNovel(db, n.id);
    expect(chapters(db)[0]).toMatchObject({ wordCount: 0, contentHash: contentHash('', 1, '空') });
  });
});

describe('幂等与单章同步', () => {
  it('AC2.9 磁盘无变化时第二次同步不产生任何变更', () => {
    const { db, n } = setup({ 'Ch01-开端.md': CH1, 'notes.md': 'x' });
    syncNovel(db, n.id);
    const snap = JSON.stringify(chapters(db));
    expect(syncNovel(db, n.id)).toMatchObject({ added: 0, updated: 0, restored: 0, markedMissing: 0 });
    expect(JSON.stringify(chapters(db))).toBe(snap);
    expect(syncNovel(db, n.id, { force: true })).toMatchObject({ added: 0, updated: 0 });
    expect(JSON.stringify(chapters(db))).toBe(snap);
  });

  it('syncChapter 强制重读：mtime 未变但内容变了也能发现', () => {
    const { db, n, dir } = setup({});
    const f = path.join(dir, 'Ch01-开端.md');
    put(f, CH1); // put 使用整毫秒 mtime，便于下面精确还原
    syncNovel(db, n.id);
    const t = new Date(fs.statSync(f).mtimeMs);
    fs.writeFileSync(f, CH1.replace('你好', '您好')); // 等长改动
    fs.utimesSync(f, t, t); // 还原 mtime，使 size 与 mtime 都不变
    const id = chapters(db)[0].id;
    expect(syncNovel(db, n.id).updated).toBe(0); // 短路，看不到
    expect(syncChapter(db, id)).toEqual({ changed: true });
  });

  it('syncChapter：文件消失 → 标记丢失', () => {
    const { db, n, dir } = setup({ 'Ch01-开端.md': CH1 });
    syncNovel(db, n.id);
    fs.rmSync(path.join(dir, 'Ch01-开端.md'));
    expect(syncChapter(db, chapters(db)[0].id)).toEqual({ changed: true });
    expect(chapters(db)[0].fileMissing).toBe(true);
  });
});

describe('scanAndSync', () => {
  it('发现新书并同步章节；归档的书不同步', () => {
    const t = makeTmpDir({ 'A/Ch01-开端.md': CH1, 'B/Ch01-开端.md': CH1 });
    cleanups.push(t.cleanup);
    const db = makeDb();
    addRoot(db, t.dir);
    const s1 = scanAndSync(db);
    expect([s1.newNovels, s1.chapters.added]).toEqual([2, 2]);
    // 归档 B 后新增章节不会被同步
    db.$client.prepare("update novel set archived = 1 where name = 'B'").run();
    fs.writeFileSync(path.join(t.dir, 'B', 'Ch02-新.md'), CH2);
    fs.writeFileSync(path.join(t.dir, 'A', 'Ch02-新.md'), CH2);
    const s2 = scanAndSync(db);
    expect(s2.chapters.added).toBe(1);
  });
});

describe('scanAndSync force', () => {
  it('保留 mtime 且大小不变的改动：普通扫描发现不了，force 可以', () => {
    const { db, n, dir } = setup({ 'Ch01-甲.md': '# 第1章 甲\n\naaaa\n' });
    syncNovel(db, n.id);
    const file = path.join(dir, 'Ch01-甲.md');
    const st = fs.statSync(file);
    fs.writeFileSync(file, '# 第1章 甲\n\nbbbb\n');
    fs.utimesSync(file, st.atimeMs / 1000, st.mtimeMs / 1000); // 模拟 rsync -t / cp -p；Date 会丢亚毫秒
    const before = db.select().from(chapter).get()!.contentHash;
    scanAndSync(db);
    expect(db.select().from(chapter).get()!.contentHash).toBe(before);
    scanAndSync(db, { force: true });
    expect(db.select().from(chapter).get()!.contentHash).not.toBe(before);
  });
});
