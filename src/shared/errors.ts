export type ExternalServiceErrorDetails = {
  operation: string;
  requestUrl: string;
  statusCode: number | null;
  responseBody: string;
  parameters: Readonly<Record<string, string>>;
  /**
   * 是否值得重试。默认 true（网络抖动、5xx 都可能自愈）。
   * 「元件不存在」这类业务性失败必须显式写 false —— 否则会白白重试三轮，
   * 用户要多等 1.7 秒才看到结果，日志里还会多两条误导性的 retry 记录。
   */
  retryable?: boolean;
};

export class ExternalServiceError extends Error {
  readonly details: ExternalServiceErrorDetails;

  constructor(message: string, details: ExternalServiceErrorDetails, cause: Error | null) {
    super(message, cause === null ? undefined : { cause });
    this.name = "ExternalServiceError";
    this.details = details;
  }
}

export type AllegroExecutionErrorDetails = {
  executablePath: string;
  workingDirectory: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export class AllegroExecutionError extends Error {
  readonly details: AllegroExecutionErrorDetails;

  constructor(message: string, details: AllegroExecutionErrorDetails, cause: Error | null) {
    super(message, cause === null ? undefined : { cause });
    this.name = "AllegroExecutionError";
    this.details = details;
  }
}

export class FootprintValidationError extends Error {
  readonly lcscId: string;
  readonly issues: readonly string[];

  constructor(lcscId: string, issues: readonly string[]) {
    super(`Footprint validation failed for ${lcscId}: ${issues.join("; ")}`);
    this.name = "FootprintValidationError";
    this.lcscId = lcscId;
    this.issues = issues;
  }
}
