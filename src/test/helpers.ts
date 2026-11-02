import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '@/db';
import { eq } from 'drizzle-orm';
import { novel, platform, type Novel } from '@/db/schema';
import { bindPlatform, listPlatforms } from '@/lib/platforms';

export function makeDb(): Db {
  return createDb(':memory:');
}

export function makeTmpDir(files: Record<string, string> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'novel-hub-')));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function insertNovel(db: Db, dirPath: string, over: Partial<typeof novel.$inferInsert> = {}): Novel {
  return db
    .insert(novel)
    .values({ name: path.basename(dirPath), dirPath, ...over })
    .returning()
    .get();
}

export const SAMPLE_BOOK_URL = 'https://fanqienovel.com/main/writer/chapter-manage/7670888040847395864&坏人?type=1';

/** 给番茄写入测试认证，并以样例链接绑定该小说 → 该（小说, 番茄）为「已配置」。 */
export function configureFanqie(db: Db, novelId: number): { platformId: number } {
  const fanqie = listPlatforms(db).find((p) => p.name === '番茄')!;
  db.update(platform).set({ cookie: 'c', csrfToken: 't' }).where(eq(platform.id, fanqie.id)).run();
  bindPlatform(db, novelId, fanqie.id, SAMPLE_BOOK_URL);
  return { platformId: fanqie.id };
}
