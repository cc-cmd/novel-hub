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
    const s = scanAndSync(getDb());
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
    const n = setArchived(db, novelId, archived);
    if (!archived) syncNovel(db, novelId);
    refresh();
    return { name: n.name };
  });
}

export async function setChapterSubdirAction(novelId: number, subdir: string) {
  return wrap(() => {
    const db = getDb();
    setChapterSubdir(db, novelId, subdir);
    syncNovel(db, novelId, { force: true });
    refresh();
  });
}
