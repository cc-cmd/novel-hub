'use client';
import { useRouter } from 'next/navigation';

export function RetryButton() {
  const router = useRouter();
  return <button className="rounded border px-3" onClick={() => router.refresh()}>点击重试</button>;
}
