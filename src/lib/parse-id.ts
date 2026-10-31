/** 严格解析正整数（URL 参数用）；非正整数一律返回 null。 */
export function parsePositiveInt(v: string | undefined | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
