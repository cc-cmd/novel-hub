// 分卷规则：按章节区间对应平台分卷（同 fanqie-publish 技能的 VOL_RANGES）。
// 存在 novel_platform.volumes（JSON），编辑时用每行一条的文本：`1-50 第一卷：崩塌`。

import { UserError } from './result';

export interface VolumeRule { from: number; to: number; name: string }
export interface RemoteVolume { volumeId: string; volumeName: string }

const LINE_RE = /^(\d+)\s*[-–~～至]\s*(\d+)\s+(.+?)\s*$/;

export function parseVolumeRules(text: string): VolumeRule[] {
  const rules: VolumeRule[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = LINE_RE.exec(line);
    if (!m) throw new UserError(`第 ${i + 1} 行格式错误：应为「起始章-结束章 卷名」，如 1-50 第一卷：崩塌`);
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (from < 1 || from > to) throw new UserError(`第 ${i + 1} 行章节区间无效`);
    if (m[3].length > 50) throw new UserError(`第 ${i + 1} 行卷名过长`);
    rules.push({ from, to, name: m[3] });
  });
  rules.sort((a, b) => a.from - b.from);
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].from <= rules[i - 1].to) throw new UserError(`章节区间重叠：${rules[i - 1].from}-${rules[i - 1].to} 与 ${rules[i].from}-${rules[i].to}`);
  }
  return rules;
}

export const formatVolumeRules = (rules: VolumeRule[]) => rules.map((r) => `${r.from}-${r.to} ${r.name}`).join('\n');

export function loadVolumeRules(json: string | null): VolumeRule[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const ruleFor = (seq: number, rules: VolumeRule[]) => rules.find((r) => r.from <= seq && seq <= r.to);

/** 卷名主干：「第一卷：崩塌」→「第一卷」，用于容忍平台卷名写法差异。 */
const stem = (name: string) => name.split(/[：:]/)[0].trim();

export function matchRemoteVolume(name: string, remote: RemoteVolume[]): RemoteVolume | undefined {
  return remote.find((v) => v.volumeName === name) ?? remote.find((v) => stem(v.volumeName) === stem(name));
}

export type VolumeTarget =
  | { kind: 'ok'; volume: RemoteVolume }
  | { kind: 'missing'; name: string } // 规则指定的卷平台上还没有，可新建
  | { kind: 'blocked'; reason: string };

/** 章节应发往哪一卷。未配置规则时：平台只有一卷就用它，否则要求配置。 */
export function resolveVolume(seq: number, rules: VolumeRule[], remote: RemoteVolume[]): VolumeTarget {
  if (rules.length === 0) {
    if (remote.length === 1) return { kind: 'ok', volume: remote[0] };
    return { kind: 'blocked', reason: remote.length === 0 ? '平台上没有分卷' : '平台有多个分卷，请先配置分卷规则' };
  }
  const rule = ruleFor(seq, rules);
  if (!rule) return { kind: 'blocked', reason: `第 ${seq} 章不在任何分卷规则区间内` };
  const v = matchRemoteVolume(rule.name, remote);
  return v ? { kind: 'ok', volume: v } : { kind: 'missing', name: rule.name };
}
