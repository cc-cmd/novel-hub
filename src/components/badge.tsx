import type { Badge as BadgeKind } from '@/lib/types';

const META: Record<BadgeKind, { icon: string; label: string; cls: string }> = {
  unpublished: { icon: '○', label: '未发', cls: 'bg-white border-stone-300 text-stone-600' },
  published: { icon: '✓', label: '已发', cls: 'bg-blue-600 border-blue-600 text-white' },
  stale: { icon: '↻', label: '需更新', cls: 'bg-orange-100 border-orange-300 text-orange-800' },
};

export function Badge({ kind, title, suffix }: { kind: BadgeKind; title?: string; suffix?: string }) {
  const m = META[kind];
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${m.cls}`}>
      <span aria-hidden>{m.icon}</span>
      {m.label}
      {suffix}
    </span>
  );
}
