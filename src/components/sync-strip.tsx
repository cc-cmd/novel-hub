import { syncStrip } from '@/lib/sync-status';

export function SyncStrip(p: { lastSyncedAt: number | null; lastSyncError: string | null; changedCount: number }) {
  const s = syncStrip(p);
  const cls = s.tone === 'warn' ? 'border-orange-300 bg-orange-50 text-orange-900' : 'border-blue-200 bg-blue-50 text-blue-950';
  return (
    <div className={`flex flex-wrap gap-x-3 rounded border px-3 py-2 text-sm ${cls}`}>
      <span className="font-medium">{s.title}</span>
      <span>{s.detail}</span>
    </div>
  );
}
