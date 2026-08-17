import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class JsonStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  readonly #initialValue: T;

  constructor(path: string, schema: z.ZodType<T>, initialValue: T) {
    this.#path = path;
    this.#schema = schema;
    this.#initialValue = initialValue;
  }

  async read(): Promise<T> {
    try {
      const content = await readFile(this.#path, "utf8");
      const parsed: unknown = JSON.parse(content);
      return this.#schema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return structuredClone(this.#initialValue);
      }
      throw error;
    }
  }

  async write(value: T): Promise<T> {
    const validated = this.#schema.parse(value);
    const temporaryPath = `${this.#path}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#path);
    return validated;
  }
}
