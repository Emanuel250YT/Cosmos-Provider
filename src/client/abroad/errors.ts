import type { AbroadQuoteErrorCode } from "./types";

/** Error thrown by {@link AbroadClient} — API failures, quote refusals, and input validation. */
export class AbroadError extends Error {
  /** Machine-readable code: Abroad's own `code`/`reason` where it gives one, else a local `AB_*` marker. */
  readonly code: string;
  /** HTTP status, when the error came from an API response. */
  readonly statusCode?: number;
  /** Whether Abroad said retrying could succeed (quote endpoints report this explicitly). */
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    options?: { statusCode?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AbroadError";
    this.code = code;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * The corridor exists but the amount falls outside it, or Abroad can't
 * price it right now. Carries the machine-readable reason so a UI can say
 * "below the minimum" rather than a generic failure.
 */
export class AbroadQuoteError extends AbroadError {
  constructor(
    message: string,
    code: AbroadQuoteErrorCode | string,
    options?: { statusCode?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, code, options);
    this.name = "AbroadQuoteError";
  }
}

/**
 * Abroad accepted the request but won't move the transaction until this user
 * is verified (`kycRequired: true`). Distinct from a plain failure: the
 * caller's next move is to collect identity documents and submit
 * `POST /kyc`, then create the transaction again — nothing about the quote
 * or the corridor is wrong.
 */
export class AbroadKycRequiredError extends AbroadError {
  /** The partner-scoped user id that needs verifying. */
  readonly userId: string;

  constructor(userId: string, message?: string) {
    super(
      message ??
        `Abroad requires identity verification for user "${userId}" before this transaction can proceed. Submit the KYC form, then create the transaction again.`,
      "KYC_REQUIRED",
    );
    this.name = "AbroadKycRequiredError";
    this.userId = userId;
  }
}
