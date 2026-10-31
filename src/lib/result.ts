export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };
export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
export const fail = (error: string): ActionResult<never> => ({ ok: false, error });

export class UserError extends Error {}

/** Server Action 包装：把 UserError 转成 fail，其余异常原样抛出。 */
export async function wrap<T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    throw e;
  }
}
