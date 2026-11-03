'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { planPublishAction, runPublishAction } from '@/app/actions/publish';
import type { PublishPlan, PublishResult } from '@/lib/fanqie-publish';
import { Badge } from './badge';

const OUTCOME: Record<PublishResult['outcome'], { label: string; cls: string }> = {
  published: { label: '已提交', cls: 'text-blue-900' },
  skipped: { label: '已跳过', cls: 'text-stone-600' },
  failed: { label: '失败', cls: 'text-red-700' },
  deferred: { label: '已顺延', cls: 'text-orange-800' },
};

/** 发布到番茄：先看计划（只读），勾选后二次确认才真正提交。覆盖会让线上章节回到审核中。 */
export function PublishPanel({ novelId, platformId, platformName }: { novelId: number; platformId: number; platformName: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<PublishResult[] | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      setError('');
      setResults(null);
      setConfirming(false);
      const r = await planPublishAction(novelId, platformId);
      if (!r.ok) return setError(r.error);
      setPlan(r.data);
      setSelected(new Set());
    });
  const run = () =>
    start(async () => {
      setError('');
      const r = await runPublishAction(novelId, platformId, [...selected]);
      setConfirming(false);
      if (!r.ok) return setError(r.error);
      setResults(r.data);
      setPlan(null);
      router.refresh();
    });

  const pickable = plan?.rows.filter((r) => !r.blocked) ?? [];
  const picked = pickable.filter((r) => selected.has(r.chapterId));
  const overwrites = picked.filter((r) => r.mode === 'overwrite').length;
  const newWords = picked.filter((r) => r.mode === 'new').reduce((s, r) => s + r.wordCount, 0);
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="space-y-3 rounded border bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">发布到{platformName}</h2>
        <span className="flex-1 text-xs text-stone-600">列出未发布与需更新的章节；有平台章节 ID 的覆盖，其余新发。</span>
        <button className="rounded border px-3 py-1" disabled={pending} onClick={load}>{pending && !confirming ? '读取中…' : plan ? '刷新计划' : '查看发布计划'}</button>
        {(plan || results) && <button className="px-2 text-stone-600" onClick={() => { setPlan(null); setResults(null); setError(''); }}>收起</button>}
      </div>
      {error && <p role="alert" className="font-medium text-red-700">{error}</p>}

      {plan && (plan.rows.length === 0 ? (
        <p className="text-stone-600">没有需要发布的章节：全部已发布，或尚未重新扫描。</p>
      ) : (
        <>
          <p className="font-mono text-xs text-stone-600">
            今日已新发 {plan.usedToday} / {plan.dailyLimit} 字 · AI 标记 use_ai={plan.useAi}
          </p>
          <div className="max-h-96 overflow-auto rounded border">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-stone-50 text-xs text-stone-600">
                <tr>
                  <th className="p-2">
                    <input type="checkbox" aria-label="全选可发布章节" checked={pickable.length > 0 && picked.length === pickable.length}
                      onChange={(e) => setSelected(new Set(e.target.checked ? pickable.map((r) => r.chapterId) : []))} />
                  </th>
                  <th className="p-2">章节</th><th className="p-2">状态</th><th className="p-2">方式</th><th className="p-2">字数</th><th className="p-2">分卷</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {plan.rows.map((r) => (
                  <tr key={r.chapterId} className={r.blocked ? 'text-stone-400' : ''}>
                    <td className="p-2">
                      <input type="checkbox" aria-label={`选择 ${r.title}`} disabled={!!r.blocked} checked={selected.has(r.chapterId)} onChange={() => toggle(r.chapterId)} />
                    </td>
                    <td className="p-2">{r.title}{r.blocked && <div className="text-xs text-orange-800">⚠ {r.blocked}</div>}</td>
                    <td className="p-2"><Badge kind={r.status} /></td>
                    <td className="p-2">{r.mode === 'overwrite' ? '覆盖' : '新发'}</td>
                    <td className="p-2 font-mono">{r.wordCount}</td>
                    <td className="p-2">{r.volumeName ?? '—'}{r.createVolume && <span className="text-xs text-blue-900">（将新建）</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!confirming ? (
            <button className="rounded bg-stone-900 px-3 py-1 font-medium text-white disabled:opacity-40" disabled={picked.length === 0 || pending} onClick={() => setConfirming(true)}>
              发布选中的 {picked.length} 章
            </button>
          ) : (
            <div role="alert" className="space-y-2 rounded border border-orange-300 bg-orange-50 p-3 text-orange-900">
              <p>
                将提交 {picked.length} 章到{platformName}
                {overwrites > 0 && `，其中 ${overwrites} 章覆盖线上内容（读者可见，覆盖后回到审核中，审核期间不能再改）`}
                {newWords > 0 && `；新发共 ${newWords} 字，计入每日额度`}。请确认改稿已定稿。
              </p>
              <div className="flex gap-2">
                <button className="rounded bg-red-700 px-3 py-1 font-medium text-white" disabled={pending} onClick={run}>{pending ? `提交中…（每章间隔 3 秒）` : '确认发布'}</button>
                <button className="rounded border bg-white px-3" disabled={pending} onClick={() => setConfirming(false)}>取消</button>
              </div>
            </div>
          )}
        </>
      ))}

      {results && (
        <div className="space-y-1">
          <p className="font-medium">
            完成：提交 {results.filter((r) => r.outcome === 'published').length} 章
            {results.some((r) => r.outcome !== 'published') && `，其余 ${results.filter((r) => r.outcome !== 'published').length} 章未提交`}。
            审核时段 7:00–24:00，审核通过后点「重新扫描」核对线上状态。
          </p>
          <ul className="divide-y rounded border">
            {results.map((r) => (
              <li key={r.chapterId} className="flex gap-3 p-2">
                <span className="flex-1">{r.title}<span className="ml-2 text-xs text-stone-500">{r.mode === 'overwrite' ? '覆盖' : '新发'}</span></span>
                <span className={OUTCOME[r.outcome].cls}>{OUTCOME[r.outcome].label}{r.message && `：${r.message}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
