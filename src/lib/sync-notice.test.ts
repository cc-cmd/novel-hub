import { describe, expect, it } from 'vitest';
import type { PlatformSyncOutcome } from './platform-sync';
import { buildRescanNotice } from './sync-notice';

const ok = (over: Partial<Extract<PlatformSyncOutcome, { ok: true }>> = {}): PlatformSyncOutcome => ({
  ok: true, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄',
  published: 38, stale: 2, unpublished: 10, skipped: 0, unreadable: 0, remoteExtra: 0, ...over,
});
const bad = (over: Partial<Extract<PlatformSyncOutcome, { ok: false }>> = {}): PlatformSyncOutcome => ({
  ok: false, novelId: 1, novelName: 'A', platformId: 1, platformName: '番茄', error: '番茄暂时无法访问，稍后重试', authFailed: false, ...over,
});

describe('buildRescanNotice', () => {
  it('无已配置平台：只有本地文案', () => {
    expect(buildRescanNotice('本地扫描完成', [], 'novel')).toEqual({ kind: 'success', text: '本地扫描完成', alert: null });
  });
  it('F7.13 成功汇总：丢失、线上多出、无法比对都计入', () => {
    expect(buildRescanNotice('本地扫描完成', [ok({ published: 6, stale: 2, unpublished: 3, skipped: 1, remoteExtra: 1, unreadable: 2 })], 'novel').text)
      .toBe('本地扫描完成。番茄同步完成：已发布 6、需更新 2、未发布 3；1 章文件丢失未比对；线上多出 1 章本地没有；2 章无法比对，状态未改动');
  });
  it('F7.21 单本失败：本地结果保留，错误单独一条', () => {
    expect(buildRescanNotice('本地扫描完成', [bad()], 'novel')).toEqual({
      kind: 'success', text: '本地扫描完成',
      alert: { text: '番茄暂时无法访问，稍后重试。各章状态未改动', settingsLink: false },
    });
  });
  it('单本认证失效：带去设置', () => {
    expect(buildRescanNotice('x', [bad({ authFailed: true, error: '认证无效或已过期' })], 'novel').alert).toEqual({
      text: '番茄同步失败：认证已失效，各章状态未改动', settingsLink: true,
    });
  });
  it('全局全部成功：求和', () => {
    expect(buildRescanNotice('x', [ok(), ok({ novelId: 2, published: 1, stale: 0, unpublished: 0 })], 'all').text).toContain('已发布 39、需更新 2、未发布 10');
  });
  it('AC7.15 全局部分失败：只汇总本数，详情在卡片上', () => {
    expect(buildRescanNotice('x', [ok(), bad({ novelId: 2 })], 'all')).toEqual({ kind: 'warn', text: 'x。番茄同步：1 本成功，1 本失败', alert: null });
  });
  it('全局认证失效：不重复错误条（看板顶部已有常驻错误条）', () => {
    expect(buildRescanNotice('x', [bad({ authFailed: true })], 'all')).toEqual({ kind: 'warn', text: 'x。番茄同步未执行：认证已失效', alert: null });
  });
});
