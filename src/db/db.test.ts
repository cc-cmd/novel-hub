import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from './index';
import { chapter, novel, platform, publication } from './schema';
import { insertNovel, makeDb, makeTmpDir } from '@/test/helpers';

describe('createDb', () => {
  it('migrates and seeds builtin platforms idempotently', () => {
    const db = createDb(':memory:');
    const rows = db.select().from(platform).all();
    expect(rows.map((r) => r.name)).toEqual(['番茄', '起点']);
    expect(rows.every((r) => r.builtin)).toBe(true);
  });

  it('F2.12 转换规则版本变化时清空 mtime，迫使章节重算 hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-hub-db-'));
    const file = path.join(dir, 'x.db');
    try {
      const db = createDb(file);
      const n = db.insert(novel).values({ name: 'A', dirPath: '/a' }).returning().get();
      db.insert(chapter).values({ novelId: n.id, seq: 1, title: 't', filePath: '/a/Ch01-t.md', mtimeMs: 123 }).run();
      db.$client.close();
      expect(createDb(file).select().from(chapter).get()!.mtimeMs).toBe(123); // 版本相同：保持

      const raw = createDb(file);
      raw.$client.pragma('user_version = 0'); // 模拟旧版本规则
      raw.$client.close();
      expect(createDb(file).select().from(chapter).get()!.mtimeMs).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('REQ-07 新增列', () => {
  const cols = (db: ReturnType<typeof makeDb>, table: string) =>
    (db.$client.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);

  it('platform / novel_platform / publication 带有同步所需列', () => {
    const db = makeDb();
    expect(cols(db, 'platform')).toEqual(expect.arrayContaining(['cookie', 'csrf_token']));
    expect(cols(db, 'novel_platform')).toEqual(expect.arrayContaining(['book_id', 'last_synced_at', 'last_sync_error']));
    expect(cols(db, 'publication')).toEqual(expect.arrayContaining(['platform_item_id', 'platform_word_count', 'synced_at']));
  });

  it('重开同一个库文件（再次迁移）后既有发布记录保留', () => {
    const file = path.join(makeTmpDir().dir, 'reopen.db');
    const db = createDb(file);
    const n = insertNovel(db, '/x/A');
    const [fanqie] = db.select().from(platform).all();
    const ch = db.insert(chapter).values({ novelId: n.id, seq: 1, title: 'T', filePath: '/x/A/Ch01.md' }).returning().get();
    db.insert(publication).values({ chapterId: ch.id, platformId: fanqie.id, status: 'published', publishedHash: 'h' }).run();
    db.$client.close();
    const again = createDb(file);
    expect(again.select().from(publication).all()).toMatchObject([{ status: 'published', publishedHash: 'h' }]);
  });
});
