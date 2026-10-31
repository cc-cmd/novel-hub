import type { ProblemFile } from '@/lib/chapters';

export function ProblemFiles({ problems }: { problems: ProblemFile[] }) {
  if (problems.length === 0) return null;
  return (
    <details className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm">
      <summary className="cursor-pointer">{problems.length} 个文件需要处理，不影响其他章节</summary>
      <ul className="mt-2 space-y-1">
        {problems.map((p) => (
          <li key={`${p.fileName}-${p.reason}`}>
            <span className="font-mono">{p.fileName}</span> —— {p.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
