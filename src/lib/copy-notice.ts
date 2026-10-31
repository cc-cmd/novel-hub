import type { CopyMode } from './publish';

export function copyNotice(
  p: { title: string; wordCount: number; bodyEmpty: boolean; mode: CopyMode },
  unsaved = false,
): string {
  if (unsaved) return '已复制，复制的是未保存内容';
  if (p.mode === 'title') return `已复制标题：${p.title}`;
  if (p.bodyEmpty) return '已复制标题，正文为空';
  return p.mode === 'body' ? `已复制《${p.title}》正文，共 ${p.wordCount} 字` : `已复制《${p.title}》，共 ${p.wordCount} 字`;
}
