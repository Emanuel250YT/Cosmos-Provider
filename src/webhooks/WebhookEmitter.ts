/**
 * Outgoing webhook emitter: signs every event with HMAC-SHA256 and POSTs it
 * to your endpoints with retries. Isomorphic (WebCrypto + fetch).
 *
 * Each delivery carries:
 *   `x-cosmos-signature: t={unix_seconds},v1={hmac_hex}`
 * where the signed message is `{t}.{rawBody}`. Verify on the receiving end
 * with {@link verifyCosmosSignature}.
 */

import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";

export const COSMOS_SIGNATURE_HEADER = "x-cosmos-signature";

export interface WebhookEndpoint {
  /** URL to POST events to. */
  url: string;
  /** Shared secret used to sign the payload. */
  secret: string;
  /** Only deliver these event types (default: all). */
  events?: string[];
}

export interface WebhookEmitterOptions {
  endpoints: WebhookEndpoint[];
  /** Delivery attempts per endpoint. Default: 3. */
  maxAttempts?: number;
  /** Base backoff between retries in ms (exponential). Default: 500. */
  backoffMs?: number;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
  /** Called after every delivery attempt (success or failure). */
  onResult?: (result: WebhookDeliveryResult) => void;
}

export interface WebhookDeliveryResult {
  url: string;
  event: string;
  ok: boolean;
  status?: number;
  attempts: number;
  error?: unknown;
}

export interface CosmosWebhookEvent<T = unknown> {
  /** Event type, e.g. "order.completed". */
  type: string;
  /** Event payload. */
  data: T;
  /** Creation time (ms since epoch). */
  createdAt: number;
}

export class WebhookEmitter {
  #endpoints: WebhookEndpoint[];
  #maxAttempts: number;
  #backoffMs: number;
  #fetch: typeof fetch;
  #onResult?: (result: WebhookDeliveryResult) => void;

  constructor(options: WebhookEmitterOptions) {
    this.#endpoints = options.endpoints;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#backoffMs = options.backoffMs ?? 500;
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.#onResult = options.onResult;
  }

  /** Deliver an event to every matching endpoint. Never throws. */
  async emit<T>(type: string, data: T): Promise<WebhookDeliveryResult[]> {
    const event: CosmosWebhookEvent<T> = { type, data, createdAt: Date.now() };
    const body = JSON.stringify(event);

    const deliveries = this.#endpoints
      .filter((endpoint) => !endpoint.events || endpoint.events.includes(type))
      .map((endpoint) => this.#deliver(endpoint, type, body));

    return Promise.all(deliveries);
  }

  async #deliver(endpoint: WebhookEndpoint, type: string, body: string): Promise<WebhookDeliveryResult> {
    let lastError: unknown;
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, this.#backoffMs * 2 ** (attempt - 2)));
      }
      try {
        const t = Math.floor(Date.now() / 1000);
        const signature = await hmacSha256Hex(endpoint.secret, `${t}.${body}`);
        const response = await this.#fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [COSMOS_SIGNATURE_HEADER]: `t=${t},v1=${signature}`,
          },
          body,
        });
        lastStatus = response.status;
        if (response.ok) {
          const result: WebhookDeliveryResult = {
            url: endpoint.url,
            event: type,
            ok: true,
            status: response.status,
            attempts: attempt,
          };
          this.#onResult?.(result);
          return result;
        }
        // Client errors (except 408/429) will not improve on retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    const result: WebhookDeliveryResult = {
      url: endpoint.url,
      event: type,
      ok: false,
      status: lastStatus,
      attempts: this.#maxAttempts,
      error: lastError,
    };
    this.#onResult?.(result);
    return result;
  }
}

/**
 * Verify a webhook sent by {@link WebhookEmitter} on the receiving end.
 *
 * ```ts
 * app.post("/hooks/cosmos", express.raw({ type: "application/json" }), async (req, res) => {
 *   const ok = await verifyCosmosSignature(req.body.toString(), req.get("x-cosmos-signature"), secret);
 *   if (!ok) return res.sendStatus(401);
 *   const event = JSON.parse(req.body.toString());
 *   res.sendStatus(200);
 * });
 * ```
 */
export async function verifyCosmosSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options?: { toleranceSeconds?: number },
): Promise<boolean> {
  if (!signatureHeader) return false;

  let t: string | undefined;
  let v1: string | undefined;
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (key === "t") t = value;
    else if (key === "v1") v1 = value;
  }
  if (!t || !v1) return false;

  const tolerance = options?.toleranceSeconds ?? 300;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > tolerance) return false;

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return timingSafeEqualStr(expected, v1);
}
