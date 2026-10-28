import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PendingOlbQueueSchema,
  PendingOlbWrites,
  type PendingOlbDeps,
  type PendingOlbWrite,
} from "../src/main/connectors/olb-pending";
import { JsonStore } from "../src/main/connectors/json-store";
import type { NormalizedSymbol, OlbPartSummary } from "../src/shared/schemas";

/**
 * 补写队列的语义（用户 2026-10-23 要求"Capture 打开着库也能生成"）：
 * 写入照做、结果落盘，但 Capture 保存时会用内存旧副本覆盖 → 锁消失后自动重放一次。
 * 这里把"重放还是保留"的三种判定钉死，避免以后改坏成"每次都覆盖用户手改"。
 */

const symbol: NormalizedSymbol = {
  name: "LMK00301",
  refdesPrefix: "U",
  pcbFootprint: "LMK00301_RHS",
  sections: [
    {
      name: "S0",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      pins: [
        {
          name: "VDD",
          number: "1",
          connection: { x: 0, y: 0 },
          body: { x: 10, y: 0 },
          length: 10,
          type: "power",
          visible: true,
        },
      ],
      shapes: [
        {
          kind: "rect",
          min: { x: 10, y: 0 },
          max: { x: 100, y: 50 },
          cornerRadius: 0,
          filled: false,
        },
      ],
    },
  ],
  sourceJson: "{}",
};

const summary = (sectionCount: number, pinCount: number, bodyWidth: number | null): OlbPartSummary => ({
  sectionCount,
  pinCount,
  bodyWidth,
});

const OLD = summary(1, 1, 60);
const NEW = summary(1, 1, 90);
const HAND_EDITED = summary(2, 1, 90);

type Harness = {
  readonly pending: PendingOlbWrites;
  readonly deps: {
    blocked: boolean;
    current: OlbPartSummary | null;
    write: ReturnType<typeof vi.fn>;
  };
};

const makeHarness = async (overrides: Partial<PendingOlbDeps> = {}): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), "easy2alg-pending-"));
  const store = new JsonStore(
    join(directory, "pending-olb.json"),
    PendingOlbQueueSchema,
    [] as PendingOlbWrite[],
  );
  const deps = {
    blocked: false,
    current: OLD as OlbPartSummary | null,
    write: vi.fn(async () => undefined),
  };
  const pending = new PendingOlbWrites(store, {
    isBlocked: async () => deps.blocked,
    // 每次读取都反映 deps.current 的当前值（测试里会中途改它）
    readParts: async () =>
      new Map(deps.current === null ? [] : [["LMK00301", deps.current]]),
    write: deps.write,
    now: () => 1_000,
    ...overrides,
  });
  return { pending, deps };
};

const enqueue = async (pending: PendingOlbWrites): Promise<void> => {
  await pending.enqueue({
    symbol,
    libraryPath: "E:/lib/EASY2ALG.OLB",
    fillPcbFootprint: true,
    snapPins: true,
    expected: NEW,
    previous: OLD,
  });
};

describe("PendingOlbWrites", () => {
  it("同一器件重复登记只保留最新一条", async () => {
    const { pending } = await makeHarness();
    await enqueue(pending);
    await enqueue(pending);
    const items = await pending.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.packageName).toBe("LMK00301");
  });

  it("Capture 还占着库时不重放，条目留在队列里", async () => {
    const { pending, deps } = await makeHarness();
    deps.blocked = true;
    await enqueue(pending);
    const result = await pending.flush();
    expect(result.written).toBe(0);
    expect(deps.write).not.toHaveBeenCalled();
    expect(await pending.count()).toBe(1);
  });

  it("磁盘上已经是我们写的内容时直接出队，不重复写", async () => {
    const { pending, deps } = await makeHarness();
    deps.current = NEW;
    await enqueue(pending);
    const result = await pending.flush();
    expect(result.satisfied).toBe(1);
    expect(deps.write).not.toHaveBeenCalled();
    expect(await pending.count()).toBe(0);
  });

  it("内容退回写入前的旧版本（被 Capture 覆盖）时重放", async () => {
    const { pending, deps } = await makeHarness();
    deps.current = OLD;
    await enqueue(pending);
    const result = await pending.flush();
    expect(result.written).toBe(1);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(await pending.count()).toBe(0);
  });

  it("新器件被 Capture 冲掉（库里没有）时重放", async () => {
    const { pending, deps } = await makeHarness();
    deps.current = null;
    await pending.enqueue({
      symbol,
      libraryPath: "E:/lib/EASY2ALG.OLB",
      fillPcbFootprint: true,
      snapPins: true,
      expected: NEW,
      previous: null,
    });
    const result = await pending.flush();
    expect(result.written).toBe(1);
    expect(deps.write).toHaveBeenCalledTimes(1);
  });

  it("内容既不是我们写的、也不是旧版本（用户在 Capture 里手改过）时保留用户版本", async () => {
    const { pending, deps } = await makeHarness();
    deps.current = HAND_EDITED;
    await enqueue(pending);
    const result = await pending.flush();
    expect(result.skipped).toBe(1);
    expect(deps.write).not.toHaveBeenCalled();
    expect(await pending.count()).toBe(0);
  });

  it("重放失败时留队并退避，下一轮（时间未到）不再尝试", async () => {
    let clock = 1_000;
    const { pending, deps } = await makeHarness({ now: () => clock });
    deps.current = OLD;
    deps.write.mockRejectedValueOnce(new Error("tclsh 挂了"));
    await enqueue(pending);
    const first = await pending.flush();
    expect(first.failed).toBe(1);
    expect(await pending.count()).toBe(1);
    // 还没到退避时间 → 不再碰 Cadence
    clock = 2_000;
    const second = await pending.flush();
    expect(second.failed).toBe(0);
    expect(deps.write).toHaveBeenCalledTimes(1);
    // 过了退避时间 → 再试一次并成功
    clock = 100_000;
    const third = await pending.flush();
    expect(third.written).toBe(1);
    expect(await pending.count()).toBe(0);
  });

  it("并发 flush 只跑一轮", async () => {
    const { pending, deps } = await makeHarness();
    deps.current = OLD;
    await enqueue(pending);
    await Promise.all([pending.flush(), pending.flush(), pending.flush()]);
    expect(deps.write).toHaveBeenCalledTimes(1);
  });
});
