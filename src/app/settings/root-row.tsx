'use client';
import { useState, useTransition } from 'react';
import { removeRootAction } from '@/app/actions/library';
import { useNotice } from '@/components/notice';
import type { RootInfo } from '@/lib/library';

const STATE_TEXT = (r: RootInfo) =>
  r.state === 'ok'
    ? `正常 · 已识别 ${r.novelCount} 本小说`
    : r.state === 'missing'
      ? '目录不存在 · 已有记录保留'
      : '无读取权限 · 已有记录保留';

export function RootRow({ root }: { root: RootInfo }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const remove = () =>
    start(async () => {
      const r = await removeRootAction(root.id);
      if (!r.ok) return notify({ kind: 'error', text: r.error });
      notify({ kind: 'success', text: `已移除 ${root.path}，磁盘文件未改动` });
    });

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-mono text-sm">{root.path}</div>
          <div className={`text-xs ${root.state === 'ok' ? 'text-stone-500' : 'text-red-700'}`}>{STATE_TEXT(root)}</div>
        </div>
        {!confirming && <button className="rounded border px-3" onClick={() => setConfirming(true)}>移除</button>}
      </div>
      {confirming && (
        <div className="flex items-center gap-3 rounded bg-amber-50 p-3 text-sm">
          <span className="flex-1">移除后其下小说保留记录，磁盘文件不受影响。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={remove}>确认移除</button>
          <button className="rounded border px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
    </li>
  );
}
