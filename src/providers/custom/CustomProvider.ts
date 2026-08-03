/**
 * Custom payment provider factory.
 *
 * Plug ANY payment rail into the engine without implementing the full
 * `PaymentProvider` interface by hand: you supply the raw API calls, and the
 * `CustomProvider` adapts every response to the normalized Cosmos format —
 * so payment links, QRs, statuses and webhooks always behave exactly like
 * the built-in providers.
 *
 * Three layers of adaptation, from zero-effort to full control:
 *
 * 1. **Auto-mapping** — common field aliases (`init_point`, `checkout_url`,
 *    `qr_code`, `transaction_amount`, `external_reference`...) are picked up
 *    automatically from the raw response.
 * 2. **`statusMap`** — map your provider's status strings onto the
 *    normalized `ChargeStatus` set (a large default alias table is applied
 *    first: "paid"/"succeeded"/"accredited" → "approved", etc.).
 * 3. **`adapt.*` hooks** — full-control mappers when your API shape is
 *    unusual; whatever they return is still normalized and validated.
 *
 * Webhooks work out of the box too: verification via a custom function or a
 * built-in HMAC-SHA256 check, and parsing via dot-paths (or a custom
 * parser). The engine never trusts the webhook body — it re-fetches the
 * charge with your `getCharge` — so a custom provider gets the same safety
 * model as the built-in ones.
 */

import { ProviderError } from "@/core/errors";
import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
import type {
  Charge,
  ChargeState,
  ChargeStatus,
  CreateChargeRequest,
  CreatePayoutRequest,
  FiatCurrencyCode,
  PaymentProvider,
  PayoutResult,
  WebhookNotification,
  WebhookRequest,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CustomWebhookConfig {
  /**
   * Custom signature verification. Return `false` (or throw) to reject.
   * Takes precedence over `hmac`.
   */
  verify?: (request: WebhookRequest) => boolean | Promise<boolean>;
  /**
   * Built-in HMAC-SHA256 verification: the hex digest of `payload` (raw
   * body by default) with `secret` must match the `header` value. A
   * `sha256=` prefix on the header value is tolerated.
   */
  hmac?: {
    secret: string;
    /** Header carrying the signature, e.g. "x-signature" or "x-hub-signature-256". */
    header: string;
    /** What gets signed. Default: the raw request body. */
    payload?: (request: WebhookRequest) => string;
  };
  /**
   * Custom parser: extract the charge id (and event kind) from the webhook.
   * Return `null` for notifications that are not about payments.
   */
  parse?: (request: WebhookRequest) => WebhookNotification | null | Promise<WebhookNotification | null>;
  /**
   * Where to look for the charge id, as dot-paths into the query string and
   * the JSON body (query wins). Default:
   * `["data.id", "id", "payment_id", "charge_id", "resource.id"]`.
   */
  chargeIdPaths?: string[];
}

export interface CustomAdapters {
  /**
   * Map the raw `createCharge` response to (a partial) `Charge`. Whatever is
   * missing gets filled by auto-mapping and normalization.
   */
  charge?: (raw: unknown, request: CreateChargeRequest) => Partial<Charge>;
  /** Map the raw `getCharge` response to (a partial) `ChargeState`. */
  chargeState?: (raw: unknown, chargeId: string) => Partial<ChargeState>;
  /** Map the raw `createPayout` response to (a partial) `PayoutResult`. */
  payout?: (raw: unknown, request: CreatePayoutRequest) => Partial<PayoutResult>;
}

export interface CustomProviderConfig {
  /** Unique name used to select the provider on each order. */
  name: string;
  /** ISO 3166-1 alpha-2 country codes. Default: [] (no restriction). */
  regions?: readonly string[];
  /** Fiat currencies accepted. Default: [] (no restriction). */
  currencies?: readonly FiatCurrencyCode[];

  /** Call your API to build the charge. Return the raw response. */
  createCharge: (request: CreateChargeRequest) => Promise<unknown>;
  /** Call your API for the trusted state of a charge. Return the raw response. */
  getCharge: (chargeId: string) => Promise<unknown>;
  /** Optional payout rail (offramp). Return the raw response. */
  createPayout?: (request: CreatePayoutRequest) => Promise<unknown>;

  /** Response mappers for unusual API shapes. */
  adapt?: CustomAdapters;
  /**
   * Provider status string → normalized `ChargeStatus`. Merged over the
   * built-in alias table; keys are matched case-insensitively.
   */
  statusMap?: Record<string, ChargeStatus>;
  /** Webhook verification + parsing. Omit to accept and auto-parse. */
  webhook?: CustomWebhookConfig;
}

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

/** Built-in provider-status aliases → normalized ChargeStatus. */
export const DEFAULT_STATUS_ALIASES: Record<string, ChargeStatus> = {
  // approved
  approved: "approved",
  accredited: "approved",
  paid: "approved",
  success: "approved",
  succeeded: "approved",
  successful: "approved",
  confirmed: "approved",
  completed: "approved",
  settled: "approved",
  captured: "approved",
  // pending
  pending: "pending",
  in_process: "pending",
  processing: "pending",
  in_progress: "pending",
  created: "pending",
  waiting: "pending",
  waiting_payment: "pending",
  authorized: "pending",
  in_mediation: "pending",
  open: "pending",
  new: "pending",
  unpaid: "pending",
  // rejected
  rejected: "rejected",
  failed: "rejected",
  failure: "rejected",
  declined: "rejected",
  denied: "rejected",
  error: "rejected",
  // canceled
  canceled: "canceled",
  cancelled: "canceled",
  voided: "canceled",
  void: "canceled",
  // refunded
  refunded: "refunded",
  refund: "refunded",
  charged_back: "refunded",
  chargeback: "refunded",
  reversed: "refunded",
  // expired
  expired: "expired",
  timeout: "expired",
  timed_out: "expired",
};

const CHARGE_STATUSES: readonly ChargeStatus[] = [
  "pending",
  "approved",
  "rejected",
  "refunded",
  "canceled",
  "expired",
];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build a fully compliant `PaymentProvider` from plain functions plus
 * declarative adapters. See {@link CustomProviderConfig}.
 */
export function createCustomProvider(config: CustomProviderConfig): CustomProvider {
  return new CustomProvider(config);
}

export class CustomProvider implements PaymentProvider {
  readonly name: string;
  readonly regions: readonly string[];
  readonly currencies: readonly FiatCurrencyCode[];

  #config: CustomProviderConfig;
  #statusMap: Record<string, ChargeStatus>;

  constructor(config: CustomProviderConfig) {
    if (!config.name) throw new ProviderError("custom", "`name` is required.");
    if (typeof config.createCharge !== "function" || typeof config.getCharge !== "function") {
      throw new ProviderError(config.name, "`createCharge` and `getCharge` are required.");
    }
    this.name = config.name;
    this.regions = config.regions ?? [];
    this.currencies = (config.currencies ?? []).map((c) => c.toUpperCase());
    this.#config = config;
    this.#statusMap = { ...DEFAULT_STATUS_ALIASES };
    for (const [key, value] of Object.entries(config.statusMap ?? {})) {
      this.#statusMap[key.toLowerCase()] = value;
    }
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const raw = await this.#config.createCharge(request);
    const adapted = this.#config.adapt?.charge?.(raw, request) ?? {};
    return this.#normalizeCharge(raw, adapted, request);
  }

  async getCharge(chargeId: string): Promise<ChargeState> {
    const raw = await this.#config.getCharge(chargeId);
    const adapted = this.#config.adapt?.chargeState?.(raw, chargeId) ?? {};
    return this.#normalizeChargeState(raw, adapted, chargeId);
  }

  /** Auto-map + validate so the engine always gets a usable charge. */
  #normalizeCharge(raw: unknown, adapted: Partial<Charge>, request: CreateChargeRequest): Charge {
    const auto = autoMapCharge(raw);

    const link = firstString(adapted.link, auto.link);
    const qr = firstString(adapted.qr, auto.qr);
    const qrBase64 = firstString(adapted.qrBase64, auto.qrBase64);
    const deposit = adapted.deposit ?? auto.deposit;
    const id = firstString(adapted.id, auto.id) ?? request.reference;

    let method = adapted.method;
    if (!method || !["qr", "link", "transfer"].includes(method)) {
      method = qr ? "qr" : link ? "link" : deposit ? "transfer" : undefined;
    }
    if (!method) {
      throw new ProviderError(
        this.name,
        "Charge response has no payment link, QR or deposit instructions. " +
          "Return one of them from `createCharge` or map it via `adapt.charge` " +
          "(fields: link, qr, qrBase64, deposit).",
      );
    }

    return {
      id,
      method,
      qr,
      qrBase64,
      link,
      deposit,
      expiresAt:
        adapted.expiresAt ??
        auto.expiresAt ??
        (request.expiresInMinutes ? Date.now() + request.expiresInMinutes * 60_000 : undefined),
      raw,
    };
  }

  #normalizeChargeState(raw: unknown, adapted: Partial<ChargeState>, chargeId: string): ChargeState {
    const auto = autoMapChargeState(raw);
    const rawStatus = adapted.status ?? auto.status;
    return {
      id: firstString(adapted.id, auto.id) ?? chargeId,
      status: this.#normalizeStatus(rawStatus),
      amount: toNumber(adapted.amount ?? auto.amount) ?? 0,
      currency: (firstString(adapted.currency, auto.currency) ?? "").toUpperCase(),
      reference: firstString(adapted.reference, auto.reference),
      raw,
    };
  }

  /** Unknown statuses resolve to "pending" — never to a false approval. */
  #normalizeStatus(status: unknown): ChargeStatus {
    if (typeof status !== "string" || !status) return "pending";
    if (CHARGE_STATUSES.includes(status as ChargeStatus)) return status as ChargeStatus;
    return this.#statusMap[status.toLowerCase()] ?? "pending";
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    const webhook = this.#config.webhook;
    if (webhook?.verify) return webhook.verify(request);
    if (webhook?.hmac) {
      const { secret, header, payload } = webhook.hmac;
      const received = headerValue(request.headers, header);
      if (!received) return false;
      const signed = payload
        ? payload(request)
        : typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);
      const expected = await hmacSha256Hex(secret, signed);
      return timingSafeEqualStr(expected, received.replace(/^sha256=/i, ""));
    }
    return true; // no verification configured
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null> {
    if (this.#config.webhook?.parse) return this.#config.webhook.parse(request);

    const body = parseBody(request.body);
    const paths = this.#config.webhook?.chargeIdPaths ?? [
      "data.id",
      "id",
      "payment_id",
      "charge_id",
      "resource.id",
    ];

    let chargeId: string | undefined;
    for (const path of paths) {
      const fromQuery = request.query?.[path] ?? queryFromUrl(request.url, path);
      if (fromQuery) {
        chargeId = fromQuery;
        break;
      }
      const fromBody = dotGet(body, path);
      if (fromBody !== undefined && fromBody !== null && fromBody !== "") {
        chargeId = String(fromBody);
        break;
      }
    }
    if (!chargeId) return null;

    // "payment.updated"-style events collapse to their family ("payment").
    const kind =
      firstString(
        typeof body.type === "string" ? body.type : undefined,
        typeof body.event === "string" ? body.event.split(".")[0] : undefined,
        typeof body.action === "string" ? body.action.split(".")[0] : undefined,
      ) ?? "payment";

    return { chargeId, kind, raw: body };
  }

  // -------------------------------------------------------------------------
  // Payouts
  // -------------------------------------------------------------------------

  async createPayout(request: CreatePayoutRequest): Promise<PayoutResult> {
    if (!this.#config.createPayout) {
      throw new ProviderError(this.name, "This provider has no payout rail configured.");
    }
    const raw = await this.#config.createPayout(request);
    const adapted = this.#config.adapt?.payout?.(raw, request) ?? {};

    let status = adapted.status;
    if (!status) {
      const normalized = this.#normalizeStatus(autoMapChargeState(raw).status);
      status = normalized === "approved" ? "sent" : normalized === "rejected" ? "failed" : "pending";
    }
    return {
      id: firstString(adapted.id, autoMapCharge(raw).id) ?? request.reference,
      status,
      raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Auto-mapping (field aliases)
// ---------------------------------------------------------------------------

const LINK_KEYS = [
  "link",
  "init_point",
  "sandbox_init_point",
  "checkout_url",
  "payment_url",
  "payment_link",
  "ticket_url",
  "redirect_url",
  "url",
  "href",
];
const QR_KEYS = ["qr", "qr_code", "qr_data", "emv", "copy_paste", "br_code", "qr_string"];
const QR_B64_KEYS = ["qr_base64", "qr_code_base64", "qr_image", "qr_png"];
const ID_KEYS = ["id", "charge_id", "payment_id", "preference_id", "transaction_id", "uuid"];
const EXPIRES_KEYS = ["expires_at", "expiration_date_to", "expiration_date", "expire_at"];
const STATUS_KEYS = ["status", "state", "payment_status"];
const AMOUNT_KEYS = ["amount", "transaction_amount", "total", "total_amount", "value", "paid_amount"];
const CURRENCY_KEYS = ["currency", "currency_id", "currency_code"];
const REFERENCE_KEYS = ["reference", "external_reference", "order_id", "external_id"];

/** Objects worth scanning for aliases: the response itself + common nests. */
function candidates(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const nested = ["data", "charge", "payment", "transaction", "result", "body"]
    .map((key) => root[key])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
  // Mercado Pago-style PIX nest, common enough to support out of the box.
  const poi = (root.point_of_interaction as Record<string, unknown> | undefined)?.transaction_data;
  if (poi && typeof poi === "object") nested.push(poi as Record<string, unknown>);
  return [root, ...nested];
}

function pick(raw: unknown, keys: string[]): unknown {
  for (const obj of candidates(raw)) {
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function autoMapCharge(raw: unknown): Partial<Charge> & { expiresAt?: number } {
  const expiresRaw = pick(raw, EXPIRES_KEYS);
  return {
    id: toStringOrUndefined(pick(raw, ID_KEYS)),
    link: toStringOrUndefined(pick(raw, LINK_KEYS)),
    qr: toStringOrUndefined(pick(raw, QR_KEYS)),
    qrBase64: toStringOrUndefined(pick(raw, QR_B64_KEYS)),
    deposit: undefined, // deposits are too provider-specific to guess
    expiresAt: toEpochMs(expiresRaw),
  };
}

function autoMapChargeState(raw: unknown): {
  id?: string;
  status?: string;
  amount?: unknown;
  currency?: string;
  reference?: string;
} {
  const metadata = pick(raw, ["metadata"]);
  const metaReference =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).external_reference
      : undefined;
  return {
    id: toStringOrUndefined(pick(raw, ID_KEYS)),
    status: toStringOrUndefined(pick(raw, STATUS_KEYS)),
    amount: pick(raw, AMOUNT_KEYS),
    currency: toStringOrUndefined(pick(raw, CURRENCY_KEYS)),
    reference: toStringOrUndefined(pick(raw, REFERENCE_KEYS) ?? metaReference),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: seconds vs milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

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

function dotGet(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
