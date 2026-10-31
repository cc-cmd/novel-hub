import type { Db } from './index';
import { platform } from './schema';

export const BUILTIN_PLATFORMS = ['番茄', '起点'] as const;

/** F3.1：首次启动写入预置平台；幂等。 */
export function seedBuiltinPlatforms(db: Db) {
  for (const name of BUILTIN_PLATFORMS) {
    db.insert(platform).values({ name, builtin: true }).onConflictDoNothing().run();
  }
}
