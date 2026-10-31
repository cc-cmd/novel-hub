'use client';
import { useState, useTransition } from 'react';
import { deletePlatformAction, renamePlatformAction } from '@/app/actions/platforms';
import { useNotice } from '@/components/notice';

export function PlatformRow({ id, name, builtin, boundNovels }: { id: number; name: string; builtin: boolean; boundNovels: number }) {
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
    <li className="space-y-1 py-3">
      <div className="flex items-center gap-3">
        {renaming ? (
          <input className="rounded border px-2" value={draft} onChange={(e) => { setDraft(e.target.value); setError(''); }} />
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {builtin && <span className="rounded bg-stone-100 px-2 text-xs text-stone-600">预置</span>}
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
    </li>
  );
}
