'use client';
import { useState, useTransition } from 'react';
import { clearPlatformAuthAction, savePlatformAuthAction } from '@/app/actions/platforms';
import { useNotice } from '@/components/notice';

/** 番茄认证信息。已保存时只显示掩码（服务端传入），原文永不回传到浏览器。 */
export function PlatformAuthPanel({ platformId, summary, authFailed }: { platformId: number; summary: string | null; authFailed: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const [cookie, setCookie] = useState('');
  const [csrf, setCsrf] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const { notify } = useNotice();

  const save = () =>
    start(async () => {
      const r = await savePlatformAuthAction(platformId, cookie, csrf);
      if (!r.ok) return setError(r.error.includes('暂时无法访问') ? `${r.error}。认证信息未保存` : r.error);
      setEditing(false);
      setSaved(true);
      setCookie('');
      setCsrf('');
      setError('');
    });
  const clear = () =>
    start(async () => {
      const r = await clearPlatformAuthAction(platformId);
      setConfirming(false);
      setSaved(false);
      if (!r.ok) notify({ kind: 'error', text: r.error });
    });
  const cancel = () => { setEditing(false); setCookie(''); setCsrf(''); setError(''); };

  return (
    <div className="space-y-2 rounded border bg-stone-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">认证信息</span>
        <span className="flex-1 font-mono text-stone-600">{summary ?? '未配置'}</span>
        {!editing && !confirming && <button className="rounded border bg-white px-3" onClick={() => { setEditing(true); setSaved(false); }}>{summary ? '更新' : '配置'}</button>}
        {summary && !editing && !confirming && <button className="px-2 text-red-700" onClick={() => { setConfirming(true); setSaved(false); }}>清除</button>}
      </div>
      {authFailed && !editing && (
        <p role="alert" className="rounded border border-dashed border-red-400 bg-red-50 px-3 py-2 font-medium text-red-800">认证已失效，番茄同步已暂停。请重新获取后点“更新”。</p>
      )}
      {confirming && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-orange-300 bg-orange-50 p-3 text-orange-900">
          <span className="flex-1">清除后，所有小说的番茄列显示“—”，看板不再统计。已有记录保留，重新配置并扫描后恢复。</span>
          <button className="rounded bg-red-700 px-3 text-white" disabled={pending} onClick={clear}>确认清除</button>
          <button className="rounded border bg-white px-3" onClick={() => setConfirming(false)}>取消</button>
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <p className="text-xs text-stone-600">在已登录的番茄作家后台，从浏览器开发者工具中复制请求头。只保存在本机数据库，保存后不再显示原文。</p>
          <label className="block font-medium">Cookie
            <textarea className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs font-normal" rows={3} autoComplete="off" spellCheck={false} value={cookie}
              onChange={(e) => { setCookie(e.target.value); setError(''); }} />
          </label>
          <label className="block font-medium">X-Secsdk-Csrf-Token
            <input type="password" className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs font-normal" autoComplete="off" value={csrf}
              onChange={(e) => { setCsrf(e.target.value); setError(''); }} />
          </label>
          {error && <p role="alert" className="font-medium text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button className="rounded bg-stone-900 px-3 py-1 font-medium text-white" disabled={pending} onClick={save}>{pending ? '校验中…' : '保存并校验'}</button>
            <button className="rounded border bg-white px-3" onClick={cancel}>取消</button>
          </div>
        </div>
      )}
      {saved && !editing && <p role="status" className="text-blue-900">✓ 认证信息已校验并保存。回到小说详情页点“重新扫描”即可同步。</p>}
    </div>
  );
}
