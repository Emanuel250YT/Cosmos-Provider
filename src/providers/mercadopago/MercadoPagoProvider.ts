/**
 * Mercado Pago payment provider (Argentina, Brazil, Mexico, Chile, Colombia,
 * Peru, Uruguay).
 *
 * Talks to the Mercado Pago REST API directly with `fetch` — no SDK
 * dependency. Supports:
 *
 * - `link`     → Checkout Pro preference (`init_point` payment link).
 * - `qr`       → PIX QR for BRL; in-store dynamic QR when a POS is configured
 *                (`qrPos` option); falls back to a payment link otherwise.
 * - webhooks   → `x-signature` (ts/v1 HMAC-SHA256) verification and parsing.
 * - payouts    → optional, via the money transfer endpoint when enabled on
 *                the account.
 *
 * MULTI-ACCOUNT: Mercado Pago issues a SEPARATE merchant account (and access
 * token) per country — an Argentina token cannot process a Brazil/PIX
 * charge, and vice versa. Rather than one provider instance per country,
 * pass every account into ONE `new MercadoPagoProvider({ accounts: {...} })`
 * — see {@link MercadoPagoProviderOptions.accounts}. Register that single
 * instance once with `CosmosRamp`; `ramp.onramp({ provider: "mercadopago",
 * currency: "ARS" | "BRL", ... })` routes to the right account by currency
 * automatically. `getCharge`/`verifyWebhook` don't get a currency hint
 * (Mercado Pago's webhook payload doesn't carry one), so they try every
 * configured account in turn and use whichever one actually recognizes the
 * charge/signature — safe, since a payment id or HMAC secret only ever
 * matches its own account.
 */

import { Country, FiatCurrency } from "@/atoms/enums";
import { ProviderError } from "@/core/errors";
import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
import type {
  Charge,
  ChargeState,
  ChargeStatus,
  CreateChargeRequest,
  CreatePayoutRequest,
  PaymentProvider,
  PayoutResult,
  WebhookNotification,
  WebhookRequest,
} from "@/core/types";

const MP_BASE_URL = "https://api.mercadopago.com";

const MP_REGIONS = [
  Country.AR,
  Country.BR,
  Country.MX,
  Country.CL,
  Country.CO,
  Country.PE,
  Country.UY,
] as const;
const MP_CURRENCIES = [
  FiatCurrency.ARS,
  FiatCurrency.BRL,
  FiatCurrency.MXN,
  FiatCurrency.CLP,
  FiatCurrency.COP,
  FiatCurrency.PEN,
  FiatCurrency.UYU,
] as const;

/** Mercado Pago payment status → normalized ChargeStatus. */
const STATUS_MAP: Record<string, ChargeStatus> = {
  approved: "approved",
  accredited: "approved",
  pending: "pending",
  in_process: "pending",
  in_mediation: "pending",
  authorized: "pending",
  rejected: "rejected",
  cancelled: "canceled",
  refunded: "refunded",
  charged_back: "refunded",
  expired: "expired",
};

export interface MercadoPagoAccountCredentials {
  /** Access token for this account (`APP_USR-...` in production, `TEST-...` in sandbox). */
  accessToken: string;
  /**
   * Sandbox mode for this account. Defaults to auto-detection from its own
   * `accessToken` (`TEST-...` → sandbox) — accounts can be in different
   * modes independently (e.g. AR in production, BR still in sandbox).
   */
  sandbox?: boolean;
  /** Webhook secret from this account's Mercado Pago dashboard. */
  webhookSecret?: string;
  /** `notification_url` for charges built through this account. */
  notificationUrl?: string;
  /** Default payer email for PIX/QR charges through this account. */
  defaultPayerEmail?: string;
  /** In-store QR config (collector + POS) for this account. */
  qrPos?: { collectorId: string; posId: string };
  /**
   * API base URL for this account specifically — Mercado Pago itself uses
   * the same URL for sandbox and production (the `accessToken` alone
   * decides the mode), but this lets you route an account through your own
   * proxy without affecting the others. Falls back to the top-level
   * `baseUrl` (default: `https://api.mercadopago.com`).
   */
  baseUrl?: string;
}

export interface MercadoPagoProviderOptions extends Partial<MercadoPagoAccountCredentials> {
  /** Provider name used to select it on each `ramp.onramp/offramp` call. Default: `"mercadopago"`. */
  name?: string;
  /** Countries this instance can operate in. Default: all seven Mercado Pago markets (AR, BR, MX, CL, CO, PE, UY). */
  regions?: readonly string[];
  /** Currencies this instance can operate in. Default: all seven Mercado Pago markets. */
  currencies?: readonly string[];
  /**
   * Per-currency account overrides, for operating more than one Mercado
   * Pago merchant account from a single provider instance. Key by ISO 4217
   * currency ("ARS", "BRL", ...): a request in that currency uses this
   * account's `accessToken`/`webhookSecret`/etc. instead of the top-level
   * ones. A currency without an entry here falls back to the top-level
   * `accessToken` (the "default" account) — set at least one of the two.
   *
   * ```ts
   * new MercadoPagoProvider({
   *   accounts: {
   *     ARS: { accessToken: process.env.MP_AR_ACCESS_TOKEN!, webhookSecret: process.env.MP_AR_WEBHOOK_SECRET },
   *     BRL: { accessToken: process.env.MP_BR_ACCESS_TOKEN!, webhookSecret: process.env.MP_BR_WEBHOOK_SECRET },
   *   },
   * });
   * ```
   */
  accounts?: Partial<Record<string, MercadoPagoAccountCredentials>>;
  /** Default API base URL — every account falls back to this unless it sets its own `baseUrl`. Default: `https://api.mercadopago.com`. */
  baseUrl?: string;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
}

export class MercadoPagoProvider implements PaymentProvider {
  readonly name: string;
  readonly regions: readonly string[];
  readonly currencies: readonly string[];
  /** Default API base URL every account falls back to unless it sets its own (see {@link MercadoPagoAccountCredentials.baseUrl}). */
  readonly baseUrl: string;
  /**
   * Whether the DEFAULT account (the top-level `accessToken`, if any) runs
   * against sandbox credentials. Per-currency accounts in {@link
   * MercadoPagoProviderOptions.accounts} resolve their own sandbox mode
   * independently — check `sandbox` on that account's credentials, not this.
   */
  readonly sandbox: boolean;

  /** Resolved default account (top-level options), used for any currency without a specific override. */
  #defaultAccount?: ResolvedAccount;
  /** Per-currency overrides, keyed by uppercased ISO 4217 code. */
  #accountsByCurrency = new Map<string, ResolvedAccount>();
  #fetch: typeof fetch;

  constructor(options: MercadoPagoProviderOptions) {
    this.name = options.name ?? "mercadopago";
    this.regions = options.regions ?? MP_REGIONS;
    this.currencies = options.currencies ?? MP_CURRENCIES;
    this.baseUrl = (options.baseUrl ?? MP_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") {
      throw new ProviderError(this.name, "No fetch implementation available.");
    }

    if (options.accessToken) {
      this.#defaultAccount = resolveAccount(
        {
          accessToken: options.accessToken,
          sandbox: options.sandbox,
          webhookSecret: options.webhookSecret,
          notificationUrl: options.notificationUrl,
          defaultPayerEmail: options.defaultPayerEmail,
          qrPos: options.qrPos,
          baseUrl: options.baseUrl,
        },
        this.baseUrl,
      );
    }
    for (const [currency, account] of Object.entries(options.accounts ?? {})) {
      if (!account) continue;
      this.#accountsByCurrency.set(currency.toUpperCase(), resolveAccount(account, this.baseUrl));
    }
    if (!this.#defaultAccount && this.#accountsByCurrency.size === 0) {
      throw new ProviderError(
        this.name,
        "No account configured: pass `accessToken` (a default account) and/or `accounts` (per-currency overrides).",
      );
    }
    this.sandbox = this.#defaultAccount?.sandbox ?? false;
  }

  /** The account to use for `currency`, or the default account if there's no override. Throws if neither is configured. */
  #accountFor(currency: string): ResolvedAccount {
    const account = this.#accountsByCurrency.get(currency.toUpperCase()) ?? this.#defaultAccount;
    if (!account) {
      throw new ProviderError(
        this.name,
        `No Mercado Pago account configured for ${currency.toUpperCase()}. Add it to \`accounts\` or set a default \`accessToken\`.`,
      );
    }
    return account;
  }

  /** Every distinct configured account (default + overrides), for operations that don't know the currency up front (getCharge, verifyWebhook). */
  #allAccounts(): ResolvedAccount[] {
    const accounts = [...this.#accountsByCurrency.values()];
    if (this.#defaultAccount) accounts.push(this.#defaultAccount);
    // Dedupe by access token, in case the default and an override share one.
    const seen = new Set<string>();
    return accounts.filter((a) => (seen.has(a.accessToken) ? false : (seen.add(a.accessToken), true)));
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const account = this.#accountFor(request.currency);
    const method = request.method === "auto" ? this.#pickMethod(request, account) : request.method;

    if (method === "qr") {
      if (request.currency.toUpperCase() === FiatCurrency.BRL) return this.#createPixCharge(request, account);
      if (account.qrPos) return this.#createInStoreQrCharge(request, account);
      // No POS configured for this region — a payment link is the closest rail.
      return this.#createPreferenceCharge(request, account);
    }
    if (method === "transfer") {
      // Mercado Pago has no plain deposit rail; the hosted checkout covers
      // account-money and bank methods.
      return this.#createPreferenceCharge(request, account);
    }
    return this.#createPreferenceCharge(request, account);
  }

  #pickMethod(request: CreateChargeRequest, account: ResolvedAccount): "qr" | "link" {
    return request.currency.toUpperCase() === FiatCurrency.BRL || account.qrPos ? "qr" : "link";
  }

  /** Checkout Pro preference → hosted payment link (`init_point`). */
  async #createPreferenceCharge(request: CreateChargeRequest, account: ResolvedAccount): Promise<Charge> {
    const body: Record<string, unknown> = {
      items: [
        {
          id: request.reference,
          title: request.description ?? `Order ${request.reference}`,
          quantity: 1,
          unit_price: request.amount,
          currency_id: request.currency.toUpperCase(),
        },
      ],
      external_reference: request.reference,
      ...(account.notificationUrl ? { notification_url: account.notificationUrl } : {}),
      ...(request.expiresInMinutes
        ? {
            expires: true,
            expiration_date_to: new Date(Date.now() + request.expiresInMinutes * 60_000).toISOString(),
          }
        : {}),
      ...(request.payer?.email ? { payer: { email: request.payer.email } } : {}),
      ...request.providerOptions,
    };

    const preference = await this.#request<{ id: string; init_point?: string; sandbox_init_point?: string }>(
      account,
      "POST",
      "/checkout/preferences",
      body,
    );

    return {
      id: preference.id,
      method: "link",
      // Sandbox checkouts must go through `sandbox_init_point`; a production
      // link on test credentials renders an unusable checkout (and vice versa).
      link: account.sandbox
        ? (preference.sandbox_init_point ?? preference.init_point)
        : (preference.init_point ?? preference.sandbox_init_point),
      expiresAt: request.expiresInMinutes ? Date.now() + request.expiresInMinutes * 60_000 : undefined,
      raw: preference,
    };
  }

  /** PIX payment (BRL) → EMV QR string + base64 image. */
  async #createPixCharge(request: CreateChargeRequest, account: ResolvedAccount): Promise<Charge> {
    const email = request.payer?.email ?? account.defaultPayerEmail;
    if (!email) {
      throw new ProviderError(
        this.name,
        "PIX charges need a payer email. Pass `payer.email` or set `defaultPayerEmail`.",
      );
    }

    const body: Record<string, unknown> = {
      transaction_amount: request.amount,
      description: request.description ?? `Order ${request.reference}`,
      payment_method_id: "pix",
      payer: { email },
      external_reference: request.reference,
      ...(account.notificationUrl ? { notification_url: account.notificationUrl } : {}),
      ...(request.expiresInMinutes
        ? { date_of_expiration: new Date(Date.now() + request.expiresInMinutes * 60_000).toISOString() }
        : {}),
      ...request.providerOptions,
    };

    const payment = await this.#request<{
      id: number;
      point_of_interaction?: {
        transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string };
      };
    }>(account, "POST", "/v1/payments", body, { "X-Idempotency-Key": request.reference });

    const tx = payment.point_of_interaction?.transaction_data;
    return {
      id: String(payment.id),
      method: "qr",
      qr: tx?.qr_code,
      qrBase64: tx?.qr_code_base64,
      link: tx?.ticket_url,
      expiresAt: request.expiresInMinutes ? Date.now() + request.expiresInMinutes * 60_000 : undefined,
      raw: payment,
    };
  }

  /** In-store dynamic QR (requires a configured POS). */
  async #createInStoreQrCharge(request: CreateChargeRequest, account: ResolvedAccount): Promise<Charge> {
    const { collectorId, posId } = account.qrPos!;
    const path = `/instore/orders/qr/seller/collectors/${collectorId}/pos/${posId}/qrs`;

    const body: Record<string, unknown> = {
      external_reference: request.reference,
      title: request.description ?? `Order ${request.reference}`,
      description: request.description ?? `Order ${request.reference}`,
      total_amount: request.amount,
      items: [
        {
          title: request.description ?? `Order ${request.reference}`,
          unit_price: request.amount,
          quantity: 1,
          unit_measure: "unit",
          total_amount: request.amount,
        },
      ],
      ...(account.notificationUrl ? { notification_url: account.notificationUrl } : {}),
      ...request.providerOptions,
    };

    const result = await this.#request<{ qr_data?: string; in_store_order_id?: string }>(account, "PUT", path, body);

    return {
      id: result.in_store_order_id ?? request.reference,
      method: "qr",
      qr: result.qr_data,
      raw: result,
    };
  }

  /**
   * Fetch a charge's trusted state. The account isn't known up front (a
   * webhook/charge id alone doesn't say which account issued it), so this
   * tries every configured account in turn and returns the first one that
   * actually finds the payment — a payment id only ever exists in its own
   * account, so this is unambiguous, not a guess.
   */
  async getCharge(chargeId: string): Promise<ChargeState> {
    const accounts = this.#allAccounts();
    let lastError: unknown;
    for (const account of accounts) {
      try {
        const payment = await this.#request<{
          id: number;
          status?: string;
          transaction_amount?: number;
          currency_id?: string;
          external_reference?: string;
          metadata?: { external_reference?: string };
        }>(account, "GET", `/v1/payments/${chargeId}`);

        return {
          id: String(payment.id),
          status: STATUS_MAP[payment.status ?? ""] ?? "pending",
          amount: payment.transaction_amount ?? 0,
          currency: (payment.currency_id ?? "").toUpperCase(),
          reference: payment.external_reference ?? payment.metadata?.external_reference,
          raw: payment,
        };
      } catch (error) {
        lastError = error;
        // 404 just means "not this account" — keep trying the others.
        if (error instanceof ProviderError && error.status === 404) continue;
        throw error;
      }
    }
    throw lastError ?? new ProviderError(this.name, "No account configured to fetch charges with.");
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify the `x-signature: ts=...,v1=...` header. The signed manifest is
   * `id:{data.id};request-id:{x-request-id};ts:{ts};` (parts included only
   * when present), HMAC-SHA256 with the dashboard webhook secret.
   *
   * Like {@link getCharge}, the account isn't known up front: this tries
   * every configured account's `webhookSecret` and accepts if any one
   * matches. Safe — an HMAC signature only ever validates against the exact
   * secret that produced it.
   */
  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    const secrets = this.#allAccounts()
      .map((a) => a.webhookSecret)
      .filter((s): s is string => !!s);
    if (secrets.length === 0) return true; // verification disabled (no secret configured on any account)

    const xSignature = headerValue(request.headers, "x-signature");
    if (!xSignature) return false;

    let ts: string | undefined;
    let v1: string | undefined;
    for (const part of xSignature.split(",")) {
      const [key, value] = part.split("=").map((s) => s.trim());
      if (key === "ts") ts = value;
      else if (key === "v1") v1 = value;
    }
    if (!ts || !v1) return false;

    const dataId = this.#extractPaymentId(request);
    const requestId = headerValue(request.headers, "x-request-id");

    const parts: string[] = [];
    if (dataId) parts.push(`id:${String(dataId).toLowerCase()}`);
    if (requestId) parts.push(`request-id:${requestId}`);
    parts.push(`ts:${ts}`);
    const manifest = parts.join(";") + ";";

    for (const secret of secrets) {
      const expected = await hmacSha256Hex(secret, manifest);
      if (timingSafeEqualStr(expected, v1)) return true;
    }
    return false;
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null> {
    const body = parseBody(request.body);
    const kind =
      (typeof body.type === "string" && body.type) ||
      (typeof body.action === "string" && body.action.split(".")[0]) ||
      "unknown";

    const paymentId = this.#extractPaymentId(request);
    if (kind !== "payment" || !paymentId) return null;

    return { chargeId: String(paymentId), kind, raw: body };
  }

  /**
   * Build a correctly signed `WebhookRequest` for a payment id, exactly as
   * Mercado Pago would send it (`x-signature: ts=...,v1=...` over the
   * `id:...;request-id:...;ts:...;` manifest).
   *
   * Meant for sandbox/local testing: create a test payment, then feed the
   * result straight into `ramp.handleWebhook("mercadopago", request)` (or
   * POST it to your endpoint) to exercise the full verify → parse → fetch →
   * settle pipeline without exposing a public URL.
   *
   * @param currency Which configured account's `webhookSecret` to sign
   * with, when you operate more than one (see {@link
   * MercadoPagoProviderOptions.accounts}). Defaults to the default account.
   */
  async buildTestWebhook(
    paymentId: string | number,
    options?: { requestId?: string; ts?: number; action?: string; currency?: string },
  ): Promise<WebhookRequest> {
    const id = String(paymentId);
    const ts = String(options?.ts ?? Math.floor(Date.now() / 1000));
    const requestId = options?.requestId ?? `test-${ts}`;
    const account = options?.currency ? this.#accountFor(options.currency) : this.#defaultAccount;

    const headers: Record<string, string> = { "x-request-id": requestId };
    if (account?.webhookSecret) {
      const manifest = `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`;
      const v1 = await hmacSha256Hex(account.webhookSecret, manifest);
      headers["x-signature"] = `ts=${ts},v1=${v1}`;
    }

    return {
      body: JSON.stringify({
        type: "payment",
        action: options?.action ?? "payment.updated",
        data: { id },
      }),
      headers,
      query: { "data.id": id },
    };
  }

  #extractPaymentId(request: WebhookRequest): string | undefined {
    const fromQuery = request.query?.["data.id"] ?? queryFromUrl(request.url, "data.id");
    if (fromQuery) return fromQuery;
    const body = parseBody(request.body);
    const data = body.data as { id?: string | number } | undefined;
    return data?.id !== undefined ? String(data.id) : undefined;
  }

  // -------------------------------------------------------------------------
  // Payouts (offramp)
  // -------------------------------------------------------------------------

  /**
   * Send money to a Mercado Pago user. Requires the money-transfer feature
   * to be enabled on your account. `destination` accepts `{ email }` or any
   * raw fields the transfer endpoint supports.
   */
  async createPayout(request: CreatePayoutRequest): Promise<PayoutResult> {
    const account = this.#accountFor(request.currency);
    const body: Record<string, unknown> = {
      transaction_amount: request.amount,
      currency_id: request.currency.toUpperCase(),
      external_reference: request.reference,
      ...request.destination,
    };

    const result = await this.#request<{ id?: number | string; status?: string }>(
      account,
      "POST",
      "/v1/money_transfers",
      body,
      { "X-Idempotency-Key": `payout-${request.reference}` },
    );

    return {
      id: String(result.id ?? request.reference),
      status: result.status === "approved" || result.status === "accredited" ? "sent" : "pending",
      raw: result,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  async #request<T>(
    account: ResolvedAccount,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(account.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new ProviderError(this.name, `Network error on ${method} ${path}`, { cause });
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const message =
        (payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `HTTP ${response.status}`) + ` on ${method} ${path}`;
      throw new ProviderError(this.name, message, { status: response.status, body: payload });
    }
    return payload as T;
  }
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

interface ResolvedAccount extends MercadoPagoAccountCredentials {
  sandbox: boolean;
  baseUrl: string;
}

function resolveAccount(credentials: MercadoPagoAccountCredentials, defaultBaseUrl: string): ResolvedAccount {
  return {
    ...credentials,
    sandbox: credentials.sandbox ?? credentials.accessToken.startsWith("TEST-"),
    baseUrl: (credentials.baseUrl || defaultBaseUrl).replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Small request helpers
// ---------------------------------------------------------------------------

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function parseBody(body: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof body !== "string") return body ?? {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function queryFromUrl(url: string | undefined, key: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://localhost").searchParams.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}
