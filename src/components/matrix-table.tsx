'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import type { Filter, MatrixRow } from '@/lib/matrix';
import type { Badge as BadgeKind, PublishStatus } from '@/lib/types';
import { Badge } from './badge';
import { CopyMenu } from './copy-menu';
import { PublicationActions } from './publication-actions';

const BADGE_OF: Record<PublishStatus, BadgeKind> = { unpublished: 'unpublished', pending_review: 'pending_review', published: 'published' };

export function MatrixTable({
  novelId, platforms, rows, filter,
}: {
  novelId: number;
  platforms: Array<{ id: number; name: string; bookUrl: string | null }>;
  rows: MatrixRow[];
  filter: Filter;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // 乐观覆盖：key = `${chapterId}:${platformId}`，值为预期状态；失败时置 null 回滚
  const [override, setOverride] = useState<Record<string, PublishStatus | null>>({});
  // router.refresh() 带来新的 rows 后，由服务端数据接管，清除所有乐观覆盖
  useEffect(() => setOverride({}), [rows]);

  if (rows.length === 0) {
    return (
      <p className="rounded border bg-white p-6 text-center text-stone-600">
        {filter === 'stale' ? '所有已发章节都是最新的' : filter === 'unpublished' ? '没有未发布的章节' : '没有章节'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-stone-100 text-left">
          <tr>
            <th className="p-2">章号</th><th className="p-2">标题</th><th className="p-2 text-right">字数</th>
            {platforms.map((p) => (
              <th key={p.id} className="p-2">
                {p.bookUrl ? <a className="underline" href={p.bookUrl} target="_blank" rel="noreferrer">{p.name} ↗</a> : p.name}
              </th>
            ))}
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ chapter: ch, cells }) => {
            const openCell = cells.find((c) => open === `${ch.id}:${c.platformId}`);
            return (
              <Fragment key={ch.id}>
                <tr className="border-t">
                  <td className="p-2 font-mono">{ch.seq}</td>
                  <td className="p-2 font-serif">
                    {ch.fileMissing ? ch.title : <Link className="underline" href={`/novels/${novelId}/chapters/${ch.id}`}>{ch.title}</Link>}
                  </td>
                  <td className="p-2 text-right font-mono">{ch.fileMissing ? '—' : ch.wordCount}</td>
                  {cells.map((c) => {
                    const key = `${ch.id}:${c.platformId}`;
                    const ov = override[key];
                    const badge = ov ? BADGE_OF[ov] : c.badge;
                    const clickable = !(ch.fileMissing && c.status === 'unpublished');
                    return (
                      <td key={c.platformId} className="p-2">
                        <button disabled={!clickable} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                          <Badge kind={badge} title={c.hint} />
                        </button>
                      </td>
                    );
                  })}
                  <td className="p-2">
                    <div className="flex gap-2">
                      <CopyMenu chapterId={ch.id} fileMissing={ch.fileMissing} />
                      {!ch.fileMissing && (
                        <Link className="inline-flex min-h-[44px] items-center rounded border px-3" href={`/novels/${novelId}/chapters/${ch.id}`}>编辑</Link>
                      )}
                    </div>
                  </td>
                </tr>
                {openCell && (
                  <tr className="bg-stone-50">
                    <td colSpan={4 + platforms.length} className="p-3">
                      <div className="mb-1 text-xs text-stone-500">{openCell.platformName}</div>
                      <PublicationActions
                        chapterId={ch.id}
                        platformId={openCell.platformId}
                        platformName={openCell.platformName}
                        chapterLabel={`第${ch.seq}章`}
                        status={openCell.status}
                        fileMissing={ch.fileMissing}
                        platformUrl={openCell.platformUrl}
                        editHref={`/novels/${novelId}/chapters/${ch.id}`}
                        onOptimistic={(next) => setOverride((o) => ({ ...o, [`${ch.id}:${openCell.platformId}`]: next }))}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
