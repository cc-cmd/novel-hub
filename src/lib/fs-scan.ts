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
