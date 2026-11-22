/*! 姿势分级：从宿主人格设定里读年龄，决定能不能用性感系（private）。 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, type PersonaPolicy } from './config.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
// lib -> pose -> sub -> studio -> plugins -> 宿主根目录
const HOST_ROOT = resolve(DIR, '..', '..', '..', '..', '..');
const HOST_CONFIG = join(HOST_ROOT, 'config', 'config.json');

export type Audience = {
  id: string;
  name: string;
  age: number | null;
  adult: boolean;
  threshold: number;
  source: 'age' | 'policy' | 'unknown' | 'fallback';
};

type HostPersona = { id: string; name: string; file?: string };

function readHostConfig(): any {
  try {
    if (!existsSync(HOST_CONFIG)) return {};
    return JSON.parse(readFileSync(HOST_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function hostPersonas(): HostPersona[] {
  const config = readHostConfig();
  const map = config?.personas;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .filter(([id]) => typeof id === 'string' && id)
    .map(([id, value]: [string, any]) => ({ id, name: String(value?.name ?? id), file: value?.file }));
}

export function defaultPersonaId(ctx?: any): string {
  const config = readHostConfig();
  const webPersona = String(config?.channels?.web?.persona ?? '');
  if (webPersona && config?.personas?.[webPersona]) return webPersona;
  const ids = Object.keys(config?.personas ?? {});
  if (ids.length) return ids[0];
  const listed = ctx?.personas?.list?.();
  if (Array.isArray(listed) && listed[0]?.id) return String(listed[0].id);
  return 'default';
}

export function personaName(id: string): string {
  return hostPersonas().find((item) => item.id === id)?.name ?? id;
}

/** 从人格 md 读“17 岁 / 25岁”；多个年龄取最小，宁可保守。 */
export function detectPersonaAge(id: string): number | null {
  const hit = hostPersonas().find((item) => item.id === id);
  if (!hit?.file) return null;
  try {
    const path = isAbsolute(hit.file) ? hit.file : resolve(HOST_ROOT, hit.file);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8').slice(0, 6000);
    const matches = [...text.matchAll(/(\d{1,3})\s*岁/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 120);
    return matches.length ? Math.min(...matches) : null;
  } catch {
    return null;
  }
}

export async function audienceFor(ctx: any, personaId?: string): Promise<Audience> {
  const config = await readConfig(ctx);
  const id = String(personaId ?? '').trim() || defaultPersonaId(ctx);
  const age = detectPersonaAge(id);
  const override: PersonaPolicy | undefined = config.personaPolicy[id];
  const threshold = config.adultThreshold;

  let adult = false;
  let source: Audience['source'] = 'unknown';
  if (override === 'minor') {
    adult = false;
    source = 'policy';
  } else if (override === 'adult') {
    adult = age === null || age >= threshold;
    source = 'policy';
  } else if (age !== null) {
    adult = age >= threshold;
    source = 'age';
  } else {
    adult = config.unknownPersona === 'adult';
    source = 'unknown';
  }

  return { id, name: personaName(id), age, adult, threshold, source };
}

export async function listAudiences(ctx: any): Promise<Audience[]> {
  const ids = new Set<string>();
  for (const item of hostPersonas()) ids.add(item.id);
  for (const item of ctx?.personas?.list?.() ?? []) if (item?.id) ids.add(String(item.id));
  if (!ids.size) ids.add(defaultPersonaId(ctx));
  const list: Audience[] = [];
  for (const id of ids) list.push(await audienceFor(ctx, id));
  return list;
}
