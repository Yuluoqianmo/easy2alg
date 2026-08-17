import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

let logPath: string | null = null;

export const configureLogging = (path: string): void => {
  logPath = path;
};

export const writeLog = async (
  level: LogLevel,
  message: string,
  fields: LogFields,
): Promise<void> => {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (logPath === null) {
    process.stderr.write(`${entry}\n`);
    return;
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${entry}\n`, "utf8");
};
