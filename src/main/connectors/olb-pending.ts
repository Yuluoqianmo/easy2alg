import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NormalizedSymbolSchema,
  OlbPartSummarySchema,
  type NormalizedSymbol,
  type OlbPartSummary,
} from "../../shared/schemas";
import { writeLog } from "../logging";
import type { JsonStore } from "./json-store";

/**
 * .olb 补写队列。
 *
 * 为什么需要它：OrCAD Capture 打开着某个库时，会在同目录留 `<库名>OLBlck`。这个锁
 * **不阻止写入**（实测 .olb 本身没有被独占，XMATIC_XML2OLB 能正常导入），但 Capture
 * 手里握着的是内存里的旧副本：
 *   1. 我们写进磁盘的新器件，Capture 里看不到（关掉该库窗口再打开才有）；
 *   2. 用户在 Capture 里保存该库，Capture 会用旧内容覆盖我们刚写的部分。
 *
 * 所以策略是"先写进去、再登记补写"：写入当时就把结果落到磁盘（用户马上就有文件），
 * 同时把这次写入登记下来；等 Capture 关掉这个库（锁文件消失 / 进程退出）后自动重放
 * 一次，保证最终磁盘上是我们生成的内容。
 *
 * 重放前先比对磁盘现状，避免把用户在 Capture 里手改过的器件冲掉：
 *  - 现状 == 我们写的      → 不用补（Capture 没覆盖过），出队；
 *  - 现状 == 写入前的旧内容 → Capture 覆盖了，重放；
 *  - 现状 == 别的内容       → 用户在 Capture 里改过，保留用户的版本，出队并记日志。
 */

export const PendingOlbWriteSchema = z.object({
  id: z.string().min(1),
  libraryPath: z.string().min(1),
  packageName: z.string().min(1),
  /** 整份符号，重放时不依赖任何外部状态（应用重启后也能补） */
  symbol: NormalizedSymbolSchema,
  fillPcbFootprint: z.boolean(),
  snapPins: z.boolean(),
  createdAt: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  /** 下一次允许尝试的时间戳（ms），失败后指数退避，避免每轮都去调 Cadence */
  nextAttemptAt: z.number().finite(),
  lastError: z.string().nullable(),
  /** 我们这次写进去的内容概览 */
  expected: OlbPartSummarySchema,
  /** 写入前库里的旧内容概览（库里原本没有该器件时为 null） */
  previous: OlbPartSummarySchema.nullable(),
});
export type PendingOlbWrite = z.infer<typeof PendingOlbWriteSchema>;

export const PendingOlbQueueSchema = z.array(PendingOlbWriteSchema);
export type PendingOlbQueue = z.infer<typeof PendingOlbQueueSchema>;

export type PendingOlbDeps = {
  /** 目标库此刻是否真的还被 Capture 占着（锁文件在 **且** Capture 在跑） */
  readonly isBlocked: (libraryPath: string) => Promise<boolean>;
  /** 一次读回整个库的器件概览（每个库每轮只导出一次，别按器件重复调 Cadence） */
  readonly readParts: (libraryPath: string) => Promise<ReadonlyMap<string, OlbPartSummary>>;
  /** 重放一次写入（覆盖同名器件） */
  readonly write: (item: PendingOlbWrite) => Promise<void>;
  readonly now?: () => number;
};

export type EnqueueOlbWrite = {
  readonly symbol: NormalizedSymbol;
  readonly libraryPath: string;
  readonly fillPcbFootprint: boolean;
  readonly snapPins: boolean;
  readonly expected: OlbPartSummary;
  readonly previous: OlbPartSummary | null;
};

export type PendingFlushSummary = {
  /** 本轮开始时队列长度 */
  readonly pending: number;
  /** 补写成功 */
  readonly written: number;
  /** 磁盘上已经是对的，无需补写 */
  readonly satisfied: number;
  /** 用户在 Capture 里改过，保留用户版本 */
  readonly skipped: number;
  /** 写入失败，留待下一轮 */
  readonly failed: number;
};

const EMPTY_SUMMARY: PendingFlushSummary = {
  pending: 0,
  written: 0,
  satisfied: 0,
  skipped: 0,
  failed: 0,
};

/** 失败退避：15s → 30s → 60s … 最长 10 分钟。 */
const retryDelay = (attempts: number): number =>
  Math.min(15_000 * 2 ** Math.min(attempts, 6), 600_000);

const sameSummary = (a: OlbPartSummary, b: OlbPartSummary): boolean =>
  a.sectionCount === b.sectionCount && a.pinCount === b.pinCount && a.bodyWidth === b.bodyWidth;

export class PendingOlbWrites {
  readonly #store: JsonStore<PendingOlbQueue>;
  readonly #deps: PendingOlbDeps;
  #items: PendingOlbWrite[] | null = null;
  #flushing: Promise<PendingFlushSummary> | null = null;

  constructor(store: JsonStore<PendingOlbQueue>, deps: PendingOlbDeps) {
    this.#store = store;
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  async #load(): Promise<PendingOlbWrite[]> {
    if (this.#items === null) {
      this.#items = await this.#store.read().catch(() => []);
    }
    return this.#items;
  }

  async #save(items: PendingOlbWrite[]): Promise<void> {
    this.#items = items;
    await this.#store.write(items).catch((error: unknown) => {
      void writeLog("error", "olb_pending_save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async list(): Promise<readonly PendingOlbWrite[]> {
    return [...(await this.#load())];
  }

  async count(): Promise<number> {
    return (await this.#load()).length;
  }

  /**
   * 登记一次补写。同一目标库 + 同名器件只留最新一条 —— 用户重试时不该堆出一串
   * 相同器件，最后一条必然是用户想要的版本。
   */
  async enqueue(input: EnqueueOlbWrite): Promise<PendingOlbWrite> {
    const items = await this.#load();
    const item: PendingOlbWrite = {
      id: randomUUID(),
      libraryPath: input.libraryPath,
      packageName: input.symbol.name,
      symbol: input.symbol,
      fillPcbFootprint: input.fillPcbFootprint,
      snapPins: input.snapPins,
      createdAt: new Date(this.#now()).toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      expected: input.expected,
      previous: input.previous,
    };
    const kept = items.filter(
      (entry) =>
        !(
          entry.libraryPath === item.libraryPath && entry.packageName === item.packageName
        ),
    );
    await this.#save([...kept, item]);
    return item;
  }

  /** 并发调用只跑一轮（定时器 + 写入后触发可能同时来）。 */
  async flush(): Promise<PendingFlushSummary> {
    if (this.#flushing !== null) {
      return this.#flushing;
    }
    this.#flushing = this.#flush().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flush(): Promise<PendingFlushSummary> {
    const items = await this.#load();
    if (items.length === 0) {
      return EMPTY_SUMMARY;
    }
    const now = this.#now();
    const remaining: PendingOlbWrite[] = [];
    // 同一个库在一轮里只导出一次（可能压着十几个器件）
    const libraries = new Map<string, Map<string, OlbPartSummary>>();
    let written = 0;
    let satisfied = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      if (item.nextAttemptAt > now) {
        remaining.push(item);
        continue;
      }
      // Capture 还开着这个库 → 现在重放也会被它覆盖，等下一轮。
      const blocked = await this.#deps.isBlocked(item.libraryPath).catch(() => true);
      if (blocked) {
        remaining.push(item);
        continue;
      }
      try {
        let parts = libraries.get(item.libraryPath);
        if (parts === undefined) {
          parts = new Map(await this.#deps.readParts(item.libraryPath));
          libraries.set(item.libraryPath, parts);
        }
        const current = parts.get(item.packageName) ?? null;
        if (current !== null && sameSummary(current, item.expected)) {
          // 磁盘上已经是我们写的内容：Capture 没覆盖过（或者已经补过了）。
          satisfied += 1;
          continue;
        }
        const lost = current === null && item.previous === null;
        const clobbered =
          current !== null && item.previous !== null && sameSummary(current, item.previous);
        if (!lost && !clobbered) {
          // 既不是我们写的、也不是写入前的旧内容 → 用户在 Capture 里改过 / 删过。
          // 保留用户的版本，别把手工调整冲掉。
          skipped += 1;
          await writeLog("warn", "olb_pending_skipped", {
            libraryPath: item.libraryPath,
            packageName: item.packageName,
            current: JSON.stringify(current),
            expected: JSON.stringify(item.expected),
            previous: item.previous === null ? "null" : JSON.stringify(item.previous),
          });
          continue;
        }
        await this.#deps.write(item);
        parts.set(item.packageName, item.expected);
        written += 1;
        await writeLog("info", "olb_pending_rewritten", {
          libraryPath: item.libraryPath,
          packageName: item.packageName,
          reason: lost ? "missing" : "clobbered",
        });
      } catch (error) {
        failed += 1;
        const attempts = item.attempts + 1;
        remaining.push({
          ...item,
          attempts,
          lastError: error instanceof Error ? error.message : String(error),
          nextAttemptAt: now + retryDelay(attempts),
        });
        await writeLog("warn", "olb_pending_retry", {
          libraryPath: item.libraryPath,
          packageName: item.packageName,
          attempts,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.#save(remaining);
    const summary: PendingFlushSummary = {
      pending: items.length,
      written,
      satisfied,
      skipped,
      failed,
    };
    if (written + satisfied + skipped + failed > 0) {
      await writeLog("info", "olb_pending_flushed", { ...summary, left: remaining.length });
    }
    return summary;
  }
}
