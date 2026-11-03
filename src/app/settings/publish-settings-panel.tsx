'use client';
import { useState, useTransition } from 'react';
import { setPublishSettingsAction } from '@/app/actions/publish';
import { useNotice } from '@/components/notice';

/** 番茄发布设置：AI 标记与每日新发字数上限（平台约 2 万字，0 点重置；覆盖不计入）。 */
export function PublishSettingsPanel({ platformId, useAi, dailyWordLimit }: { platformId: number; useAi: number; dailyWordLimit: number }) {
  const [ai, setAi] = useState(useAi);
  const [limit, setLimit] = useState(String(dailyWordLimit));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { notify } = useNotice();
  const dirty = ai !== useAi || limit !== String(dailyWordLimit);
  const save = () =>
    start(async () => {
      const r = await setPublishSettingsAction(platformId, ai, Number(limit));
      if (!r.ok) return setError(r.error);
      setError('');
      notify({ kind: 'success', text: '已保存发布设置' });
    });
  return (
    <div className="space-y-2 rounded border bg-stone-50 p-3 text-sm">
      <span className="font-medium">发布设置</span>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">AI 标记（use_ai）
          <select className="mt-1 block rounded border bg-white px-2 py-1" value={ai} onChange={(e) => { setAi(Number(e.target.value)); setError(''); }}>
            <option value={2}>2 · 未使用 / 其他</option>
            <option value={1}>1 · 已使用 AI</option>
          </select>
        </label>
        <label className="block">每日新发字数上限
          <input type="number" min={1000} max={200000} step={1000} className="mt-1 block w-32 rounded border px-2 py-1 font-mono" value={limit}
            onChange={(e) => { setLimit(e.target.value); setError(''); }} />
        </label>
        <button className="rounded border bg-white px-3 py-1" disabled={pending || !dirty} onClick={save}>保存</button>
      </div>
      <p className="text-xs text-stone-600">覆盖已发布章节时传 0 不生效，因此只提供 1 和 2。覆盖不计入每日额度。</p>
      {error && <p role="alert" className="font-medium text-red-700">{error}</p>}
    </div>
  );
}
