import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapter, publication } from '@/db/schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';
import { listChapters } from './chapters';
import { getCopyPayload } from './copy';
import { syncNovel } from './sync';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup() {
  const t = makeTmpDir({ 'Ch03-开端.md': '# 第3章 开端\n\n**第一段。**\n' });
  cleanups.push(t.cleanup);
  const db = makeDb();
  const n = insertNovel(db, t.dir);
  syncNovel(db, n.id);
  return { db, n, file: path.join(t.dir, 'Ch03-开端.md'), id: listChapters(db, n.id)[0].id };
}

describe('getCopyPayload', () => {
  it('AC5.4 标题+正文', () => {
    const s = setup();
    expect(getCopyPayload(s.db, s.id, 'both')).toEqual({
      text: '第3章 开端\n\n第一段。', title: '第3章 开端', bodyEmpty: false, wordCount: 4, mode: 'both',
    });
  });
  it('AC5.8 读取磁盘最新内容（库里尚未同步）', () => {
    const s = setup();
    fs.writeFileSync(s.file, '# 第3章 开端\n\n外部刚改的。\n');
    expect(getCopyPayload(s.db, s.id, 'body').text).toBe('外部刚改的。');
  });
  it('AC5.7 只读：不改 chapter / publication', () => {
    const s = setup();
    const before = JSON.stringify([s.db.select().from(chapter).all(), s.db.select().from(publication).all()]);
    getCopyPayload(s.db, s.id, 'both');
    expect(JSON.stringify([s.db.select().from(chapter).all(), s.db.select().from(publication).all()])).toBe(before);
  });
  it('AC5.9 文件丢失 → 抛错', () => {
    const s = setup();
    fs.rmSync(s.file);
    syncNovel(s.db, s.n.id);
    expect(() => getCopyPayload(s.db, s.id, 'both')).toThrow('文件丢失，无法复制');
  });
  it('文件在两次同步之间被删除 → 读取失败也抛 UserError', () => {
    const s = setup();
    fs.rmSync(s.file);
    expect(() => getCopyPayload(s.db, s.id, 'both')).toThrow('无法读取文件');
  });
  it('非 UTF-8 → 抛错', () => {
    const s = setup();
    fs.writeFileSync(s.file, Buffer.from([0xff, 0xfe, 0x41]));
    expect(() => getCopyPayload(s.db, s.id, 'both')).toThrow('编码不支持');
  });
  it('正文为空', () => {
    const s = setup();
    fs.writeFileSync(s.file, '# 第3章 开端\n');
    expect(getCopyPayload(s.db, s.id, 'both')).toMatchObject({ text: '第3章 开端', bodyEmpty: true, wordCount: 0 });
  });
});
