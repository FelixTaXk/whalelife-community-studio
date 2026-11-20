/*! 画室（studio）：ComfyUI 直连客户端（只用 HTTP，不碰它的文件）。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { b64, describeFailure, httpJson, joinUrl, stripDataUri } from './util.ts';

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('已取消'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

export class ComfyClient {
  readonly base: string;
  readonly timeoutMs: number;
  constructor(base: string, timeoutMs = 300_000) {
    this.base = String(base ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.base)) throw new Error('ComfyUI 地址要以 http:// 开头');
    this.timeoutMs = timeoutMs;
  }

  private async call(path: string, options: any = {}) {
    return httpJson(joinUrl(this.base, path), { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs });
  }

  async stats(signal?: AbortSignal) {
    const r = await this.call('/system_stats', { signal, timeoutMs: 15_000 });
    if (!r.ok) throw new Error(describeFailure(r, '查 ComfyUI 状态'));
    return r.json;
  }

  async objectInfo(node: string, signal?: AbortSignal): Promise<any | null> {
    const r = await this.call(`/object_info/${encodeURIComponent(node)}`, { signal, timeoutMs: 20_000 });
    return r.ok ? r.json?.[node] ?? null : null;
  }

  /** 全量 /object_info：里面有每个加载节点的可选文件名枚举，正好拿来当「本地模型清单」。 */
  async allObjectInfo(signal?: AbortSignal): Promise<any | null> {
    const r = await this.call('/object_info', { signal, timeoutMs: 60_000 });
    return r.ok ? r.json : null;
  }

  /** 传给 LoadImage 的文件名：先上传到它的 input 目录，拿到服务端认识的名字。 */
  async upload(localPath: string, signal?: AbortSignal): Promise<string> {
    const bytes = readFileSync(localPath);
    const name = localPath.split(/[\\/]/).pop() as string;
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: 'image/png' }), name);
    form.append('overwrite', 'true');
    const r = await this.call('/upload/image', { method: 'POST', form, signal, timeoutMs: 60_000 });
    if (!r.ok) throw new Error(describeFailure(r, '上传图片给 ComfyUI'));
    const returned = r.json?.name;
    if (typeof returned !== 'string' || !returned) throw new Error('ComfyUI 没返回上传后的文件名');
    const subfolder = typeof r.json?.subfolder === 'string' ? r.json.subfolder.trim() : '';
    return subfolder ? `${subfolder}/${returned}` : returned;
  }

  inline(localPath: string): string {
    return 'data:image/png;base64,' + b64(readFileSync(localPath));
  }

  async submit(prompt: any, signal?: AbortSignal): Promise<string> {
    const r = await this.call('/prompt', {
      method: 'POST',
      signal,
      body: { client_id: 'studio-' + Math.random().toString(36).slice(2), prompt },
    });
    if (!r.ok) {
      const nodes = r.json?.node_errors ? '，出错节点：' + Object.keys(r.json.node_errors).join(', ') : '';
      throw new Error(describeFailure(r, '提交工作流') + nodes);
    }
    const id = r.json?.prompt_id;
    if (typeof id !== 'string' || !id) throw new Error('ComfyUI 没给任务编号');
    return id;
  }

  async waitFor(id: string, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.call(`/history/${encodeURIComponent(id)}`, { signal, timeoutMs: 20_000 });
      if (r.ok) {
        const item = r.json?.[id];
        if (item) {
          const status = item.status ?? {};
          if (status.status_str === 'error' || status.status_str === 'failed') {
            const detail = status.messages?.find?.((m: any[]) => m?.[0] === 'execution_error')?.[1];
            const where = detail?.node_type ? `（${detail.node_type} #${detail.node_id}）` : '';
            const message = detail?.exception_message ? String(detail.exception_message).slice(0, 300) : '';
            const kind = String(detail?.exception_type ?? '');
            const hint = /JSONDecodeError/i.test(kind)
              ? '多半是模型文件的量化元数据读不出来 —— 这个文件本机这版 ComfyUI 带不动，换一个底模/编码器再试'
              : '';
            throw new Error(`ComfyUI 出图失败${where}：${message.trim() || '看它的控制台'}${hint ? ' —— ' + hint : ''}`);
          }
          if (item.outputs && Object.keys(item.outputs).length) return item;
        }
      }
      await sleep(1200, signal);
    }
    throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没出结果`);
  }

  /** 从 history 的 outputs 里挑出所有产物文件（图片/视频都走 filename+subfolder+type）。 */
  collectFiles(item: any): Array<{ filename: string; subfolder: string; type: string }> {
    const found: Array<{ filename: string; subfolder: string; type: string }> = [];
    for (const block of Object.values(item?.outputs ?? {}) as any[]) {
      for (const list of ['images', 'gifs', 'videos', 'video', 'audio']) {
        if (!Array.isArray(block?.[list])) continue;
        for (const file of block[list]) {
          if (file && typeof file.filename === 'string' && file.filename) {
            found.push({ filename: file.filename, subfolder: String(file.subfolder ?? ''), type: String(file.type ?? 'output') });
          }
        }
      }
    }
    return found;
  }

  async download(file: { filename: string; subfolder: string; type: string }, target: string, signal?: AbortSignal): Promise<number> {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const url = joinUrl(this.base, `/view?${query.toString()}`);
    const timeout = AbortSignal.timeout(Math.max(30_000, this.timeoutMs));
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetch(url, { signal: composed });
    if (!res.ok) throw new Error(`取回文件失败（HTTP ${res.status}）：${file.filename}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return bytes.length;
  }

  async interrupt(signal?: AbortSignal): Promise<void> {
    await this.call('/interrupt', { method: 'POST', signal, timeoutMs: 10_000, body: {} });
  }

  /** 可选：从 object_info 里读出当前装了哪些底模，给设置页和模型清单用。 */
  async checkpoints(signal?: AbortSignal): Promise<string[]> {
    const info = await this.objectInfo('CheckpointLoaderSimple', signal);
    const list = info?.input?.required?.ckpt_name?.[0];
    return Array.isArray(list) ? list.map(String) : [];
  }
}

export function decodeResponseImage(entry: any): { bytes: Buffer; mime: string } | null {
  if (!entry) return null;
  if (typeof entry.b64_json === 'string' && entry.b64_json) {
    return { bytes: Buffer.from(stripDataUri(entry.b64_json), 'base64'), mime: 'image/png' };
  }
  if (typeof entry.image_base64 === 'string' && entry.image_base64) {
    return { bytes: Buffer.from(stripDataUri(entry.image_base64), 'base64'), mime: 'image/png' };
  }
  return null;
}
