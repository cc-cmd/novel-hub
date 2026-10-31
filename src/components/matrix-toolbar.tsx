'use client';
import { useRouter } from 'next/navigation';
import type { Filter } from '@/lib/matrix';

export function MatrixToolbar(p: {
  novelId: number;
  filter: Filter;
  platformId: number | null;
  counts: { all: number; stale: number; unpublished: number };
  shown: number;
  total: number;
  platforms: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const go = (filter: Filter, platformId: number | null) => {
    const q = new URLSearchParams();
    if (filter !== 'all') q.set('filter', filter);
    if (platformId) q.set('platform', String(platformId));
    const s = q.toString();
    router.replace(`/novels/${p.novelId}${s ? `?${s}` : ''}`);
  };
  const seg: Array<[Filter, string, number]> = [
    ['all', '全部', p.counts.all], ['stale', '只看需更新', p.counts.stale], ['unpublished', '只看未发布', p.counts.unpublished],
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" className="inline-flex overflow-hidden rounded border">
        {seg.map(([f, label, n]) => (
          <button key={f} aria-pressed={p.filter === f} onClick={() => go(f, p.platformId)}
            className={`px-3 text-sm ${p.filter === f ? 'bg-stone-900 text-white' : 'bg-white'}`}>
            {label} <span className="font-mono">{n}</span>
          </button>
        ))}
      </div>
      <select className="rounded border px-2 text-sm" value={p.platformId !== null && p.platforms.some((x) => x.id === p.platformId) ? p.platformId : ''} aria-label="限定平台"
        onChange={(e) => go(p.filter, e.target.value ? Number(e.target.value) : null)}>
        <option value="">全部平台</option>
        {p.platforms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <span className="ml-auto font-mono text-xs text-stone-600">显示 {p.shown} / 共 {p.total} 章</span>
    </div>
  );
}
