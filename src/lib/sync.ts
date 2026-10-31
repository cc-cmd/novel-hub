// src/lib/sync.ts
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, novel, scanIssue, type Chapter } from '@/db/schema';
import { classifyChapterEntries, parseChapterFilename, type DirIssue } from './fs-scan';
import { readChapterFile } from './file-io';
import { contentHash } from './hash';
import { chapterDirOf, scanLibrary, type ScanSummary } from './library';
import { countWords, resolveTitle, toPublishBody } from './publish';
import { UserError } from './result';
import type { ChapterWarning } from './types';

export interface SyncResult {
  added: number;
  updated: number;
  restored: number;
  markedMissing: number;
  issues: number;
  error?: string;
}

type Outcome = 'added' | 'updated' | 'restored' | 'unchanged' | 'skipped';

interface FileRef {
  fileName: string;
  seq: number;
  title: string;
}

function describeContent(text: string, seq: number, fallbackTitle: string) {
  const { title, h1 } = resolveTitle(text, fallbackTitle);
  const warning: ChapterWarning = !h1 ? 'no_h1' : h1.chapterNo !== seq ? 'h1_mismatch' : null;
  return {
    title,
    warning,
    wordCount: countWords(toPublishBody(text)),
    contentHash: contentHash(text, seq, fallbackTitle),
  };
}

/** 同步单个文件到数据库。issues 用于收集读文件失败。 */
function syncFile(
  db: Db,
  novelId: number,
  dir: string,
  f: FileRef,
  prev: Chapter | undefined,
  force: boolean,
  issues: DirIssue[],
): Outcome {
  const full = path.join(dir, f.fileName);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return 'skipped';
  }
  if (
    prev && !force && !prev.fileMissing && prev.filePath === full &&
    prev.mtimeMs === st.mtimeMs && prev.sizeBytes === st.size && prev.contentHash !== null
  ) {
    return 'unchanged';
  }

  let read;
  try {
    read = readChapterFile(full);
  } catch (e) {
    issues.push({ fileName: f.fileName, kind: 'unrecognized', reason: `无法读取文件：${(e as NodeJS.ErrnoException).code ?? 'ERR'}` });
    return 'skipped';
  }

  const meta = { filePath: full, mtimeMs: st.mtimeMs, sizeBytes: st.size, fileMissing: false };
  const content = read.ok
    ? describeContent(read.text, f.seq, f.title)
    : prev
      ? { title: prev.title, warning: 'encoding' as ChapterWarning, wordCount: prev.wordCount, contentHash: prev.contentHash }
      : { title: f.title, warning: 'encoding' as ChapterWarning, wordCount: 0, contentHash: null };
  const next = { ...meta, ...content };

  if (!prev) {
    db.insert(chapter).values({ novelId, seq: f.seq, ...next }).run();
    return 'added';
  }
  const keys = Object.keys(next) as Array<keyof typeof next>;
  if (keys.every((k) => prev[k] === next[k])) return 'unchanged';
  db.update(chapter).set(next).where(eq(chapter.id, prev.id)).run();
  if (prev.fileMissing) return 'restored';
  const contentChanged = (['title', 'filePath', 'wordCount', 'contentHash'] as const).some((k) => prev[k] !== next[k]);
  return contentChanged ? 'updated' : 'unchanged';
}

export function syncNovel(db: Db, novelId: number, opts: { force?: boolean } = {}): SyncResult {
  const n = db.select().from(novel).where(eq(novel.id, novelId)).get();
  if (!n) throw new UserError('小说不存在');
  const res: SyncResult = { added: 0, updated: 0, restored: 0, markedMissing: 0, issues: 0 };
  const dir = chapterDirOf(n);

  let entries: Array<{ name: string; isFile: boolean }>;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch {
    res.markedMissing = db
      .update(chapter)
      .set({ fileMissing: true })
      .where(and(eq(chapter.novelId, n.id), eq(chapter.fileMissing, false)))
      .run().changes;
    res.error = `章节目录不可读：${dir}`;
    return res;
  }

  const { chapters: files, issues } = classifyChapterEntries(entries);
  const existing = new Map(db.select().from(chapter).where(eq(chapter.novelId, n.id)).all().map((c) => [c.seq, c]));
  const seen = new Set<number>();

  db.$client.transaction(() => {
    for (const f of files) {
      seen.add(f.seq);
      const outcome = syncFile(db, n.id, dir, f, existing.get(f.seq), !!opts.force, issues);
      if (outcome === 'added') res.added++;
      else if (outcome === 'updated') res.updated++;
      else if (outcome === 'restored') res.restored++;
    }
    for (const [seq, c] of existing) {
      if (!seen.has(seq) && !c.fileMissing) {
        db.update(chapter).set({ fileMissing: true }).where(eq(chapter.id, c.id)).run();
        res.markedMissing++;
      }
    }
    // 提示集合未变化时不重写，保证磁盘无变化时数据库零写入
    const sig = (x: { fileName: string; kind: string; reason: string }) => `${x.fileName}\u0000${x.kind}\u0000${x.reason}`;
    const oldSigs = db.select().from(scanIssue).where(eq(scanIssue.novelId, n.id)).all().map(sig).sort();
    const newSigs = issues.map(sig).sort();
    if (oldSigs.length !== newSigs.length || oldSigs.some((v, i) => v !== newSigs[i])) {
      db.delete(scanIssue).where(eq(scanIssue.novelId, n.id)).run();
      for (const i of issues) db.insert(scanIssue).values({ novelId: n.id, ...i }).run();
    }
  })();
  res.issues = issues.length;
  return res;
}

/** 平台内保存后调用：强制重读该章文件。 */
export function syncChapter(db: Db, chapterId: number): { changed: boolean } {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) throw new UserError('章节不存在');
  const dir = path.dirname(ch.filePath);
  const base = path.basename(ch.filePath);
  if (!fs.existsSync(ch.filePath)) {
    if (ch.fileMissing) return { changed: false };
    db.update(chapter).set({ fileMissing: true }).where(eq(chapter.id, ch.id)).run();
    return { changed: true };
  }
  const f: FileRef = { fileName: base, seq: ch.seq, title: parseChapterFilename(base)?.title ?? ch.title };
  const outcome = syncFile(db, ch.novelId, dir, f, ch, true, []);
  return { changed: outcome === 'updated' || outcome === 'restored' || outcome === 'added' };
}

export interface FullSyncSummary extends ScanSummary {
  chapters: { added: number; updated: number; restored: number; markedMissing: number };
  issues: number;
  errors: string[];
}

export function scanAndSync(db: Db): FullSyncSummary {
  const scan = scanLibrary(db);
  const out: FullSyncSummary = {
    ...scan,
    chapters: { added: 0, updated: 0, restored: 0, markedMissing: 0 },
    issues: 0,
    errors: [],
  };
  for (const n of db.select().from(novel).where(eq(novel.archived, false)).all()) {
    try {
      const r = syncNovel(db, n.id);
      out.chapters.added += r.added;
      out.chapters.updated += r.updated;
      out.chapters.restored += r.restored;
      out.chapters.markedMissing += r.markedMissing;
      out.issues += r.issues;
      if (r.error) out.errors.push(`${n.name}：${r.error}`);
    } catch (e) {
      out.errors.push(`${n.name}：${(e as Error).message}`);
    }
  }
  return out;
}
