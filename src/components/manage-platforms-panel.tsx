'use client';
import { useState, useTransition } from 'react';
import { bindPlatformAction, unbindPlatformAction } from '@/app/actions/platforms';
import { useNotice } from './notice';

interface Item { id: number; name: string; bound: boolean; bookUrl: string | null; publicationCount: number }

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
      {item.bound && (
        <div className="flex gap-2">
          <input className="flex-1 rounded border px-2 text-sm" placeholder="作品主页链接（可选）" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }} />
          <button className="rounded border px-3 text-sm" disabled={pending} onClick={() => bind(url)}>保存链接</button>
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
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
