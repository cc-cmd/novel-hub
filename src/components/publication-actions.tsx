'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { publicationAction, restorePublicationAction } from '@/app/actions/publications';
import { OVERWRITE_WARNING } from '@/lib/publish';
import type { PubAction } from '@/lib/publications';
import type { PublishStatus } from '@/lib/types';
import { useNotice } from './notice';

const EXPECTED: Record<PubAction, PublishStatus> = {
  mark_pending: 'pending_review', mark_published: 'published', approve: 'published', resubmit: 'pending_review', cancel: 'unpublished',
};
const DONE_TEXT: Record<PubAction, string> = {
  mark_pending: '已标记为审核中', mark_published: '已标记为已发布', approve: '已标记为审核通过（已发布）',
  resubmit: '已重新提交，进入审核中', cancel: '已取消发布状态',
};

interface Props {
  chapterId: number;
  platformId: number;
  platformName: string;
  chapterLabel: string; // 例：第3章
  status: PublishStatus;
  fileMissing: boolean;
  platformUrl: string | null;
  editHref?: string;
  onOptimistic?: (next: PublishStatus | null) => void;
}

function Btn({ action, label, danger, pending, onRun }: { action: PubAction; label: string; danger?: boolean; pending: boolean; onRun: (a: PubAction) => void }) {
  return (
    <button className={`rounded border px-3 text-sm ${danger ? 'text-red-700' : ''}`} disabled={pending} onClick={() => onRun(action)}>
      {label}
    </button>
  );
}

export function PublicationActions(p: Props) {
  const router = useRouter();
  const { notify } = useNotice();
  const [pending, start] = useTransition();

  const run = (action: PubAction) =>
    start(async () => {
      p.onOptimistic?.(EXPECTED[action]);
      const r = await publicationAction(p.chapterId, p.platformId, action);
      if (!r.ok) {
        p.onOptimistic?.(null);
        return notify({ kind: 'error', text: r.error });
      }
      const text = `${p.chapterLabel} · ${p.platformName}：${DONE_TEXT[action]}`;
      if (action === 'cancel') {
        const before = r.data.before;
        notify({
          kind: 'success', text,
          undo: async () => {
            const u = await restorePublicationAction(p.chapterId, p.platformId, before);
            if (!u.ok) notify({ kind: 'error', text: u.error });
            router.refresh();
          },
        });
      } else {
        notify({ kind: 'success', text });
      }
      router.refresh();
    });

  if (p.fileMissing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-stone-600">文件丢失的章节没有可对照的内容，不能标记已发。</span>
        {p.status !== 'unpublished' && <Btn pending={pending} onRun={run} action="cancel" label="取消已发" danger />}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.status === 'unpublished' && (<><Btn pending={pending} onRun={run} action="mark_pending" label="标记审核中" /><Btn pending={pending} onRun={run} action="mark_published" label="标记已发布" /></>)}
      {p.status === 'pending_review' && (<><Btn pending={pending} onRun={run} action="approve" label="标记已发布（审核通过）" /><Btn pending={pending} onRun={run} action="cancel" label="取消" danger /></>)}
      {p.status === 'published' && (
        <>
          <Btn pending={pending} onRun={run} action="cancel" label="取消已发" danger />
          <Btn pending={pending} onRun={run} action="resubmit" label="重新提交（覆盖，进入审核中）" />
          <Btn pending={pending} onRun={run} action="mark_published" label="标记已发布（更新为当前版本）" />
          {p.editHref && <Link className="inline-flex min-h-[44px] items-center rounded border px-3 text-sm" href={p.editHref}>编辑发布信息</Link>}
          {p.platformUrl && (
            <a className="inline-flex min-h-[44px] items-center rounded border px-3 text-sm" href={p.platformUrl} target="_blank" rel="noreferrer">打开链接</a>
          )}
          <span className="text-xs text-amber-800">{OVERWRITE_WARNING}</span>
        </>
      )}
    </div>
  );
}
