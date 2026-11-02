'use client';
import Link from 'next/link';
import { createContext, useCallback, useContext, useState } from 'react';

export interface NoticeInput {
  kind: 'success' | 'error' | 'warn';
  text: string;
  undo?: () => void | Promise<void>;
  alert?: { text: string; link?: { href: string; label: string } };
}
const Ctx = createContext<{ notify: (n: NoticeInput) => void }>({ notify: () => {} });
export const useNotice = () => useContext(Ctx);

const COLORS = {
  success: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  error: 'bg-red-50 border-red-300 text-red-900',
  warn: 'bg-amber-50 border-amber-300 text-amber-900',
};

export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [n, setN] = useState<NoticeInput | null>(null);
  const notify = useCallback((x: NoticeInput) => setN(x), []);
  return (
    <Ctx.Provider value={{ notify }}>
      {n && (
        <>
        <div role="status" className={`mx-auto mt-4 flex max-w-6xl items-center gap-3 rounded border px-4 py-2 ${COLORS[n.kind]}`}>
          <span className="flex-1">{n.text}</span>
          {n.undo && (
            <button className="underline" onClick={async () => {
              const current = n;
              try { await current.undo!(); } finally { setN((cur) => (cur === current ? null : cur)); }
            }}>
              撤销
            </button>
          )}
          <button aria-label="关闭" onClick={() => setN(null)}>×</button>
        </div>
        {n.alert && (
          <div role="alert" className="mx-auto mt-2 flex max-w-6xl items-center gap-3 rounded border border-dashed border-red-400 bg-red-50 px-4 py-2 font-medium text-red-800">
            <span className="flex-1">{n.alert.text}</span>
            {n.alert.link && <Link className="font-bold underline" href={n.alert.link.href}>{n.alert.link.label}</Link>}
          </div>
        )}
        </>
      )}
      {children}
    </Ctx.Provider>
  );
}
