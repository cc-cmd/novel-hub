'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addPlatform, bindPlatform, deletePlatform, renamePlatform, unbindPlatform } from '@/lib/platforms';

const refresh = () => {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
};

export async function addPlatformAction(name: string) {
  return wrap(() => { const p = addPlatform(getDb(), name); refresh(); return p; });
}
export async function renamePlatformAction(id: number, name: string) {
  return wrap(() => { const p = renamePlatform(getDb(), id, name); refresh(); return p; });
}
export async function deletePlatformAction(id: number) {
  return wrap(() => { deletePlatform(getDb(), id); refresh(); });
}
export async function bindPlatformAction(novelId: number, platformId: number, bookUrl: string | null) {
  return wrap(() => { bindPlatform(getDb(), novelId, platformId, bookUrl); refresh(); });
}
export async function unbindPlatformAction(novelId: number, platformId: number) {
  return wrap(() => { unbindPlatform(getDb(), novelId, platformId); refresh(); });
}
