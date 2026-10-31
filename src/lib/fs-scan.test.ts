// src/lib/fs-scan.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '@/test/helpers';
import { checkDir, classifyChapterEntries, listSubdirs, normalizeRootPath, parseChapterFilename, validateDirPath } from './fs-scan';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const tmp = (files?: Record<string, string>) => {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('normalizeRootPath', () => {
  it('去末尾斜杠、解析 ..、trim', () => {
    expect(normalizeRootPath(' /a/b/ ')).toBe('/a/b');
    expect(normalizeRootPath('/a/b/../c')).toBe('/a/c');
  });
});

describe('validateDirPath', () => {
  it('空输入', () => {
    expect(validateDirPath('  ')).toEqual({ ok: false, error: '请输入目录的绝对路径' });
  });
  it('相对路径', () => {
    expect(validateDirPath('a/b')).toEqual({ ok: false, error: '路径不存在：请使用绝对路径' });
  });
  it('不存在', () => {
    expect(validateDirPath('/no/such/dir-xyz')).toEqual({ ok: false, error: '路径不存在：/no/such/dir-xyz' });
  });
  it('指向文件', () => {
    const d = tmp({ 'f.txt': 'x' });
    const f = path.join(d, 'f.txt');
    expect(validateDirPath(f)).toEqual({ ok: false, error: `不是目录：${f}` });
  });
  it('合法目录返回规范化路径', () => {
    const d = tmp();
    expect(validateDirPath(d + '/')).toEqual({ ok: true, path: d });
  });
  it('无读取权限', () => {
    const d = tmp({ 'sub/x.md': '' });
    const sub = path.join(d, 'sub');
    fs.chmodSync(sub, 0o000);
    try {
      // root 用户不受权限限制，跳过断言
      if (process.getuid?.() === 0) return;
      expect(validateDirPath(sub)).toEqual({ ok: false, error: `无读取权限：${sub}` });
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });
});

describe('checkDir / listSubdirs', () => {
  it('checkDir 区分 ok / missing', () => {
    const d = tmp();
    expect(checkDir(d)).toBe('ok');
    expect(checkDir(path.join(d, 'nope'))).toBe('missing');
  });
  it('listSubdirs 忽略隐藏项与文件，按名称排序', () => {
    const d = tmp({ 'b/x.md': '', 'a/x.md': '', '.git/HEAD': '', 'file.txt': '' });
    expect(listSubdirs(d)).toEqual([path.join(d, 'a'), path.join(d, 'b')]);
  });
});

describe('parseChapterFilename', () => {
  it.each([
    ['Ch01-重生之初.md', 1, '重生之初'],
    ['ch12-第十二回 夜行.md', 12, '第十二回 夜行'],
    ['Ch003-标题.md', 3, '标题'],
    ['CH7-x.MD', 7, 'x'],
    ['Ch01- 空格标题 .md', 1, '空格标题'],
  ])('%s', (name, seq, title) => {
    expect(parseChapterFilename(name)).toEqual({ seq, title });
  });
  it.each(['Ch01.md', '第一章.md', 'notes.md', 'Ch01-标题.txt', 'Ch-标题.md', 'Ch01－标题.md', 'Ch01-.md', 'Ch01-  .md'])(
    '未识别：%s',
    (name) => expect(parseChapterFilename(name)).toBeNull(),
  );
});

describe('classifyChapterEntries', () => {
  const f = (name: string) => ({ name, isFile: true });
  it('AC2.1 识别 + 未识别提示；非 md 与目录、隐藏文件静默忽略', () => {
    const r = classifyChapterEntries([
      f('Ch01-开端.md'), f('Ch02-发展.md'), f('notes.md'), f('cover.png'), f('._Ch03-x.md'),
      { name: '_v1', isFile: false },
    ]);
    expect(r.chapters.map((c) => c.seq)).toEqual([1, 2]);
    expect(r.issues).toEqual([{ fileName: 'notes.md', kind: 'unrecognized', reason: '文件名不符合 ChNN-标题.md，未入库' }]);
  });
  it('AC2.8 重复序号：字典序第一个生效，其余列冲突', () => {
    const r = classifyChapterEntries([f('Ch1-b.md'), f('Ch01-a.md')]);
    expect(r.chapters).toEqual([{ fileName: 'Ch01-a.md', seq: 1, title: 'a' }]);
    expect(r.issues).toEqual([{ fileName: 'Ch1-b.md', kind: 'duplicate', reason: '序号重复（与 Ch01-a.md 冲突），未入库' }]);
  });
  it('结果按 seq 升序', () => {
    const r = classifyChapterEntries([f('Ch10-j.md'), f('Ch2-b.md')]);
    expect(r.chapters.map((c) => c.seq)).toEqual([2, 10]);
  });
});
