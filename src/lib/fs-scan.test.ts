// src/lib/fs-scan.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '@/test/helpers';
import { checkDir, listSubdirs, normalizeRootPath, validateDirPath } from './fs-scan';

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
