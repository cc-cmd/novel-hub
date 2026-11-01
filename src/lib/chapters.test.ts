import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapter } from '@/db/schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { CONFLICT_MESSAGE, listChapters, listProblems, loadChapterForEdit, saveChapter } from './chapters';
import { UserError } from './result';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(files: Record<string, string>) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  return { db, dir: t.dir, n, ch: () => listChapters(db, n.id) };
}

describe('listProblems', () => {
  it('合并未识别文件与带警告的章节', () => {
    const { db, n } = setup({ 'Ch01-甲.md': '# 第9章 错号\nx', 'Ch02-乙.md': '无标题', 'notes.md': 'x' });
    const p = listProblems(db, n.id);
    expect(p).toEqual([
      { fileName: 'notes.md', reason: '文件名不符合 ChNN-标题.md，未入库', stored: false },
      { fileName: 'Ch01-甲.md', reason: 'H1 章号与文件名不符，已入库', stored: true },
      { fileName: 'Ch02-乙.md', reason: '缺少 H1，已入库，标题取自文件名', stored: true },
    ]);
  });
});

describe('loadChapterForEdit / saveChapter', () => {
  it('AC2.6 保存写回文件并更新字数/hash', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    expect(e.content).toBe('# 第1章 开端\n\n原文。\n');
    const r = saveChapter(db, e.chapter.id, '# 第1章 开端\n\n改后的正文内容。\n', { baseHash: e.baseHash! });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toBe('# 第1章 开端\n\n改后的正文内容。\n');
    expect(r.wordCount).toBe(8); // "改后的正文内容。"
    expect(ch()[0].wordCount).toBe(8);
    expect(ch()[0].contentHash).not.toBe(e.chapter.contentHash);
  });

  it('保持 CRLF 风格', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\r\n\r\n原文。\r\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    expect(e.content).not.toContain('\r');
    saveChapter(db, e.chapter.id, '# 第1章 开端\n\n新。\n', { baseHash: e.baseHash! });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toBe('# 第1章 开端\r\n\r\n新。\r\n');
  });

  it('AC2.7 只读文件：报错、数据库不变', () => {
    if (process.getuid?.() === 0) return;
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const before = ch()[0];
    const e = loadChapterForEdit(db, before.id);
    fs.chmodSync(path.join(dir, 'Ch01-开端.md'), 0o444);
    expect(() => saveChapter(db, before.id, '改', { baseHash: e.baseHash! })).toThrow('保存失败，文件未被修改');
    expect(ch()[0]).toEqual(before);
  });

  it('AC2.10 外部修改 → 冲突；overwrite=true 可覆盖', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\n原文。\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    fs.writeFileSync(path.join(dir, 'Ch01-开端.md'), '# 第1章 开端\n\n别处改了。\n');
    expect(() => saveChapter(db, e.chapter.id, '# 第1章 开端\n\n我的。\n', { baseHash: e.baseHash! })).toThrow(CONFLICT_MESSAGE);
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toContain('别处改了');
    saveChapter(db, e.chapter.id, '# 第1章 开端\n\n我的。\n', { baseHash: e.baseHash!, overwrite: true });
    expect(fs.readFileSync(path.join(dir, 'Ch01-开端.md'), 'utf8')).toContain('我的');
  });

  it('F2.20 文件丢失：不可编辑', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\nx\n' });
    fs.rmSync(path.join(dir, 'Ch01-开端.md'));
    syncNovel(db, ch()[0].novelId);
    const e = loadChapterForEdit(db, ch()[0].id);
    expect([e.content, e.baseHash]).toEqual(['', null]);
    expect(() => saveChapter(db, e.chapter.id, 'x', { baseHash: 'x' })).toThrow('文件丢失，无法编辑');
  });

  it('F2.15 磁盘文件在保存前被删除/不可读：抛 UserError 而非裸异常', () => {
    const { db, dir, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\nx\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    fs.rmSync(path.join(dir, 'Ch01-开端.md')); // 库里还没标记 file_missing
    expect(() => saveChapter(db, e.chapter.id, 'x', { baseHash: e.baseHash! })).toThrow(UserError);
    expect(() => saveChapter(db, e.chapter.id, 'x', { baseHash: e.baseHash! })).toThrow('无法读取文件');
  });

  it('保存后返回的 baseHash 可用于连续保存', () => {
    const { db, ch } = setup({ 'Ch01-开端.md': '# 第1章 开端\n\na\n' });
    const e = loadChapterForEdit(db, ch()[0].id);
    const r1 = saveChapter(db, e.chapter.id, '# 第1章 开端\n\nb\n', { baseHash: e.baseHash! });
    expect(() => saveChapter(db, e.chapter.id, '# 第1章 开端\n\nc\n', { baseHash: r1.baseHash })).not.toThrow();
  });
});
