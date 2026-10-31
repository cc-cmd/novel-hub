'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { rescanNovelAction, setArchivedAction } from '@/app/actions/library';
import { useNotice } from './notice';

export function CardMenu({ novelId, name, archived }: { novelId: number; name: string; archived: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { notify } = useNotice();

  const rescan = () =>
    start(async () => {
      const r = await rescanNovelAction(novelId);
      setOpen(false);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      notify({ kind: 'success', text: `《${name}》扫描完成：新增 ${r.data.added} 章、更新 ${r.data.updated} 章、${r.data.issues} 个文件无法识别` });
      router.refresh();
    });
  const toggleArchive = () =>
    start(async () => {
      const r = await setArchivedAction(novelId, !archived);
      setOpen(false);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      notify({ kind: 'success', text: archived ? `已取消归档《${name}》，章节已同步` : `已归档《${name}》，磁盘文件未改动` });
      router.refresh();
    });

  return (
    <div className="relative">
      <button aria-label="更多操作" aria-expanded={open} className="rounded px-2" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <ul className="absolute right-0 z-10 mt-1 w-44 rounded border bg-white py-1 shadow">
          <li><button className="w-full px-3 text-left" disabled={pending} onClick={rescan}>重新扫描此书</button></li>
          <li><Link className="flex min-h-[44px] items-center px-3" href={`/novels/${novelId}`}>设置章节目录</Link></li>
          <li><button className="w-full px-3 text-left" disabled={pending} onClick={toggleArchive}>{archived ? '取消归档' : '归档'}</button></li>
        </ul>
      )}
    </div>
  );
}
