import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EasyEdaConnector } from "../src/main/connectors/easyeda-connector";
import { ExternalServiceError } from "../src/shared/errors";

/**
 * 立创接口的「业务性失败」。
 *
 * 用户 2026-10-28 截图：C55586821 报
 * `EasyEDA data validation failed ... Invalid input: expected object, received undefined`。
 * 真实响应是 HTTP 200 + `{"success":false,"code":404,"message":"Component not found"}`。
 *
 * 但这句话不能直接翻译成"编号不存在"：同一个编号在立创商品页正常售卖
 * （HT7533 / SOT-89 / R+O，有库存），只是 EDA 里引脚与焊盘「暂未绘制…」。
 * 所以 404 之后要回查商品搜索接口才能给出对的提示。
 */

const freshCache = (): Promise<string> => mkdtemp(join(tmpdir(), "e2a-cache-"));

type Routes = {
  readonly components?: unknown;
  readonly search?: unknown;
};

/** 按 URL 分流的 fetch 桩，返回调用计数（方便断言"有没有白重试"）。 */
const stubFetch = (routes: Routes): (() => { components: number; search: number }) => {
  const counts = { components: 0, search: 0 };
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    const isSearch = url.includes("/eda/product/search");
    if (isSearch) {
      counts.search += 1;
    } else {
      counts.components += 1;
    }
    const payload = isSearch ? (routes.search ?? { code: 200, result: { productList: [] } }) : routes.components;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return () => ({ ...counts });
};

const productList = (number: string, mpn: string, pkg: string): unknown => ({
  code: 200,
  result: {
    productList: [
      { number, mpn, package: pkg, manufacturer: "R+O", stock: 710 },
    ],
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("立创接口的业务性失败", () => {
  it("器件在售但 EDA 未绘制封装：提示「尚未绘制」，且只请求一次 components", async () => {
    const counts = stubFetch({
      components: { success: false, code: 404, message: "Component not found" },
      search: productList("C55586821", "HT7533", "SOT-89"),
    });
    const connector = new EasyEdaConnector(await freshCache());

    const error = await connector.fetchFootprint("C55586821").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ExternalServiceError);
    const serviceError = error as ExternalServiceError;
    expect(serviceError.message).toContain("尚未绘制");
    expect(serviceError.message).toContain("C55586821");
    expect(serviceError.message).toContain("HT7533");
    expect(serviceError.message).toContain("SOT-89");
    expect(serviceError.details.retryable).toBe(false);
    // components 只打一次（不重试），搜索接口只用来判别原因
    expect(counts().components).toBe(1);
    expect(counts().search).toBe(1);
  });

  it("商品库也查不到：提示核对编号", async () => {
    stubFetch({
      components: { success: false, code: 404, message: "Component not found" },
      search: { code: 200, result: { productList: [] } },
    });
    const connector = new EasyEdaConnector(await freshCache());

    const error = (await connector
      .fetchFootprint("C000000")
      .catch((reason: unknown) => reason)) as ExternalServiceError;

    expect(error.message).toContain("未找到元件 C000000");
    expect(error.message).toContain("核对");
    expect(error.details.retryable).toBe(false);
  });

  it("result 缺失（success 为真但没有 result）同样按确定性失败处理", async () => {
    const counts = stubFetch({
      components: { code: 0, result: null },
      search: productList("C41355184", "HT7533-1", "SOT-89-3"),
    });
    const connector = new EasyEdaConnector(await freshCache());

    const error = (await connector
      .fetchFootprint("C41355184")
      .catch((reason: unknown) => reason)) as ExternalServiceError;

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.details.retryable).toBe(false);
    expect(counts().components).toBe(1);
  });

  it("旧版本留下的坏缓存（把 404 响应存成了正常数据）会被忽略并重新请求", async () => {
    const cacheDirectory = await freshCache();
    // v0.2.2 及以前的真实产物：61 字节的失败响应被当成有效数据落盘
    await writeFile(
      join(cacheDirectory, "C55586821.raw.json"),
      JSON.stringify({ success: false, code: 404, message: "Component not found" }),
      "utf8",
    );
    const counts = stubFetch({
      components: { success: false, code: 404, message: "Component not found" },
      search: productList("C55586821", "HT7533", "SOT-89"),
    });
    const connector = new EasyEdaConnector(cacheDirectory);

    const error = (await connector
      .fetchFootprint("C55586821")
      .catch((reason: unknown) => reason)) as ExternalServiceError;

    expect(error.message).toContain("尚未绘制");
    expect(counts().components).toBe(1);
  });

  it("5xx 业务码仍然可重试（不改变原有的抖动重试行为）", async () => {
    const counts = stubFetch({ components: { success: false, code: 502, message: "Bad Gateway" } });
    const connector = new EasyEdaConnector(await freshCache());

    const error = (await connector
      .fetchFootprint("C2040")
      .catch((reason: unknown) => reason)) as ExternalServiceError;

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.details.retryable).toBe(true);
    // RETRY_DELAYS_MS 共 3 次；服务端故障不做商品库探测
    expect(counts().components).toBe(3);
    expect(counts().search).toBe(0);
  }, 20_000);
});
