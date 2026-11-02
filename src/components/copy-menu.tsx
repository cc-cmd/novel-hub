// src/components/copy-menu.tsx
'use client';
import { useState } from 'react';
import { copyChapterAction } from '@/app/actions/copy';
import { copyAsync } from '@/lib/clipboard';
import { copyNotice } from '@/lib/copy-notice';
import type { CopyPayload } from '@/lib/copy';
import type { CopyMode } from '@/lib/publish';
import { useNotice } from './notice';

export function CopyMenu({ chapterId, fileMissing, label }: { chapterId: number; fileMissing: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const { notify } = useNotice();

  const run = async (mode: CopyMode) => {
    setBusy(true);
    setFallback(null);
    const holder: { payload?: CopyPayload } = {};
    try {
      const r = await copyAsync(async () => {
        const res = await copyChapterAction(chapterId, mode);
        if (!res.ok) throw new Error(res.error);
        holder.payload = res.data;
        return res.data.text;
      });
      if (!r.ok) {
        setFallback(r.text);
        return notify({ kind: 'error', text: '无法写入剪贴板，请手动全选复制' });
      }
      setOpen(false);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
      notify({ kind: 'success', text: copyNotice(holder.payload!) });
    } catch (e) {
      notify({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (fileMissing) {
    return <button className="rounded border px-3 text-stone-400" disabled title="文件丢失">复制 ▾</button>;
  }
  return (
    <div className="relative inline-block">
      <div className="inline-flex overflow-hidden rounded border">
        <button className="px-3" disabled={busy} onClick={() => run('both')}>{done ? '已复制 ✓' : (label ?? '复制')}</button>
        <button className="border-l px-2" aria-label="更多复制方式" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      </div>
      {open && (
        <div className="mt-1 flex gap-2">
          <button className="rounded border px-3 text-sm" disabled={busy} onClick={() => run('title')}>仅标题</button>
          <button className="rounded border px-3 text-sm" disabled={busy} onClick={() => run('body')}>仅正文</button>
        </div>
      )}
      {fallback !== null && (
        <textarea readOnly className="mt-1 h-24 w-64 rounded border p-2 text-xs" value={fallback} onFocus={(e) => e.currentTarget.select()} />
      )}
    </div>
  );
}
