/*! 姿势 · 页面与接口注册。 */

import { readFileSync } from 'node:fs';
import type { Context } from 'whalelife';
import { assetPath, assetUrl, loadCatalog, remoteAssetUrl, type AssetSize, type Catalog } from './catalog.ts';
import { readConfig } from './config.ts';
import { audienceFor, listAudiences } from './policy.ts';
import { gallery, importLibrary, saveConfig, stats } from './service.ts';
import { resolveLibraryRoot } from './paths.ts';
import { poseSettingsPage } from '../ui/settings.ts';

function sendJson(res: any, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendHtml(res: any, html: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

async function readJson(req: any, signal: AbortSignal): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw Error('请求体过大');
    chunks.push(buffer);
  }
  signal.throwIfAborted();
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mimeOf(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

const SIZES: AssetSize[] = ['thumb', 'image', 'depthThumb', 'depth'];

export type PoseWebOptions = { version: string };

export function registerWeb(ctx: Context, _catalog: Catalog, options: PoseWebOptions) {
  const base = '/plugins/studio/pose/';

  ctx.web.page(base + 'settings', async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const personaId = url.searchParams.get('persona') ?? undefined;
      const config = await readConfig(ctx);
      const [audience, personas] = await Promise.all([
        audienceFor(ctx, personaId),
        listAudiences(ctx),
      ]);
      // 高级参考没开、或人格未成年时，统计里不出现 private；双人开关没开时也不出现 couple。
      const advancedNow = config.advanced === true && audience.adult === true;
      const coupleNow = advancedNow && config.couple === true;
      const library = await stats(ctx, { hidePrivate: !advancedNow, hideCouple: !coupleNow });
      sendHtml(res, poseSettingsPage({ version: options.version, config: library.config, stats: library, personas, persona: { id: audience.id, name: audience.name, age: audience.age, adult: audience.adult }, advanced: advancedNow, couple: coupleNow }));
    } catch (error) {
      ctx.logger.warn('姿势页面渲染失败', { error: errorText(error) });
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('姿势页面加载失败，请稍后重试');
    }
  }, { title: '姿势', settings: true });

  // 图片：先读本地库，读不到再 302 到云端图源。
  // 页面里是 <img src> 的 GET 请求，必须用 page 注册（不传 entry，不进侧栏）。
  ctx.web.page(base + 'thumb', async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const id = url.searchParams.get('id') ?? '';
      const rawSize = String(url.searchParams.get('size') ?? 'thumb');
      const size: AssetSize = SIZES.includes(rawSize as AssetSize) ? (rawSize as AssetSize) : 'thumb';
      const item = loadCatalog().byId.get(id);
      if (!item) {
        res.statusCode = 404;
        res.end('no such pose');
        return;
      }
      const config = await readConfig(ctx);
      if (item.tier === 'private' || item.tier === 'couple') {
        // 默认整类不可见：没开高级开关、或人格未成年，直接 404，不靠前端藏。
        const audience = await audienceFor(ctx, url.searchParams.get('persona') ?? undefined);
        if (config.advanced !== true || !audience.adult) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        // 双人组在高级之上再加一层，双人开关没开也直接 404。
        if (item.tier === 'couple' && config.couple !== true) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
      }
      const remote = remoteAssetUrl(config, item, size);
      const root = resolveLibraryRoot(config);
      const local = assetPath(root, item, size);
      if (local) {
        const body = readFileSync(local);
        res.setHeader('Content-Type', mimeOf(local));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(body);
        return;
      }
      if (remote) {
        res.statusCode = 302;
        res.setHeader('Location', remote);
        res.setHeader('Cache-Control', 'public, max-age=600');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end('image missing');
    } catch (error) {
      res.statusCode = 500;
      res.end(errorText(error));
    }
  });

  ctx.web.api(base + 'data', async (req: any, res: any, { signal }: { signal: AbortSignal }) => {
    try {
      const body = await readJson(req, signal);
      const action = String(body?.action ?? 'read');

      if (action === 'read') {
        const personaId = typeof body?.personaId === 'string' ? body.personaId : undefined;
        const [audience, personas] = await Promise.all([
          audienceFor(ctx, personaId),
          listAudiences(ctx),
        ]);
        const config = await readConfig(ctx);
        const advanced = config.advanced === true && audience.adult;
        const couple = advanced && config.couple === true;
        const library = await stats(ctx, { hidePrivate: !advanced, hideCouple: !couple });
        sendJson(res, 200, { ok: true, config: library.config, stats: library, personas, advanced, couple, persona: { id: audience.id, name: audience.name, age: audience.age, adult: audience.adult } });
        return;
      }

      if (action === 'list') {
        const result = await gallery(ctx, {
          system: body?.system,
          category: body?.category,
          view: body?.view,
          keyword: body?.keyword,
          tier: body?.tier,
          limit: body?.limit,
          offset: body?.offset,
          personaId: typeof body?.personaId === 'string' ? body.personaId : undefined,
        });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (action === 'save') {
        const raw = body?.config && typeof body.config === 'object' ? body.config : {};
        const assetBase = String(raw.assetBaseUrl ?? '').trim();
        if (assetBase && !/^https?:\/\//i.test(assetBase)) throw Error('图片 CDN 前缀必须是 http(s) 地址');
        // 只写前端真正提交的字段；没提交的保持原值，避免局部保存把图源/开关清掉。
        const payload: any = {};
        if ('libraryRoot' in raw) payload.libraryRoot = String(raw.libraryRoot ?? '');
        if ('assetBaseUrl' in raw) payload.assetBaseUrl = String(raw.assetBaseUrl ?? '');
        if ('importRoot' in raw) payload.importRoot = String(raw.importRoot ?? '');
        if ('adultThreshold' in raw) payload.adultThreshold = Number(raw.adultThreshold);
        if ('unknownPersona' in raw) payload.unknownPersona = raw.unknownPersona === 'adult' ? 'adult' : 'minor';
        if ('personaPolicy' in raw) payload.personaPolicy = raw.personaPolicy && typeof raw.personaPolicy === 'object' ? raw.personaPolicy : {};
        if ('preferDepth' in raw) payload.preferDepth = raw.preferDepth === true;
        if ('viewPreference' in raw) payload.viewPreference = String(raw.viewPreference ?? 'auto');
        // 高级 / 双人开关只在前端明确提交时才改；没提交保持原值。
        if (typeof raw.advanced === 'boolean') payload.advanced = raw.advanced;
        if (typeof raw.couple === 'boolean') payload.couple = raw.couple;
        const config = await saveConfig(ctx, payload);
        const audience = await audienceFor(ctx, typeof body?.personaId === 'string' ? body.personaId : undefined);
        const advancedNow = config.advanced === true && audience.adult;
        const coupleNow = advancedNow && config.couple === true;
        sendJson(res, 200, { ok: true, config, stats: await stats(ctx, { hidePrivate: !advancedNow, hideCouple: !coupleNow }) });
        return;
      }

      if (action === 'import') {
        const result = await importLibrary(ctx, body?.root);
        const configNow = await readConfig(ctx);
        const audience = await audienceFor(ctx, typeof body?.personaId === 'string' ? body.personaId : undefined);
        const advanced = result && configNow.advanced === true && audience.adult;
        const couple = advanced && configNow.couple === true;
        sendJson(res, 200, { ok: true, result, stats: await stats(ctx, { hidePrivate: !advanced, hideCouple: !couple }) });
        return;
      }

      throw Error('操作无效');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorText(error) });
    }
  });
}
