import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter, scanIssue, type Chapter } from '@/db/schema';
import { CONFLICT_MESSAGE } from './chapters-constants';
import { readChapterFile, writeChapterFileAtomic } from './file-io';
import { UserError } from './result';
import { syncChapter } from './sync';

export { CONFLICT_MESSAGE };

const WARNING_TEXT = {
  h1_mismatch: 'H1 章号与文件名不符，已入库',
  no_h1: '缺少 H1，已入库，标题取自文件名',
  encoding: '编码不支持，字数与状态未更新',
} as const;

export function listChapters(db: Db, novelId: number): Chapter[] {
  return db.select().from(chapter).where(eq(chapter.novelId, novelId)).orderBy(asc(chapter.seq)).all();
}

export interface ProblemFile {
  fileName: string;
  reason: string;
  stored: boolean;
}

export function listProblems(db: Db, novelId: number): ProblemFile[] {
  const issues = db.select().from(scanIssue).where(eq(scanIssue.novelId, novelId)).orderBy(asc(scanIssue.fileName)).all();
  const warned = listChapters(db, novelId).filter((c) => c.warning);
  return [
    ...issues.map((i) => ({ fileName: i.fileName, reason: i.reason, stored: false })),
    ...warned.map((c) => ({ fileName: path.basename(c.filePath), reason: WARNING_TEXT[c.warning!], stored: true })),
  ];
}

export interface EditorData {
  chapter: Chapter;
  content: string;
  baseHash: string | null;
  readError: string | null;
}

function getChapter(db: Db, id: number): Chapter {
  const ch = db.select().from(chapter).where(eq(chapter.id, id)).get();
  if (!ch) throw new UserError('章节不存在');
  return ch;
}

export function loadChapterForEdit(db: Db, chapterId: number): EditorData {
  const ch = getChapter(db, chapterId);
  if (ch.fileMissing) return { chapter: ch, content: '', baseHash: null, readError: null };
  try {
    const r = readChapterFile(ch.filePath);
    if (!r.ok) return { chapter: ch, content: '', baseHash: null, readError: '编码不支持：文件不是 UTF-8' };
    return { chapter: ch, content: r.text.replace(/\r\n/g, '\n'), baseHash: r.rawHash, readError: null };
  } catch (e) {
    return { chapter: ch, content: '', baseHash: null, readError: `无法读取文件：${(e as Error).message}` };
  }
}

export function saveChapter(
  db: Db,
  chapterId: number,
  content: string,
  opts: { baseHash: string; overwrite?: boolean },
): { wordCount: number; baseHash: string } {
  const ch = getChapter(db, chapterId);
  if (ch.fileMissing) throw new UserError('文件丢失，无法编辑');

  const current = readChapterFile(ch.filePath);
  if (!current.ok) throw new UserError('编码不支持：文件不是 UTF-8，无法保存');
  if (!opts.overwrite && current.rawHash !== opts.baseHash) throw new UserError(CONFLICT_MESSAGE);

  // 先写文件；失败则抛出，数据库保持不变
  try {
    writeChapterFileAtomic(ch.filePath, content.replace(/\r\n/g, '\n'), { hasBom: current.hasBom, eol: current.eol });
  } catch (e) {
    throw new UserError(`保存失败，文件未被修改：${(e as Error).message}`);
  }
  syncChapter(db, chapterId);

  const after = readChapterFile(ch.filePath);
  return { wordCount: getChapter(db, chapterId).wordCount, baseHash: after.ok ? after.rawHash : '' };
}
