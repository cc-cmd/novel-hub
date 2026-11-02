import Link from 'next/link';
import { RetryButton } from './retry-button';
import type { NovelStat } from '@/lib/stats';
import { CardMenu } from './card-menu';
import { RatioBar } from './ratio-bar';
import { cardSyncLine } from '@/lib/sync-status';

const TAG = 'rounded border px-2 py-0.5 text-xs';

export function NovelCard({ s }: { s: NovelStat }) {
  const n = s.novel;
  return (
    <article className={`space-y-3 rounded border bg-white p-4 ${n.archived ? 'opacity-60' : ''}`}>
      <header className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <Link href={`/novels/${n.id}`} className="font-serif text-lg underline-offset-2 hover:underline">{n.name}</Link>
          <div className="font-mono text-xs text-stone-600">
            {s.chapterCount} 章 · {s.wordCount} 字{s.missingCount > 0 && ` · 丢失 ${s.missingCount} 章`}
          </div>
          <div className="flex flex-wrap gap-1">
            {n.dirMissing && <span className={`${TAG} border-dashed border-red-400 text-red-700`}>{s.platforms.some((p) => p.configured) ? '目录丢失，未同步' : '目录丢失'}</span>}
            {n.rootRemoved && <span className={`${TAG} text-stone-600`}>根目录已移除</span>}
            {n.archived && <span className={`${TAG} text-stone-600`}>已归档</span>}
          </div>
        </div>
        {s.staleChapters > 0 && (
          <span className="rounded border border-orange-300 bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">↻ 需更新 {s.staleChapters}</span>
        )}
        <CardMenu novelId={n.id} name={n.name} archived={n.archived} />
      </header>

      {s.error ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-red-800">
          统计失败：<span className="font-mono text-xs">{s.error}</span>
          <RetryButton />
        </div>
      ) : s.platforms.length === 0 ? (
        <p className="text-sm text-stone-600">
          未绑定平台。<Link className="underline" href={`/novels/${n.id}`}>去绑定</Link>
        </p>
      ) : !s.platforms.some((p) => p.configured) ? (
        <p className="text-sm text-stone-600">未配置同步。<Link className="underline" href={`/novels/${n.id}`}>去配置</Link></p>
      ) : (
        <>
          <ul className="space-y-3">
            {s.platforms.filter((p) => p.configured).map((p) => {
              const line = n.dirMissing ? { text: '状态保持上次同步结果', failed: false } : cardSyncLine(p);
              return (
                <li key={p.platformId} className="space-y-1">
                  <RatioBar published={p.published} stale={p.stale} unpublished={p.unpublished} />
                  <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                    <span className="font-medium">{p.platformName}</span>
                    <span className="font-mono text-xs text-stone-700">
                      已发 {p.published} ·{' '}
                      {p.stale > 0 ? (
                        <Link className="font-bold text-orange-700 underline" href={`/novels/${n.id}?filter=stale&platform=${p.platformId}`}>需更新 {p.stale}</Link>
                      ) : (
                        <>需更新 {p.stale}</>
                      )}{' '}
                      ·{' '}
                      {p.unpublished > 0 ? (
                        <Link className="underline" href={`/novels/${n.id}?filter=unpublished&platform=${p.platformId}`}>未发 {p.unpublished}</Link>
                      ) : (
                        <>未发 {p.unpublished}</>
                      )}
                    </span>
                  </div>
                  <p className={`text-xs ${line.failed ? 'text-red-700' : 'text-stone-500'}`}>{line.text}</p>
                </li>
              );
            })}
          </ul>
          {s.platforms.some((p) => !p.configured) && (
            <p className="text-xs text-stone-500">{s.platforms.filter((p) => !p.configured).map((p) => p.platformName).join('、')} 未配置，不计入统计</p>
          )}
        </>
      )}
    </article>
  );
}
