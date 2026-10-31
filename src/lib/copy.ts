import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { chapter } from '@/db/schema';
import { readChapterFile } from './file-io';
import { buildPublishForm, countWords, formatForCopy, type CopyMode } from './publish';
import { UserError } from './result';

export interface CopyPayload {
  text: string;
  title: string;
  bodyEmpty: boolean;
  wordCount: number;
  mode: CopyMode;
}

export function getCopyPayload(db: Db, chapterId: number, mode: CopyMode): CopyPayload {
  const ch = db.select().from(chapter).where(eq(chapter.id, chapterId)).get();
  if (!ch) throw new UserError('章节不存在');
  if (ch.fileMissing) throw new UserError('文件丢失，无法复制');
  let read;
  try {
    read = readChapterFile(ch.filePath);
  } catch (e) {
    throw new UserError(`无法读取文件：${(e as Error).message}`);
  }
  if (!read.ok) throw new UserError('编码不支持：文件不是 UTF-8，无法复制');
  const { title, body } = buildPublishForm(read.text, ch.seq, ch.title);
  return {
    text: formatForCopy(read.text, ch.seq, ch.title, mode),
    title,
    bodyEmpty: body === '',
    wordCount: countWords(body),
    mode,
  };
}
