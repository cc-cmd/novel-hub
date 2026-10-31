'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updatePublicationInfoAction } from '@/app/actions/publications';
import type { MatrixCell } from '@/lib/matrix';
import { buildInfoPatch } from '@/lib/publication-patch';
import { Badge } from './badge';
import { useNotice } from './notice';
import { PublicationActions } from './publication-actions';

const toLocalInput = (ms: number | null) => {
  if (!ms) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

export function PlatformCard({ cell, chapterId, chapterLabel, fileMissing }: {
  cell: MatrixCell; chapterId: number; chapterLabel: string; fileMissing: boolean;
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

  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{cell.platformName}</h3>
        <Badge kind={cell.badge} title={cell.hint} />
      </div>
      {cell.hint && <p className="text-xs text-stone-600">{cell.hint}</p>}
      <PublicationActions
        chapterId={chapterId} platformId={cell.platformId} platformName={cell.platformName} chapterLabel={chapterLabel}
        status={cell.status} fileMissing={fileMissing} platformUrl={cell.platformUrl}
      />
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
