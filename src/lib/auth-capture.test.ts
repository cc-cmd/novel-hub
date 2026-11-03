import { describe, expect, it } from 'vitest';
import { makeDb } from '@/test/helpers';
import { authFromHeaders, captureStatus, startCapture, waitForFanqieAuth, type SocketCtor } from './auth-capture';

/** 假 CDP：连上后按脚本推送事件；记录收到的命令。 */
function fakeCdp(events: Array<Record<string, unknown>>, opts: { closeAfter?: boolean } = {}) {
  const sent: string[] = [];
  const Ws = class {
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
      setTimeout(() => {
        this.onopen?.({});
        for (const ev of events) this.onmessage?.({ data: JSON.stringify(ev) });
        if (opts.closeAfter) this.onclose?.({});
      }, 0);
    }
    send(d: string) { sent.push(JSON.parse(d).method); }
    close() {}
  } as unknown as SocketCtor;
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('/json/list')) return Response.json([{ type: 'page', url: 'https://fanqienovel.com/main/writer/login', webSocketDebuggerUrl: 'ws://page' }]);
    return Response.json({});
  }) as typeof fetch;
  return { Ws, fetchImpl, sent };
}

const extra = (headers: Record<string, string>) => ({ method: 'Network.requestWillBeSentExtraInfo', params: { headers } });

describe('authFromHeaders', () => {
  it('大小写不敏感，缺任一项返回 null', () => {
    expect(authFromHeaders({ cookie: 'a=1', 'X-Secsdk-Csrf-Token': 't' })).toEqual({ cookie: 'a=1', csrfToken: 't' });
    expect(authFromHeaders({ Cookie: 'a=1' })).toBeNull();
  });
});

describe('waitForFanqieAuth', () => {
  it('忽略无认证的请求，取第一条同时带 Cookie 与 CSRF 的请求；连上后打开作家后台', async () => {
    const f = fakeCdp([extra({ Cookie: 'x' }), { method: 'Other' }, extra({ Cookie: 'sid=1', 'x-secsdk-csrf-token': 'tok' })]);
    await expect(waitForFanqieAuth({ fetchImpl: f.fetchImpl, WebSocketImpl: f.Ws, timeoutMs: 1000 })).resolves.toEqual({ cookie: 'sid=1', csrfToken: 'tok' });
    expect(f.sent).toEqual(['Network.enable', 'Page.enable', 'Page.navigate']);
  });
  it('窗口被关闭 → 报错', async () => {
    const f = fakeCdp([], { closeAfter: true });
    await expect(waitForFanqieAuth({ fetchImpl: f.fetchImpl, WebSocketImpl: f.Ws, timeoutMs: 1000 })).rejects.toThrow('登录窗口已关闭');
  });
  it('超时 → 报错', async () => {
    const f = fakeCdp([]);
    await expect(waitForFanqieAuth({ fetchImpl: f.fetchImpl, WebSocketImpl: f.Ws, timeoutMs: 20 })).rejects.toThrow('超时');
  });
  it('调试端口一直连不上 → 报错', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    await expect(waitForFanqieAuth({ fetchImpl, timeoutMs: 20, pollMs: 5 })).rejects.toThrow('未能连接');
  });
});

describe('startCapture', () => {
  it('成功：保存认证并标记 done；失败：记录错误信息', async () => {
    const db = makeDb();
    const saved: unknown[] = [];
    const f = fakeCdp([extra({ Cookie: 'sid=1', 'X-Secsdk-Csrf-Token': 'tok' })]);
    const { done } = await startCapture(db, 1, { launch: async () => {}, save: async (_d, _id, a) => { saved.push(a); }, fetchImpl: f.fetchImpl, WebSocketImpl: f.Ws, timeoutMs: 1000 });
    await done;
    expect(saved).toEqual([{ cookie: 'sid=1', csrfToken: 'tok' }]);
    expect(captureStatus(1).state).toBe('done');

    const g = fakeCdp([extra({ Cookie: 'sid=1', 'X-Secsdk-Csrf-Token': 'tok' })]);
    const r = await startCapture(db, 2, { launch: async () => {}, save: async () => { throw new Error('boom'); }, fetchImpl: g.fetchImpl, WebSocketImpl: g.Ws, timeoutMs: 1000 });
    await r.done;
    expect(captureStatus(2)).toEqual({ state: 'error', message: '获取失败' });
  });
});
