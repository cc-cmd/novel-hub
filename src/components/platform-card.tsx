'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updatePublicationInfoAction } from '@/app/actions/publications';
import type { MatrixCell } from '@/lib/matrix';
import { buildInfoPatch } from '@/lib/publication-patch';
import { fmtSyncTime } from '@/lib/sync-status';
import { Badge } from './badge';
import { useNotice } from './notice';

const toLocalInput = (ms: number | null) => {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

export function PlatformCard({ cell, chapterId, novelId }: {
  cell: MatrixCell; chapterId: number; novelId: number;
}) {
  const router = useRouter();
  const { notify } = useNotice();
  const [url, setUrl] = useState(cell.platformUrl ?? '');
  const [at, setAt] = useState(toLocalInput(cell.publishedAt));
  const [atDirty, setAtDirty] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const patch = buildInfoPatch({ status: cell.status, url, at, atDirty });
      const r = await updatePublicationInfoAction(chapterId, cell.platformId, patch);
      if (!r.ok) return setError(r.error);
      notify({ kind: 'success', text: `已保存 ${cell.platformName} 发布信息` });
      router.refresh();
    });

  if (!cell.configured) {
    return (
      <section className="space-y-1 rounded border bg-stone-50 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{cell.platformName}</h3>
          <span className="text-stone-500">—</span>
        </div>
        <p className="text-xs text-stone-600">
          未配置，无状态。{cell.syncSupported ? <Link className="underline" href="/settings#fanqie">去配置</Link> : '暂不支持自动校验。'}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{cell.platformName}</h3>
        <Badge kind={cell.badge ?? cell.status} title={cell.hint} />
      </div>
      <p className="text-xs text-stone-600">
        状态由{cell.platformName}同步 · {cell.lastSyncedAt ? `最近同步：${fmtSyncTime(cell.lastSyncedAt)}` : '尚未同步'}
        {cell.platformWordCount !== null && <><br />同步时线上 <span className="font-mono">{cell.platformWordCount}</span> 字</>}
      </p>
      {cell.changedSinceSync && (
        <p role="status" className="rounded border border-orange-300 bg-orange-50 p-2 text-xs text-orange-900">
          本地已改动，这里的状态要等重新扫描才更新。<Link className="font-bold underline" href={`/novels/${novelId}`}>去重新扫描</Link>
        </p>
      )}
      <div className="space-y-2 text-sm">
        {cell.status !== 'unpublished' && (
          <label className="block">发布时间
            <input type="datetime-local" className="mt-1 w-full rounded border px-2" value={at} onChange={(e) => { setAt(e.target.value); setAtDirty(true); }} />
          </label>
        )}
        <label className="block">章节链接
          <input className="mt-1 w-full rounded border px-2" placeholder="https://…" value={url}
            onChange={(e) => { setUrl(e.target.value); setError(''); }} />
        </label>
        {error && <p className="text-red-700">{error}</p>}
        <button className="rounded border px-3" disabled={pending} onClick={save}>保存发布信息</button>
      </div>
    </section>
  );
}
