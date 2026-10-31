// 唯一的「发布形态」转换实现。字数、hash、复制、需更新判断都依赖这里；不得在别处复制规则。

import type { Badge, PublishStatus } from './types';

export function parseChineseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in digits) {
      cur = digits[ch];
      seen = true;
    } else if (ch in units) {
      total += (cur || 1) * units[ch];
      cur = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + cur : null;
}

export interface H1Info {
  chapterNo: number;
  title: string;
}

// 同时支持 `# 第N章 标题`（需求文档约定）与真实稿件的 `# 《书名》· 第N章 · 标题`（pipeline.py 的 _TITLE_RE）
const H1_RE = /^#\s+(?:《[^》]+》\s*[·・]\s*)?第\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*章\s*(?:[·・:：]\s*|\s+)(.+?)\s*$/;

export function parseH1(markdown: string): H1Info | null {
  const first = markdown
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .find((l) => l.trim() !== '');
  if (!first) return null;
  const m = H1_RE.exec(first.trim());
  if (!m) return null;
  const chapterNo = parseChineseNumber(m[1]);
  const title = m[2].trim();
  if (chapterNo === null || !title) return null;
  return { chapterNo, title };
}

/** 移除首个非空行（若它是一级标题 `# `）。 */
export function stripLeadingH1(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() !== '');
  if (i >= 0 && /^#\s+/.test(lines[i])) lines.splice(i, 1);
  return lines.join('\n');
}

const ESC_BASE = 0xe000; // 把转义字符暂存到私有区，避免被后续规则误处理

function convertLine(line: string): string {
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return '';
  let s = line.replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, (_, c: string) => String.fromCharCode(ESC_BASE + c.charCodeAt(0)));
  s = s
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}(?:>\s?)+/, '')
    .replace(/^(\s*)[-*+]\s+/, '$1· ');
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
    .replace(/(?<!\*)\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1')
    .replace(/(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1');
  return s.replace(/[\uE000-\uE07F]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - ESC_BASE));
}

export function toPublishBody(markdown: string): string {
  let text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  text = stripLeadingH1(text);
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    out.push((inFence ? raw : convertLine(raw)).replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

export const platformTitle = (seq: number, title: string) => `第${seq}章 ${title}`;

export function resolveTitle(markdown: string, fallbackTitle: string): { title: string; h1: H1Info | null } {
  const h1 = parseH1(markdown);
  return { title: h1 ? h1.title : fallbackTitle, h1 };
}

export function buildPublishForm(markdown: string, seq: number, fallbackTitle: string): { title: string; body: string } {
  return { title: platformTitle(seq, resolveTitle(markdown, fallbackTitle).title), body: toPublishBody(markdown) };
}

export function countWords(body: string): number {
  return [...body.replace(/\s/g, '')].length;
}

export interface ChapterForBadge {
  contentHash: string | null;
  fileMissing: boolean;
}
export interface PublicationForBadge {
  status: PublishStatus;
  publishedHash: string | null;
}

export const OVERWRITE_WARNING = '覆盖会重新审核，请确认已定稿。';

/** 需更新 := status ∈ {pending_review, published} 且 published_hash ≠ content_hash。看板 SQL 必须与此等价。 */
export function isStale(ch: ChapterForBadge, pub?: PublicationForBadge | null): boolean {
  if (ch.fileMissing || !pub || pub.status === 'unpublished') return false;
  if (!ch.contentHash) return false;
  return !pub.publishedHash || pub.publishedHash !== ch.contentHash;
}

export function deriveBadge(ch: ChapterForBadge, pub?: PublicationForBadge | null): Badge {
  if (ch.fileMissing) return 'missing';
  if (!pub || pub.status === 'unpublished') return 'unpublished';
  return isStale(ch, pub) ? 'stale' : pub.status;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function badgeHint(a: {
  badge: Badge;
  status: PublishStatus;
  platformName: string;
  mtimeMs?: number | null;
}): string | undefined {
  switch (a.badge) {
    case 'pending_review':
      return `平台审核中，暂不能修改该章${a.platformName === '番茄' ? '（番茄审核时段 7:00–24:00）' : ''}`;
    case 'stale':
      if (a.status === 'pending_review') return '本地内容已变更，待审核结束后再覆盖';
      return `本地内容已${a.mtimeMs ? `于 ${fmtDate(a.mtimeMs)} ` : ''}变更，与 ${a.platformName} 已发版本不一致`;
    case 'missing':
      return '文件丢失';
    default:
      return undefined;
  }
}

export type CopyMode = 'both' | 'title' | 'body';

export function formatForCopy(markdown: string, seq: number, fallbackTitle: string, mode: CopyMode = 'both'): string {
  const { title, body } = buildPublishForm(markdown, seq, fallbackTitle);
  if (mode === 'title') return title;
  if (mode === 'body') return body;
  return body ? `${title}\n\n${body}` : title;
}
