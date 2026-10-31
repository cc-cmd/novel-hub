'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { rescanNovelAction } from '@/app/actions/library';
import { useNotice } from './notice';

export function RescanNovelButton({ novelId }: { novelId: number }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { notify } = useNotice();
  return (
    <button className="rounded border px-4" disabled={pending}
      onClick={() => start(async () => {
        const r = await rescanNovelAction(novelId);
        if (!r.ok) return notify({ kind: 'error', text: r.error });
        notify({ kind: 'success', text: `扫描完成：新增 ${r.data.added} 章、更新 ${r.data.updated} 章、${r.data.issues} 个文件无法识别` });
        router.refresh();
      })}>
      {pending ? '扫描中…' : '重新扫描'}
    </button>
  );
}
