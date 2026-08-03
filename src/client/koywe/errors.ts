/** Error thrown by {@link KoyweClient} — API failures, auth failures, and input validation. */
export class KoyweError extends Error {
  /** Machine-readable code (`AUTH_FAILED`, `MISSING_STELLAR_ADDRESS`, the API's own `error` field...). */
  readonly code: string;
  /** HTTP status code, when the error came from an API response. */
  readonly statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = "KoyweError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
