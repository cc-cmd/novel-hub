import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTmpDir } from '@/test/helpers';
import { readChapterFile, writeChapterFileAtomic } from './file-io';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function tmp(files: Record<string, string> = {}) {
  const t = makeTmpDir(files);
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('readChapterFile', () => {
  it('读取 UTF-8，检测 LF/CRLF', () => {
    const d = tmp({ 'a.md': 'x\ny', 'b.md': 'x\r\ny' });
    expect(readChapterFile(path.join(d, 'a.md'))).toMatchObject({ ok: true, text: 'x\ny', eol: '\n', hasBom: false });
    expect(readChapterFile(path.join(d, 'b.md'))).toMatchObject({ ok: true, eol: '\r\n' });
  });
  it('BOM 被忽略但被记录', () => {
    const d = tmp();
    const f = path.join(d, 'c.md');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好')]));
    expect(readChapterFile(f)).toMatchObject({ ok: true, text: '你好', hasBom: true });
  });
  it('非 UTF-8 → encoding', () => {
    const d = tmp();
    const f = path.join(d, 'd.md');
    fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0x41]));
    expect(readChapterFile(f)).toEqual({ ok: false, reason: 'encoding' });
  });
  it('文件不存在时抛错', () => {
    expect(() => readChapterFile('/no/such/file.md')).toThrow();
  });
});

describe('writeChapterFileAtomic', () => {
  it('按原风格还原 CRLF 与 BOM，且不遗留临时文件', () => {
    const d = tmp({ 'a.md': 'old' });
    const f = path.join(d, 'a.md');
    writeChapterFileAtomic(f, '第一行\n第二行', { hasBom: true, eol: '\r\n' });
    const raw = fs.readFileSync(f);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString('utf8')).toBe('第一行\r\n第二行');
    expect(fs.readdirSync(d)).toEqual(['a.md']);
  });
  it('AC2.7 只读文件 → 抛错且内容不变', () => {
    if (process.getuid?.() === 0) return; // root 无视权限
    const d = tmp({ 'a.md': 'old' });
    const f = path.join(d, 'a.md');
    fs.chmodSync(f, 0o444);
    expect(() => writeChapterFileAtomic(f, 'new', { hasBom: false, eol: '\n' })).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('old');
  });
});
