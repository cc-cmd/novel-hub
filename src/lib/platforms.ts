import { and, count, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novelPlatform, platform, publication, type Platform } from '@/db/schema';
import { UserError } from './result';

function cleanName(input: string, selfId?: number, db?: Db): string {
  const name = input.trim();
  if (name.length < 1 || name.length > 20) throw new UserError('平台名称长度应为 1–20 个字');
  if (db) {
    const dup = db.select().from(platform).all().some((p) => p.id !== selfId && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new UserError('平台已存在');
  }
  return name;
}

export function listPlatforms(db: Db): Array<Platform & { boundNovels: number }> {
  return db
    .select()
    .from(platform)
    .orderBy(platform.id)
    .all()
    .map((p) => ({
      ...p,
      boundNovels: db.select({ c: count() }).from(novelPlatform).where(eq(novelPlatform.platformId, p.id)).get()!.c,
    }));
}

export function addPlatform(db: Db, name: string): Platform {
  return db.insert(platform).values({ name: cleanName(name, undefined, db), builtin: false }).returning().get();
}

export function renamePlatform(db: Db, id: number, name: string): Platform {
  const p = db.select().from(platform).where(eq(platform.id, id)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.builtin) throw new UserError('预置平台不可改名');
  return db.update(platform).set({ name: cleanName(name, id, db) }).where(eq(platform.id, id)).returning().get();
}

export function deletePlatform(db: Db, id: number): void {
  const p = db.select().from(platform).where(eq(platform.id, id)).get();
  if (!p) throw new UserError('平台不存在');
  if (p.builtin) throw new UserError('预置平台不可删除');
  const bound = db.select({ c: count() }).from(novelPlatform).where(eq(novelPlatform.platformId, id)).get()!.c;
  const pubs = db.select({ c: count() }).from(publication).where(eq(publication.platformId, id)).get()!.c;
  if (bound > 0 || pubs > 0) {
    throw new UserError(`无法删除：${p.name}被 ${bound} 本小说绑定，并有 ${pubs} 条发布记录。请保留该平台。`);
  }
  db.delete(platform).where(eq(platform.id, id)).run();
}

export function validateUrl(input: string | null | undefined, label: string): string | null {
  const v = (input ?? '').trim();
  if (!v) return null;
  let ok = /^https?:\/\//i.test(v);
  if (ok) {
    try {
      new URL(v);
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new UserError(`${label}格式错误：需以 http:// 或 https:// 开头`);
  return v;
}

export function bindPlatform(db: Db, novelId: number, platformId: number, bookUrl?: string | null): void {
  const url = validateUrl(bookUrl, '作品主页链接');
  db.insert(novelPlatform)
    .values({ novelId, platformId, bookUrl: url })
    .onConflictDoUpdate({ target: [novelPlatform.novelId, novelPlatform.platformId], set: { bookUrl: url } })
    .run();
}

export function unbindPlatform(db: Db, novelId: number, platformId: number): void {
  db.delete(novelPlatform).where(and(eq(novelPlatform.novelId, novelId), eq(novelPlatform.platformId, platformId))).run();
}

export interface Binding {
  platform: Platform;
  bound: boolean;
  bookUrl: string | null;
  publicationCount: number;
}

export function listBindings(db: Db, novelId: number): Binding[] {
  const links = new Map(db.select().from(novelPlatform).where(eq(novelPlatform.novelId, novelId)).all().map((l) => [l.platformId, l]));
  return db
    .select()
    .from(platform)
    .orderBy(platform.id)
    .all()
    .map((p) => ({
      platform: p,
      bound: links.has(p.id),
      bookUrl: links.get(p.id)?.bookUrl ?? null,
      publicationCount: db
        .select({ c: count() })
        .from(publication)
        .innerJoin(chapter, eq(chapter.id, publication.chapterId))
        .where(and(eq(chapter.novelId, novelId), eq(publication.platformId, p.id)))
        .get()!.c,
    }));
}
