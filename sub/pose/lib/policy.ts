/*! 姿势分级：只使用插件自己的配置和宿主公开的人格列表，不读取宿主人格正文。 */

import { readConfig, type PersonaPolicy } from './config.ts';

export type Audience = {
  id: string;
  name: string;
  age: number | null;
  adult: boolean;
  threshold: number;
  source: 'policy' | 'unknown' | 'fallback';
};

type PersonaChoice = { id?: string; name?: string };

function personaChoices(ctx: any): PersonaChoice[] {
  const listed = ctx?.personas?.list?.();
  return Array.isArray(listed) ? listed : [];
}

export function defaultPersonaId(ctx?: any): string {
  const first = personaChoices(ctx).find((item) => item?.id);
  return first?.id ? String(first.id) : 'default';
}

export function personaName(ctx: any, id: string): string {
  return personaChoices(ctx).find((item) => item?.id === id)?.name ?? id;
}

/**
 * 年龄只来自插件设置里的 personaPolicy。宿主只公开人格 ID 和名称，
 * 不提供年龄；不猜不读正文，未标记的人格按配置里的 unknownPersona 处理。
 */
export async function audienceFor(ctx: any, personaId?: string): Promise<Audience> {
  const config = await readConfig(ctx);
  const id = String(personaId ?? '').trim() || defaultPersonaId(ctx);
  const override: PersonaPolicy | undefined = config.personaPolicy[id];
  const threshold = config.adultThreshold;

  let adult = false;
  let source: Audience['source'] = 'unknown';
  if (override === 'minor') {
    adult = false;
    source = 'policy';
  } else if (override === 'adult') {
    adult = true;
    source = 'policy';
  } else {
    adult = config.unknownPersona === 'adult';
    source = 'unknown';
  }

  return { id, name: personaName(ctx, id), age: null, adult, threshold, source };
}

export async function listAudiences(ctx: any): Promise<Audience[]> {
  const ids = new Set<string>();
  for (const item of personaChoices(ctx)) if (item?.id) ids.add(String(item.id));
  if (!ids.size) ids.add(defaultPersonaId(ctx));
  const list: Audience[] = [];
  for (const id of ids) list.push(await audienceFor(ctx, id));
  return list;
}
