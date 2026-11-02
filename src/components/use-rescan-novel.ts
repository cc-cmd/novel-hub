'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { scanNovelLocalAction, syncPlatformsAction } from '@/app/actions/library';
import { runRescanNovel, unwrap } from '@/lib/rescan-flow';
import { buildRescanNotice } from '@/lib/sync-notice';
import { useNotice } from './notice';

export function useRescanNovel(novelId: number, prefix = '') {
  const [pending, start] = useTransition();
  const [stage, setStage] = useState<'local' | 'remote'>('local');
  const router = useRouter();
  const { notify } = useNotice();
  const rescan = (after?: () => void) =>
    start(async () => {
      try {
        const { local, platformSync } = await runRescanNovel(
          { local: async () => unwrap(await scanNovelLocalAction(novelId)), platforms: async () => unwrap(await syncPlatformsAction(novelId)) },
          setStage,
        );
        if (local.error) {
          notify({ kind: 'warn', text: `${prefix}本地目录不可访问，未执行同步，各章状态未改动` });
        } else {
          const added = local.added > 0 ? `新增 ${local.added} 章、` : '';
          const n = buildRescanNotice(`${prefix}本地扫描完成：${added}更新 ${local.updated} 章，${local.issues} 个文件需要处理`, platformSync, 'novel');
          notify({
            kind: n.kind, text: n.text,
            alert: n.alert ? { text: n.alert.text, link: n.alert.settingsLink ? { href: '/settings#fanqie', label: '去设置' } : undefined } : undefined,
          });
        }
        router.refresh();
      } catch (e) {
        notify({ kind: 'error', text: (e as Error).message });
      } finally {
        after?.();
      }
    });
  return { pending, stage, rescan };
}
