'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { planPublish, runPublish, setPublishSettings, setVolumeRules } from '@/lib/fanqie-publish';
import { publisherForPlatform } from '@/lib/platform-auth';
import { wrap } from '@/lib/result';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
};

export async function planPublishAction(novelId: number, platformId: number) {
  return wrap(() => { const db = getDb(); return planPublish(db, novelId, platformId, publisherForPlatform(db, platformId)); });
}
export async function runPublishAction(novelId: number, platformId: number, chapterIds: number[]) {
  return wrap(async () => {
    const db = getDb();
    const r = await runPublish(db, novelId, platformId, chapterIds, publisherForPlatform(db, platformId));
    refresh();
    return r;
  });
}
export async function setPublishSettingsAction(platformId: number, useAi: number, dailyWordLimit: number) {
  return wrap(() => { setPublishSettings(getDb(), platformId, { useAi, dailyWordLimit }); refresh(); });
}
export async function setVolumeRulesAction(novelId: number, platformId: number, text: string) {
  return wrap(() => { setVolumeRules(getDb(), novelId, platformId, text); refresh(); });
}
