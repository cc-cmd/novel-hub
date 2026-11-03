export function RatioBar(p: { published: number; stale: number; unpublished: number }) {
  const total = p.published + p.stale + p.unpublished;
  const seg = [['bg-blue-600', p.published, '已发'], ['bg-orange-400', p.stale, '需更新'], ['bg-stone-200', p.unpublished, '未发']] as const;
  const label = seg.filter(([, n]) => n > 0).map(([, n, l]) => `${l} ${n}`).join('，') || '无章节';
  return (
    <div role="img" aria-label={label} className="flex h-2 w-full overflow-hidden rounded bg-stone-100">
      {total > 0 && seg.map(([cls, n, l]) => n > 0 && <div key={l} className={cls} style={{ width: `${(n / total) * 100}%` }} />)}
    </div>
  );
}
