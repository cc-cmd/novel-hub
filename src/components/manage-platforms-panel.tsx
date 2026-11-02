'use client';
import { useState, useTransition } from 'react';
import { bindPlatformAction, unbindPlatformAction } from '@/app/actions/platforms';
import { UserError } from '@/lib/result';
import { parseFanqieBookId } from '@/lib/fanqie-url';
import { fmtSyncTime, isAuthSyncError, syncErrorLabel } from '@/lib/sync-status';
import { useNotice } from './notice';

interface Item {
  id: number; name: string; bound: boolean; bookUrl: string | null; publicationCount: number;
  syncSupported: boolean; hasAuth: boolean; configured: boolean; lastSyncedAt: number | null; lastSyncError: string | null;
}

/** 输入时的即时提示（F7.3）；真正的校验在保存时由服务端完成。 */
function linkHint(url: string): { text: string; warn: boolean } {
  if (!url.trim()) return { text: '从番茄作家后台打开本书“章节管理”，复制地址栏的链接。', warn: false };
  try {
    return { text: `✓ 格式正确，书号 ${parseFanqieBookId(url)}`, warn: false };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { text: '格式不对：应为 fanqienovel.com/main/writer/chapter-manage/<书号>', warn: true };
  }
}

export function ManagePlatformsPanel({ novelId, bindings, defaultOpen }: { novelId: number; bindings: Item[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="w-full sm:w-auto">
      <button className="rounded border px-4" aria-expanded={open} onClick={() => setOpen(!open)}>管理平台</button>
      {open && (
        <ul className="mt-2 w-full min-w-[320px] divide-y rounded border bg-white px-3">
          {bindings.map((b) => <Row key={b.id} novelId={novelId} item={b} />)}
        </ul>
      )}
    </div>
  );
}

function Row({ novelId, item }: { novelId: number; item: Item }) {
  const [url, setUrl] = useState(item.bookUrl ?? '');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const bind = (u: string) =>
    start(async () => {
      const r = await bindPlatformAction(novelId, item.id, u || null);
      if (!r.ok) return setError(r.error);
      notify({ kind: 'success', text: `已${item.bound ? '更新' : '绑定'} ${item.name}` });
    });
  const unbind = () =>
    start(async () => {
      const r = await unbindPlatformAction(novelId, item.id);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      setConfirming(false);
      notify({ kind: 'success', text: `已解绑 ${item.name}，发布记录已保留` });
    });

  return (
    <li className="space-y-2 py-3">
      <label className="flex items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={item.bound} disabled={pending}
          onChange={(e) => {
            if (e.target.checked) bind(url);
            else if (item.publicationCount > 0) setConfirming(true);
            else unbind();
          }} />
        <span className="font-medium">{item.name}</span>
      </label>
      {item.bound && item.syncSupported && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded px-2 py-0.5 font-medium ${item.configured ? 'bg-blue-50 text-blue-900' : 'bg-orange-100 text-orange-900'}`}>
              {item.configured ? '已配置' : !item.hasAuth ? '缺认证' : '缺链接'}
            </span>
            {item.lastSyncError ? (
              <span className="text-red-700">
                上次同步失败：{syncErrorLabel(item.lastSyncError)}{' '}
                {isAuthSyncError(item.lastSyncError) && <a className="underline" href="/settings#fanqie">去设置</a>}
              </span>
            ) : item.configured ? (
              <span className="text-stone-600">{item.lastSyncedAt ? `最近同步：${fmtSyncTime(item.lastSyncedAt)} · 成功` : '尚未同步'}</span>
            ) : null}
          </div>
          <label className="block text-xs text-stone-600" htmlFor={`url-${item.id}`}>作品链接（作家后台“章节管理”页）</label>
          <div className="flex gap-2">
            <input id={`url-${item.id}`} className="flex-1 rounded border px-2 font-mono text-xs" placeholder="https://fanqienovel.com/main/writer/chapter-manage/<书号>"
              value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} />
            <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>{pending ? '校验中…' : '保存并校验'}</button>
          </div>
          {!error && <p className={`text-xs ${linkHint(url).warn ? 'text-orange-800' : 'text-stone-600'}`}>{linkHint(url).text}</p>}
          {!item.hasAuth && <p className="text-xs text-orange-900">未配置认证信息，不会同步状态。<a className="underline" href="/settings#fanqie">去设置</a></p>}
          {item.hasAuth && !item.bookUrl && <p className="text-xs text-orange-900">未填写作品链接，不会同步状态</p>}
        </div>
      )}
      {item.bound && !item.syncSupported && (
        <div className="space-y-1">
          <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600">暂不支持自动校验</span>
          <div className="flex gap-2">
            <input className="flex-1 rounded border px-2 text-sm" placeholder="作品主页链接（可选）" value={url}
              onChange={(e) => { setUrl(e.target.value); setError(''); }} />
            <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>保存链接</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
      {confirming && (
        <div className="flex items-center gap-3 rounded bg-amber-50 p-3 text-sm">
          <span className="flex-1">已有 {item.publicationCount} 条发布记录将被隐藏，重新绑定后恢复。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={unbind}>确认解绑</button>
          <button className="rounded border px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </li>
  );
}
