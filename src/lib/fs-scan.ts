// src/lib/fs-scan.ts
import fs from 'node:fs';
import path from 'node:path';

export function normalizeRootPath(input: string): string {
  return path.resolve(input.trim());
}

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

const isDenied = (e: unknown) => ['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');

export function validateDirPath(input: string): PathCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: '请输入目录的绝对路径' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '路径不存在：请使用绝对路径' };
  const p = normalizeRootPath(raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    return { ok: false, error: isDenied(e) ? `无读取权限：${p}` : `路径不存在：${p}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `不是目录：${p}` };
  try {
    fs.readdirSync(p);
  } catch {
    return { ok: false, error: `无读取权限：${p}` };
  }
  return { ok: true, path: p };
}

export type DirState = 'ok' | 'missing' | 'denied';

export function checkDir(p: string): DirState {
  try {
    if (!fs.statSync(p).isDirectory()) return 'missing';
    fs.readdirSync(p);
    return 'ok';
  } catch (e) {
    return isDenied(e) ? 'denied' : 'missing';
  }
}

export function listSubdirs(root: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(root, ent.name);
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) out.push(full);
  }
  return out.sort();
}

const CHAPTER_RE = /^ch(\d+)-(.+)\.md$/i;

export function parseChapterFilename(name: string): { seq: number; title: string } | null {
  const m = CHAPTER_RE.exec(name);
  if (!m) return null;
  const title = m[2].trim();
  const seq = parseInt(m[1], 10);
  if (!title || !Number.isSafeInteger(seq)) return null;
  return { seq, title };
}

export interface ParsedChapterFile {
  fileName: string;
  seq: number;
  title: string;
}

export interface DirIssue {
  fileName: string;
  kind: 'unrecognized' | 'duplicate';
  reason: string;
}

export function classifyChapterEntries(entries: Array<{ name: string; isFile: boolean }>): {
  chapters: ParsedChapterFile[];
  issues: DirIssue[];
} {
  const names = entries
    .filter((e) => e.isFile && !e.name.startsWith('.') && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const chapters: ParsedChapterFile[] = [];
  const issues: DirIssue[] = [];
  const bySeq = new Map<number, string>();
  for (const fileName of names) {
    const p = parseChapterFilename(fileName);
    if (!p) {
      issues.push({ fileName, kind: 'unrecognized', reason: '文件名不符合 ChNN-标题.md，未入库' });
      continue;
    }
    const first = bySeq.get(p.seq);
    if (first) {
      issues.push({ fileName, kind: 'duplicate', reason: `序号重复（与 ${first} 冲突），未入库` });
      continue;
    }
    bySeq.set(p.seq, fileName);
    chapters.push({ fileName, ...p });
  }
  chapters.sort((a, b) => a.seq - b.seq);
  return { chapters, issues };
}
