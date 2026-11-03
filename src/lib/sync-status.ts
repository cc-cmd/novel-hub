const AUTH_MARK = '认证无效或已过期';

export const isAuthSyncError = (e: string | null | undefined): boolean => !!e && e.includes(AUTH_MARK);
export const syncErrorLabel = (e: string): string => (isAuthSyncError(e) ? '认证已失效' : e);

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtSyncTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? `今天 ${time}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function syncStrip(i: { lastSyncedAt: number | null; lastSyncError: string | null; changedCount: number; now?: number }) {
  const now = i.now ?? Date.now();
  if (i.lastSyncError) {
    return {
      tone: 'warn' as const,
      title: '上次同步失败',
      detail: i.lastSyncedAt ? `下方仍是${fmtSyncTime(i.lastSyncedAt, now)} 的状态，可能已过期。` : '尚无成功同步的记录。',
    };
  }
  if (!i.lastSyncedAt) return { tone: 'info' as const, title: '尚未同步', detail: '点“重新扫描”获取番茄线上状态。' };
  const fixed = '状态由番茄同步，不能手动修改。';
  if (now - i.lastSyncedAt < 60_000 && i.changedCount === 0) return { tone: 'info' as const, title: '番茄状态已是最新', detail: `刚刚同步。${fixed}` };
  return {
    tone: 'info' as const,
    title: `最近同步：${fmtSyncTime(i.lastSyncedAt, now)}`,
    detail: i.changedCount > 0 ? `${i.changedCount} 章在同步后有本地改动，重新扫描后状态才会更新。` : fixed,
  };
}

/** 同步不保存线上标题，原因由线上字数与本地字数推断：字数相同仍判需更新，只可能是标题不同。 */
export function staleReason(platformWordCount: number | null, localWordCount: number): string {
  if (platformWordCount === null) return '线上内容不一致';
  return platformWordCount === localWordCount ? '字数相同，标题不同' : '字数不同，内容不一致';
}

export function cardSyncLine(i: { lastSyncedAt: number | null; lastSyncError: string | null; now?: number }) {
  if (i.lastSyncError) return { text: `同步失败：${syncErrorLabel(i.lastSyncError)}，状态未改动`, failed: true };
  return { text: i.lastSyncedAt ? `最近同步：${fmtSyncTime(i.lastSyncedAt, i.now)}` : '尚未同步', failed: false };
}
