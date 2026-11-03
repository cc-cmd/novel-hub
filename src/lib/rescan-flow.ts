import type { PlatformSyncOutcome } from './platform-sync';
import type { ActionResult } from './result';
import type { FullSyncSummary, SyncResult } from './sync';

export type LocalScan = FullSyncSummary & { syncable: Array<{ id: number; name: string }> };

export function unwrap<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failure = (novelId: number, novelName: string, e: unknown): PlatformSyncOutcome => ({
  ok: false, novelId, novelName, platformId: 0, platformName: '番茄', error: (e as Error).message, authFailed: false,
});

/** 单本：本地扫描成功后再同步。同步抛错不影响已拿到的本地结果。 */
export async function runRescanNovel(
  steps: { local: () => Promise<SyncResult>; platforms: () => Promise<PlatformSyncOutcome[]> },
  onStage: (stage: 'local' | 'remote') => void,
): Promise<{ local: SyncResult; platformSync: PlatformSyncOutcome[] }> {
  onStage('local');
  const local = await steps.local();
  if (local.error) return { local, platformSync: [] };
  onStage('remote');
  try {
    return { local, platformSync: await steps.platforms() };
  } catch (e) {
    return { local, platformSync: [failure(0, '', e)] };
  }
}

/** 全局：本地扫描后逐本串行同步（间隔 delayMs），每本完成后上报进度。 */
export async function runRescanAll(
  steps: { local: () => Promise<LocalScan>; sync: (novelId: number) => Promise<PlatformSyncOutcome[]> },
  onProgress: (p: { done: number; total: number }) => void,
  delayMs = 300,
): Promise<{ summary: LocalScan; platformSync: PlatformSyncOutcome[] }> {
  const summary = await steps.local();
  const platformSync: PlatformSyncOutcome[] = [];
  const total = summary.syncable.length;
  for (const [i, n] of summary.syncable.entries()) {
    onProgress({ done: i + 1, total });
    try {
      platformSync.push(...(await steps.sync(n.id)));
    } catch (e) {
      platformSync.push(failure(n.id, n.name, e));
    }
    if (delayMs > 0 && i < total - 1) await sleep(delayMs);
  }
  return { summary, platformSync };
}
