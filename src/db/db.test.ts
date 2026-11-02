import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from './index';
import { chapter, novel, platform } from './schema';

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
