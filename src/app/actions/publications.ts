'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { applyPublicationAction, restorePublication, updatePublicationInfo, type PubAction, type PubSnapshot } from '@/lib/publications';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/novels/[id]', 'page');
  revalidatePath('/novels/[id]/chapters/[cid]', 'page');
};

export async function publicationAction(chapterId: number, platformId: number, action: PubAction) {
  return wrap(() => { const r = applyPublicationAction(getDb(), chapterId, platformId, action); refresh(); return r; });
}
export async function restorePublicationAction(chapterId: number, platformId: number, snapshot: PubSnapshot) {
  return wrap(() => { restorePublication(getDb(), chapterId, platformId, snapshot); refresh(); });
}
export async function updatePublicationInfoAction(
  chapterId: number,
  platformId: number,
  patch: { platformUrl?: string | null; publishedAt?: number | null },
) {
  return wrap(() => { const r = updatePublicationInfo(getDb(), chapterId, platformId, patch); refresh(); return r; });
}
