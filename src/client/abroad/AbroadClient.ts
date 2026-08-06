/**
 * AbroadClient — typed access to the Abroad Finance partner API
 * (https://api.abroad.finance).
 *
 * Abroad is a full ramp on both legs: it collects the local fiat (PIX in
 * Brazil, BREB in Colombia) and moves the crypto itself. You give it a
 * destination address and it delivers; you send to its deposit address and
 * it pays the bank out. Nothing here signs or holds keys.
 *
 * ⚠ THERE IS NO SANDBOX. Every corridor Abroad publishes is mainnet —
 * `GET /public/corridors` reports `chainId: "stellar:pubnet"` for all of
 * them — and the partner key is a live credential. A quote is a harmless
 * read, but `POST /transaction` mints a real PIX charge and expects real
 * Circle USDC. There is no environment flag that makes it otherwise, so
 * treat `createTransaction` the same way you'd treat a production payment
 * call regardless of what your own app calls its current environment.
 *
 * Auth is the `X-API-Key` header (NOT `Authorization`), which is why this
 * doesn't sit on the shared {@link REST} atom — that one hardcodes
 * `Authorization` for Etherfuse and can't send multipart, which
 * {@link AbroadClient.submitKyc} needs.
 */

import { AbroadError, AbroadQuoteError } from "./errors";
import type {
  AbroadAcceptTransactionRequest,
  AbroadAcceptTransactionResponse,
  AbroadCorridor,
  AbroadCorridorDirection,
  AbroadCorridorResponse,
  AbroadKycStatusResponse,
  AbroadKycSubmission,
  AbroadKycSubmitResponse,
  AbroadLiquidityResponse,
  AbroadOnrampQuoteRequest,
  AbroadPartnerInfo,
  AbroadPartnerUser,
  AbroadPaymentMethod,
  AbroadQuoteErrorResponse,
  AbroadQuoteRequest,
  AbroadQuoteResponse,
  AbroadReverseQuoteRequest,
  AbroadTransactionStatusResponse,
} from "./types";

export const ABROAD_BASE_URL = "https://api.abroad.finance";

export interface AbroadClientOptions {
  /** Partner API key (`partner_...`), sent as `X-API-Key`. */
  apiKey: string;
  /** Override the API base URL. Defaults to {@link ABROAD_BASE_URL}. */
  baseUrl?: string;
  /** Fetch implementation. Defaults to the global one (Node >= 18, browsers). */
  fetch?: typeof fetch;
  /** Timeout per attempt, in ms. Default: 30,000. */
  timeoutMs?: number;
  /** Retries on transient errors (429/5xx/network). Default: 2. */
  retries?: number;
  onDebug?: (message: string) => void;
}

/** Retryable per Abroad's own quote-error contract, plus the usual transport-level transients. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class AbroadClient {
  readonly baseUrl: string;

  #apiKey: string;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #retries: number;
  #onDebug?: (message: string) => void;

  constructor(options: AbroadClientOptions) {
    if (!options.apiKey?.trim()) {
      throw new AbroadError("An Abroad partner API key is required.", "MISSING_API_KEY");
    }
    this.#apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? ABROAD_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 2;
    this.#onDebug = options.onDebug;

    if (typeof this.#fetch !== "function") {
      throw new AbroadError("No global fetch found. Use Node >= 18 or pass `fetch`.", "NO_FETCH");
    }
  }

  // -------------------------------------------------------------------------
  // Quotes
  // -------------------------------------------------------------------------

  /**
   * Price an ONRAMP from the fiat side: "the buyer pays `fiat_amount`, how
   * much crypto do they receive?". `value` in the response is CRYPTO.
   */
  quoteOnramp(request: AbroadOnrampQuoteRequest): Promise<AbroadQuoteResponse> {
    return this.#quote("/quote/onramp", request);
  }

  /**
   * Price an OFFRAMP from the fiat side: "the seller wants `amount` of fiat
   * paid out, how much crypto must they send?". `value` is CRYPTO.
   */
  quoteOfframp(request: AbroadQuoteRequest): Promise<AbroadQuoteResponse> {
    return this.#quote("/quote", request);
  }

  /**
   * Price an OFFRAMP from the crypto side: "the seller sends `source_amount`
   * of crypto, how much fiat do they receive?". `value` is FIAT.
   */
  quoteOfframpReverse(request: AbroadReverseQuoteRequest): Promise<AbroadQuoteResponse> {
    return this.#quote("/quote/reverse", request);
  }

  /**
   * Quote endpoints report refusals as a structured 400 (`code`, `reason`,
   * `retryable`) rather than a bare failure — "below the minimum" and "this
   * corridor is closed" are ordinary, actionable answers, so they're mapped
   * to {@link AbroadQuoteError} with the code intact instead of being
   * flattened into a generic API error.
   */
  async #quote(path: string, body: unknown): Promise<AbroadQuoteResponse> {
    try {
      return await this.#request<AbroadQuoteResponse>("POST", path, { body });
    } catch (error) {
      if (error instanceof AbroadError && error.statusCode === 400) {
        const payload = (error.cause ?? {}) as Partial<AbroadQuoteErrorResponse>;
        if (payload?.code) {
          throw new AbroadQuoteError(payload.reason ?? error.message, payload.code, {
            statusCode: 400,
            retryable: payload.retryable ?? false,
            cause: payload,
          });
        }
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /**
   * Turn a quote into a real transaction.
   *
   * ⚠ This is the call that moves money. Onramp responses carry
   * `payment_instructions.br_code` (a live PIX charge); offramp responses
   * carry `payment_context` (the address and memo to send real crypto to).
   * Check `kycRequired` on the result before showing either — Abroad returns
   * it `true` with no usable instructions when the user isn't verified yet.
   */
  createTransaction(request: AbroadAcceptTransactionRequest): Promise<AbroadAcceptTransactionResponse> {
    return this.#request<AbroadAcceptTransactionResponse>("POST", "/transaction", { body: request });
  }

  /** Current state of a transaction. This is the trusted read — never settle off a webhook body alone. */
  getTransaction(transactionId: string): Promise<AbroadTransactionStatusResponse> {
    return this.#request<AbroadTransactionStatusResponse>("GET", `/transaction/${encodeURIComponent(transactionId)}`);
  }

  /** Paginated transaction history for one of your users. */
  listTransactions(externalUserId: string, page = 1, pageSize = 20): Promise<unknown> {
    return this.#request("GET", "/transactions/list", {
      query: { externalUserId, page, pageSize },
    });
  }

  // -------------------------------------------------------------------------
  // KYC
  // -------------------------------------------------------------------------

  /** Whether `userId` is verified. Cheap enough to call before every transaction; Abroad also reports it on the transaction response. */
  getKycStatus(userId: string): Promise<AbroadKycStatusResponse> {
    return this.#request<AbroadKycStatusResponse>("GET", "/kyc/status", { query: { userId } });
  }

  /**
   * Submit the self-service KYC form: identity fields plus a photo of the
   * identity document, as `multipart/form-data`. A complete submission is
   * auto-approved, so the returned status is usually `APPROVED` straight
   * away — but read it rather than assuming, since an incomplete one comes
   * back `PENDING`/`REJECTED`.
   *
   * `document` is the image bytes. Pass a `Blob`/`File` in the browser; in
   * Node, a `Blob` built from a Buffer works (`new Blob([buf], { type })`).
   */
  async submitKyc(
    submission: AbroadKycSubmission,
    document: Blob,
    documentFilename = "document.jpg",
  ): Promise<AbroadKycSubmitResponse> {
    const form = new FormData();
    for (const [key, value] of Object.entries(submission)) {
      form.append(key, String(value));
    }
    form.append("document", document, documentFilename);
    // No Content-Type header here on purpose — fetch has to set it itself so
    // the multipart boundary matches the body it generates.
    return this.#request<AbroadKycSubmitResponse>("POST", "/kyc", { form });
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Every route Abroad currently supports, with its amount bounds. Worth
   * reading rather than hardcoding: coverage and limits change, and the
   * `chainId` is how you confirm which network a corridor settles on (all of
   * them are mainnet today).
   *
   * `direction` defaults to payouts (`CRYPTO_TO_FIAT`) on Abroad's side when
   * omitted, so it's always sent explicitly here.
   */
  async getCorridors(direction: AbroadCorridorDirection = "CRYPTO_TO_FIAT"): Promise<AbroadCorridor[]> {
    const response = await this.#request<AbroadCorridorResponse>("GET", "/public/corridors", {
      query: { direction },
      auth: false,
    });
    return response.corridors ?? [];
  }

  /** How much fiat Abroad can currently pay out on a rail. A quote can succeed and still exceed this. */
  getLiquidity(paymentMethod: AbroadPaymentMethod): Promise<AbroadLiquidityResponse> {
    return this.#request<AbroadLiquidityResponse>("GET", "/payments/liquidity", {
      query: { paymentMethod },
    });
  }

  /** The authenticated partner — handy as a credential check at boot (`needsKyc`/`isKybApproved` tell you whether the account is live). */
  getPartner(): Promise<AbroadPartnerInfo> {
    return this.#request<AbroadPartnerInfo>("GET", "/partner");
  }

  /** Register one of your users with Abroad. Optional: `createTransaction` accepts any `user_id` string. */
  createPartnerUser(userId: string, kycExternalToken?: string): Promise<AbroadPartnerUser> {
    return this.#request<AbroadPartnerUser>("POST", "/partnerUser", {
      body: { userId, ...(kycExternalToken ? { kycExternalToken } : {}) },
    });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      form?: FormData;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (attempt > 0) {
        const delay = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        this.#onDebug?.(`[abroad] retry ${attempt}/${this.#retries} in ${delay}ms → ${method} ${path}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        return await this.#execute<T>(method, url.toString(), path, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof AbroadError &&
          (error.code === "NETWORK_ERROR" || (error.statusCode !== undefined && isRetryableStatus(error.statusCode)));
        if (!retryable || attempt === this.#retries) throw error;
      }
    }
    throw lastError;
  }

  async #execute<T>(
    method: string,
    url: string,
    path: string,
    options: { body?: unknown; form?: FormData; auth?: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.auth !== false) headers["X-API-Key"] = this.#apiKey;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    this.#onDebug?.(`[abroad] ${method} ${path}`);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new AbroadError(`Network failure on ${method} ${path}`, "NETWORK_ERROR", { retryable: true, cause });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const record = (payload ?? {}) as Record<string, unknown>;
      const reason =
        (typeof record.reason === "string" && record.reason) ||
        (typeof record.message === "string" && record.message) ||
        (typeof payload === "string" && payload) ||
        response.statusText;
      throw new AbroadError(`Abroad ${method} ${path} failed (${response.status}): ${reason}`, String(record.code ?? `HTTP_${response.status}`), {
        statusCode: response.status,
        retryable: isRetryableStatus(response.status),
        cause: payload,
      });
    }
    return payload as T;
  }
}
