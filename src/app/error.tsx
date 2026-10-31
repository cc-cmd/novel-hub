'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-3 rounded border border-red-300 bg-red-50 p-6">
      <h2 className="font-semibold text-red-900">统计失败</h2>
      <p className="font-mono text-xs text-red-800">{error.message}</p>
      <button className="rounded bg-red-700 px-4 text-white" onClick={reset}>点击重试</button>
    </div>
  );
}
