'use client';
import { useRescanNovel } from './use-rescan-novel';

/** hasSync：这本书有已配置平台时按钮作为主操作，并显示同步阶段（F7.20）。 */
export function RescanNovelButton({ novelId, hasSync = false }: { novelId: number; hasSync?: boolean }) {
  const { pending, stage, rescan } = useRescanNovel(novelId);
  const label = !pending ? '重新扫描' : !hasSync ? '扫描中…' : stage === 'local' ? '扫描本地文件…' : '同步番茄…';
  return (
    <button className={`min-w-[124px] rounded px-4 ${hasSync ? 'bg-stone-900 font-medium text-white' : 'border'}`} disabled={pending} onClick={() => rescan()}>
      {label}
    </button>
  );
}
