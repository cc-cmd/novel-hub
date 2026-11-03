import type { PlatformSyncOutcome } from './platform-sync';

export interface RescanNotice {
  kind: 'success' | 'warn';
  text: string;
  alert: { text: string; settingsLink: boolean } | null;
}

type Ok = Extract<PlatformSyncOutcome, { ok: true }>;
type Bad = Extract<PlatformSyncOutcome, { ok: false }>;

function successText(oks: Ok[]): string {
  const sum = (k: 'published' | 'stale' | 'unpublished' | 'skipped' | 'unreadable' | 'remoteExtra') => oks.reduce((s, o) => s + o[k], 0);
  let t = `番茄同步完成：已发布 ${sum('published')}、需更新 ${sum('stale')}、未发布 ${sum('unpublished')}`;
  if (sum('skipped') > 0) t += `；${sum('skipped')} 章文件丢失未比对`;
  if (sum('remoteExtra') > 0) t += `；线上多出 ${sum('remoteExtra')} 章本地没有`;
  if (sum('unreadable') > 0) t += `；${sum('unreadable')} 章无法比对，状态未改动`;
  return t;
}

export function buildRescanNotice(localText: string, outcomes: PlatformSyncOutcome[], scope: 'novel' | 'all'): RescanNotice {
  const oks = outcomes.filter((o): o is Ok => o.ok);
  const bads = outcomes.filter((o): o is Bad => !o.ok);
  if (bads.length === 0) {
    return { kind: 'success', text: oks.length ? `${localText}。${successText(oks)}` : localText, alert: null };
  }
  const authFailed = bads.some((b) => b.authFailed);
  if (scope === 'novel') {
    return {
      kind: 'success',
      text: oks.length ? `${localText}。${successText(oks)}` : localText,
      alert: authFailed
        ? { text: '番茄同步失败：认证已失效，各章状态未改动', settingsLink: true }
        : { text: `${bads[0].error}。各章状态未改动`, settingsLink: false },
    };
  }
  return {
    kind: 'warn',
    text: authFailed ? `${localText}。番茄同步未执行：认证已失效` : `${localText}。番茄同步：${oks.length} 本成功，${bads.length} 本失败`,
    alert: null,
  };
}
