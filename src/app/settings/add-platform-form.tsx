'use client';
import { useState, useTransition } from 'react';
import { addPlatformAction } from '@/app/actions/platforms';

export function AddPlatformForm() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await addPlatformAction(value);
      if (!r.ok) return setError(r.error);
      setValue('');
    });
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input className="flex-1 rounded border px-3" placeholder="新增平台，如：晋江" value={value}
          onChange={(e) => { setValue(e.target.value); setError(''); }} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="rounded bg-stone-900 px-4 text-white" disabled={pending} onClick={submit}>添加</button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
