export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded bg-stone-200" />
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(400px, 100%), 1fr))' }}>
        {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded border bg-stone-100" />)}
      </div>
      <p className="text-sm text-stone-500">正在扫描并同步…</p>
    </div>
  );
}
