'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { rescanAction } from '@/app/actions/library';
import { AddRootForm } from './add-root-form';
import { useNotice } from './notice';
import type { Sort } from '@/lib/stats';

export function DashboardToolbar(p: { novelCount: number; rootCount: number; showArchived: boolean; sort: Sort }) {
  const router = useRouter();
  const { notify } = useNotice();
  const [adding, setAdding] = useState(false);
  const [scanning, startScan] = useTransition();

  const nav = (archived: boolean, sort: Sort) => {
    const q = new URLSearchParams();
    if (archived) q.set('archived', '1');
    if (sort !== 'recent') q.set('sort', sort);
    const s = q.toString();
    router.replace(s ? `/?${s}` : '/');
  };

  const scan = async (prefix?: string) => {
    const r = await rescanAction();
    if (!r.ok) return notify({ kind: 'error', text: r.error });
    const s = r.data;
    const changed = s.chapters.added + s.chapters.updated + s.chapters.restored;
    notify({
      kind: s.errors.length ? 'warn' : 'success',
      text: prefix ?? `新增 ${s.newNovels} 本、更新 ${changed} 章、${s.issues} 个文件无法识别`,
    });
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="font-serif text-2xl">我的小说</h1>
          <p className="font-mono text-xs text-stone-500">{p.novelCount} 本小说 · {p.rootCount} 个根目录</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={p.showArchived} onChange={(e) => nav(e.target.checked, p.sort)} />
          显示已归档
        </label>
        <select className="rounded border px-2 text-sm" aria-label="排序" value={p.sort} onChange={(e) => nav(p.showArchived, e.target.value as Sort)}>
          <option value="recent">最近更新</option>
          <option value="name">名称</option>
          <option value="stale">需更新数</option>
        </select>
        <button className="rounded border px-4" disabled={scanning} onClick={() => startScan(() => scan())}>
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
        <button className="rounded bg-stone-900 px-4 text-white" aria-expanded={adding} onClick={() => setAdding(!adding)}>添加小说目录</button>
      </div>
      {adding && (
        <div className="rounded border bg-white p-4">
          <AddRootForm
            submitLabel="添加并扫描"
            onCancel={() => setAdding(false)}
            onSuccess={async (path) => {
              setAdding(false);
              await scan(`已添加 ${path}，扫描完成`);
            }}
          />
        </div>
      )}
    </div>
  );
}
