'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { captureStatus, startCapture } from '@/lib/auth-capture';
import { bindPlatformChecked, clearAuth, importFanqieAuthFromFile, saveFanqieAuth } from '@/lib/platform-auth';
import { addPlatform, deletePlatform, renamePlatform, unbindPlatform } from '@/lib/platforms';

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
  return wrap(async () => { await bindPlatformChecked(getDb(), novelId, platformId, bookUrl); refresh(); });
}
export async function savePlatformAuthAction(platformId: number, cookie: string, csrfToken: string) {
  return wrap(async () => { await saveFanqieAuth(getDb(), platformId, { cookie, csrfToken }); refresh(); });
}
export async function importPlatformAuthAction(platformId: number, filePath: string) {
  return wrap(async () => { await importFanqieAuthFromFile(getDb(), platformId, filePath); refresh(); });
}
export async function startAuthCaptureAction(platformId: number) {
  return wrap(async () => { await startCapture(getDb(), platformId); });
}
/** 轮询一键获取进度；完成时刷新页面数据（掩码、状态徽标）。 */
export async function authCaptureStatusAction(platformId: number) {
  return wrap(() => { const s = captureStatus(platformId); if (s.state === 'done') refresh(); return s; });
}
export async function clearPlatformAuthAction(platformId: number) {
  return wrap(() => { clearAuth(getDb(), platformId); refresh(); });
}
export async function unbindPlatformAction(novelId: number, platformId: number) {
  return wrap(() => { unbindPlatform(getDb(), novelId, platformId); refresh(); });
}
