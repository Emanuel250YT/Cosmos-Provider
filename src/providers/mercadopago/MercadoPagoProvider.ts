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
 */

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

const MP_REGIONS = ["AR", "BR", "MX", "CL", "CO", "PE", "UY"] as const;
const MP_CURRENCIES = ["ARS", "BRL", "MXN", "CLP", "COP", "PEN", "UYU"] as const;

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

export interface MercadoPagoProviderOptions {
  /** Access token (`APP_USR-...` in production, `TEST-...` in sandbox). */
  accessToken: string;
  /**
   * Webhook secret from the Mercado Pago dashboard, used to verify the
   * `x-signature` header. Strongly recommended — without it, webhooks are
   * accepted unverified.
   */
  webhookSecret?: string;
  /** URL Mercado Pago should notify when a payment changes state. */
  notificationUrl?: string;
  /**
   * Default payer email for PIX/QR payments (Mercado Pago requires one).
   * Can be overridden per charge via `payer.email`.
   */
  defaultPayerEmail?: string;
  /**
   * In-store QR configuration for non-PIX dynamic QRs:
   * your collector (user) id and the POS external id.
   */
  qrPos?: { collectorId: string; posId: string };
  /** Override the API base URL. */
  baseUrl?: string;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
}

export class MercadoPagoProvider implements PaymentProvider {
  readonly name = "mercadopago";
  readonly regions = MP_REGIONS;
  readonly currencies = MP_CURRENCIES;
  readonly baseUrl: string;

  #accessToken: string;
  #webhookSecret?: string;
  #notificationUrl?: string;
  #defaultPayerEmail?: string;
  #qrPos?: { collectorId: string; posId: string };
  #fetch: typeof fetch;

  constructor(options: MercadoPagoProviderOptions) {
    if (!options.accessToken) {
      throw new ProviderError(this.name, "`accessToken` is required.");
    }
    this.#accessToken = options.accessToken;
    this.#webhookSecret = options.webhookSecret;
    this.#notificationUrl = options.notificationUrl;
    this.#defaultPayerEmail = options.defaultPayerEmail;
    this.#qrPos = options.qrPos;
    this.baseUrl = (options.baseUrl ?? MP_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") {
      throw new ProviderError(this.name, "No fetch implementation available.");
    }
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const method = request.method === "auto" ? this.#pickMethod(request) : request.method;

    if (method === "qr") {
      if (request.currency.toUpperCase() === "BRL") return this.#createPixCharge(request);
      if (this.#qrPos) return this.#createInStoreQrCharge(request);
      // No POS configured for this region — a payment link is the closest rail.
      return this.#createPreferenceCharge(request);
    }
    if (method === "transfer") {
      // Mercado Pago has no plain deposit rail; the hosted checkout covers
      // account-money and bank methods.
      return this.#createPreferenceCharge(request);
    }
    return this.#createPreferenceCharge(request);
  }

  #pickMethod(request: CreateChargeRequest): "qr" | "link" {
    return request.currency.toUpperCase() === "BRL" || this.#qrPos ? "qr" : "link";
  }

  /** Checkout Pro preference → hosted payment link (`init_point`). */
  async #createPreferenceCharge(request: CreateChargeRequest): Promise<Charge> {
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
      ...(this.#notificationUrl ? { notification_url: this.#notificationUrl } : {}),
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
      "POST",
      "/checkout/preferences",
      body,
    );

    return {
      id: preference.id,
      method: "link",
      link: preference.init_point ?? preference.sandbox_init_point,
      expiresAt: request.expiresInMinutes ? Date.now() + request.expiresInMinutes * 60_000 : undefined,
      raw: preference,
    };
  }

  /** PIX payment (BRL) → EMV QR string + base64 image. */
  async #createPixCharge(request: CreateChargeRequest): Promise<Charge> {
    const email = request.payer?.email ?? this.#defaultPayerEmail;
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
      ...(this.#notificationUrl ? { notification_url: this.#notificationUrl } : {}),
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
    }>("POST", "/v1/payments", body, { "X-Idempotency-Key": request.reference });

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
  async #createInStoreQrCharge(request: CreateChargeRequest): Promise<Charge> {
    const { collectorId, posId } = this.#qrPos!;
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
      ...(this.#notificationUrl ? { notification_url: this.#notificationUrl } : {}),
      ...request.providerOptions,
    };

    const result = await this.#request<{ qr_data?: string; in_store_order_id?: string }>("PUT", path, body);

    return {
      id: result.in_store_order_id ?? request.reference,
      method: "qr",
      qr: result.qr_data,
      raw: result,
    };
  }

  async getCharge(chargeId: string): Promise<ChargeState> {
    const payment = await this.#request<{
      id: number;
      status?: string;
      transaction_amount?: number;
      currency_id?: string;
      external_reference?: string;
      metadata?: { external_reference?: string };
    }>("GET", `/v1/payments/${chargeId}`);

    return {
      id: String(payment.id),
      status: STATUS_MAP[payment.status ?? ""] ?? "pending",
      amount: payment.transaction_amount ?? 0,
      currency: (payment.currency_id ?? "").toUpperCase(),
      reference: payment.external_reference ?? payment.metadata?.external_reference,
      raw: payment,
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Verify the `x-signature: ts=...,v1=...` header. The signed manifest is
   * `id:{data.id};request-id:{x-request-id};ts:{ts};` (parts included only
   * when present), HMAC-SHA256 with the dashboard webhook secret.
   */
  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    if (!this.#webhookSecret) return true; // verification disabled (no secret configured)

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

    const expected = await hmacSha256Hex(this.#webhookSecret, manifest);
    return timingSafeEqualStr(expected, v1);
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
    const body: Record<string, unknown> = {
      transaction_amount: request.amount,
      currency_id: request.currency.toUpperCase(),
      external_reference: request.reference,
      ...request.destination,
    };

    const result = await this.#request<{ id?: number | string; status?: string }>(
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
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
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
