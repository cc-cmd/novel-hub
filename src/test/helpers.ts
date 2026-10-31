import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '@/db';
import { novel, type Novel } from '@/db/schema';

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
