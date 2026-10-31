'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addRoot, removeRoot, scanLibrary, setArchived, setChapterSubdir } from '@/lib/library';

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
    const s = scanLibrary(getDb());
    refresh();
    return s;
  });
}

export async function setArchivedAction(novelId: number, archived: boolean) {
  return wrap(() => {
    const n = setArchived(getDb(), novelId, archived);
    refresh();
    return { name: n.name };
  });
}

export async function setChapterSubdirAction(novelId: number, subdir: string) {
  return wrap(() => {
    setChapterSubdir(getDb(), novelId, subdir);
    refresh();
  });
}
