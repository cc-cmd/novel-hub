// 一键获取番茄认证：启动专用 Chrome（独立用户目录 + 远程调试端口），用户在其中登录，
// 通过 CDP 的 Network.requestWillBeSentExtraInfo 读取页面自己发出的 /api/author 请求头。
// 原理同 fanqie-publish 技能的 capture-auth.mjs：不猜、不解密浏览器 Cookie 数据库。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '@/db';
import { saveFanqieAuth } from './platform-auth';
import { UserError } from './result';

export const CAPTURE_PORT = 9223; // 避开技能脚本默认的 9222
export const WRITER_URL = 'https://fanqienovel.com/main/writer/';
const TIMEOUT_MS = 5 * 60_000;

export interface Auth { cookie: string; csrfToken: string }

/** 请求头里同时有 Cookie 与 X-Secsdk-Csrf-Token 才算抓到（大小写不敏感）。 */
export function authFromHeaders(headers: Record<string, unknown>): Auth | null {
  let cookie = '';
  let csrfToken = '';
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === 'cookie' && typeof v === 'string') cookie = v;
    if (key === 'x-secsdk-csrf-token' && typeof v === 'string') csrfToken = v;
  }
  return cookie && csrfToken ? { cookie, csrfToken } : null;
}

interface Target { type: string; url: string; webSocketDebuggerUrl?: string }
interface Socket {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketCtor = new (url: string) => Socket;

export interface WaitDeps {
  port?: number;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: SocketCtor;
}

async function listTargets(port: number, fetchImpl: typeof fetch): Promise<Target[] | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
    return res.ok ? ((await res.json()) as Target[]) : null;
  } catch {
    return null;
  }
}

/** 连上番茄页面，打开作家后台，等到第一条带认证的请求。用户关掉窗口或超时则报错。 */
export async function waitForFanqieAuth(deps: WaitDeps = {}): Promise<Auth> {
  const port = deps.port ?? CAPTURE_PORT;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const Ws = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
  const pollMs = deps.pollMs ?? 500;
  const deadline = Date.now() + (deps.timeoutMs ?? TIMEOUT_MS);

  let page: Target | undefined;
  while (!page) {
    const targets = await listTargets(port, fetchImpl);
    page = targets?.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
    if (Date.now() > deadline) throw new UserError('未能连接到登录窗口，请重试');
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const ws = new Ws(page.webSocketDebuggerUrl!);
  return new Promise<Auth>((resolve, reject) => {
    let id = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      try { ws.close(); } catch { /* 已关闭 */ }
    };
    const timer = setTimeout(() => finish(() => reject(new UserError('等待登录超时（5 分钟），请重试'))), Math.max(0, deadline - Date.now()));
    const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
    ws.onopen = () => {
      send('Network.enable');
      send('Page.enable');
      send('Page.navigate', { url: WRITER_URL }); // 已登录时立即触发一次 /api/author 请求
    };
    ws.onmessage = (e) => {
      let m: { method?: string; params?: { headers?: Record<string, unknown> } };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.method !== 'Network.requestWillBeSentExtraInfo') return;
      const auth = authFromHeaders(m.params?.headers ?? {});
      if (auth) finish(() => resolve(auth));
    };
    ws.onerror = () => finish(() => reject(new UserError('与登录窗口的连接中断，请重试')));
    ws.onclose = () => finish(() => reject(new UserError('登录窗口已关闭，未获取到认证')));
  });
}

/** 关闭专用 Chrome（尽力而为）。 */
async function closeBrowser(port: number, fetchImpl: typeof fetch, Ws: SocketCtor): Promise<void> {
  try {
    const v = (await (await fetchImpl(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
    if (!v.webSocketDebuggerUrl) return;
    const ws = new Ws(v.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    ws.onerror = () => {};
  } catch {
    /* 窗口可能已被用户关闭 */
  }
}

export function chromePath(): string {
  return process.env.NOVEL_HUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
export function captureProfileDir(): string {
  return process.env.NOVEL_HUB_CHROME_PROFILE ?? path.join(process.cwd(), 'data', 'chrome-profile');
}

/** 启动专用 Chrome。用独立用户目录，不碰你日常 Chrome 的数据；登录态保存在该目录，下次通常免登录。 */
export function launchCaptureChrome(port = CAPTURE_PORT): Promise<void> {
  const bin = chromePath();
  if (!fs.existsSync(bin)) throw new UserError('未找到 Chrome，可通过环境变量 NOVEL_HUB_CHROME 指定路径');
  fs.mkdirSync(captureProfileDir(), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${captureProfileDir()}`, '--no-first-run', '--no-default-browser-check', WRITER_URL], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(new UserError('Chrome 启动失败')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export type CaptureState =
  | { state: 'idle' }
  | { state: 'waiting'; startedAt: number }
  | { state: 'done'; at: number }
  | { state: 'error'; message: string };

const g = globalThis as unknown as { __fanqieCapture?: Map<number, CaptureState> };
const jobs = () => (g.__fanqieCapture ??= new Map());

export function captureStatus(platformId: number): CaptureState {
  return jobs().get(platformId) ?? { state: 'idle' };
}

export interface CaptureDeps extends WaitDeps {
  launch?: (port: number) => Promise<void>;
  save?: (db: Db, platformId: number, auth: Auth) => Promise<void>;
}

/** 启动后台任务后立即返回；进度用 captureStatus 轮询。同一平台同时只跑一个。 */
export async function startCapture(db: Db, platformId: number, deps: CaptureDeps = {}): Promise<{ done: Promise<void> }> {
  if (captureStatus(platformId).state === 'waiting') throw new UserError('正在等待登录，请在弹出的 Chrome 窗口中完成');
  const port = deps.port ?? CAPTURE_PORT;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const Ws = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
  const save = deps.save ?? ((d, id, a) => saveFanqieAuth(d, id, a));
  await (deps.launch ?? launchCaptureChrome)(port);
  jobs().set(platformId, { state: 'waiting', startedAt: Date.now() });
  const done = (async () => {
    try {
      const auth = await waitForFanqieAuth({ ...deps, port, fetchImpl, WebSocketImpl: Ws });
      await save(db, platformId, auth);
      jobs().set(platformId, { state: 'done', at: Date.now() });
      await closeBrowser(port, fetchImpl, Ws);
    } catch (e) {
      jobs().set(platformId, { state: 'error', message: e instanceof UserError ? e.message : '获取失败' });
    }
  })();
  return { done };
}
