/*! 画室（studio）共享工具层。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const rand = () => Math.random().toString(36).slice(2, 7);

export function extOf(name: string, fallback = 'png'): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : fallback;
}

export function safeName(text: string, max = 48): string {
  return String(text ?? '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'item';
}

export function joinUrl(base: string, path: string): string {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  const p = String(path ?? '').trim();
  if (!p) return b;
  return b + (p.startsWith('/') ? p : '/' + p);
}

/** 「832x1216」「832*1216」「832×1216」都认。 */
export function parseSize(input: unknown): { width: number; height: number } | null {
  if (typeof input !== 'string') return null;
  const m = /^\s*(\d{2,5})\s*[xX*×]\s*(\d{2,5})\s*$/.exec(input);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) return null;
  return { width, height };
}

export function formatSize(width?: number, height?: number): string {
  if (!width || !height) return '';
  return `${width}x${height}`;
}

/** 把尺寸吸到允许的档位里；返回 null 表示原尺寸已合法。 */
export function snapSize(
  width: number,
  height: number,
  allowed: Array<[number, number]>,
  multiple?: number,
): { width: number; height: number; adjusted: boolean } {
  if (allowed.length) {
    const nearest = allowed
      .map(([w, h]) => ({ w, h, d: Math.abs(w - width) + Math.abs(h - height) }))
      .sort((a, b) => a.d - b.d)[0];
    if (nearest && nearest.d > 0) return { width: nearest.w, height: nearest.h, adjusted: true };
    return { width, height, adjusted: false };
  }
  if (multiple) {
    const w = Math.max(multiple, Math.round(width / multiple) * multiple);
    const h = Math.max(multiple, Math.round(height / multiple) * multiple);
    return { width: w, height: h, adjusted: w !== width || h !== height };
  }
  return { width, height, adjusted: false };
}

export type HttpResult = {
  status: number;
  ok: boolean;
  json: any;
  text: string;
  error?: string;
};

const MAX_TEXT = 4000;

/**
 * 一次 HTTP 往返：自带超时与取消，错误正文只留前面一小段。
 * 连不上时给出「后端没在跑」这类能直接照做的提示。
 */
export async function httpJson(
  url: string,
  options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    form?: FormData;
    accept?: string;
  } = {},
): Promise<HttpResult> {
  const { method = 'GET', body, headers = {}, timeoutMs = 120000, signal, form, accept } = options;
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const init: any = { method, headers: { ...headers }, signal: composed };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (accept) init.headers.Accept = accept;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text: text.slice(0, MAX_TEXT) };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (/aborted|AbortError|timeout/i.test(message)) {
      return { status: 0, ok: false, json: null, text: '', error: `请求超时或被取消（${Math.round(timeoutMs / 1000)} 秒）：${url}` };
    }
    if (/refused|10061|ECONNREFUSED|fetch failed/i.test(message)) {
      return { status: 0, ok: false, json: null, text: '', error: `连不上 ${new URL(url).origin} —— 后端没在跑，或端口不对` };
    }
    return { status: 0, ok: false, json: null, text: '', error: message };
  }
}

/** 从各家错误体里尽量捞一句人话，捞不到就用状态码。 */
export function describeFailure(result: HttpResult, what: string): string {
  if (result.error) return result.error;
  const candidates = [
    result.json?.error?.message,
    result.json?.error?.msg,
    result.json?.error,
    result.json?.message,
    result.json?.msg,
    result.json?.code && result.json?.message,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return `${what}出错（HTTP ${result.status}）：${item.slice(0, 300)}`;
  }
  const chunk = (result.text ?? '').replace(/\s+/g, ' ').trim();
  if (chunk) return `${what}出错（HTTP ${result.status}）：${chunk.slice(0, 300)}`;
  return `${what}出错（HTTP ${result.status}）`;
}

export function b64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes as any).toString('base64');
}

export function decodeB64(text: string): Buffer {
  return Buffer.from(String(text ?? ''), 'base64');
}

/** 各家返回里可能混着 data URI 前缀，统一剥掉。 */
export function stripDataUri(text: string): string {
  return String(text ?? '').replace(/^data:[^;]+;base64,/, '');
}
