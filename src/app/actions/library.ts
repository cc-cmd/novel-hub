'use server';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { wrap } from '@/lib/result';
import { addRoot, removeRoot, setArchived, setChapterSubdir } from '@/lib/library';
import { clientForPlatform } from '@/lib/platform-auth';
import { syncNovelPlatforms } from '@/lib/platform-sync';
import { listSyncableNovels } from '@/lib/rescan';
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

/** 手动重新扫描：忽略 mtime/size 短路；同步由客户端随后逐本调用 syncPlatformsAction。 */
export async function scanAllLocalAction() {
  return wrap(() => {
    try {
      const db = getDb();
      const s = scanAndSync(db, { force: true });
      return { ...s, syncable: listSyncableNovels(db, s.failedNovelIds) };
    } finally {
      refresh();
    }
  });
}

export async function scanNovelLocalAction(novelId: number) {
  return wrap(() => {
    try {
      return syncNovel(getDb(), novelId, { force: true });
    } finally {
      refresh();
    }
  });
}

export async function syncPlatformsAction(novelId: number) {
  return wrap(async () => {
    try {
      return await syncNovelPlatforms(getDb(), novelId, clientForPlatform);
    } finally {
      refresh();
    }
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
