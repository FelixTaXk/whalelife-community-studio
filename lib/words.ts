/*! 提示词小抄 · 通用词库引擎。
 *
 * 这是一个独立插件：不依赖任何具体宿主，也不认识任何具体宿主的动作名。
 * 词库可选：优先读用户自己的 data/prompts.json；没有就读随包附带的 prompts.sample.json。
 * 两个都没有时引擎照样工作，只是词条为 0，页面提示导入，不抛异常。
 *
 * 可配置的部分都在 WordConfig 里：词条字段名、分类语义（负面/质量/成人前缀）、
 * 配方层、动作白名单、质量词白名单、安全词正则。默认值只描述通用约定，不写具体作品或本机路径。
 *
 * NSFW：词库可以带成人分类（分类对象上的 nsfw / adult / role，或 id 命中配置的前缀）。
 * 是否可用由 allowNsfw 决定，默认关闭；关闭时这些分类不参与 categories / search / pick / recipe。
 * 自动补词永远不碰成人分类，无论开关开没开。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WORD_LANG_MODES = ['primary', 'secondary', 'both'] as const;
export type WordLangMode = (typeof WORD_LANG_MODES)[number];

export type WordFields = {
  /** 主字段：自动补词、默认语言优先取它 */
  primary: string;
  /** 副字段：用来做「正文里出现副字段 → 补主字段」的映射 */
  secondary: string;
};

export type WordSemantics = {
  /** 负面分类 id；留空表示词库没有负面分类 */
  negative: string;
  /** 质量分类 id；质量分类可再被 qualityAllowlist 收窄 */
  quality: string;
  /** 成人分类 id 前缀；分类上带 nsfw/adult/role 时优先按分类标记判断 */
  nsfwPrefix: string;
};

export type WordConfig = {
  lang: WordLangMode;
  pickCount: number;
  disabledCategories: string[];
  recipeLayers: string[];
  recipeMaxLayers: number;
  autoEnrich: boolean;
  /** 动作白名单；'*' 表示所有调用方传来的 kind 都补 */
  enrichKinds: string[];
  enrichLayers: string[];
  enrichCount: number;
  allowNsfw: boolean;
  negativePrompt: string;
  fields: WordFields;
  semantics: WordSemantics;
  /** 质量分类里只取这些词；空数组表示不额外收窄 */
  qualityAllowlist: string[];
  /** 自动补词的安全词正则；每项是一条正则，空数组表示不额外过滤 */
  blockedPatterns: string[];
};

export const WORD_DEFAULT: WordConfig = {
  lang: 'primary',
  pickCount: 3,
  disabledCategories: [],
  recipeLayers: [],
  recipeMaxLayers: 6,
  autoEnrich: false,
  enrichKinds: ['*'],
  enrichLayers: [],
  enrichCount: 2,
  allowNsfw: false,
  negativePrompt: '',
  fields: { primary: 'en', secondary: 'zh' },
  semantics: { negative: 'negative', quality: 'quality', nsfwPrefix: 'nsfw' },
  qualityAllowlist: [],
  blockedPatterns: ['\\b(explicit|sensitive|nsfw|nude|naked|lingerie|underwear|swimwear|bikini|cleavage)\\b'],
};

export type WordCategory = {
  id: string;
  name: string;
  icon?: string;
  count?: number;
  /** 可选角色：negative / quality / nsfw；也可以在分类上写 nsfw / adult 布尔 */
  role?: string;
  nsfw?: boolean;
  adult?: boolean;
};

export type WordTag = {
  cat: string;
  /** 词条的所有字段；字段名由配置决定，不限定 zh/en */
  values: Record<string, string>;
};

type Data = {
  categories: WordCategory[];
  catById: Map<string, WordCategory>;
  tags: WordTag[];
  builtAt: string;
  byCat: Map<string, WordTag[]>;
  /** 实际读到的文件；两个文件都没有时是用户词库的路径 */
  path: string;
  sample: boolean;
  bytes: number;
  broken: boolean;
  /** 成人分类 / 词条数量：只用来在页面报数，跟开关无关 */
  nsfwCategories: number;
  nsfwTags: number;
};

export type WordLibrary = {
  path: string;
  exists: boolean;
  sample: boolean;
  bytes: number;
  builtAt: string;
  categories: number;
  tags: number;
  nsfwCategories: number;
  nsfwTags: number;
  broken: boolean;
};

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** 分类是否成人分类：分类标记优先，其次按配置的 id 前缀。 */
export function isNsfwCategory(id: string, semantics: WordSemantics, category?: WordCategory) {
  if (category?.nsfw === true || category?.adult === true || String(category?.role ?? '').toLowerCase() === 'nsfw') {
    return true;
  }
  const prefix = String(semantics?.nsfwPrefix ?? '').trim().toLowerCase();
  return Boolean(prefix) && String(id ?? '').toLowerCase().startsWith(prefix);
}

/** 分类是否负面分类。 */
export function isNegativeCategory(id: string, semantics: WordSemantics, category?: WordCategory) {
  return String(category?.role ?? '').toLowerCase() === 'negative' || (Boolean(semantics?.negative) && id === semantics.negative);
}

/** 分类是否质量分类。 */
export function isQualityCategory(id: string, semantics: WordSemantics, category?: WordCategory) {
  return String(category?.role ?? '').toLowerCase() === 'quality' || (Boolean(semantics?.quality) && id === semantics.quality);
}

function normalizeFields(stored: any): WordFields {
  const primary = asText(stored?.fields?.primary) || WORD_DEFAULT.fields.primary;
  const secondary = asText(stored?.fields?.secondary) || WORD_DEFAULT.fields.secondary;
  return { primary, secondary };
}

function normalizeSemantics(stored: any): WordSemantics {
  const value = stored?.semantics ?? {};
  return {
    negative: value.negative === '' ? '' : asText(value.negative) || WORD_DEFAULT.semantics.negative,
    quality: value.quality === '' ? '' : asText(value.quality) || WORD_DEFAULT.semantics.quality,
    nsfwPrefix: value.nsfwPrefix === '' ? '' : asText(value.nsfwPrefix) || WORD_DEFAULT.semantics.nsfwPrefix,
  };
}

function normalizeLang(stored: any, fields: WordFields): WordLangMode {
  const value = asText(stored);
  if ((WORD_LANG_MODES as readonly string[]).includes(value)) return value as WordLangMode;
  if (value && value === fields.primary) return 'primary';
  if (value && value === fields.secondary) return 'secondary';
  // 兼容旧配置：en 当主字段、zh 当副字段。
  if (value === 'en') return 'primary';
  if (value === 'zh') return 'secondary';
  return WORD_DEFAULT.lang;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

export function normalizeWordConfig(stored: any, categories: WordCategory[]): WordConfig {
  const fields = normalizeFields(stored);
  const semantics = normalizeSemantics(stored);
  const known = new Set(categories.map((c) => c.id));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const disabled = Array.isArray(stored?.disabledCategories)
    ? list(stored.disabledCategories).filter((id) => known.has(id))
    : WORD_DEFAULT.disabledCategories.slice();
  const recipeLayers = Array.isArray(stored?.recipeLayers)
    ? list(stored.recipeLayers).filter((id) => known.has(id) && !isNegativeCategory(id, semantics, byId.get(id)) && !isNsfwCategory(id, semantics, byId.get(id)))
    : WORD_DEFAULT.recipeLayers.slice();
  const recipeMaxLayers = Math.min(20, Math.max(1, Number(stored?.recipeMaxLayers) || WORD_DEFAULT.recipeMaxLayers));
  const autoEnrich = typeof stored?.autoEnrich === 'boolean' ? stored.autoEnrich : WORD_DEFAULT.autoEnrich;
  const enrichKinds = Array.isArray(stored?.enrichKinds)
    ? list(stored.enrichKinds).filter((id) => id === '*' || id.length <= 40)
    : WORD_DEFAULT.enrichKinds.slice();
  const enrichLayers = Array.isArray(stored?.enrichLayers)
    ? list(stored.enrichLayers).filter((id) => known.has(id) && !isNegativeCategory(id, semantics, byId.get(id)) && !isNsfwCategory(id, semantics, byId.get(id)))
    : WORD_DEFAULT.enrichLayers.slice();
  const enrichCount = Math.min(5, Math.max(1, Number(stored?.enrichCount) || WORD_DEFAULT.enrichCount));
  const allowNsfw = stored?.allowNsfw === true;
  const negativePrompt = typeof stored?.negativePrompt === 'string' ? stored.negativePrompt.slice(0, 4000) : '';
  const qualityAllowlist = Array.isArray(stored?.qualityAllowlist)
    ? list(stored.qualityAllowlist).map((word) => word.toLowerCase()).slice(0, 200)
    : WORD_DEFAULT.qualityAllowlist.slice();
  const blockedPatterns = Array.isArray(stored?.blockedPatterns)
    ? list(stored.blockedPatterns).slice(0, 30)
    : WORD_DEFAULT.blockedPatterns.slice();
  return {
    lang: normalizeLang(stored?.lang, fields),
    pickCount: Math.min(8, Math.max(1, Number(stored?.pickCount) || WORD_DEFAULT.pickCount)),
    disabledCategories: disabled,
    recipeLayers,
    recipeMaxLayers,
    autoEnrich,
    enrichKinds,
    enrichLayers,
    enrichCount,
    allowNsfw,
    negativePrompt,
    fields,
    semantics,
    qualityAllowlist,
    blockedPatterns,
  };
}

/** 读取词条上的一个字段；字段名不限定。 */
function fieldOf(tag: WordTag, key: string) {
  return asText(tag?.values?.[key]);
}

/** 主文本：优先配置的主字段，其次常见别名，最后取第一个非空字段。 */
function primaryOf(tag: WordTag, fields: WordFields) {
  return (
    fieldOf(tag, fields.primary) ||
    fieldOf(tag, 'prompt') ||
    fieldOf(tag, 'text') ||
    fieldOf(tag, 'en') ||
    Object.values(tag?.values ?? {}).find(Boolean) ||
    ''
  );
}

/** 副文本：优先配置的副字段，其次常见别名，最后取与主文本不同的第一个字段。 */
function secondaryOf(tag: WordTag, fields: WordFields) {
  const primary = primaryOf(tag, fields);
  return (
    fieldOf(tag, fields.secondary) ||
    fieldOf(tag, 'zh') ||
    fieldOf(tag, 'translation') ||
    fieldOf(tag, 'cn') ||
    Object.values(tag?.values ?? {}).find((value) => value && value !== primary) ||
    ''
  );
}

function textOf(tag: WordTag, lang: string, fields: WordFields) {
  if (lang && lang !== 'primary' && lang !== 'secondary' && lang !== 'both' && tag?.values?.[lang]) {
    return tag.values[lang];
  }
  const primary = primaryOf(tag, fields);
  const secondary = secondaryOf(tag, fields);
  if (lang === 'secondary') return secondary || primary;
  if (lang === 'both') return primary && secondary ? `${primary} / ${secondary}` : primary || secondary;
  return primary || secondary;
}

function sample<T>(arr: T[], n: number) {
  const pool = arr.slice();
  const out: T[] = [];
  while (pool.length && out.length < n) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/** 任一字段已经出现在正文里，就不再补。 */
function tagPresent(hay: string, tag: WordTag) {
  return Object.values(tag?.values ?? {})
    .map((value) => asText(value).toLowerCase())
    .filter((value) => value.length >= 2)
    .some((value) => hay.includes(value));
}

function compilePatterns(patterns: string[]) {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern, 'i'));
    } catch {
      /* 配置里写了坏正则，跳过它，不让整个词库崩掉 */
    }
  }
  return out;
}

/** 能参与自动补词的词条：非负面、非成人、不命中安全正则、质量分类按白名单收窄。 */
function usable(tag: WordTag, cfg: WordConfig, data: Data, blocked: RegExp[]) {
  const category = data.catById.get(tag.cat);
  if (!primaryOf(tag, cfg.fields) && !secondaryOf(tag, cfg.fields)) return false;
  if (isNegativeCategory(tag.cat, cfg.semantics, category)) return false;
  if (isNsfwCategory(tag.cat, cfg.semantics, category)) return false;
  const text = [primaryOf(tag, cfg.fields), secondaryOf(tag, cfg.fields), ...Object.values(tag.values)].join(' ');
  if (blocked.some((re) => re.test(text))) return false;
  if (isQualityCategory(tag.cat, cfg.semantics, category) && cfg.qualityAllowlist.length) {
    const primary = primaryOf(tag, cfg.fields).toLowerCase();
    const secondary = secondaryOf(tag, cfg.fields).toLowerCase();
    if (!cfg.qualityAllowlist.includes(primary) && !cfg.qualityAllowlist.includes(secondary)) return false;
  }
  return true;
}

/** 一份都没有时的空词库（页面能打开，工具给导入说明）。 */
function parseEmpty(path: string, broken = false): Data {
  return {
    categories: [],
    catById: new Map(),
    tags: [],
    builtAt: '',
    byCat: new Map(),
    path,
    sample: false,
    bytes: 0,
    broken,
    nsfwCategories: 0,
    nsfwTags: 0,
  };
}

/** 导入时把任意字段的字符串值收进 values；分类字段单独处理。 */
function tagValues(raw: any): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (key === 'cat' || key === 'category' || key === 'id') continue;
    if (typeof value === 'string' && value.trim()) values[key] = value.trim();
  }
  return values;
}

function parseCategory(raw: any): WordCategory | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  const category: WordCategory = { id: String(raw.id), name: String(raw.name ?? raw.id) };
  if (typeof raw.icon === 'string' && raw.icon) category.icon = raw.icon;
  const count = Number(raw.count);
  if (Number.isFinite(count) && count > 0) category.count = Math.round(count);
  if (typeof raw.role === 'string' && raw.role) category.role = raw.role;
  if (raw.nsfw === true) category.nsfw = true;
  if (raw.adult === true) category.adult = true;
  return category;
}

function parse(path: string, sample: boolean, bytes: number, semantics: WordSemantics): Data | null {
  let raw: any = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  // 兼容两种常见写法：本插件的 categories，以及上游数据的 cats。
  const rawCats = Array.isArray(raw.categories) ? raw.categories : Array.isArray(raw.cats) ? raw.cats : [];
  const categories = rawCats.map(parseCategory).filter(Boolean) as WordCategory[];
  const tags: WordTag[] = [];
  for (const item of Array.isArray(raw.tags) ? raw.tags : []) {
    if (!item || typeof item !== 'object') continue;
    const cat = String(item.cat ?? item.category ?? '');
    const values = tagValues(item);
    if (!cat || !categories.some((c) => c.id === cat) || !Object.keys(values).length) continue;
    tags.push({ cat, values });
  }
  if (!tags.length) return null;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const byCat = new Map<string, WordTag[]>();
  for (const tag of tags) {
    if (!byCat.has(tag.cat)) byCat.set(tag.cat, []);
    byCat.get(tag.cat)!.push(tag);
  }
  return {
    categories,
    catById,
    tags,
    builtAt: String(raw.builtAt ?? raw.generatedAt ?? ''),
    byCat,
    path,
    sample,
    bytes,
    broken: false,
    nsfwCategories: categories.filter((c) => isNsfwCategory(c.id, semantics, c)).length,
    nsfwTags: tags.filter((t) => isNsfwCategory(t.cat, semantics, catById.get(t.cat))).length,
  };
}

export type WordEngineOptions = {
  file: string;
  sample?: string;
  readConfig: () => Promise<any>;
};

export function createWordEngine(options: WordEngineOptions) {
  let cache: Data | null = null;
  /** 用户词库坏了并回退到示例 */
  let broken = false;
  let lastSemantics: WordSemantics = WORD_DEFAULT.semantics;

  /** 依次试：用户自己的词库 → 随包示例。只返回真实存在的文件。 */
  const candidates = (): Array<{ path: string; sample: boolean; bytes: number }> => {
    const list: Array<{ path: string; sample: boolean }> = [{ path: options.file, sample: false }];
    if (options.sample) list.push({ path: options.sample, sample: true });
    const out: Array<{ path: string; sample: boolean; bytes: number }> = [];
    for (const item of list) {
      try {
        const st = statSync(item.path);
        if (st.isFile() && st.size > 0) out.push({ ...item, bytes: st.size });
      } catch {
        /* 没有这个文件，试下一个 */
      }
    }
    return out;
  };

  const cfgOf = async () => {
    let stored: any = null;
    try {
      stored = await options.readConfig();
    } catch {
      stored = null;
    }
    const semantics = normalizeSemantics(stored);
    lastSemantics = semantics;
    const categories = load(semantics).categories;
    return normalizeWordConfig(stored, categories);
  };

  const load = (semantics: WordSemantics = lastSemantics): Data => {
    if (!cache) {
      broken = false;
      const list = candidates();
      for (const item of list) {
        const data = parse(item.path, item.sample, item.bytes, semantics);
        if (data) {
          if (item.sample && broken) data.broken = true;
          cache = data;
          break;
        }
        if (!item.sample) broken = true;
      }
      if (!cache) {
        broken = list.some((item) => !item.sample);
        cache = parseEmpty(options.file, broken);
      }
    }
    return cache;
  };

  const library = async (): Promise<WordLibrary> => {
    const cfg = await cfgOf();
    const data = load(cfg.semantics);
    return {
      path: data.path,
      exists: data.bytes > 0,
      sample: data.sample,
      bytes: data.bytes,
      builtAt: data.builtAt,
      categories: data.categories.length,
      tags: data.tags.length,
      nsfwCategories: data.nsfwCategories,
      nsfwTags: data.nsfwTags,
      broken: data.broken,
    };
  };

  const flags = (id: string, cfg: WordConfig, data: Data) => {
    const category = data.catById.get(id);
    return {
      nsfw: isNsfwCategory(id, cfg.semantics, category),
      negative: isNegativeCategory(id, cfg.semantics, category),
      quality: isQualityCategory(id, cfg.semantics, category),
    };
  };

  /** 工具能用到的分类：配置里没被禁用、成人开关开着、且不是负面。 */
  const enabledList = (cfg: WordConfig, data = load()) => {
    const off = new Set(cfg.disabledCategories);
    return data.categories.filter((c) => {
      if (off.has(c.id)) return false;
      const role = flags(c.id, cfg, data);
      if (role.negative) return false;
      return cfg.allowNsfw || !role.nsfw;
    });
  };

  const unavailableReason = (cat: string, cfg: WordConfig, data = load()) => {
    const role = flags(cat, cfg, data);
    if (role.negative) return '负面词不参与查词和挑词：请在设置页的「共用负面提示词」里编辑。';
    if (role.nsfw && !cfg.allowNsfw) return '这是成人分类，开关没开；设置页 →「进阶」里可以打开：' + cat;
    return '这个分类在设置里关掉了：' + cat;
  };

  const stats = (cfg: WordConfig) => {
    const data = load();
    const enabled = enabledList(cfg, data);
    return {
      categories: data.categories.length,
      enabledCategories: enabled.length,
      tags: data.tags.length,
      enabledTags: enabled.reduce((sum, c) => sum + (data.byCat.get(c.id)?.length ?? 0), 0),
      nsfwCategories: data.nsfwCategories,
      nsfwTags: data.nsfwTags,
      allowNsfw: cfg.allowNsfw,
      builtAt: data.builtAt,
      autoEnrich: cfg.autoEnrich,
      enrichKinds: cfg.enrichKinds.slice(),
      enrichLayers: cfg.enrichLayers.slice(),
      enrichCount: cfg.enrichCount,
    };
  };

  const categories = async () => {
    const cfg = await cfgOf();
    const data = load();
    return enabledList(cfg, data).map((c) => ({ id: c.id, name: c.name, count: (data.byCat.get(c.id) ?? []).length }));
  };

  /** 词库负面分类的全部词：设置页的「填入词库里的全部负面词」用它。 */
  const negativeLibraryText = async () => {
    const cfg = await cfgOf();
    const data = load();
    return (data.byCat.get(cfg.semantics.negative) ?? [])
      .map((tag) => primaryOf(tag, cfg.fields) || secondaryOf(tag, cfg.fields))
      .filter(Boolean)
      .join(', ');
  };

  const negativePrompt = async () => {
    const cfg = await cfgOf();
    return String(cfg.negativePrompt ?? '').trim();
  };

  const search = async (args: any) => {
    const cfg = await cfgOf();
    const data = load();
    const q = String(args?.query ?? '').trim().toLowerCase();
    if (!q) return { status: 'error', error: 'query 不能为空' };
    const enabled = new Set(enabledList(cfg, data).map((c) => c.id));
    const cat = args?.category ? String(args.category) : '';
    if (cat && !enabled.has(cat)) return { status: 'error', error: unavailableReason(cat, cfg, data) };
    const limit = Math.min(20, Math.max(1, Number(args?.limit) || 8));
    const lang = normalizeLang(args?.lang, cfg.fields);
    const hits: any[] = [];
    for (const tag of data.tags) {
      if (!enabled.has(tag.cat)) continue;
      if (cat && tag.cat !== cat) continue;
      const matched = Object.values(tag.values).some((value) => value.toLowerCase().includes(q));
      if (matched) {
        const primary = primaryOf(tag, cfg.fields);
        const secondary = secondaryOf(tag, cfg.fields);
        hits.push({
          cat: tag.cat,
          text: textOf(tag, lang, cfg.fields),
          primary,
          secondary,
          values: tag.values,
          en: primary,
          zh: secondary,
        });
        if (hits.length >= limit) break;
      }
    }
    return { status: 'ok', query: args?.query, count: hits.length, tags: hits };
  };

  const pick = async (args: any) => {
    const cfg = await cfgOf();
    const data = load();
    const enabled = enabledList(cfg, data);
    const count = Math.min(8, Math.max(1, Number(args?.count) || cfg.pickCount));
    const lang = normalizeLang(args?.lang, cfg.fields);
    const cat = args?.category ? String(args.category) : '';
    if (cat && flags(cat, cfg, data).negative) {
      return { status: 'error', error: '负面词不参与随机挑词：请用设置页的「共用负面提示词」维护。' };
    }
    const pickable = enabled.filter((c) => !flags(c.id, cfg, data).negative);
    let pool: WordTag[] = [];
    if (cat) {
      if (!pickable.some((c) => c.id === cat)) return { status: 'error', error: unavailableReason(cat, cfg, data) };
      pool = data.byCat.get(cat) ?? [];
    } else {
      for (const c of pickable) pool = pool.concat(data.byCat.get(c.id) ?? []);
    }
    if (!pool.length) return { status: 'error', error: '没有可用的词' };
    const picked = sample(pool, count);
    const texts = picked.map((tag) => textOf(tag, lang, cfg.fields)).filter(Boolean);
    return {
      status: 'ok',
      category: cat || 'all',
      tags: picked.map((tag) => {
        const primary = primaryOf(tag, cfg.fields);
        const secondary = secondaryOf(tag, cfg.fields);
        return {
          cat: tag.cat,
          text: textOf(tag, lang, cfg.fields),
          primary,
          secondary,
          values: tag.values,
          en: primary,
          zh: secondary,
        };
      }),
      text: texts.join(', '),
    };
  };

  const recipe = async (args: any) => {
    const cfg = await cfgOf();
    const data = load();
    const enabled = new Set(enabledList(cfg, data).map((c) => c.id));
    const lang = normalizeLang(args?.lang, cfg.fields);
    const requested: string[] | null = Array.isArray(args?.layers) ? args.layers.map(String) : null;
    const base = (requested ?? cfg.recipeLayers).filter((id: string) => enabled.has(id) && !flags(id, cfg, data).negative && !flags(id, cfg, data).nsfw);
    const fallback = enabledList(cfg, data)
      .filter((c) => !flags(c.id, cfg, data).negative)
      .map((c) => c.id);
    const layersList = (base.length ? base : fallback).slice(0, cfg.recipeMaxLayers);
    const words: string[] = [];
    const layersOut: any[] = [];
    for (const cat of layersList) {
      const pool = data.byCat.get(cat);
      if (!pool?.length) continue;
      const picked = sample(pool, 1).map((tag) => textOf(tag, lang, cfg.fields)).filter(Boolean);
      if (!picked.length) continue;
      words.push(...picked);
      layersOut.push({ category: cat, words: picked });
    }
    const extra = String(args?.extra ?? '').trim();
    if (extra) words.push(extra);
    return { status: 'ok', text: words.join(', '), layers: layersOut };
  };

  /** 自动补词：先把正文里的副字段换成主字段，再从勾选的层补词；已有的词跳过。 */
  const enrich = async (input: any) => {
    const cfg = await cfgOf();
    const data = load();
    const text = String(input?.text ?? '').trim();
    const kind = String(input?.kind ?? '').trim();
    const stop = (skipped: string) => ({ text, added: [] as Array<{ cat: string; word: string; why: string }>, skipped });
    if (!text) return stop('empty');
    if (!cfg.autoEnrich) return stop('off');
    if (!cfg.enrichKinds.includes('*') && !cfg.enrichKinds.includes(kind)) return stop('kind');
    if (input?.signal?.aborted) return stop('aborted');
    const enabled = new Set(enabledList(cfg, data).map((c) => c.id));
    const layers = cfg.enrichLayers.filter((id) => enabled.has(id) && !flags(id, cfg, data).negative && !flags(id, cfg, data).nsfw);
    if (!layers.length) return stop('layers');
    const blocked = compilePatterns(cfg.blockedPatterns);
    const hay = text.toLowerCase();
    const added: Array<{ cat: string; word: string; why: string }> = [];
    const words: string[] = [];

    // 1) 正文里写了副字段、词库有对应主字段的，补主字段（生成模型对主字段更跟得住）。
    for (const tag of data.tags) {
      if (words.length >= cfg.enrichCount) break;
      if (input?.signal?.aborted) return stop('aborted');
      if (!enabled.has(tag.cat) || !usable(tag, cfg, data, blocked)) continue;
      const primary = fieldOf(tag, cfg.fields.primary) || fieldOf(tag, 'prompt') || fieldOf(tag, 'text') || fieldOf(tag, 'en');
      const secondary = fieldOf(tag, cfg.fields.secondary) || fieldOf(tag, 'zh') || fieldOf(tag, 'translation') || fieldOf(tag, 'cn');
      if (secondary.length >= 2 && primary && hay.includes(secondary.toLowerCase()) && !hay.includes(primary.toLowerCase()) && !words.includes(primary)) {
        words.push(primary);
        added.push({ cat: tag.cat, word: primary, why: '副字段→主字段' });
      }
    }

    // 2) 再从勾选的层里补，正文里已经出现的词跳过。
    for (let round = 0; words.length < cfg.enrichCount && round < 8; round++) {
      for (const layer of layers) {
        if (words.length >= cfg.enrichCount) break;
        if (input?.signal?.aborted) return stop('aborted');
        const pool = (data.byCat.get(layer) ?? []).filter((tag) => {
          if (!usable(tag, cfg, data, blocked)) return false;
          const word = primaryOf(tag, cfg.fields);
          return Boolean(word) && !words.includes(word) && !tagPresent(hay, tag);
        });
        if (!pool.length) continue;
        const picked = pool[Math.floor(Math.random() * pool.length)];
        const word = primaryOf(picked, cfg.fields);
        words.push(word);
        added.push({ cat: layer, word, why: '按层补词' });
      }
    }
    if (!words.length) return stop('nothing');
    const next = text.replace(/[，,\s]+$/g, '') + ', ' + words.join(', ');
    return { text: next, added, skipped: '' };
  };

  const pageData = async () => {
    const cfg = await cfgOf();
    const data = load();
    return {
      config: cfg,
      stats: stats(cfg),
      categories: data.categories.map((c) => ({
        id: c.id,
        name: c.name,
        count: (data.byCat.get(c.id) ?? []).length,
        ...flags(c.id, cfg, data),
      })),
      builtAt: data.builtAt,
      library: await library(),
      negative: {
        text: cfg.negativePrompt,
        defaultText: await negativeLibraryText(),
        count: (data.byCat.get(cfg.semantics.negative) ?? []).length,
      },
    };
  };

  /** 导入自己的词库：校验后写到 data/prompts.json（覆盖），并清缓存。 */
  const importLibrary = async (text: string): Promise<WordLibrary> => {
    const raw = String(text ?? '').trim();
    if (!raw) throw Error('词库内容是空的');
    if (raw.length > 8 * 1024 * 1024) throw Error('词库文件太大，上限 8MB');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Error('不是合法的 JSON');
    }
    const rawCats = Array.isArray(parsed?.categories) ? parsed.categories : Array.isArray(parsed?.cats) ? parsed.cats : null;
    if (!rawCats || !rawCats.length) throw Error('缺少 categories 数组');
    if (!Array.isArray(parsed?.tags) || !parsed.tags.length) throw Error('缺少 tags 数组');
    const categories = rawCats.map(parseCategory).filter(Boolean) as WordCategory[];
    if (!categories.length) throw Error('categories 里没有合法的分类');
    const ids = new Set(categories.map((c) => c.id));
    const tags: WordTag[] = [];
    for (const item of parsed.tags) {
      if (!item || typeof item !== 'object') continue;
      const cat = String(item.cat ?? item.category ?? '');
      const values = tagValues(item);
      if (!ids.has(cat) || !Object.keys(values).length) continue;
      tags.push({ cat, values });
    }
    if (!tags.length) throw Error('tags 里没有能用的词条（cat 要能对上 categories，且至少有一个文本字段）');
    const clean = {
      version: parsed.version ?? 1,
      license: String(parsed.license ?? ''),
      source: String(parsed.source ?? ''),
      note: String(parsed.note ?? ''),
      builtAt: String(parsed.builtAt ?? parsed.generatedAt ?? new Date().toISOString()),
      categories,
      tags: tags.map((tag) => ({ cat: tag.cat, ...tag.values })),
    };
    mkdirSync(dirname(options.file), { recursive: true });
    const tmp = `${options.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean), 'utf8');
    renameSync(tmp, options.file);
    cache = null;
    return library();
  };

  /** 删掉自己的词库，回到随包示例（没有示例就回到空词库）。 */
  const resetLibrary = async (): Promise<WordLibrary> => {
    rmSync(options.file, { force: true });
    cache = null;
    return library();
  };

  return {
    stats: async () => stats(await cfgOf()),
    categories,
    search,
    pick,
    recipe,
    enrich,
    negativePrompt,
    negativeLibraryText,
    pageData,
    library,
    importLibrary,
    resetLibrary,
    reload: () => {
      cache = null;
    },
  };
}

export type WordEngine = ReturnType<typeof createWordEngine>;
