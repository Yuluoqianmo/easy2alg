import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExternalServiceError } from "../../shared/errors";
import type { NormalizedFootprint } from "../../shared/schemas";
import { NormalizedFootprintSchema } from "../../shared/schemas";
import { normalizeEasyEdaResponse, RawEasyEdaResponseSchema } from "../conversion/normalize";
import { writeLog } from "../logging";

const LcscIdSchema = z.string().trim().toUpperCase().regex(/^C\d+$/);
const API_TEMPLATE = "https://easyeda.com/api/products/{lcsc_id}/components?version=6.4.19.5";
const RETRY_DELAYS_MS = [0, 450, 1_250] as const;

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const responseSnippet = (body: string): string => body.slice(0, 2_000);

export class EasyEdaConnector {
  readonly #cacheDirectory: string;

  constructor(cacheDirectory: string) {
    this.#cacheDirectory = cacheDirectory;
  }

  async fetchFootprint(lcscIdInput: string): Promise<NormalizedFootprint> {
    const lcscId = LcscIdSchema.parse(lcscIdInput);
    const cached = await this.#readCache(lcscId);
    if (cached !== null) {
      await writeLog("info", "easyeda_cache_hit", { lcscId });
      return cached;
    }

    const requestUrl = API_TEMPLATE.replace("{lcsc_id}", lcscId);
    let lastError: ExternalServiceError | null = null;
    for (const [attemptIndex, waitMilliseconds] of RETRY_DELAYS_MS.entries()) {
      if (waitMilliseconds > 0) {
        await writeLog("warn", "easyeda_request_retry", {
          lcscId,
          attempt: attemptIndex + 1,
          waitMilliseconds,
        });
        await delay(waitMilliseconds);
      }
      try {
        const footprint = await this.#requestFootprint(requestUrl, lcscId);
        await this.#writeCache(lcscId, footprint);
        return footprint;
      } catch (error) {
        if (!(error instanceof ExternalServiceError)) {
          throw error;
        }
        lastError = error;
      }
    }

    if (lastError === null) {
      throw new Error(`EasyEDA request failed for ${lcscId} without an error result`);
    }
    throw lastError;
  }

  async #requestFootprint(requestUrl: string, lcscId: string): Promise<NormalizedFootprint> {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Encoding": "gzip, deflate",
          Referer: "https://easyeda.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0 Easy2ALG/0.1",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA request failed for ${lcscId}: ${cause.message}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: null,
          responseBody: "",
          parameters: { lcscId },
        },
        cause,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      throw new ExternalServiceError(
        `EasyEDA request failed for ${lcscId}: HTTP ${response.status}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { lcscId },
        },
        null,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA returned invalid JSON for ${lcscId}`,
        {
          operation: "fetch_component",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { lcscId },
        },
        cause,
      );
    }

    try {
      const raw = RawEasyEdaResponseSchema.parse(parsed);
      return normalizeEasyEdaResponse(raw, lcscId);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new ExternalServiceError(
        `EasyEDA data validation failed for ${lcscId}: ${cause.message}`,
        {
          operation: "validate_component",
          requestUrl,
          statusCode: response.status,
          responseBody: responseSnippet(body),
          parameters: { lcscId },
        },
        cause,
      );
    }
  }

  async #readCache(lcscId: string): Promise<NormalizedFootprint | null> {
    const cachePath = join(this.#cacheDirectory, `${lcscId}.json`);
    try {
      const content = await readFile(cachePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      return NormalizedFootprintSchema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #writeCache(lcscId: string, footprint: NormalizedFootprint): Promise<void> {
    const cachePath = join(this.#cacheDirectory, `${lcscId}.json`);
    const temporaryPath = `${cachePath}.tmp`;
    await mkdir(this.#cacheDirectory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(footprint)}\n`, "utf8");
    await rename(temporaryPath, cachePath);
  }
}
