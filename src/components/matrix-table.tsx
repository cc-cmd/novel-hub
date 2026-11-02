'use client';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { Filter, MatrixRow } from '@/lib/matrix';
import { staleReason } from '@/lib/sync-status';
import { Badge } from './badge';
import { CopyMenu } from './copy-menu';

export function MatrixTable({
  novelId, platforms, rows, filter,
}: {
  novelId: number;
  platforms: Array<{ id: number; name: string; bookUrl: string | null; configured: boolean }>;
  rows: MatrixRow[];
  filter: Filter;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="rounded border bg-white p-6 text-center text-stone-600">
        {filter === 'stale' ? '所有已发章节都是最新的' : filter === 'unpublished' ? '没有未发布的章节' : '没有章节'}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-stone-100 text-left">
          <tr>
            <th className="p-2">章号</th><th className="p-2">标题</th><th className="p-2 text-right">字数</th>
            {platforms.map((p) => (
              <th key={p.id} className="p-2">
                {p.configured && p.bookUrl ? <a className="underline" href={p.bookUrl} target="_blank" rel="noreferrer">{p.name} ↗</a> : p.name}
                {!p.configured && <span className="font-normal text-stone-500" title="未配置，无状态"> · 未配置</span>}
              </th>
            ))}
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ chapter: ch, cells }) => {
            const openCell = cells.find((c) => open === `${ch.id}:${c.platformId}`);
            const changed = cells.some((c) => c.changedSinceSync);
            return (
              <Fragment key={ch.id}>
                <tr className="border-t">
                  <td className="p-2 font-mono">{ch.seq}</td>
                  <td className="p-2 font-serif">
                    {ch.fileMissing ? (
                      <>
                        <span className="text-stone-600">{ch.title}</span>
                        <span className="ml-2 rounded border border-dashed border-red-400 bg-red-50 px-1.5 font-sans text-xs font-medium text-red-700" title="本地文件缺失，本章未参与同步，状态保持不变">! 文件丢失</span>
                      </>
                    ) : (
                      <Link className="underline" href={`/novels/${novelId}/chapters/${ch.id}`}>{ch.title}</Link>
                    )}
                    {changed && <span className="ml-2 whitespace-nowrap font-sans text-xs text-orange-800">同步后有改动</span>}
                  </td>
                  <td className="p-2 text-right font-mono">{ch.fileMissing ? '—' : ch.wordCount}</td>
                  {cells.map((c) => {
                    const key = `${ch.id}:${c.platformId}`;
                    return (
                      <td key={c.platformId} className={`p-2 ${c.configured ? '' : 'bg-stone-50'}`}>
                        {!c.badge ? (
                          <span className="text-stone-500" title={c.hint}>—</span>
                        ) : c.badge === 'stale' ? (
                          <button aria-label={`第${ch.seq}章 ${c.platformName}：需更新，查看差异`} aria-expanded={open === key} title={c.hint} onClick={() => setOpen(open === key ? null : key)}>
                            <Badge kind="stale" suffix=" ▾" />
                          </button>
                        ) : (
                          <Badge kind={c.badge} title={c.hint} />
                        )}
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
                  <tr className="border-t border-orange-300 bg-orange-50 text-orange-900">
                    <td colSpan={4 + platforms.length} className="p-3">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="font-bold">{staleReason(openCell.platformWordCount, ch.wordCount)}</span>
                        <span className="text-xs">
                          本地 <b className="font-mono font-medium">{ch.fileMissing ? '—' : ch.wordCount}</b> 字 · 线上 <b className="font-mono font-medium">{openCell.platformWordCount ?? '—'}</b> 字
                        </span>
                        <span className="flex-1" />
                        <CopyMenu chapterId={ch.id} fileMissing={ch.fileMissing} label="复制标题+正文" />
                        {platforms.find((p) => p.id === openCell.platformId)?.bookUrl && (
                          <a className="underline" href={platforms.find((p) => p.id === openCell.platformId)!.bookUrl!} target="_blank" rel="noreferrer">打开{openCell.platformName}后台 ↗</a>
                        )}
                        <span className="basis-full text-xs">在{openCell.platformName}覆盖后点“重新扫描”，状态会自动更新。覆盖会重新审核，请确认已定稿。</span>
                      </div>
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
