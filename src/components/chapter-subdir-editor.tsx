'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setChapterSubdirAction } from '@/app/actions/library';
import { useNotice } from './notice';

export function ChapterSubdirEditor({ novelId, value }: { novelId: number; value: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();
  const { notify } = useNotice();

  const save = () =>
    start(async () => {
      const r = await setChapterSubdirAction(novelId, draft);
      if (!r.ok) return setError(r.error);
      setEditing(false);
      notify({ kind: 'success', text: '章节目录已更新并同步' });
      router.refresh();
    });

  if (!editing) {
    return (
      <span className="text-sm text-stone-600">
        章节目录：<span className="font-mono">{value ? `${value}/` : '（小说目录本身）'}</span>{' '}
        <button className="underline" onClick={() => { setDraft(value); setEditing(true); }}>修改</button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex gap-2">
        <input
          className="rounded border px-2 font-mono text-sm"
          value={draft}
          placeholder="留空 = 小说目录本身，例如：改稿"
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
        />
        <button className="rounded bg-stone-900 px-3 text-white" disabled={pending} onClick={save}>保存并同步</button>
        <button className="rounded border px-3" onClick={() => setEditing(false)}>取消</button>
      </span>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </span>
  );
}
