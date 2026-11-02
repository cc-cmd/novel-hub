'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addRoot, removeRoot, setArchived, setChapterSubdir } from '@/lib/library';
import { scanAndSync, syncNovel } from '@/lib/sync';

function refresh() {
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/novels/[id]', 'page');
}

export async function addRootAction(input: string) {
  return wrap(() => {
    const r = addRoot(getDb(), input);
    refresh();
    return r;
  });
}

export async function removeRootAction(id: number) {
  return wrap(() => {
    removeRoot(getDb(), id);
    refresh();
  });
}

export async function rescanAction() {
  return wrap(() => {
    const s = scanAndSync(getDb(), { force: true }); // 手动重新扫描：忽略 mtime/size 短路
    refresh();
    return s;
  });
}

export async function rescanNovelAction(novelId: number) {
  return wrap(() => {
    const r = syncNovel(getDb(), novelId, { force: true });
    refresh();
    return r;
  });
}

export async function setArchivedAction(novelId: number, archived: boolean) {
  return wrap(() => {
    const db = getDb();
    try {
      const n = setArchived(db, novelId, archived);
      if (!archived) syncNovel(db, novelId);
      return { name: n.name };
    } finally {
      refresh();
    }
  });
}

export async function setChapterSubdirAction(novelId: number, subdir: string) {
  return wrap(() => {
    const db = getDb();
    try {
      setChapterSubdir(db, novelId, subdir);
      syncNovel(db, novelId, { force: true });
    } finally {
      refresh();
    }
  });
}
