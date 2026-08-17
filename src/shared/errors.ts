export type ExternalServiceErrorDetails = {
  operation: string;
  requestUrl: string;
  statusCode: number | null;
  responseBody: string;
  parameters: Readonly<Record<string, string>>;
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
