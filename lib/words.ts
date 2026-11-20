/*! 画室 · 提示词词库引擎。
 *
 * 词库来自鱼仔 PromptForge 的非成人子集，只在本机使用。
 * 「提示词小抄」子插件和画画子插件共用这一份逻辑：父插件用 ctx.provide('promptkit') 暴露，
 * 补词配置仍由子插件自己的 data/config.json 管。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFileSync } from 'node:fs';

export const WORD_KINDS = ['draw', 'selfie', 'snapshot', 'paint'] as const;
export type WordKind = (typeof WORD_KINDS)[number];
export const WORD_LANGS = ['zh', 'en', 'both'] as const;

export type WordConfig = {
  lang: 'zh' | 'en' | 'both';
  pickCount: number;
  disabledCategories: string[];
  recipeLayers: string[];
  autoEnrich: boolean;
  enrichKinds: string[];
  enrichLayers: string[];
  enrichCount: number;
};

const DEFAULT_LAYERS = ['composition', 'lighting', 'pose', 'expression', 'style'];
const DEFAULT_ENRICH_KINDS = ['draw', 'selfie', 'snapshot', 'paint'];
const DEFAULT_ENRICH_LAYERS = ['style'];

export const WORD_DEFAULT: WordConfig = {
  lang: 'en',
  pickCount: 3,
  disabledCategories: ['negative'],
  recipeLayers: DEFAULT_LAYERS.slice(),
  autoEnrich: true,
  enrichKinds: DEFAULT_ENRICH_KINDS.slice(),
  enrichLayers: DEFAULT_ENRICH_LAYERS.slice(),
  enrichCount: 2,
};

/** style 分类里只取“质量类”词，避免自动补进 anime / watercolor 这类会改画风的词。 */
const SAFE_STYLE = new Set([
  'masterpiece',
  'best quality',
  'highres',
  'absurdres',
  'very aesthetic',
  'newest',
  '4k',
  '8k',
  'detailed',
  'intricate details',
]);
/** 分级/成人相关词一律不参与自动补词（词库里还留着评级标签，但补词时跳过）。 */
const UNSAFE = /(explicit|sensitive|nsfw|nude|naked|lingerie|underwear|swimsuit|bikini|cleavage|sex|shower)/i;

export type WordCategory = { id: string; name: string };
export type WordTag = { cat: string; zh: string; en: string };

type Data = {
  categories: WordCategory[];
  tags: WordTag[];
  builtAt: string;
  byCat: Map<string, WordTag[]>;
};

export function normalizeWordConfig(stored: any, categories: WordCategory[]): WordConfig {
  const known = new Set(categories.map((c) => c.id));
  const lang = WORD_LANGS.includes(stored?.lang) ? stored.lang : WORD_DEFAULT.lang;
  const pickCount = Math.min(8, Math.max(1, Number(stored?.pickCount) || WORD_DEFAULT.pickCount));
  const disabled = Array.isArray(stored?.disabledCategories)
    ? stored.disabledCategories.map(String).filter((id: string) => known.has(id))
    : WORD_DEFAULT.disabledCategories.slice();
  const layers = Array.isArray(stored?.recipeLayers)
    ? stored.recipeLayers.map(String).filter((id: string) => known.has(id))
    : WORD_DEFAULT.recipeLayers.slice();
  const autoEnrich = typeof stored?.autoEnrich === 'boolean' ? stored.autoEnrich : WORD_DEFAULT.autoEnrich;
  const enrichKinds = Array.isArray(stored?.enrichKinds)
    ? stored.enrichKinds.map(String).filter((id: string) => WORD_KINDS.includes(id as WordKind))
    : WORD_DEFAULT.enrichKinds.slice();
  const enrichLayers = Array.isArray(stored?.enrichLayers)
    ? stored.enrichLayers.map(String).filter((id: string) => known.has(id) && id !== 'negative')
    : WORD_DEFAULT.enrichLayers.slice();
  const enrichCount = Math.min(5, Math.max(1, Number(stored?.enrichCount) || WORD_DEFAULT.enrichCount));
  return {
    lang,
    pickCount,
    disabledCategories: disabled,
    recipeLayers: layers,
    autoEnrich,
    enrichKinds,
    enrichLayers,
    enrichCount,
  };
}

function textOf(tag: WordTag, lang: string) {
  const zh = String(tag?.zh ?? '').trim();
  const en = String(tag?.en ?? '').trim();
  if (lang === 'zh') return zh || en;
  if (lang === 'en') return en || zh;
  return zh && en ? zh + ' / ' + en : zh || en;
}

function sample<T>(arr: T[], n: number) {
  const pool = arr.slice();
  const out: T[] = [];
  while (pool.length && out.length < n) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/** 词条的中文或英文任一个已经出现在正文里，就不再补。 */
function tagPresent(hay: string, tag: WordTag) {
  const parts = [tag?.zh, tag?.en]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter((value) => value.length >= 2);
  return parts.some((part) => hay.includes(part));
}

/** 能参与自动补词的词条：质量层只留 SAFE_STYLE，分级/成人词一律跳过。 */
function usable(tag: WordTag, layer?: string) {
  const zh = String(tag?.zh ?? '').trim();
  const en = String(tag?.en ?? '').trim().toLowerCase();
  if (!zh && !en) return false;
  if (UNSAFE.test(zh) || UNSAFE.test(en)) return false;
  if (layer === 'style' && !SAFE_STYLE.has(en)) return false;
  return true;
}

export function createWordEngine(options: { file: string; readConfig: () => Promise<any> }) {
  let cache: Data | null = null;

  const load = (): Data => {
    if (!cache) {
      const file = JSON.parse(readFileSync(options.file, 'utf8'));
      const categories: WordCategory[] = Array.isArray(file.categories) ? file.categories : [];
      const tags: WordTag[] = Array.isArray(file.tags) ? file.tags : [];
      const byCat = new Map<string, WordTag[]>();
      for (const tag of tags) {
        if (!byCat.has(tag.cat)) byCat.set(tag.cat, []);
        byCat.get(tag.cat)!.push(tag);
      }
      cache = { categories, tags, builtAt: String(file.builtAt ?? ''), byCat };
    }
    return cache;
  };

  const cfgOf = async () => {
    let stored: any = null;
    try {
      stored = await options.readConfig();
    } catch {
      stored = null;
    }
    return normalizeWordConfig(stored, load().categories);
  };

  const enabledList = (cfg: WordConfig) => {
    const off = new Set(cfg.disabledCategories);
    return load().categories.filter((c) => !off.has(c.id));
  };

  const stats = (cfg: WordConfig) => {
    const data = load();
    const enabled = enabledList(cfg);
    return {
      categories: data.categories.length,
      enabledCategories: enabled.length,
      tags: data.tags.length,
      enabledTags: enabled.reduce((sum, c) => sum + (data.byCat.get(c.id)?.length ?? 0), 0),
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
    return enabledList(cfg).map((c) => ({ id: c.id, name: c.name, count: (data.byCat.get(c.id) ?? []).length }));
  };

  const search = async (args: any) => {
    const cfg = await cfgOf();
    const q = String(args?.query ?? '').trim().toLowerCase();
    if (!q) return { status: 'error', error: 'query 不能为空' };
    const enabled = new Set(enabledList(cfg).map((c) => c.id));
    const cat = args?.category ? String(args.category) : '';
    if (cat && !enabled.has(cat)) return { status: 'error', error: '这个分类在设置里关掉了：' + cat };
    const limit = Math.min(20, Math.max(1, Number(args?.limit) || 8));
    const lang = WORD_LANGS.includes(args?.lang) ? args.lang : cfg.lang;
    const hits: any[] = [];
    for (const tag of load().tags) {
      if (!enabled.has(tag.cat)) continue;
      if (cat && tag.cat !== cat) continue;
      const zh = String(tag.zh ?? '').toLowerCase();
      const en = String(tag.en ?? '').toLowerCase();
      if (zh.includes(q) || en.includes(q)) {
        hits.push({ cat: tag.cat, zh: tag.zh, en: tag.en, text: textOf(tag, lang) });
        if (hits.length >= limit) break;
      }
    }
    return { status: 'ok', query: args?.query, count: hits.length, tags: hits };
  };

  const pick = async (args: any) => {
    const cfg = await cfgOf();
    const enabled = enabledList(cfg);
    const count = Math.min(8, Math.max(1, Number(args?.count) || cfg.pickCount));
    const lang = WORD_LANGS.includes(args?.lang) ? args.lang : cfg.lang;
    const cat = args?.category ? String(args.category) : '';
    const data = load();
    let pool: WordTag[] = [];
    if (cat) {
      if (!enabled.some((c) => c.id === cat)) return { status: 'error', error: '这个分类在设置里关掉了：' + cat };
      pool = data.byCat.get(cat) ?? [];
    } else {
      for (const c of enabled) pool = pool.concat(data.byCat.get(c.id) ?? []);
    }
    if (!pool.length) return { status: 'error', error: '没有可用的词' };
    const picked = sample(pool, count);
    const texts = picked.map((tag) => textOf(tag, lang)).filter(Boolean);
    return {
      status: 'ok',
      category: cat || 'all',
      tags: picked.map((tag) => ({ cat: tag.cat, zh: tag.zh, en: tag.en, text: textOf(tag, lang) })),
      text: texts.join(', '),
    };
  };

  const recipe = async (args: any) => {
    const cfg = await cfgOf();
    const enabled = new Set(enabledList(cfg).map((c) => c.id));
    const lang = WORD_LANGS.includes(args?.lang) ? args.lang : cfg.lang;
    let layersList = cfg.recipeLayers.filter((id) => enabled.has(id));
    if (!layersList.length) layersList = DEFAULT_LAYERS.filter((id) => enabled.has(id));
    const data = load();
    const words: string[] = [];
    const layersOut: any[] = [];
    for (const cat of layersList) {
      const pool = data.byCat.get(cat);
      if (!pool?.length) continue;
      const picked = sample(pool, 1).map((tag) => textOf(tag, lang)).filter(Boolean);
      if (!picked.length) continue;
      words.push(...picked);
      layersOut.push({ category: cat, words: picked });
    }
    const extra = String(args?.extra ?? '').trim();
    if (extra) words.push(extra);
    return { status: 'ok', text: words.join(', '), layers: layersOut };
  };

  /** 生图自动补词：先把正文里的中文换成词库英文，再从勾选的层补词；已有的词跳过。 */
  const enrich = async (input: any) => {
    const cfg = await cfgOf();
    const text = String(input?.text ?? '').trim();
    const kind = String(input?.kind ?? 'draw');
    const stop = (skipped: string) => ({ text, added: [] as Array<{ cat: string; word: string; why: string }>, skipped });
    if (!text) return stop('empty');
    if (!cfg.autoEnrich) return stop('off');
    if (!cfg.enrichKinds.includes(kind)) return stop('kind');
    if (input?.signal?.aborted) return stop('aborted');
    const enabled = new Set(enabledList(cfg).map((c) => c.id));
    const layers = cfg.enrichLayers.filter((id) => enabled.has(id) && id !== 'negative');
    if (!layers.length) return stop('layers');
    const data = load();
    const hay = text.toLowerCase();
    const added: Array<{ cat: string; word: string; why: string }> = [];
    const words: string[] = [];

    // 1) 正文里写了中文、词库有对应英文的，补英文（画图模型对英文更跟得住）。
    for (const tag of data.tags) {
      if (words.length >= cfg.enrichCount) break;
      if (input?.signal?.aborted) return stop('aborted');
      if (!enabled.has(tag.cat) || tag.cat === 'negative') continue;
      if (!usable(tag, tag.cat)) continue;
      const zh = String(tag.zh ?? '').trim();
      const en = String(tag.en ?? '').trim();
      if (zh.length >= 2 && en && hay.includes(zh.toLowerCase()) && !hay.includes(en.toLowerCase()) && !words.includes(en)) {
        words.push(en);
        added.push({ cat: tag.cat, word: en, why: '中文→英文' });
      }
    }

    // 2) 再从勾选的层里补，正文里已经出现的词跳过。
    for (let round = 0; words.length < cfg.enrichCount && round < 8; round++) {
      for (const layer of layers) {
        if (words.length >= cfg.enrichCount) break;
        if (input?.signal?.aborted) return stop('aborted');
        const pool = (data.byCat.get(layer) ?? []).filter((tag) => {
          if (!usable(tag, layer)) return false;
          const word = textOf(tag, cfg.lang);
          return Boolean(word) && !words.includes(word) && !tagPresent(hay, tag);
        });
        if (!pool.length) continue;
        const picked = pool[Math.floor(Math.random() * pool.length)];
        const word = textOf(picked, cfg.lang);
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
      categories: data.categories.map((c) => ({ id: c.id, name: c.name, count: (data.byCat.get(c.id) ?? []).length })),
      builtAt: data.builtAt,
    };
  };

  return {
    stats: async () => stats(await cfgOf()),
    categories,
    search,
    pick,
    recipe,
    enrich,
    pageData,
    reload: () => {
      cache = null;
    },
  };
}

export type WordEngine = ReturnType<typeof createWordEngine>;
