import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';
import { seedBuiltinPlatforms } from './seed';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** file 传 ':memory:' 用于测试。会执行迁移与预置数据。 */
export function createDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  seedBuiltinPlatforms(db);
  return db;
}

const g = globalThis as unknown as { __novelHubDb?: Db };

/** Next 开发模式热更新下复用同一连接。 */
export function getDb(): Db {
  g.__novelHubDb ??= createDb(process.env.NOVEL_HUB_DB ?? path.join(process.cwd(), 'data', 'novel-hub.db'));
  return g.__novelHubDb;
}
