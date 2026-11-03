'use client';
import { useState, useTransition } from 'react';
import { deletePlatformAction, renamePlatformAction } from '@/app/actions/platforms';
import { useNotice } from '@/components/notice';
import { PlatformAuthPanel } from './platform-auth-panel';
import { PublishSettingsPanel } from './publish-settings-panel';

export function PlatformRow({ id, name, builtin, boundNovels, syncSupported, authSummary, authFailed, useAi, dailyWordLimit }: {
  id: number; name: string; builtin: boolean; boundNovels: number; syncSupported: boolean; authSummary: string | null; authFailed: boolean;
  useAi: number; dailyWordLimit: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const rename = () =>
    start(async () => {
      const r = await renamePlatformAction(id, draft);
      if (!r.ok) return setError(r.error);
      setRenaming(false);
    });
  const remove = () =>
    start(async () => {
      const r = await deletePlatformAction(id);
      if (!r.ok) notify({ kind: 'error', text: r.error });
    });

  return (
    <li id={syncSupported ? 'fanqie' : undefined} className={`space-y-1 py-3${syncSupported ? ' scroll-mt-4' : ''}`}>
      <div className="flex items-center gap-3">
        {renaming ? (
          <input className="rounded border px-2" value={draft} onChange={(e) => { setDraft(e.target.value); setError(''); }} />
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {builtin && <span className="rounded bg-stone-100 px-2 text-xs text-stone-600">预置</span>}
        {syncSupported && (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${authFailed ? 'bg-red-50 text-red-800' : authSummary ? 'bg-blue-50 text-blue-900' : 'bg-orange-100 text-orange-900'}`}>
            {authFailed ? '认证已失效' : authSummary ? '可同步' : '缺认证'}
          </span>
        )}
        <span className="flex-1 text-xs text-stone-500">被 {boundNovels} 本小说绑定</span>
        {!builtin && !renaming && (
          <>
            <button className="rounded border px-3" onClick={() => setRenaming(true)}>重命名</button>
            <button className="rounded border px-3 text-red-700" disabled={pending} onClick={remove}>删除</button>
          </>
        )}
        {renaming && (
          <>
            <button className="rounded bg-stone-900 px-3 text-white" disabled={pending} onClick={rename}>保存</button>
            <button className="rounded border px-3" onClick={() => { setRenaming(false); setDraft(name); setError(''); }}>取消</button>
          </>
        )}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {syncSupported ? (
        <>
          <PlatformAuthPanel platformId={id} summary={authSummary} authFailed={authFailed} />
          <PublishSettingsPanel platformId={id} useAi={useAi} dailyWordLimit={dailyWordLimit} />
        </>
      ) : (
        <p className="text-xs text-stone-500">暂不支持自动校验</p>
      )}
    </li>
  );
}
