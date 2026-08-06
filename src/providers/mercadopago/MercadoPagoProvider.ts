/**
 * Mercado Pago payment provider (Argentina, Brazil, Mexico, Chile, Colombia,
 * Peru, Uruguay).
 *
 * Talks to the Mercado Pago REST API directly with `fetch` — no SDK
 * dependency. Payment link and PIX are two genuinely different ways to
 * collect money (different endpoints, different account requirements,
 * different countries), so each has its own explicit method rather than
 * one method with a `method` flag:
 *
 * - {@link createPaymentLink} → Checkout Pro preference (`init_point`
 *   payment link). Works in every market this provider supports, and is
 *   the one that's safe to exercise against sandbox/test credentials.
 * - {@link createPixCharge}   → direct PIX payment, Brazil (BRL) only.
 *   Mercado Pago does NOT allow this on sandbox/test credentials — it
 *   always requires a real, production merchant account with the Payments
 *   API scope enabled; this method throws immediately against a sandbox
 *   account instead of letting the API fail with a confusing 401.
 * - in-store dynamic QR      → when a POS is configured (`qrPos` option).
 * - webhooks   → `x-signature` (ts/v1 HMAC-SHA256) verification and parsing.
 * - payouts    → optional, via the money transfer endpoint when enabled on
 *                the account.
 *
 * `createCharge` (the generic {@link PaymentProvider} interface method used
 * by `CosmosRamp`) still exists and dispatches to the method above that
 * matches `request.method` — use it when you're going through `CosmosRamp`;
 * call `createPaymentLink`/`createPixCharge` directly when you're only
 * using this provider on its own.
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

/** Request for {@link MercadoPagoProvider.createPaymentLink} — same as {@link CreateChargeRequest} minus `method`, which is always `"link"`. */
export type MercadoPagoPaymentLinkRequest = Omit<CreateChargeRequest, "method">;

/** Request for {@link MercadoPagoProvider.createPixCharge} — same as {@link CreateChargeRequest} minus `method` (always `"qr"`) and `currency` (always `"BRL"`). */
export type MercadoPagoPixChargeRequest = Omit<CreateChargeRequest, "method" | "currency">;

export interface MercadoPagoProviderOptions extends Partial<MercadoPagoAccountCredentials> {
  /** Provider name used to select it on each `ramp.onramp/offramp` call. Default: `"mercadopago"`. */
  name?: string;
  /** Countries this instance can operate in. Default: all seven Mercado Pago markets (AR, BR, MX, CL, CO, PE, UY). */
  regions?: readonly string[];
  /** Currencies this instance can operate in. Default: all seven Mercado Pago markets. */
  currencies?: readonly string[];
  /** Optional logo URL, for UIs that list providers (e.g. a payment-method picker). */
  logoUrl?: string;
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
  /** Optional logo URL, for UIs that list providers (e.g. a payment-method picker). */
  readonly logoUrl?: string;
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
    this.logoUrl = options.logoUrl;
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

  /**
   * Checkout Pro payment link (`init_point`/`sandbox_init_point`). Works in
   * every market this provider supports, and is the method to use for
   * sandbox/test-credential runs — unlike {@link createPixCharge}, Mercado
   * Pago serves this one on test accounts too.
   */
  async createPaymentLink(request: MercadoPagoPaymentLinkRequest): Promise<Charge> {
    const account = this.#accountFor(request.currency);
    return this.#createPreferenceCharge({ ...request, method: "link" }, account);
  }

  /**
   * PIX payment, Brazil (BRL) only — direct `POST /v1/payments` charge with
   * `payment_method_id: "pix"`.
   *
   * Mercado Pago does not support PIX on sandbox/test accounts: the
   * Payments API scope it needs is only granted to real, production
   * merchant accounts. This throws immediately when the resolved BRL
   * account is in sandbox mode, instead of letting the request fail with a
   * confusing "Unauthorized use of live credentials" 401 — use {@link
   * createPaymentLink} to test the BRL rail in sandbox instead.
   */
  async createPixCharge(request: MercadoPagoPixChargeRequest): Promise<Charge> {
    const account = this.#accountFor(FiatCurrency.BRL);
    if (account.sandbox) {
      throw new ProviderError(
        this.name,
        "PIX is not available on Mercado Pago sandbox/test accounts — it requires a production account with the " +
          "Payments API scope enabled. Use createPaymentLink() to test the BRL rail in sandbox instead.",
      );
    }
    return this.#createPixCharge({ ...request, currency: FiatCurrency.BRL, method: "qr" }, account);
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
        return toChargeState(
          await this.#request<MercadoPagoPaymentPayload>(account, "GET", `/v1/payments/${chargeId}`),
        );
      } catch (error) {
        lastError = error;
        // 404 just means "not this account" — keep trying the others.
        if (error instanceof ProviderError && error.status === 404) continue;
        throw error;
      }
    }
    throw lastError ?? new ProviderError(this.name, "No account configured to fetch charges with.");
  }

  /**
   * Find the payment made against an `external_reference`.
   *
   * This is the ONLY way to check the outcome of a Checkout Pro link
   * ({@link createPaymentLink}): its `Charge.id` is a *preference* id, and
   * `/v1/payments/<preferenceId>` doesn't exist — passing one to
   * {@link getCharge} always 404s, however genuinely the buyer paid. The
   * payment MP creates when they do carries the preference's
   * `external_reference`, so that's what identifies it.
   *
   * Returns the approved payment when there is one (a buyer who retries after
   * a rejection leaves several against the same reference), else the most
   * recent, else `null` when nobody has paid yet.
   */
  async findChargeByReference(reference: string): Promise<ChargeState | null> {
    const query = `?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc`;
    let lastError: unknown;
    for (const account of this.#allAccounts()) {
      try {
        const found = await this.#request<{ results?: MercadoPagoPaymentPayload[] }>(
          account,
          "GET",
          `/v1/payments/search${query}`,
        );
        const results = found.results ?? [];
        if (results.length === 0) continue;
        const payment = results.find((p) => p.status === "approved") ?? results[0]!;
        return toChargeState(payment);
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError && error.status === 404) continue;
        throw error;
      }
    }
    if (lastError && !(lastError instanceof ProviderError && lastError.status === 404)) throw lastError;
    return null;
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
   *
   * The signed id is whatever the notification used to name its resource, so
   * this follows {@link parseWebhook} across both formats: `data.id` for
   * Webhooks v2, the bare `id` query param for IPN. Signing the v2 id alone
   * would reject every IPN notification as forged.
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

  /**
   * Mercado Pago has TWO notification formats and a `notification_url` set on
   * a Checkout Pro preference receives the older one, so both are handled:
   *
   * - Webhooks v2 — `?data.id=<paymentId>&type=payment`, body
   *   `{type:"payment", action:"payment.updated", data:{id}}`.
   * - IPN — `?topic=payment&id=<paymentId>`, body `{topic, resource}` with
   *   no `data.id` anywhere. Preference-based checkouts (`createPaymentLink`)
   *   are notified this way, so treating it as unparseable silently drops
   *   every real payment on that rail.
   *
   * IPN also emits `topic=merchant_order`, which carries the payments for a
   * preference rather than a payment id — resolved through the merchant order
   * to the payment that actually went through. `handleWebhook` re-fetches
   * whatever id comes out of here from the API before trusting it, so this
   * only has to identify the payment, not vouch for its state.
   */
  async parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null> {
    const body = parseBody(request.body);
    const topic = this.#webhookTopic(request, body);

    if (topic === "payment") {
      const paymentId = this.#extractPaymentId(request);
      if (!paymentId) return null;
      return { chargeId: String(paymentId), kind: "payment", raw: body };
    }

    if (topic === "merchant_order") {
      const merchantOrderId = this.#extractResourceId(request, body);
      if (!merchantOrderId) return null;
      const paymentId = await this.#paymentIdFromMerchantOrder(merchantOrderId);
      if (!paymentId) return null;
      return { chargeId: paymentId, kind: "payment", raw: body };
    }

    return null;
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

  /** What this notification is about, across both formats: `type`/`action` (Webhooks v2, body or query) or `topic` (IPN, query or body). */
  #webhookTopic(request: WebhookRequest, body: Record<string, unknown>): string {
    const fromBody =
      (typeof body.type === "string" && body.type) ||
      (typeof body.action === "string" && body.action.split(".")[0]) ||
      (typeof body.topic === "string" && body.topic) ||
      "";
    if (fromBody) return fromBody;
    return queryParam(request, "type") ?? queryParam(request, "topic") ?? "unknown";
  }

  /**
   * The payment id, in whichever place the notification put it: `data.id`
   * (Webhooks v2, query then body) or the bare `id` query param (IPN). The
   * IPN `id` is only read once the topic says "payment" — for other topics
   * it identifies a different resource entirely.
   */
  #extractPaymentId(request: WebhookRequest): string | undefined {
    const fromQuery = request.query?.["data.id"] ?? queryFromUrl(request.url, "data.id");
    if (fromQuery) return fromQuery;
    const body = parseBody(request.body);
    const data = body.data as { id?: string | number } | undefined;
    if (data?.id !== undefined) return String(data.id);
    return this.#extractResourceId(request, body);
  }

  /** IPN's resource id: the `id` query param, or the trailing id of the `resource` URL in the body. */
  #extractResourceId(request: WebhookRequest, body: Record<string, unknown>): string | undefined {
    const fromQuery = queryParam(request, "id");
    if (fromQuery) return fromQuery;
    if (typeof body.resource === "string") {
      const tail = body.resource.split("?")[0]!.split("/").filter(Boolean).pop();
      if (tail && /^\d+$/.test(tail)) return tail;
    }
    return undefined;
  }

  /**
   * Resolve a merchant order to the payment worth acting on: the approved one
   * if there is one, else the most recent. Returns undefined when the order
   * has no payments yet (the notification that fires as the buyer merely
   * opens the checkout), which `parseWebhook` reports as "nothing to do".
   */
  async #paymentIdFromMerchantOrder(merchantOrderId: string): Promise<string | undefined> {
    for (const account of this.#allAccounts()) {
      try {
        const order = await this.#request<{ payments?: Array<{ id?: number | string; status?: string }> }>(
          account,
          "GET",
          `/merchant_orders/${merchantOrderId}`,
        );
        const payments = order.payments ?? [];
        if (payments.length === 0) return undefined;
        const chosen = payments.find((p) => p.status === "approved") ?? payments[payments.length - 1]!;
        return chosen.id !== undefined ? String(chosen.id) : undefined;
      } catch (error) {
        // 404 just means "not this account" — same per-account probing as getCharge.
        if (error instanceof ProviderError && error.status === 404) continue;
        throw error;
      }
    }
    return undefined;
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

/** The fields of a `/v1/payments` payload this provider reads — the same shape whether it came from a fetch by id or from a search. */
interface MercadoPagoPaymentPayload {
  id: number | string;
  status?: string;
  transaction_amount?: number;
  currency_id?: string;
  external_reference?: string;
  metadata?: { external_reference?: string };
}

function toChargeState(payment: MercadoPagoPaymentPayload): ChargeState {
  return {
    id: String(payment.id),
    status: STATUS_MAP[payment.status ?? ""] ?? "pending",
    amount: payment.transaction_amount ?? 0,
    currency: (payment.currency_id ?? "").toUpperCase(),
    reference: payment.external_reference ?? payment.metadata?.external_reference,
    raw: payment,
  };
}

/** A query param from either the parsed `query` map or the raw `url`. */
function queryParam(request: WebhookRequest, key: string): string | undefined {
  return request.query?.[key] ?? queryFromUrl(request.url, key);
}

function queryFromUrl(url: string | undefined, key: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://localhost").searchParams.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}
