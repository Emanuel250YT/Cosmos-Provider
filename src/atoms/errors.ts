/** Atom: the library's error hierarchy. */

/** Base error: everything cosmos-providers throws inherits from here. */
export class EtherfuseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API responded with an error HTTP status. */
export class EtherfuseAPIError extends EtherfuseError {
  /** HTTP status (400, 404, 409, 424...). */
  readonly status: number;
  /** HTTP method of the failed request. */
  readonly method: string;
  /** Path of the failed request. */
  readonly path: string;
  /** Raw body of the error response (parsed JSON or text). */
  readonly body: unknown;

  constructor(status: number, method: string, path: string, body: unknown) {
    super(
      `Etherfuse API error ${status} on ${method} ${path}${EtherfuseAPIError.#describe(body)}`,
    );
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }

  static #describe(body: unknown): string {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const msg = b["message"] ?? b["error"] ?? b["detail"];
      if (typeof msg === "string") return `: ${msg}`;
    }
    if (typeof body === "string" && body.length > 0) return `: ${body.slice(0, 200)}`;
    return "";
  }

  /** 424: quote temporarily unavailable — retryable with backoff. */
  get isRetryable(): boolean {
    return this.status === 424 || this.status === 429 || this.status >= 500;
  }
}

/** Network failure or timeout before receiving a response. */
export class EtherfuseNetworkError extends EtherfuseError {}

/** The PIX payload (BR Code) is invalid or couldn't be built/parsed. */
export class PixError extends EtherfuseError {}

/** Invalid webhook signature. */
export class WebhookVerificationError extends EtherfuseError {}
