import type { PublishStatus } from './types';

/** 构造「保存发布信息」的补丁：仅在发布时间被用户改过且已发/审核中时才带 publishedAt。 */
export function buildInfoPatch(i: { status: PublishStatus; url: string; at: string; atDirty: boolean }) {
  const patch: { platformUrl: string | null; publishedAt?: number | null } = { platformUrl: i.url || null };
  if (i.status !== 'unpublished' && i.atDirty) patch.publishedAt = i.at ? new Date(i.at).getTime() : null;
  return patch;
}
