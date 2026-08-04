/** Error thrown by the SEP (Stellar Ecosystem Proposal) helpers. */
export class SepError extends Error {
  /** Which SEP the failing call belongs to (`"SEP-1"`, `"SEP-10"`, `"SEP-24"`). */
  readonly sep: string;
  /** HTTP status code, when the error came from an API response. */
  readonly statusCode?: number;

  constructor(sep: string, message: string, statusCode?: number, options?: { cause?: unknown }) {
    super(`[${sep}] ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SepError";
    this.sep = sep;
    this.statusCode = statusCode;
  }
}
