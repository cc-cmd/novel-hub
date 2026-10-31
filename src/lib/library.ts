// src/lib/library.ts
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { libraryRoot, novel, type Novel } from '@/db/schema';
import { UserError } from './result';
import { checkDir, listSubdirs, validateDirPath, type DirState } from './fs-scan';

export function chapterDirOf(n: Pick<Novel, 'dirPath' | 'chapterSubdir'>): string {
  return n.chapterSubdir ? path.join(n.dirPath, n.chapterSubdir) : n.dirPath;
}

export function addRoot(db: Db, input: string) {
  const v = validateDirPath(input);
  if (!v.ok) throw new UserError(v.error);
  const dup = db.select().from(libraryRoot).where(eq(libraryRoot.path, v.path)).get();
  if (dup) throw new UserError('该目录已添加，无需重复添加');
  const row = db.insert(libraryRoot).values({ path: v.path }).returning().get();
  return { id: row.id, path: row.path };
}

export function removeRoot(db: Db, id: number): void {
  db.delete(libraryRoot).where(eq(libraryRoot.id, id)).run();
  refreshNovelFlags(db);
}

export interface RootInfo {
  id: number;
  path: string;
  state: DirState;
  novelCount: number;
}

export function listRoots(db: Db): RootInfo[] {
  const novels = db.select({ dirPath: novel.dirPath }).from(novel).all();
  return db
    .select()
    .from(libraryRoot)
    .orderBy(libraryRoot.id)
    .all()
    .map((r) => ({
      id: r.id,
      path: r.path,
      state: checkDir(r.path),
      novelCount: novels.filter((n) => path.dirname(n.dirPath) === r.path).length,
    }));
}

/** 重新计算每本小说的 dirMissing / rootRemoved。只在值变化时写库。 */
export function refreshNovelFlags(db: Db): void {
  const roots = new Set(db.select().from(libraryRoot).all().map((r) => r.path));
  for (const n of db.select().from(novel).all()) {
    const dirMissing = checkDir(n.dirPath) === 'missing';
    const rootRemoved = !roots.has(path.dirname(n.dirPath));
    if (dirMissing !== n.dirMissing || rootRemoved !== n.rootRemoved) {
      db.update(novel).set({ dirMissing, rootRemoved }).where(eq(novel.id, n.id)).run();
    }
  }
}

export interface ScanSummary {
  newNovels: number;
  roots: Array<{ path: string; state: DirState }>;
}

/** 只发现小说，不同步章节（章节同步见 REQ-02 的 scanAndSync）。幂等。 */
export function scanLibrary(db: Db): ScanSummary {
  const summary: ScanSummary = { newNovels: 0, roots: [] };
  for (const root of db.select().from(libraryRoot).orderBy(libraryRoot.id).all()) {
    const state = checkDir(root.path);
    summary.roots.push({ path: root.path, state });
    if (state !== 'ok') continue;
    for (const dir of listSubdirs(root.path)) {
      const exists = db.select({ id: novel.id }).from(novel).where(eq(novel.dirPath, dir)).get();
      if (exists) continue;
      db.insert(novel).values({ name: path.basename(dir), dirPath: dir }).run();
      summary.newNovels++;
    }
  }
  refreshNovelFlags(db);
  return summary;
}

export function setArchived(db: Db, novelId: number, archived: boolean): Novel {
  return db.update(novel).set({ archived }).where(eq(novel.id, novelId)).returning().get();
}

export function setChapterSubdir(db: Db, novelId: number, subdir: string): Novel {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  let rel = subdir.trim();
  if (rel) {
    if (path.isAbsolute(rel)) throw new UserError('章节目录必须是小说目录内的相对路径');
    rel = path.normalize(rel).replace(/[\\/]+$/, '');
    if (rel === '..' || rel.startsWith('..' + path.sep)) throw new UserError('章节目录必须是小说目录内的相对路径');
    if (rel === '.') rel = '';
  }
  if (rel) {
    const full = path.join(n.dirPath, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new UserError(`目录不存在：${full}`);
  }
  return db.update(novel).set({ chapterSubdir: rel }).where(eq(novel.id, novelId)).returning().get();
}
