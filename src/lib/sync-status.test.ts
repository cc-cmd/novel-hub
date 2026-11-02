import { describe, expect, it } from 'vitest';
import { cardSyncLine, fmtSyncTime, isAuthSyncError, staleReason, syncErrorLabel, syncStrip } from './sync-status';

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
const TODAY = new Date(2026, 10, 2, 14, 32).getTime();
const AUTH = '认证无效或已过期，请重新获取 Cookie 与 CSRF Token';

describe('syncStrip（F7.20 文案，REQ-07 §6）', () => {
  it('从未同步', () => {
    expect(syncStrip({ lastSyncedAt: null, lastSyncError: null, changedCount: 0, now: NOW }))
      .toEqual({ tone: 'info', title: '尚未同步', detail: '点“重新扫描”获取番茄线上状态。' });
  });
  it('刚同步（1 分钟内）', () => {
    expect(syncStrip({ lastSyncedAt: NOW - 1000, lastSyncError: null, changedCount: 0, now: NOW }))
      .toMatchObject({ title: '番茄状态已是最新', detail: '刚刚同步。状态由番茄同步，不能手动修改。' });
  });
  it('有过同步：显示时间；有改动才提示', () => {
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: null, changedCount: 2, now: NOW }))
      .toEqual({ tone: 'info', title: '最近同步：今天 14:32', detail: '2 章在同步后有本地改动，重新扫描后状态才会更新。' });
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: null, changedCount: 0, now: NOW }).detail).toBe('状态由番茄同步，不能手动修改。');
  });
  it('上次失败：提醒状态可能过期，优先于其他文案', () => {
    expect(syncStrip({ lastSyncedAt: TODAY, lastSyncError: AUTH, changedCount: 2, now: NOW }))
      .toEqual({ tone: 'warn', title: '上次同步失败', detail: '下方仍是今天 14:32 的状态，可能已过期。' });
    expect(syncStrip({ lastSyncedAt: null, lastSyncError: AUTH, changedCount: 0, now: NOW }).detail).toBe('尚无成功同步的记录。');
  });
});

it('staleReason：只用已入库字段推断', () => {
  expect(staleReason(3190, 3190)).toBe('字数相同，标题不同');
  expect(staleReason(3198, 3245)).toBe('字数不同，内容不一致');
  expect(staleReason(null, 3245)).toBe('线上内容不一致');
});

it('失败原因', () => {
  expect(isAuthSyncError(AUTH)).toBe(true);
  expect(isAuthSyncError('番茄暂时无法访问，稍后重试')).toBe(false);
  expect(isAuthSyncError(null)).toBe(false);
  expect(syncErrorLabel(AUTH)).toBe('认证已失效');
  expect(syncErrorLabel('番茄暂时无法访问，稍后重试')).toBe('番茄暂时无法访问，稍后重试');
});

it('fmtSyncTime', () => {
  expect(fmtSyncTime(TODAY, NOW)).toBe('今天 14:32');
  expect(fmtSyncTime(new Date(2026, 9, 24, 9, 5).getTime(), NOW)).toBe('10-24 09:05');
});

it('cardSyncLine', () => {
  expect(cardSyncLine({ lastSyncedAt: TODAY, lastSyncError: null, now: NOW })).toEqual({ text: '最近同步：今天 14:32', failed: false });
  expect(cardSyncLine({ lastSyncedAt: TODAY, lastSyncError: AUTH, now: NOW })).toEqual({ text: '同步失败：认证已失效，状态未改动', failed: true });
  expect(cardSyncLine({ lastSyncedAt: null, lastSyncError: null, now: NOW })).toEqual({ text: '尚未同步', failed: false });
});
