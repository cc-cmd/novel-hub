'use server';
import { getDb } from '@/db';
import { getCopyPayload } from '@/lib/copy';
import type { CopyMode } from '@/lib/publish';
import { wrap } from '@/lib/result';

export async function copyChapterAction(chapterId: number, mode: CopyMode) {
  return wrap(() => getCopyPayload(getDb(), chapterId, mode));
}
