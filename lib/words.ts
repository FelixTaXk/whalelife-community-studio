/*! 画室 · 提示词词库引擎。
 *
 * 词库可选：优先读用户自己的 data/prompts.json；没有就读随包附带的 prompts.sample.json。
 * 两个都没有时引擎照样工作，只是词条为 0，页面提示导入，不抛异常。
 * 「提示词小抄」子插件和画画子插件共用这一份逻辑：父插件用 ctx.provide('promptkit') 暴露，
 * 补词配置仍由子插件自己的 data/config.json 管。
 *
 * NSFW：词库可以带成人分类（id 以 nsfw 开头）。是否可用由配置里的 allowNsfw 决定，默认关闭。
 * 关闭时这些分类不参与 categories / search / pick / recipe；自动补词永远不碰成人分类，
 * 无论开关开没开 —— 补词是无人值守往每张图上加词，不该悄悄加成人内容。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WORD_KINDS = ['draw', 'selfie', 'snapshot', 'paint'] as const;
export type WordKind = (typeof WORD_KINDS)[number];
export const WORD_LANGS = ['zh', 'en', 'both'] as const;

/** 成人分类：id 以 nsfw 开头（nsfwbody / nsfwcloth / nsfwact / nsfwplay）。 */
export const isNsfwCategory = (id: string) => /^nsfw/i.test(String(id ?? ''));

export type WordConfig = {
  lang: 'zh' | 'en' | 'both';
  pickCount: number;
  disabledCategories: string[];
  recipeLayers: string[];
  autoEnrich: boolean;
  enrichKinds: string[];
  enrichLayers: string[];
  enrichCount: number;
  /** 是否允许查词工具使用 NSFW 分类（默认 false）。自动补词不受它影响，始终不用成人分类。 */
  allowNsfw: boolean;
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
  allowNsfw: false,
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

export type WordCategory = { id: string; name: string; icon?: string; count?: number };
export type WordTag = { cat: string; zh: string; en: string };

type Data = {
  categories: WordCategory[];
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

/** 一份都没有时的空词库（页面能打开，工具给导入说明）。 */
function parseEmpty(path: string, broken = false): Data {
  return {
    categories: [],
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

/** 当前词库从哪儿来：自己的文件、随包示例，或两者都没有。 */
export type WordLibrary = {
  path: string;
  exists: boolean;
  sample: boolean;
  bytes: number;
  builtAt: string;
  categories: number;
  tags: number;
  /** 词库里的成人分类数 / 词条数；是否能用由 allowNsfw 决定 */
  nsfwCategories: number;
  nsfwTags: number;
  /** 用户自己的词库存在但读不出来（JSON 坏了 / 没有词条），已回退到示例 */
  broken: boolean;
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
    ? stored.enrichLayers
        .map(String)
        .filter((id: string) => known.has(id) && id !== 'negative' && !isNsfwCategory(id))
    : WORD_DEFAULT.enrichLayers.slice();
  const enrichCount = Math.min(5, Math.max(1, Number(stored?.enrichCount) || WORD_DEFAULT.enrichCount));
  const allowNsfw = stored?.allowNsfw === true;
  return {
    lang,
    pickCount,
    disabledCategories: disabled,
    recipeLayers: layers,
    autoEnrich,
    enrichKinds,
    enrichLayers,
    enrichCount,
    allowNsfw,
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

/** 能参与自动补词的词条：质量层只留 SAFE_STYLE，成人分类和分级词一律跳过。 */
function usable(tag: WordTag, layer?: string) {
  const zh = String(tag?.zh ?? '').trim();
  const en = String(tag?.en ?? '').trim().toLowerCase();
  if (!zh && !en) return false;
  if (isNsfwCategory(tag.cat)) return false;
  if (UNSAFE.test(zh) || UNSAFE.test(en)) return false;
  if (layer === 'style' && !SAFE_STYLE.has(en)) return false;
  return true;
}

export function createWordEngine(options: { file: string; sample?: string; readConfig: () => Promise<any> }) {
  let cache: Data | null = null;
  /** 用户词库坏了并回退到示例 */
  let broken = false;

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

  const parse = (path: string, sample: boolean, bytes: number): Data | null => {
    let raw: any = {};
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
    // 兼容两种写法：引擎自己的 categories，以及 PromptForge 源数据的 cats。
    // 用户直接把自己那份源数据丢进 data/ 也能读，不用先跑脚本转格式。
    const rawCats = Array.isArray(raw.categories) ? raw.categories : Array.isArray(raw.cats) ? raw.cats : [];
    const categories: WordCategory[] = rawCats
      .filter((c: any) => c && typeof c.id === 'string' && c.id)
      .map((c: any) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
    const tags: WordTag[] = (Array.isArray(raw.tags) ? raw.tags : []).filter(
      (t: any) => t && categories.some((c) => c.id === t.cat) && (String(t.zh ?? '').trim() || String(t.en ?? '').trim()),
    );
    if (!tags.length) return null;
    const byCat = new Map<string, WordTag[]>();
    for (const tag of tags) {
      if (!byCat.has(tag.cat)) byCat.set(tag.cat, []);
      byCat.get(tag.cat)!.push(tag);
    }
    return {
      categories,
      tags,
      builtAt: String(raw.builtAt ?? raw.generatedAt ?? ''),
      byCat,
      path,
      sample,
      bytes,
      broken,
      nsfwCategories: categories.filter((c) => isNsfwCategory(c.id)).length,
      nsfwTags: tags.filter((t) => isNsfwCategory(t.cat)).length,
    };
  };

  const load = (): Data => {
    if (!cache) {
      broken = false;
      const list = candidates();
      for (const item of list) {
        const data = parse(item.path, item.sample, item.bytes);
        if (data) {
          cache = data;
          break;
        }
        if (!item.sample) broken = true;
      }
      if (!cache) {
        broken = list.some((item) => !item.sample);
        cache = parseEmpty(join(options.file), broken);
      }
    }
    return cache;
  };

  const library = async (): Promise<WordLibrary> => {
    const data = load();
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

  const cfgOf = async () => {
    let stored: any = null;
    try {
      stored = await options.readConfig();
    } catch {
      stored = null;
    }
    return normalizeWordConfig(stored, load().categories);
  };

  /** 工具能用到的分类：配置里没被禁用，且（成人分类）开关是开着的。 */
  const enabledList = (cfg: WordConfig) => {
    const off = new Set(cfg.disabledCategories);
    return load().categories.filter((c) => !off.has(c.id) && (cfg.allowNsfw || !isNsfwCategory(c.id)));
  };

  /** 请求某个分类但拿不到时，说清楚是「被设置关了」还是「成人分类开关没开」。 */
  const unavailableReason = (cat: string, cfg: WordConfig) => {
    if (isNsfwCategory(cat) && !cfg.allowNsfw) return '这是成人（NSFW）分类，开关没开；设置页 →「NSFW 分类」里可以打开：' + cat;
    return '这个分类在设置里关掉了：' + cat;
  };

  const stats = (cfg: WordConfig) => {
    const data = load();
    const enabled = enabledList(cfg);
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
    return enabledList(cfg).map((c) => ({ id: c.id, name: c.name, count: (data.byCat.get(c.id) ?? []).length }));
  };

  const search = async (args: any) => {
    const cfg = await cfgOf();
    const q = String(args?.query ?? '').trim().toLowerCase();
    if (!q) return { status: 'error', error: 'query 不能为空' };
    const enabled = new Set(enabledList(cfg).map((c) => c.id));
    const cat = args?.category ? String(args.category) : '';
    if (cat && !enabled.has(cat)) return { status: 'error', error: unavailableReason(cat, cfg) };
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
    if (cat === 'negative') {
      return { status: 'error', error: '负面词不参与随机挑词：挑出来只能当正面的画面描述，写负面提示词请用 prompt_search。' };
    }
    // 负面分类就算在设置里勾上了，也只给 search 用，不进随机挑词的池子。
    const pickable = enabled.filter((c) => c.id !== 'negative');
    let pool: WordTag[] = [];
    if (cat) {
      if (!pickable.some((c) => c.id === cat)) return { status: 'error', error: unavailableReason(cat, cfg) };
      pool = data.byCat.get(cat) ?? [];
    } else {
      for (const c of pickable) pool = pool.concat(data.byCat.get(c.id) ?? []);
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
    // 负面词不进配方：拼出来是正面描述，混进 low quality 之类的词只会互相打架。
    let layersList = cfg.recipeLayers.filter((id) => enabled.has(id) && id !== 'negative');
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
      categories: data.categories.map((c) => ({
        id: c.id,
        name: c.name,
        count: (data.byCat.get(c.id) ?? []).length,
        /** 页面据此把成人分类和普通分类分开显示、并跟着开关上锁 */
        nsfw: isNsfwCategory(c.id),
      })),
      builtAt: data.builtAt,
      library: await library(),
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
    // 和 parse 一样兼容 PromptForge 源数据的 cats 写法，免得用户还得先跑脚本转格式。
    const rawCats = Array.isArray(parsed?.categories) ? parsed.categories : Array.isArray(parsed?.cats) ? parsed.cats : null;
    if (!rawCats || !rawCats.length) throw Error('缺少 categories 数组');
    if (!Array.isArray(parsed?.tags) || !parsed.tags.length) throw Error('缺少 tags 数组');
    const categories: WordCategory[] = rawCats
      .filter((c: any) => c && typeof c.id === 'string' && c.id)
      .map((c: any) => {
        // 分类上的 icon / count 不影响查词，但没必要在导入时丢掉（源数据里有 icon，例如 🔞）。
        const out: WordCategory = { id: String(c.id), name: String(c.name ?? c.id) };
        if (typeof c.icon === 'string' && c.icon) out.icon = c.icon;
        const count = Number(c.count);
        if (Number.isFinite(count) && count > 0) out.count = Math.round(count);
        return out;
      });
    if (!categories.length) throw Error('categories 里没有合法的分类');
    const ids = new Set(categories.map((c) => c.id));
    const tags: WordTag[] = parsed.tags
      .filter((t: any) => t && ids.has(String(t.cat ?? '')))
      .map((t: any) => ({ cat: String(t.cat), zh: String(t.zh ?? ''), en: String(t.en ?? '') }))
      .filter((t: WordTag) => t.zh.trim() || t.en.trim());
    if (!tags.length) throw Error('tags 里没有能用的词条（cat 要能对上 categories）');
    const clean = {
      version: parsed.version ?? 1,
      license: String(parsed.license ?? ''),
      source: String(parsed.source ?? ''),
      note: String(parsed.note ?? ''),
      builtAt: String(parsed.builtAt ?? parsed.generatedAt ?? new Date().toISOString()),
      categories,
      tags,
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
