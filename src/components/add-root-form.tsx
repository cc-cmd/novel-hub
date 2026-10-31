'use client';
import { useState, useTransition } from 'react';
import { addRootAction } from '@/app/actions/library';

export function AddRootForm({
  submitLabel,
  onSuccess,
  onCancel,
}: {
  submitLabel: string;
  onSuccess?: (path: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = await addRootAction(value);
      if (!r.ok) return setError(r.error);
      setValue('');
      await onSuccess?.(r.data.path);
    });

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border px-3 font-mono text-sm"
          placeholder="/Users/me/小说"
          value={value}
          aria-invalid={!!error}
          onChange={(e) => { setValue(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="rounded bg-stone-900 px-4 text-white disabled:opacity-50" disabled={pending} onClick={submit}>
          {pending ? '处理中…' : submitLabel}
        </button>
        {onCancel && <button className="rounded border px-4" onClick={onCancel}>取消</button>}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
