import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureLockFile } from "../src/main/connectors/capture-lock";

/**
 * 锁文件识别：Capture 打开 `X.OLB` 时会在同目录留 `X.OLBlck`（大小写随库名），
 * 有的版本是 `X.OLB.lck`。只认同名的，别把别的库的锁算到自己头上。
 */
describe("captureLockFile", () => {
  const makeDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "easy2alg-lock-"));

  it("识别 <库名>lck", async () => {
    const directory = await makeDirectory();
    const library = join(directory, "EASY2ALG.OLB");
    await writeFile(library, "x");
    await writeFile(join(directory, "EASY2ALG.OLBlck"), "");
    expect(await captureLockFile(library)).toBe(join(directory, "EASY2ALG.OLBlck"));
  });

  it("识别 <库名>.lck（大小写不敏感）", async () => {
    const directory = await makeDirectory();
    const library = join(directory, "MyLib.olb");
    await writeFile(library, "x");
    await writeFile(join(directory, "MYLIB.OLB.LCK"), "");
    expect(await captureLockFile(library)).toBe(join(directory, "MYLIB.OLB.LCK"));
  });

  it("别的库的锁不算", async () => {
    const directory = await makeDirectory();
    const library = join(directory, "EASY2ALG.OLB");
    await writeFile(library, "x");
    await writeFile(join(directory, "OTHER.OLBlck"), "");
    expect(await captureLockFile(library)).toBeNull();
  });

  it("目录不存在时不抛", async () => {
    expect(await captureLockFile("E:/definitely-not-here/xx.OLB")).toBeNull();
  });
});
