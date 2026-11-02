import { describe, expect, it } from 'vitest';
import type { PlatformSyncOutcome } from './platform-sync';
import type { SyncResult } from './sync';
import { runRescanAll, runRescanNovel, unwrap } from './rescan-flow';

const local = { added: 1, updated: 0, issues: 0 } as unknown as SyncResult;
const okOut = { ok: true, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄', published: 1, stale: 0, unpublished: 0, skipped: 0, unreadable: 0, remoteExtra: 0 } as PlatformSyncOutcome;

describe('runRescanNovel', () => {
  it('F7.8/F7.20 先本地后同步，并依次上报阶段', async () => {
    const stages: string[] = [];
    const r = await runRescanNovel({ local: async () => local, platforms: async () => [okOut] }, (s) => stages.push(s));
    expect(stages).toEqual(['local', 'remote']);
    expect(r.platformSync).toEqual([okOut]);
  });
  it('F7.15 本地扫描报错 → 不同步', async () => {
    const r = await runRescanNovel(
      { local: async () => ({ ...local, error: '目录不可读' }), platforms: async () => { throw new Error('不应联网'); } },
      () => {},
    );
    expect(r.platformSync).toEqual([]);
  });
  it('同步抛错不影响本地结果，转为失败结果', async () => {
    const r = await runRescanNovel({ local: async () => local, platforms: async () => { throw new Error('boom'); } }, () => {});
    expect(r.local).toBe(local);
    expect(r.platformSync[0]).toMatchObject({ ok: false, error: 'boom', authFailed: false });
  });
});

describe('runRescanAll', () => {
  const summary = (syncable: Array<{ id: number; name: string }>) => ({ syncable } as never);
  it('F7.9/F7.20 串行同步并上报 X/Y；AC7.15 一本失败不影响另一本', async () => {
    const seen: string[] = [];
    const calls: number[] = [];
    const r = await runRescanAll(
      {
        local: async () => summary([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]),
        sync: async (id) => {
          calls.push(id);
          if (id === 1) throw new Error('boom');
          return [okOut];
        },
      },
      (p) => seen.push(`${p.done}/${p.total}`),
      0,
    );
    expect(calls).toEqual([1, 2]);
    expect(seen).toEqual(['1/2', '2/2']);
    expect(r.platformSync.map((o) => o.ok)).toEqual([false, true]);
    expect(r.platformSync[0]).toMatchObject({ novelName: 'A', error: 'boom' });
  });
});

it('unwrap', () => {
  expect(unwrap({ ok: true, data: 1 })).toBe(1);
  expect(() => unwrap({ ok: false, error: 'x' })).toThrow('x');
});
