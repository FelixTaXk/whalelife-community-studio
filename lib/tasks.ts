/*! 画室（studio）：后台任务表。
 *
 * 出图一分钟、视频几分钟，都比一次工具调用的等待窗口长；所以重活都丢进这里，
 * 工具先给任务号，之后用 task 工具查。任务记录落盘，重启后仍能看到已经完成的那些。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenFile, GenResult } from './types.ts';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export type TaskRecord = {
  id: string;
  kind: 'image' | 'video';
  status: TaskStatus;
  backend: string;
  prompt: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  files?: GenFile[];
  seed?: number;
  width?: number;
  height?: number;
  notes?: string[];
  error?: string;
};

export type TaskSpec = {
  kind: 'image' | 'video';
  backend: string;
  prompt: string;
  width?: number;
  height?: number;
  /** 展示用的请求摘要，不含超长提示词 */
  brief?: Record<string, any>;
};

const MAX_KEPT = 200;

export class TaskBox {
  private readonly dir: string;
  private readonly limit: number;
  private readonly logger: (message: string) => void;
  private readonly records = new Map<string, TaskRecord>();
  private readonly runners = new Map<string, (signal: AbortSignal) => Promise<GenResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly parentSignal: AbortSignal;
  private active = 0;
  private stopped = false;
  private readonly onAbort = () => this.dispose();

  constructor(options: { dir: string; signal: AbortSignal; limit?: number; logger?: (message: string) => void }) {
    this.dir = options.dir;
    this.limit = Math.max(1, options.limit ?? 1);
    this.logger = options.logger ?? (() => {});
    this.parentSignal = options.signal;
    mkdirSync(this.dir, { recursive: true });
    this.restore();
    this.parentSignal.addEventListener('abort', this.onAbort, { once: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private restore(): void {
    try {
      const files = readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
      for (const name of files.slice(-MAX_KEPT)) {
        const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as TaskRecord;
        if (!record?.id) continue;
        // 上一次进程里没跑完的，恢复时标成中断，避免看起来像还在跑。
        if (record.status === 'running' || record.status === 'queued') {
          record.status = 'failed';
          record.error = '宿主重启，任务中断';
          record.finishedAt = record.finishedAt ?? new Date().toISOString();
          this.persist(record);
        }
        this.records.set(record.id, record);
      }
    } catch (error: any) {
      this.logger(`任务记录读取失败：${String(error?.message ?? error)}`);
    }
  }

  private persist(record: TaskRecord): void {
    try {
      writeFileSync(this.path(record.id), JSON.stringify(record, null, 2), 'utf8');
    } catch {
      // 落盘失败不影响任务本身
    }
  }

  private prune(): void {
    if (this.records.size <= MAX_KEPT) return;
    const finished = [...this.records.values()]
      .filter((record) => record.status !== 'running' && record.status !== 'queued')
      .sort((a, b) => (a.finishedAt ?? a.createdAt).localeCompare(b.finishedAt ?? b.createdAt));
    while (this.records.size > MAX_KEPT && finished.length) {
      const victim = finished.shift() as TaskRecord;
      this.records.delete(victim.id);
      try {
        unlinkSync(this.path(victim.id));
      } catch {
        // 删不掉就留着
      }
    }
  }

  create(spec: TaskSpec, run: (signal: AbortSignal) => Promise<GenResult>): TaskRecord {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const record: TaskRecord = {
      id,
      kind: spec.kind,
      status: 'queued',
      backend: spec.backend,
      prompt: spec.prompt.length > 200 ? spec.prompt.slice(0, 200) + '…' : spec.prompt,
      createdAt: new Date().toISOString(),
      width: spec.width,
      height: spec.height,
      ...(spec.brief ? { notes: ['请求：' + JSON.stringify(spec.brief)] } : {}),
    };
    this.records.set(id, record);
    this.runners.set(id, run);
    this.persist(record);
    this.pump();
    this.prune();
    return record;
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  list(max = 20): TaskRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, max)));
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status === 'done' || record.status === 'failed' || record.status === 'canceled') return false;
    const controller = this.controllers.get(id);
    if (controller) controller.abort(new Error('用户取消'));
    record.status = 'canceled';
    record.finishedAt = new Date().toISOString();
    this.runners.delete(id);
    this.persist(record);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.records.keys()]) this.cancel(id);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.parentSignal.removeEventListener('abort', this.onAbort);
    for (const controller of this.controllers.values()) {
      try {
        controller.abort(new Error('插件停止'));
      } catch {
        // 忽略
      }
    }
    this.controllers.clear();
    this.runners.clear();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.limit) {
      const next = [...this.records.values()].find((record) => record.status === 'queued');
      if (!next) return;
      const runner = this.runners.get(next.id);
      if (!runner) {
        next.status = 'failed';
        next.error = '任务没有执行体';
        this.persist(next);
        continue;
      }
      const controller = new AbortController();
      const combined = AbortSignal.any([controller.signal, this.parentSignal]);
      this.controllers.set(next.id, controller);
      next.status = 'running';
      next.startedAt = new Date().toISOString();
      this.persist(next);
      this.active += 1;
      runner(combined)
        .then((result) => {
          const record = this.records.get(next.id);
          if (!record) return;
          if (record.status === 'canceled') return;
          if (result.ok) {
            record.status = 'done';
            record.files = result.files as any;
            record.seed = result.seed;
            record.width = result.width ?? record.width;
            record.height = result.height ?? record.height;
            if (result.notes?.length) record.notes = [...(record.notes ?? []), ...result.notes];
          } else {
            record.status = 'failed';
            record.error = result.error;
          }
        })
        .catch((error: any) => {
          const record = this.records.get(next.id);
          if (!record) return;
          if (record.status === 'canceled') return;
          record.status = 'failed';
          record.error = String(error?.message ?? error);
        })
        .finally(() => {
          const record = this.records.get(next.id);
          if (record) {
            record.finishedAt = new Date().toISOString();
            this.persist(record);
          }
          this.controllers.delete(next.id);
          this.runners.delete(next.id);
          this.active -= 1;
          this.pump();
        });
    }
  }
}

/** 给工具层用的一行摘要。 */
export function describeTask(record: TaskRecord): string {
  const head = `${record.id} · ${record.status} · ${record.backend} · ${record.kind}`;
  if (record.status === 'done' && record.files?.length) {
    return `${head} · ${record.files.length} 个文件：${record.files.map((file: any) => file.path).join('、')}`;
  }
  if (record.status === 'failed') return `${head} · ${record.error ?? '失败'}`;
  return head;
}
