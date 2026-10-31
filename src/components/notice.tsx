'use client';
import { createContext, useCallback, useContext, useState } from 'react';

export interface NoticeInput {
  kind: 'success' | 'error' | 'warn';
  text: string;
  undo?: () => void | Promise<void>;
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
        <div role="status" className={`mx-auto mt-4 flex max-w-6xl items-center gap-3 rounded border px-4 py-2 ${COLORS[n.kind]}`}>
          <span className="flex-1">{n.text}</span>
          {n.undo && (
            <button className="underline" onClick={async () => { await n.undo!(); setN(null); }}>
              撤销
            </button>
          )}
          <button aria-label="关闭" onClick={() => setN(null)}>×</button>
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}
