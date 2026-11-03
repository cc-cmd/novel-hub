'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { updatePublicationInfo } from '@/lib/publications';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/novels/[id]', 'page');
  revalidatePath('/novels/[id]/chapters/[cid]', 'page');
};

export async function updatePublicationInfoAction(
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
) {
  return wrap(() => { const r = updatePublicationInfo(getDb(), chapterId, platformId, patch); refresh(); return r; });
}
