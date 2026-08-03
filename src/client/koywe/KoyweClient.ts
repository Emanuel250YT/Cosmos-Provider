/**
 * KoyweClient — client for the Koywe crypto fiat on/off-ramp API
 * (`https://api-sandbox.koywe.com` in sandbox, docs at
 * https://docs-crypto.koywe.com). Zero dependencies — copy the whole
 * `koywe/` folder into any TypeScript project.
 *
 * **Server-side only** — authenticates with a `clientId`/`secret` pair that
 * must never reach the browser. Exchanges them for a 24h JWT
 * (`POST /rest/auth`) and caches one token per user email (plus an
 * email-less "app" token for catalogue/quote calls that aren't user-scoped).
 *
 * On-ramp: Argentine pesos (and CLP/MXN/COP/PEN/BRL) → USDC on Stellar via
 * WIREAR (CVU bank transfer), QRI-AR (QR) or Khipu. Off-ramp: USDC → fiat to
 * a registered bank account.
 *
 * ```ts
 * const koywe = new KoyweClient({
 *   clientId: process.env.KOYWE_CLIENT_ID!,
 *   secret: process.env.KOYWE_SECRET!,
 *   baseUrl: process.env.KOYWE_BASE_URL!, // https://api-sandbox.koywe.com
 *   usdcIssuer: process.env.PUBLIC_USDC_ISSUER!,
 * });
 *
 * const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000" });
 * const order = await koywe.createOnRampOrder({ quoteId: quote.id, stellarAddress: "G..." });
 * ```
 */

import { Asset, FiatCurrency } from "@/atoms/enums";
import { KoyweError } from "./errors";
import { isValidStellarPublicKey } from "./stellarKey";
import type {
  KoyweConfig,
  KoyweRail,
  KoyweTokenInfo,
  KoyweAccountCheck,
  KoyweCheckAccountResponse,
  KoywePaymentMethod,
  KoyweQuote,
  KoyweDepositInstructions,
  KoyweOnRampOrder,
  KoyweOffRampOrder,
  KoyweOrder,
  GetQuoteArgs,
  CreateOnRampOrderArgs,
  CreateOffRampOrderArgs,
  CreateAccountArgs,
  CreateBankAccountArgs,
  GetBankAccountsArgs,
  KoyweBankAccount,
  KoyweBankAccountRequest,
  KoyweBankAccountResponse,
  KoyweAccountRequest,
  KoyweAuthResponse,
  KoyweTokenCurrency,
  KoywePaymentProvider,
  KoyweQuoteResponse,
  KoyweOrderResponse,
  KoyweErrorResponse,
} from "./types";

/** Koywe's symbol for USDC on Stellar in quote/order requests. */
const USDC_STELLAR_SYMBOL = `${Asset.USDC} Stellar`;
/** The display symbol exposed to callers for the Stellar leg. */
const USDC_DISPLAY_SYMBOL: Asset = Asset.USDC;

/**
 * Client for the Koywe crypto fiat on/off-ramp API.
 *
 * Handles per-user auth-token caching, currency/rail discovery, executable
 * quotes, delegated-KYC account registration, order creation (on- and
 * off-ramp), order polling, and KYC status.
 */
export class KoyweClient {
  /** Machine-readable provider identifier. */
  readonly name = "koywe";
  /** Human-readable provider name. */
  readonly displayName = "Koywe";
  /** Tokens Koywe can deliver on Stellar. The issuer is injected from config. */
  readonly supportedTokens: readonly KoyweTokenInfo[];
  /** ISO 4217 fiat currency codes supported by Koywe. */
  readonly supportedCurrencies: readonly FiatCurrency[] = [
    FiatCurrency.ARS,
    FiatCurrency.CLP,
    FiatCurrency.MXN,
    FiatCurrency.COP,
    FiatCurrency.PEN,
    FiatCurrency.BRL,
  ];
  /** Local payment rails surfaced for Koywe (per market). */
  readonly supportedRails: readonly KoyweRail[] = ["wirear", "qri", "spei", "pse"];

  readonly #config: KoyweConfig;
  #fetch: typeof fetch;
  /**
   * Cached JWTs keyed by email. The empty-string key holds the email-less
   * "app" token used for catalogue/quote calls. Lazily populated by
   * {@link KoyweClient.authToken}.
   */
  readonly #tokens = new Map<string, string>();

  constructor(config: KoyweConfig & { fetch?: typeof fetch }) {
    if (!config.clientId || !config.secret) {
      throw new KoyweError("`clientId` and `secret` are required.", "MISSING_CREDENTIALS", 400);
    }
    if (!config.baseUrl) {
      throw new KoyweError("`baseUrl` is required.", "MISSING_BASE_URL", 400);
    }
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") {
      throw new KoyweError("No fetch implementation available.", "NO_FETCH", 500);
    }
    this.supportedTokens = [
      {
        symbol: USDC_DISPLAY_SYMBOL,
        name: "USD Coin",
        issuer: config.usdcIssuer,
        koyweSymbol: USDC_STELLAR_SYMBOL,
        decimals: 6,
      },
    ];
  }

  #debugLog(...args: unknown[]): void {
    if (this.#config.debug) console.log("[Koywe]", ...args);
  }

  #debugError(...args: unknown[]): void {
    if (this.#config.debug) console.error("[Koywe]", ...args);
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  /** List Koywe's token/currency catalogue (`GET /rest/token-currencies`). */
  async getTokenCurrencies(): Promise<KoyweTokenCurrency[]> {
    return this.#request<KoyweTokenCurrency[]>("GET", "/rest/token-currencies");
  }

  /**
   * List the payment providers (rails) available for a fiat currency
   * (`GET /rest/payment-providers?symbol={fiat}`).
   */
  async getPaymentProviders(fiatCurrency: string): Promise<KoywePaymentMethod[]> {
    const providers = await this.#request<KoywePaymentProvider[]>(
      "GET",
      `/rest/payment-providers?symbol=${encodeURIComponent(fiatCurrency)}`,
    );
    return providers.map((p) => ({
      id: p._id,
      name: p.name,
      label: labelForProvider(p.name),
      rail: railForProvider(p.name),
      fee: p.fee,
    }));
  }

  // ---------------------------------------------------------------------------
  // Quote
  // ---------------------------------------------------------------------------

  /**
   * Request an executable conversion quote. On-ramp prices `fiatCurrency` →
   * USDC and requires a `paymentMethodId`; off-ramp prices USDC →
   * `fiatCurrency`. Executable quotes return a `quoteId` and expire in ~2-5
   * minutes.
   */
  async getQuote(args: GetQuoteArgs): Promise<KoyweQuote> {
    const isOnRamp = args.ramp === "onramp";
    const symbolIn = isOnRamp ? args.fiatCurrency : USDC_STELLAR_SYMBOL;
    const symbolOut = isOnRamp ? USDC_STELLAR_SYMBOL : args.fiatCurrency;

    const body: Record<string, unknown> = {
      amountIn: Number(args.amount),
      symbolIn,
      symbolOut,
      executable: true,
    };
    if (isOnRamp && args.paymentMethodId) body.paymentMethodId = args.paymentMethodId;

    const response = await this.#request<KoyweQuoteResponse>("POST", "/rest/quotes", body);

    const expiresAt = response.validUntil
      ? new Date(response.validUntil * 1000).toISOString()
      : new Date(Date.now() + 120_000).toISOString();

    return {
      id: response.quoteId ?? "",
      ramp: args.ramp,
      sourceAsset: displayAsset(response.symbolIn),
      targetAsset: displayAsset(response.symbolOut),
      sourceAmount: String(response.amountIn),
      destinationAmount: String(response.amountOut),
      exchangeRate: String(response.exchangeRate),
      fee: String((response.koyweFee ?? 0) + (response.networkFee ?? 0)),
      expiresAt,
      paymentMethodId: response.paymentMethodId,
    };
  }

  // ---------------------------------------------------------------------------
  // On-ramp
  // ---------------------------------------------------------------------------

  /**
   * Create an on-ramp order (fiat → USDC on Stellar) from an executable quote.
   *
   * For WIREAR the response carries inline CVU/alias/bank instructions; for
   * QRI / Khipu it carries a hosted redirect URL the user must open to pay.
   */
  async createOnRampOrder(args: CreateOnRampOrderArgs): Promise<KoyweOnRampOrder> {
    if (!args.stellarAddress) {
      throw new KoyweError(
        "`stellarAddress` is required to create a Koywe on-ramp order.",
        "MISSING_STELLAR_ADDRESS",
        400,
      );
    }
    if (!isValidStellarPublicKey(args.stellarAddress)) {
      throw new KoyweError(
        `Invalid Stellar public key: ${args.stellarAddress}`,
        "INVALID_STELLAR_ADDRESS",
        400,
      );
    }

    const email = args.email ?? this.#config.email;
    const response = await this.#request<KoyweOrderResponse>(
      "POST",
      "/rest/orders",
      {
        quoteId: args.quoteId,
        destinationAddress: args.stellarAddress,
        ...(email ? { email } : {}),
        documentNumber: args.documentNumber,
        ...(args.callbackUrl ? { callbackUrl: args.callbackUrl } : {}),
        ...(args.externalId ? { externalId: args.externalId } : {}),
      },
      email,
    );

    return {
      id: response.orderId,
      quoteId: response.quoteId ?? args.quoteId,
      status: response.status ?? "WAITING",
      sourceAmount: String(response.amountIn),
      destinationAmount: String(response.amountOut),
      sourceAsset: displayAsset(response.symbolIn),
      targetAsset: displayAsset(response.symbolOut),
      stellarAddress: args.stellarAddress,
      deposit: parseDepositInstructions(response.providedAddress),
      interactiveUrl: response.providedAction,
    };
  }

  // ---------------------------------------------------------------------------
  // Off-ramp
  // ---------------------------------------------------------------------------

  /**
   * Register a bank account to receive an off-ramp payout
   * (`POST /rest/bank-accounts`). Must run before {@link createOffRampOrder}:
   * the returned {@link KoyweBankAccount.id} is what you pass as
   * `bankAccountId`. In the sandbox the `accountNumber` must be one of
   * Koywe's validated test accounts for the country.
   */
  async createBankAccount(args: CreateBankAccountArgs): Promise<KoyweBankAccount> {
    const body: KoyweBankAccountRequest = {
      accountNumber: args.accountNumber,
      countryCode: args.countryCode,
      currencySymbol: args.currencySymbol,
      email: args.email,
      ...(args.documentNumber ? { documentNumber: args.documentNumber } : {}),
      ...(args.bankCode ? { bankCode: args.bankCode } : {}),
      ...(args.accountType ? { accountType: args.accountType } : {}),
    };
    const response = await this.#request<KoyweBankAccountResponse>(
      "POST",
      "/rest/bank-accounts",
      body,
      args.email,
    );
    return mapBankAccount(response);
  }

  /**
   * List a user's registered bank accounts for a country/currency
   * (`GET /rest/bank-accounts`). Useful to make {@link createBankAccount}
   * idempotent: look up an existing account by `accountNumber` first, since
   * re-registering the same account errors.
   */
  async getBankAccounts(args: GetBankAccountsArgs): Promise<KoyweBankAccount[]> {
    const params = new URLSearchParams({
      countryCode: args.countryCode,
      currencySymbol: args.currencySymbol,
      email: args.email,
    });
    const response = await this.#request<KoyweBankAccountResponse[]>(
      "GET",
      `/rest/bank-accounts?${params}`,
      undefined,
      args.email,
    );
    return response.map(mapBankAccount);
  }

  /**
   * Create an off-ramp order (USDC on Stellar → fiat) from an executable
   * quote. The user then sends USDC to {@link KoyweOffRampOrder.depositAddress}
   * and submits the resulting tx hash via {@link submitTxHash}.
   */
  async createOffRampOrder(args: CreateOffRampOrderArgs): Promise<KoyweOffRampOrder> {
    const email = args.email ?? this.#config.email;
    const response = await this.#request<KoyweOrderResponse>(
      "POST",
      "/rest/orders",
      {
        quoteId: args.quoteId,
        destinationAddress: args.bankAccountId,
        ...(email ? { email } : {}),
        documentNumber: args.documentNumber,
      },
      email,
    );

    return {
      id: response.orderId,
      quoteId: response.quoteId ?? args.quoteId,
      status: response.status ?? "WAITING",
      sourceAmount: String(response.amountIn),
      destinationAmount: String(response.amountOut),
      sourceAsset: displayAsset(response.symbolIn),
      targetAsset: displayAsset(response.symbolOut),
      bankAccountId: args.bankAccountId,
      depositAddress: response.providedAddress,
      interactiveUrl: response.providedAction,
    };
  }

  /**
   * Attach the Stellar transaction hash to an off-ramp order so Koywe can
   * reconcile the on-chain USDC transfer
   * (`POST /rest/orders/{orderId}/txHash`).
   */
  async submitTxHash(orderId: string, txHash: string, email?: string): Promise<void> {
    await this.#request(
      "POST",
      `/rest/orders/${encodeURIComponent(orderId)}/txHash`,
      { txHash },
      email ?? this.#config.email,
    );
  }

  // ---------------------------------------------------------------------------
  // Order polling
  // ---------------------------------------------------------------------------

  /** Fetch the current state of an order. Returns `null` if not found. */
  async getOrder(orderId: string, email?: string): Promise<KoyweOrder | null> {
    return this.#fetchOrder(`/rest/orders/${encodeURIComponent(orderId)}`, email);
  }

  /**
   * Fetch an order by the client-supplied `externalId` (the idempotency key
   * passed to {@link createOnRampOrder}) rather than Koywe's `orderId`.
   * Useful to resume tracking after a hosted-payment redirect.
   */
  async getOrderByExternalId(externalId: string, email?: string): Promise<KoyweOrder | null> {
    return this.#fetchOrder(`/rest/orders/external_id/${encodeURIComponent(externalId)}`, email);
  }

  async #fetchOrder(endpoint: string, email?: string): Promise<KoyweOrder | null> {
    try {
      const response = await this.#request<KoyweOrderResponse>(
        "GET",
        endpoint,
        undefined,
        email ?? this.#config.email,
      );
      return {
        id: response.orderId,
        status: response.status,
        sourceAmount: String(response.amountIn),
        destinationAmount: String(response.amountOut),
        sourceAsset: displayAsset(response.symbolIn),
        targetAsset: displayAsset(response.symbolOut),
        deposit: parseDepositInstructions(response.providedAddress),
        depositAddress: response.providedAddress,
        interactiveUrl: response.providedAction,
        dates: response.dates,
        txHash: response.txHash,
        statusDetails: response.statusDetails,
        isDeliveryExpired: Boolean(response.dates?.expiredByRetriesDate),
      };
    } catch (error) {
      if (error instanceof KoyweError && error.statusCode === 404) return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // KYC
  // ---------------------------------------------------------------------------

  /**
   * Register a delegated-KYC account (`POST /rest/accounts`). There is no
   * hosted KYC widget in the delegated-KYC model — you collect the
   * end-user's identity details and Koywe verifies them.
   */
  async createAccount(args: CreateAccountArgs): Promise<void> {
    const body: KoyweAccountRequest = {
      email: args.email,
      document: {
        documentNumber: args.document.documentNumber,
        documentType: args.document.documentType,
        country: args.document.country,
        isCompany: args.document.isCompany ?? false,
        ...(args.document.others ? { others: args.document.others } : {}),
      },
      address: {
        addressCountry: args.address.country,
        addressZipCode: args.address.zipCode,
        addressState: args.address.state,
        addressCity: args.address.city,
        addressStreet: args.address.street,
        ...(args.address.neighborhood ? { addressNeighborhood: args.address.neighborhood } : {}),
      },
      personalInfo: { ...args.personalInfo },
    };
    await this.#request("POST", "/rest/accounts", body, args.email);
  }

  /**
   * Check whether a user's account can actually operate
   * (`GET /rest/accounts/{email}/check`). This is Koywe's real verdict —
   * `canOperate` plus the list of still-missing requirements — not an
   * inference from whether a document was submitted. A 404 (no account)
   * maps to a non-operable `not_started` check.
   */
  async checkAccount(email?: string): Promise<KoyweAccountCheck> {
    const resolved = email ?? this.#config.email;
    if (!resolved) {
      throw new KoyweError("An email is required to check a Koywe account.", "MISSING_EMAIL", 400);
    }
    try {
      const result = await this.#request<KoyweCheckAccountResponse>(
        "GET",
        `/rest/accounts/${encodeURIComponent(resolved)}/check`,
        undefined,
        resolved,
      );
      return {
        canOperate: result.canOperate ?? false,
        accountStatus: result.accountStatus ?? "unknown",
        missing: (result.errors ?? []).map((e) => ({ field: e.field, message: e.message })),
        nextVerificationDate: result.nextVerificationDate,
      };
    } catch (error) {
      if (error instanceof KoyweError && error.statusCode === 404) {
        return { canOperate: false, accountStatus: "not_started", missing: [] };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Return a cached JWT for `email` (or an email-less app token when
   * omitted), signing in via `POST /rest/auth` on first use. Tokens are
   * valid for 24h and kept for the lifetime of the client.
   */
  async #authToken(email?: string): Promise<string> {
    const key = email ?? "";
    const cached = this.#tokens.get(key);
    if (cached) return cached;

    const url = `${this.#config.baseUrl}/rest/auth`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.#config.clientId,
          secret: this.#config.secret,
          ...(email ? { email } : {}),
        }),
      });
    } catch (cause) {
      throw new KoyweError("Network error on POST /rest/auth", "NETWORK_ERROR", undefined);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new KoyweError(text || `Koywe auth failed: ${response.status}`, "AUTH_FAILED", response.status);
    }

    const data = (await response.json()) as KoyweAuthResponse;
    this.#tokens.set(key, data.token);
    return data.token;
  }

  /**
   * Send an authenticated JSON request, mapping Koywe errors to
   * {@link KoyweError}. Pass `email` to use that user's JWT; omit it for
   * catalogue/quote calls that aren't user-scoped.
   */
  async #request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    body?: unknown,
    email?: string,
  ): Promise<T> {
    const token = await this.#authToken(email);
    const url = `${this.#config.baseUrl}${endpoint}`;
    this.#debugLog(`${method} ${url}`, body ? JSON.stringify(body) : "");

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new KoyweError(`Network error on ${method} ${endpoint}`, "NETWORK_ERROR", undefined);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      this.#debugError(`Error ${response.status}:`, errorText);

      let parsed: KoyweErrorResponse | undefined;
      try {
        parsed = JSON.parse(errorText) as KoyweErrorResponse;
      } catch {
        // Not JSON.
      }

      const message = parsed
        ? Array.isArray(parsed.message)
          ? parsed.message.join("; ")
          : parsed.message
        : errorText || `Koywe API error: ${response.status}`;

      throw new KoyweError(
        message || `Koywe API error: ${response.status}`,
        parsed?.error || "KOYWE_ERROR",
        response.status,
      );
    }

    const text = await response.text();
    this.#debugLog("Response:", text || "(empty)");
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a ramp's transaction limits from a {@link KoyweClient.getTokenCurrencies}
 * catalogue. Returns `{ min, max }` for `fiatCurrency` under the given crypto
 * `tokenSymbol` (default `"USDC Stellar"`), or `null` when the pair isn't
 * offered.
 */
export function resolveFiatLimits(
  tokens: KoyweTokenCurrency[],
  fiatCurrency: string,
  tokenSymbol: string = USDC_STELLAR_SYMBOL,
): { min?: number; max?: number } | null {
  const token = tokens.find((t) => t.symbol === tokenSymbol);
  const fiat = token?.currencies.find((c) => c.symbol === fiatCurrency);
  if (!fiat) return null;
  const limits: { min?: number; max?: number } = {};
  if (fiat.minimum !== undefined) limits.min = fiat.minimum;
  if (fiat.maximum !== undefined) limits.max = fiat.maximum;
  return limits;
}

// ---------------------------------------------------------------------------
// Module-private mapping helpers
// ---------------------------------------------------------------------------

function displayAsset(symbol: string | undefined): string {
  if (!symbol) return "";
  return symbol === USDC_STELLAR_SYMBOL ? USDC_DISPLAY_SYMBOL : symbol;
}

function mapBankAccount(response: KoyweBankAccountResponse): KoyweBankAccount {
  return {
    id: response._id,
    accountNumber: response.accountNumber,
    countryCode: response.countryCode,
    currencySymbol: response.currencySymbol,
    bankCode: response.bankCode,
    bankName: response.name,
  };
}

function labelForProvider(name: string): string {
  switch (name.toUpperCase()) {
    case "WIREAR":
      return "Bank transfer (CVU)";
    case "QRI-AR":
      return "QR transfer";
    case "KHIPU":
      return "Khipu";
    case "WIREMX":
      return "Bank transfer (SPEI)";
    case "STP":
      return "SPEI (STP)";
    case "PSE":
      return "PSE";
    case "BANCOLOMBIA":
      return "Bancolombia";
    case "NEQUI":
      return "Nequi";
    case "PALOMMA":
      return "Palomma";
    case "WIRECO":
      return "Bank transfer";
    default:
      return name;
  }
}

function railForProvider(name: string): KoyweRail | undefined {
  switch (name.toUpperCase()) {
    case "WIREAR":
      return "wirear";
    case "QRI-AR":
      return "qri";
    case "WIREMX":
      return "spei";
    case "PSE":
      return "pse";
    default:
      return undefined;
  }
}

/**
 * Parse a WIREAR `providedAddress` multi-line string into structured deposit
 * fields, e.g.:
 *
 *   ` CVU 0000053600000017871248 \n alias 30718280229.KOYWE1 \n Banco Coinag \n tef@koywe.com `
 *
 * Returns `undefined` when there is no inline instruction string (QRI/Khipu
 * orders use `interactiveUrl` instead).
 */
function parseDepositInstructions(providedAddress: string | undefined): KoyweDepositInstructions | undefined {
  if (!providedAddress || !providedAddress.trim()) return undefined;

  const result: KoyweDepositInstructions = { raw: providedAddress.trim() };
  const lines = providedAddress
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("cvu")) {
      result.cvu = line.replace(/cvu/i, "").trim();
    } else if (lower.startsWith("alias")) {
      result.alias = line.replace(/alias/i, "").trim();
    } else if (line.includes("@")) {
      result.email = line;
    } else {
      result.bankName = result.bankName ?? line;
    }
  }

  return result;
}
