/*! 画室（studio）：调用 Python 边车（看图 / 画蒙版 / 读尺寸）。
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { execFile } from 'node:child_process';

export type ImgToolResult = { ok: boolean; error?: string; [key: string]: any };

/** 跑一次 imgtool.py，只认最后一行 JSON；stderr 用来补错误说明。 */
export function runImgtool(
  python: string,
  script: string,
  args: string[],
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<ImgToolResult> {
  return new Promise((resolve, reject) => {
    const options: any = {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    };
    if (signal) options.signal = signal;
    execFile(python, [script, ...args], options, (error, stdout, stderr) => {
      const line = String(stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.ok === false) return resolve({ ok: false, error: String(parsed.error ?? '边车报错') });
          return resolve(parsed);
        } catch {
          // 落到下面的统一报错
        }
      }
      const tail = String(stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
      if (error) {
        const killed = (error as any).killed ? '（超时被杀）' : '';
        return resolve({ ok: false, error: `${String((error as any).message ?? error).slice(0, 300)}${killed}${tail ? '：' + tail : ''}` });
      }
      resolve({ ok: false, error: tail || '边车没有返回可解析的 JSON' });
    });
  });
}
