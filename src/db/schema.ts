import { integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { ChapterWarning, PublishStatus } from '@/lib/types';

const now = () => Date.now();

export const libraryRoot = sqliteTable('library_root', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const novel = sqliteTable('novel', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  dirPath: text('dir_path').notNull().unique(),
  chapterSubdir: text('chapter_subdir').notNull().default(''),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  dirMissing: integer('dir_missing', { mode: 'boolean' }).notNull().default(false),
  rootRemoved: integer('root_removed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const chapter = sqliteTable(
  'chapter',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    novelId: integer('novel_id').notNull().references(() => novel.id),
    seq: integer('seq').notNull(),
    title: text('title').notNull(),
    filePath: text('file_path').notNull(),
    wordCount: integer('word_count').notNull().default(0),
    contentHash: text('content_hash'),
    fileMissing: integer('file_missing', { mode: 'boolean' }).notNull().default(false),
    warning: text('warning').$type<ChapterWarning>(),
    mtimeMs: real('mtime_ms'),
    sizeBytes: integer('size_bytes'),
  },
  (t) => [unique().on(t.novelId, t.seq)],
);

export const scanIssue = sqliteTable('scan_issue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  novelId: integer('novel_id').notNull().references(() => novel.id),
  fileName: text('file_name').notNull(),
  kind: text('kind').$type<'unrecognized' | 'duplicate'>().notNull(),
  reason: text('reason').notNull(),
});

export const platform = sqliteTable('platform', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  cookie: text('cookie'),
  csrfToken: text('csrf_token'),
  useAi: integer('use_ai').notNull().default(2),
  dailyWordLimit: integer('daily_word_limit').notNull().default(20000),
});

export const novelPlatform = sqliteTable(
  'novel_platform',
  {
    novelId: integer('novel_id').notNull().references(() => novel.id),
    platformId: integer('platform_id').notNull().references(() => platform.id),
    bookUrl: text('book_url'),
    bookId: text('book_id'),
    lastSyncedAt: integer('last_synced_at'),
    lastSyncError: text('last_sync_error'),
    volumes: text('volumes'),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.platformId] })],
);

export const publication = sqliteTable(
  'publication',
  {
    chapterId: integer('chapter_id').notNull().references(() => chapter.id),
    platformId: integer('platform_id').notNull().references(() => platform.id),
    status: text('status').$type<PublishStatus>().notNull().default('unpublished'),
    publishedAt: integer('published_at'),
    platformUrl: text('platform_url'),
    publishedHash: text('published_hash'),
    platformItemId: text('platform_item_id'),
    platformWordCount: integer('platform_word_count'),
    syncedAt: integer('synced_at'),
    submittedAt: integer('submitted_at'),
    quotaWords: integer('quota_words'),
  },
  (t) => [primaryKey({ columns: [t.chapterId, t.platformId] })],
);

export type Novel = typeof novel.$inferSelect;
export type Chapter = typeof chapter.$inferSelect;
export type Publication = typeof publication.$inferSelect;
export type Platform = typeof platform.$inferSelect;
