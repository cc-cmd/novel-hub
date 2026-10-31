'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { saveChapter } from '@/lib/chapters';
import { wrap } from '@/lib/result';

export async function saveChapterAction(chapterId: number, content: string, baseHash: string, overwrite = false) {
  return wrap(() => {
    const r = saveChapter(getDb(), chapterId, content, { baseHash, overwrite });
    revalidatePath('/');
    revalidatePath('/novels/[id]', 'page');
    revalidatePath('/novels/[id]/chapters/[cid]', 'page');
    return r;
  });
}
