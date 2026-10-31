'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { saveChapterAction } from '@/app/actions/chapters';
import { CONFLICT_MESSAGE } from '@/lib/chapters-constants';
import { countWords, toPublishBody } from '@/lib/publish';

interface Props {
  novelId: number;
  novelName: string;
  chapterId: number;
  heading: string; // 例：第3章 开端
  filePath: string;
  initialContent: string;
  initialBaseHash: string | null;
  fileMissing: boolean;
  readError: string | null;
  aside?: React.ReactNode;
}

export function ChapterEditor(p: Props) {
  const router = useRouter();
  const [content, setContent] = useState(p.initialContent);
  const [saved, setSaved] = useState(p.initialContent);
  const [baseHash, setBaseHash] = useState(p.initialBaseHash);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, start] = useTransition();

  const disabled = p.fileMissing || !!p.readError;
  const dirty = content !== saved;
  const words = countWords(toPublishBody(content));

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = (overwrite = false) =>
    start(async () => {
      if (!baseHash) return;
      setError('');
      const r = await saveChapterAction(p.chapterId, content, baseHash, overwrite);
      if (!r.ok) {
        if (r.error === CONFLICT_MESSAGE) setConflict(true);
        else setError(r.error);
        return;
      }
      setConflict(false);
      setSaved(content);
      setBaseHash(r.data.baseHash);
      setJustSaved(true);
      router.refresh(); // 刷新右侧平台状态卡（可能变为「需更新」）
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <Link className="text-sm underline" href={`/novels/${p.novelId}`}>← {p.novelName}</Link>
          <h1 className="font-serif text-xl">{p.heading}</h1>
          <div className="font-mono text-xs text-stone-500">{p.filePath}</div>
        </div>
        {/* REQ-05 在此加入「复制标题+正文」按钮 */}
        <button
          className="rounded bg-stone-900 px-4 text-white disabled:opacity-40"
          disabled={disabled || !dirty || pending}
          onClick={() => save()}
        >
          {pending ? '保存中…' : '保存'}
        </button>
      </div>

      {p.fileMissing && <Banner kind="error">文件丢失，无法编辑</Banner>}
      {p.readError && <Banner kind="error">{p.readError}</Banner>}
      {error && (
        <Banner kind="error">
          保存失败，文件未被修改：{error.replace('保存失败，文件未被修改：', '')}{' '}
          <button className="underline" onClick={() => save()}>重试保存</button>
        </Banner>
      )}
      {conflict && (
        <Banner kind="warn">
          文件已被外部修改{' '}
          <button className="underline" onClick={() => save(true)}>覆盖磁盘文件</button>{' '}
          <button className="underline" onClick={() => router.refresh()}>放弃并重新加载</button>
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <textarea
            className="min-h-[60vh] w-full resize-y rounded border bg-white p-4 font-serif leading-8 disabled:bg-stone-100"
            value={content}
            disabled={disabled}
            onChange={(e) => { setContent(e.target.value); setJustSaved(false); }}
          />
          <div className="flex justify-between font-mono text-xs text-stone-600">
            <span>{words} 字</span>
            <span>{dirty ? '未保存修改' : justSaved ? '已写回文件，字数与状态已更新' : '与文件一致'}</span>
          </div>
        </div>
        <aside className="space-y-3">{p.aside}</aside>
      </div>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'error' | 'warn'; children: React.ReactNode }) {
  const cls = kind === 'error' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900';
  return <div role="alert" className={`rounded border px-4 py-2 text-sm ${cls}`}>{children}</div>;
}
